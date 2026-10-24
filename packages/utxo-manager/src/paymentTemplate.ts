// Connect v1 payment-template oracle (shared by TS and Go).
//
// This module deliberately does NOT decide wallet ownership, authorization or
// fees. It only turns a requested payment type + recipient script into the
// exact v1 output-role template and re-checks a real transaction against that
// frozen template. Callers still need the manager for coin selection and the
// Vault for the real authorization decision.
//
// v1 scope:
//   - inputs: exact P2PKH only
//   - business output: exact P2PKH or exact P2PK
//   - change output: exact P2PKH to the paying wallet
//   - OP_RETURN / unknown scripts / P2PK change / additional outputs: reject
//
// Script checks are shape checks, not byte-substring searches: pushed data may
// contain 0x6a without turning the output into an OP_RETURN output.

import { UtmError } from "./contract.js";
import { parseAmount, addChecked, sumChecked } from "./amounts.js";
import { bytesToHex, hexToBytes, sha256 } from "./hash.js";

export type PaymentType = "p2pkh" | "p2pk";
export type PaymentOutputRole = "business" | "change";
export type PaymentScriptKind = "p2pkh" | "p2pk" | "op-return" | "unknown";

export interface PaymentOutputFact {
  vout: number;
  scriptHex: string;
  valueSats: string;
}

export interface PaymentRoleFact extends PaymentOutputFact {
  role: PaymentOutputRole;
}

export interface PaymentTemplatePlan {
  paymentType: PaymentType;
  businessAmountSats: string;
  businessScriptHex: string;
  /** null/absent means no change output is allowed. */
  changeScriptHex?: string | null;
  changeAmountSats?: string;
}

export interface PaymentTemplateValidation {
  businessSats: string;
  changeSats: string;
  feeSats: string;
  totalInSats: string;
}

const OP_0 = 0x00;
const OP_RETURN = 0x6a;
const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

function reject(code: "policy-denied" | "tx-invalid", message: string): never {
  throw new UtmError(code, message);
}

function normalizeHex(value: unknown, field: string, exactBytes?: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    reject("policy-denied", `${field} must be hex`);
  }
  const lower = value.toLowerCase();
  if (exactBytes !== undefined && lower.length !== exactBytes * 2) {
    reject("policy-denied", `${field} must be exactly ${exactBytes} bytes`);
  }
  return lower;
}

function amount(value: unknown, field: string): bigint {
  // Reuse the shared amount semantics so TS and Go return the same code
  // (`amount-invalid`) for non-canonical or out-of-range amounts.
  return parseAmount(value, field);
}

function readPush(script: Uint8Array, offset: number): { opcode: number; dataStart: number; dataEnd: number; next: number } | null {
  if (offset >= script.length) return null;
  const opcode = script[offset]!;
  if (opcode <= 0x4b) return { opcode, dataStart: offset + 1, dataEnd: offset + 1 + opcode, next: offset + 1 + opcode };
  if (opcode === OP_PUSHDATA1) {
    if (offset + 2 > script.length) return null;
    const len = script[offset + 1]!;
    return { opcode, dataStart: offset + 2, dataEnd: offset + 2 + len, next: offset + 2 + len };
  }
  if (opcode === OP_PUSHDATA2) {
    if (offset + 3 > script.length) return null;
    const len = script[offset + 1]! | (script[offset + 2]! << 8);
    return { opcode, dataStart: offset + 3, dataEnd: offset + 3 + len, next: offset + 3 + len };
  }
  if (opcode === OP_PUSHDATA4) {
    if (offset + 5 > script.length) return null;
    const len = (script[offset + 1]! | (script[offset + 2]! << 8) | (script[offset + 3]! << 16) | (script[offset + 4]! << 24)) >>> 0;
    return { opcode, dataStart: offset + 5, dataEnd: offset + 5 + len, next: offset + 5 + len };
  }
  return { opcode, dataStart: offset + 1, dataEnd: offset + 1, next: offset + 1 };
}

/**
 * Classify a locking script by parsing opcodes, never by searching for the
 * byte 0x6a inside pushed data. Any non-template shape is "unknown" or
 * "op-return"; callers must reject both.
 */
export function classifyPaymentScript(scriptHex: string): PaymentScriptKind {
  const normalized = normalizeHex(scriptHex, "scriptHex");
  const script = hexToBytes(normalized);
  if (script.length === 25
    && script[0] === OP_DUP && script[1] === OP_HASH160 && script[2] === 0x14
    && script[23] === OP_EQUALVERIFY && script[24] === OP_CHECKSIG) {
    return "p2pkh";
  }
  if (script.length === 35 && script[0] === 0x21 && script[34] === OP_CHECKSIG
    && isValidCompressedPublicKey(normalized.slice(2, 68))) {
    return "p2pk";
  }
  // Walk actual opcodes so a valid template whose pushed data happens to
  // contain 0x6a is not misclassified.
  let offset = 0;
  let previousWasFalse = false;
  while (offset < script.length) {
    const step = readPush(script, offset);
    if (!step || step.next > script.length) return "unknown";
    if (step.opcode === OP_RETURN || (previousWasFalse && step.opcode === OP_RETURN)) return "op-return";
    previousWasFalse = step.opcode === OP_0;
    offset = step.next;
  }
  return "unknown";
}


const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

/** Compressed secp256k1 point validity, not just a 33-byte prefix check. */
export function isValidCompressedPublicKey(publicKeyHex: string): boolean {
  if (!/^(02|03)[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  const x = BigInt(`0x${publicKeyHex.slice(2)}`);
  if (x >= SECP256K1_P) return false;
  const rhs = (x * x * x + 7n) % SECP256K1_P;
  let y = modPow(rhs, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  if ((y * y) % SECP256K1_P !== rhs) return false;
  if ((y & 1n) !== (publicKeyHex.slice(0, 2) === "03" ? 1n : 0n)) y = SECP256K1_P - y;
  return true;
}

export function p2pkhScriptFromHash160(hash160Hex: string): string {
  const hash = normalizeHex(hash160Hex, "hash160Hex", 20);
  return `76a914${hash}88ac`;
}

export function p2pkhScriptFromPublicKey(publicKeyHex: string): string {
  const key = normalizeHex(publicKeyHex, "publicKeyHex", 33);
  if (!isValidCompressedPublicKey(key)) reject("policy-denied", "P2PKH public key is not a valid compressed secp256k1 point");
  return p2pkhScriptFromHash160(hash160(hexToBytes(key)));
}

export function p2pkScriptFromPublicKey(publicKeyHex: string): string {
  const key = normalizeHex(publicKeyHex, "publicKeyHex", 33);
  if (!isValidCompressedPublicKey(key)) reject("policy-denied", "P2PK public key is not a valid compressed secp256k1 point");
  return `21${key}ac`;
}

/** Parse an output script into its canonical P2PKH hash160 or P2PK key. */
export function paymentScriptMaterial(scriptHex: string): { kind: PaymentScriptKind; hash160Hex?: string; publicKeyHex?: string } {
  const kind = classifyPaymentScript(scriptHex);
  const script = normalizeHex(scriptHex, "scriptHex");
  if (kind === "p2pkh") return { kind, hash160Hex: script.slice(6, 46) };
  if (kind === "p2pk") return { kind, publicKeyHex: script.slice(2, 68) };
  return { kind };
}

/**
 * Whether a business output script corresponds to the verified App publisher.
 * This is a fact statement only: a match does not make the payee trustworthy
 * or the business purpose real, and a mismatch is not a rejection reason.
 */
export function publisherMatchesPaymentScript(scriptHex: string, publisherPublicKeyHex: string): boolean {
  const publisher = normalizeHex(publisherPublicKeyHex, "publisherPublicKeyHex", 33);
  if (!isValidCompressedPublicKey(publisher)) reject("policy-denied", "publisherPublicKeyHex is not a valid compressed secp256k1 point");
  const material = paymentScriptMaterial(scriptHex);
  if (material.kind === "p2pkh") return material.hash160Hex === hash160(hexToBytes(publisher));
  if (material.kind === "p2pk") return material.publicKeyHex === publisher;
  return false;
}

/**
 * Build the frozen v1 output-role map. vout 0 is the business output; an
 * optional vout 1 is wallet P2PKH change. Same-script business/change still
 * keep distinct roles because the role is bound to the vout.
 */
export function buildPaymentTemplate(plan: PaymentTemplatePlan): PaymentRoleFact[] {
  if (plan.paymentType !== "p2pkh" && plan.paymentType !== "p2pk") reject("policy-denied", "unsupported payment type");
  const businessAmount = amount(plan.businessAmountSats, "businessAmountSats");
  if (businessAmount <= 0n) reject("policy-denied", "business amount must be positive");
  const businessScript = normalizeHex(plan.businessScriptHex, "businessScriptHex");
  const businessKind = classifyPaymentScript(businessScript);
  if (businessKind !== plan.paymentType) {
    reject("policy-denied", `business output does not match payment type ${plan.paymentType}`);
  }
  const outputs: PaymentRoleFact[] = [
    { vout: 0, scriptHex: businessScript, valueSats: businessAmount.toString(), role: "business" },
  ];
  const changeAmount = plan.changeAmountSats === undefined ? 0n : amount(plan.changeAmountSats, "changeAmountSats");
  if (changeAmount < 0n) reject("policy-denied", "change amount cannot be negative");
  if (changeAmount > 0n) {
    if (plan.changeScriptHex === undefined || plan.changeScriptHex === null) {
      reject("policy-denied", "positive change requires a wallet P2PKH script");
    }
    const changeScript = normalizeHex(plan.changeScriptHex, "changeScriptHex");
    if (classifyPaymentScript(changeScript) !== "p2pkh") {
      reject("policy-denied", "change must be an exact P2PKH script");
    }
    outputs.push({ vout: 1, scriptHex: changeScript, valueSats: changeAmount.toString(), role: "change" });
  }
  return outputs;
}

/**
 * Independently re-check a real transaction's prevout scripts and output
 * facts against the frozen plan. This is what prevents an App-reported type,
 * a forged `change` label or an extra OP_RETURN output from being trusted.
 */
export function validatePaymentTemplate(input: {
  plan: PaymentTemplatePlan;
  prevouts: readonly { scriptHex: string; valueSats: string }[];
  outputs: readonly PaymentOutputFact[];
}): PaymentTemplateValidation {
  if (input.prevouts.length === 0) reject("policy-denied", "payment requires at least one input");
  const prevoutValues: bigint[] = [];
  for (const [index, prevout] of input.prevouts.entries()) {
    const kind = classifyPaymentScript(prevout.scriptHex);
    if (kind !== "p2pkh") reject("policy-denied", `input ${index} is not an exact P2PKH output`);
    prevoutValues.push(amount(prevout.valueSats, "prevout valueSats"));
  }
  const totalIn = sumChecked(prevoutValues, "payment inputs");
  const expected = buildPaymentTemplate(input.plan);
  if (input.outputs.length !== expected.length) reject("policy-denied", "payment output count does not match the frozen template");
  const seen = new Set<number>();
  let business = 0n;
  let change = 0n;
  for (const [index, actual] of input.outputs.entries()) {
    if (!Number.isSafeInteger(actual.vout) || actual.vout < 0) reject("tx-invalid", "output vout is invalid");
    if (seen.has(actual.vout)) reject("tx-invalid", "duplicate output vout");
    seen.add(actual.vout);
    const row = expected.find((candidate) => candidate.vout === actual.vout);
    if (!row) reject("policy-denied", `unexpected output vout ${actual.vout}`);
    if (normalizeHex(actual.scriptHex, "output scriptHex") !== row.scriptHex) {
      reject("policy-denied", `output ${actual.vout} script does not match its frozen role`);
    }
    if (amount(actual.valueSats, "output valueSats") !== BigInt(row.valueSats)) {
      reject("policy-denied", `output ${actual.vout} value does not match its frozen role`);
    }
    if (row.role === "business") business = addChecked(business, BigInt(row.valueSats), "business outputs");
    else change = addChecked(change, BigInt(row.valueSats), "change outputs");
  }
  const totalOut = addChecked(business, change, "payment outputs");
  if (totalOut > totalIn) reject("policy-denied", "outputs exceed inputs");
  return {
    businessSats: business.toString(),
    changeSats: change.toString(),
    feeSats: (totalIn - totalOut).toString(),
    totalInSats: totalIn.toString(),
  };
}

/* ---------------- RIPEMD-160 (for HASH160) ---------------- */

const RMD_R = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RMD_RP = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const RMD_S = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const RMD_SP = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function f1(x: number, y: number, z: number): number { return (x ^ y ^ z) >>> 0; }
function f2(x: number, y: number, z: number): number { return ((x & y) | (~x & z)) >>> 0; }
function f3(x: number, y: number, z: number): number { return ((x | ~y) ^ z) >>> 0; }
function f4(x: number, y: number, z: number): number { return ((x & z) | (y & ~z)) >>> 0; }
function f5(x: number, y: number, z: number): number { return (x ^ (y | ~z)) >>> 0; }
const RMD_F = [f1, f2, f3, f4, f5];
const RMD_FP = [f5, f4, f3, f2, f1];
const RMD_K = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const RMD_KP = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

export function ripemd160(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const paddedLen = (((data.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const x = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getUint32(off + i * 4, true);
    let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4;
    for (let j = 0; j < 80; j++) {
      const round = Math.floor(j / 16);
      let t = (rotl((al + (RMD_F[round]!(bl, cl, dl) >>> 0) + x[RMD_R[j]!]! + RMD_K[round]!) >>> 0, RMD_S[j]!) + el) >>> 0;
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;
      t = (rotl((ar + (RMD_FP[round]!(br, cr, dr) >>> 0) + x[RMD_RP[j]!]! + RMD_KP[round]!) >>> 0, RMD_SP[j]!) + er) >>> 0;
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t;
    }
    const t = (h1 + cl + dr) >>> 0;
    h1 = (h2 + dl + er) >>> 0;
    h2 = (h3 + el + ar) >>> 0;
    h3 = (h4 + al + br) >>> 0;
    h4 = (h0 + bl + cr) >>> 0;
    h0 = t;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, true);
  outView.setUint32(4, h1, true);
  outView.setUint32(8, h2, true);
  outView.setUint32(12, h3, true);
  outView.setUint32(16, h4, true);
  return out;
}

export function hash160(data: Uint8Array): string {
  return bytesToHex(ripemd160(sha256(data)));
}

/** Same hex convenience API as Go Hash160Hex. */
export function hash160Hex(data: string): string {
  try { return hash160(hexToBytes(data)); }
  catch { throw new UtmError("policy-denied", "invalid public key hex"); }
}
