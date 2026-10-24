// Transaction codec: parse / build / size model for generic (opaque-script)
// transactions. Scripts are opaque bytes; P2PKH-ness is decided by the caller
// comparing against the wallet script. txid = display-order dsha256.
import { UtmError } from "./contract.js";
import { MAX_MONEY } from "./amounts.js";
import { bytesToHex, calcTxid, hexToBytes } from "./hash.js";

export interface TxInput {
  txid: string; // 64-char lowercase hex, display order
  vout: number;
  scriptSigHex: string; // may be "" for unsigned templates
  sequence: number;
  outpointKey: string; // derived canonical txid:vout, equivalent to Go OutpointKey
}

export interface TxOutput {
  value: bigint;
  scriptHex: string;
}

export interface ParsedTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
  canonicalTxid: string;
  sizeBytes: number;
}

const TXID_RE = /^[0-9a-f]{64}$/;

export function checkTxid(txid: unknown): string {
  if (typeof txid !== "string" || !TXID_RE.test(txid)) throw new UtmError("tx-invalid", "invalid txid");
  return txid;
}

/**
 * Attach unlocking scripts to an unsigned template, re-serializing
 * canonically. Hosts use this to combine kernel-built templates with
 * signatures from the trusted signer. Lengths are preserved exactly;
 * the kernel enforces the per-input signature-size bound on submit.
 */
export function assembleSigned(unsignedTxHex: string, scriptSigs: readonly string[]): string {
  const parsed = parseTx(unsignedTxHex);
  if (scriptSigs.length !== parsed.inputs.length) throw new UtmError("tx-invalid", "signature count mismatch");
  const parts: Uint8Array[] = [u32leBytes(parsed.version), encodeVarint(parsed.inputs.length)];
  for (let i = 0; i < parsed.inputs.length; i++) {
    const input = parsed.inputs[i]!;
    let script: Uint8Array;
    try {
      script = hexToBytes(scriptSigs[i]!);
    } catch {
      throw new UtmError("tx-invalid", "bad unlocking script");
    }
    if (script.length > 10000) throw new UtmError("tx-invalid", "unlocking script too long");
    parts.push(txidToLeBytes(input.txid), u32leBytes(input.vout), encodeVarint(script.length), script, u32leBytes(input.sequence));
  }
  parts.push(encodeVarint(parsed.outputs.length));
  for (const output of parsed.outputs) {
    parts.push(u64leBytes(output.value), encodeVarint(output.scriptHex.length / 2), hexToBytes(output.scriptHex));
  }
  parts.push(u32leBytes(parsed.locktime));
  return bytesToHex(concat(parts));
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get left(): number {
    return this.bytes.length - this.pos;
  }
  u8(): number {
    if (this.left < 1) throw new UtmError("tx-invalid", "tx truncated");
    return this.bytes[this.pos++]!;
  }
  u32le(): number {
    if (this.left < 4) throw new UtmError("tx-invalid", "tx truncated");
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4;
    return v;
  }
  u64le(): bigint {
    if (this.left < 8) throw new UtmError("tx-invalid", "tx truncated");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    const lo = BigInt(view.getUint32(0, true));
    const hi = BigInt(view.getUint32(4, true));
    this.pos += 8;
    const v = (hi << 32n) | lo;
    if (v > MAX_MONEY) throw new UtmError("tx-invalid", "output value exceeds max money");
    return v;
  }
  bytes32leToTxid(): string {
    if (this.left < 32) throw new UtmError("tx-invalid", "tx truncated");
    const le = this.bytes.slice(this.pos, this.pos + 32);
    this.pos += 32;
    const reversed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) reversed[i] = le[31 - i]!;
    return bytesToHex(reversed);
  }
  varint(): number {
    const prefix = this.u8();
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      if (this.left < 2) throw new UtmError("tx-invalid", "tx truncated");
      const v = this.bytes[this.pos]! | (this.bytes[this.pos + 1]! << 8);
      this.pos += 2;
      if (v < 0xfd) throw new UtmError("tx-invalid", "non-canonical varint");
      return v;
    }
    if (prefix === 0xfe) {
      const v = this.u32le();
      if (v < 0x10000) throw new UtmError("tx-invalid", "non-canonical varint");
      return v;
    }
    const lo = this.u32le();
    const hi = this.u32le();
    if (hi !== 0 || lo < 0x100000000) throw new UtmError("tx-invalid", "varint too large");
    return lo;
  }
  slice(n: number): Uint8Array {
    if (n < 0 || this.left < n) throw new UtmError("tx-invalid", "tx truncated");
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new UtmError("tx-invalid", "varint out of range");
  if (value < 0xfd) return new Uint8Array([value]);
  if (value <= 0xffff) return new Uint8Array([0xfd, value & 0xff, (value >> 8) & 0xff]);
  if (value <= 0xffffffff) {
    const out = new Uint8Array(5);
    out[0] = 0xfe;
    new DataView(out.buffer).setUint32(1, value, true);
    return out;
  }
  throw new UtmError("tx-invalid", "varint too large");
}

export function varintSize(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  throw new UtmError("tx-invalid", "varint too large");
}

/** Detached canonical ordering, including an empty array for no keys. */
export function sortedOutpointKeys(keys: readonly string[]): string[] {
  return [...keys].sort();
}

export function parseTx(rawTxHex: string, expectedTxid?: string): ParsedTx {
  let raw: Uint8Array;
  try {
    raw = hexToBytes(rawTxHex);
  } catch {
    throw new UtmError("tx-invalid", "rawTx is not hex");
  }
  if (raw.length < 10 || raw.length > 4_000_000) throw new UtmError("tx-invalid", "tx size out of bounds");
  const r = new Reader(raw);
  const version = r.u32le();
  const nIn = r.varint();
  if (nIn === 0 || nIn > 100000) throw new UtmError("tx-invalid", "bad input count");
  const inputs: TxInput[] = [];
  const seenIn = new Set<string>();
  for (let i = 0; i < nIn; i++) {
    const txid = r.bytes32leToTxid();
    const vout = r.u32le();
    const scriptLen = r.varint();
    if (scriptLen > 10000) throw new UtmError("tx-invalid", "scriptSig too long");
    const script = r.slice(scriptLen);
    const sequence = r.u32le();
    const key = `${txid}:${vout}`;
    if (seenIn.has(key)) throw new UtmError("tx-invalid", "duplicate input");
    seenIn.add(key);
    inputs.push({ txid, vout, scriptSigHex: bytesToHex(script), sequence, outpointKey: key });
  }
  const nOut = r.varint();
  if (nOut === 0 || nOut > 100000) throw new UtmError("tx-invalid", "bad output count");
  const outputs: TxOutput[] = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.u64le();
    const scriptLen = r.varint();
    if (scriptLen > 10000) throw new UtmError("tx-invalid", "script too long");
    const script = r.slice(scriptLen);
    outputs.push({ value, scriptHex: bytesToHex(script) });
  }
  const locktime = r.u32le();
  if (r.left !== 0) throw new UtmError("tx-invalid", "trailing bytes");
  const canonicalTxid = calcTxid(raw);
  if (expectedTxid !== undefined && expectedTxid.toLowerCase() !== canonicalTxid) {
    throw new UtmError("tx-invalid", "txid does not match raw transaction");
  }
  return { version, inputs, outputs, locktime, canonicalTxid, sizeBytes: raw.length };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function u32leBytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function u64leBytes(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_MONEY) throw new UtmError("amount-invalid", "output value out of range");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(value & 0xffffffffn), true);
  view.setUint32(4, Number((value >> 32n) & 0xffffffffn), true);
  return out;
}

function txidToLeBytes(txid: string): Uint8Array {
  checkTxid(txid);
  const be = hexToBytes(txid);
  const le = new Uint8Array(32);
  for (let i = 0; i < 32; i++) le[i] = be[31 - i]!;
  return le;
}

export interface UnsignedTemplate {
  version?: number;
  locktime?: number;
  inputs: Array<{ txid: string; vout: number; sequence?: number }>;
  outputs: Array<{ value: bigint | string; scriptHex: string }>;
}

export function buildUnsigned(template: UnsignedTemplate): string {
  const version = template.version ?? 1;
  const locktime = template.locktime ?? 0;
  if (!Number.isInteger(version) || !Number.isInteger(locktime) || locktime < 0) {
    throw new UtmError("tx-invalid", "bad version/locktime");
  }
  const parts: Uint8Array[] = [u32leBytes(version), encodeVarint(template.inputs.length)];
  const seen = new Set<string>();
  for (const input of template.inputs) {
    const key = `${checkTxid(input.txid)}:${input.vout}`;
    if (seen.has(key)) throw new UtmError("tx-invalid", "duplicate input");
    seen.add(key);
    if (!Number.isInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new UtmError("tx-invalid", "bad vout");
    }
    parts.push(txidToLeBytes(input.txid), u32leBytes(input.vout), encodeVarint(0), u32leBytes(input.sequence ?? 0xfffffffe));
  }
  parts.push(encodeVarint(template.outputs.length));
  for (const output of template.outputs) {
    const value = typeof output.value === "string" ? output.value : output.value.toString(10);
    let script: Uint8Array;
    try {
      script = hexToBytes(output.scriptHex);
    } catch {
      throw new UtmError("tx-invalid", "bad output script");
    }
    parts.push(u64leBytes(BigInt(value)), encodeVarint(script.length), script);
  }
  parts.push(u32leBytes(locktime));
  return bytesToHex(concat(parts));
}

/**
 * Estimated signed size for fee purposes: exact base + compact counts +
 * P2PKH input upper-bound weight each + exact output bytes.
 * Output scripts are opaque but length-exact, so CompactSize boundaries are real.
 */
export function estimateSignedSize(nInputs: number, outputScriptLengths: readonly number[]): bigint {
  if (!Number.isSafeInteger(nInputs) || nInputs <= 0) throw new UtmError("policy-denied", "input count out of range");
  let total = 4 + varintSize(nInputs) + nInputs * 148 + varintSize(outputScriptLengths.length);
  for (const len of outputScriptLengths) {
    if (!Number.isSafeInteger(len) || len < 0 || len > 10000) throw new UtmError("policy-denied", "script length out of range");
    total += 8 + varintSize(len) + len;
  }
  total += 4; // locktime
  return BigInt(total);
}
