// packages/plugin-p2pkh/src/p2pkhSigner.ts
// P2PKH 签名：使用 vault.withPrivateKey 拿到私钥后构造/签名交易。
// 设计缘由：BSV 2018-fork 之后 P2PKH 必须使用 BIP143 sighash；不实现
// 这个 sighash 交易会被网络拒绝。这里给出最小可用的 BIP143 实现，
// 避免引入 @bsv/sdk 巨大依赖。
//
// 关键 BIP143 preimage（按顺序）：
//   nVersion(4) || hashPrevouts(32) || hashSequence(32) ||
//   outpoint(36) || scriptCodeLen(varInt) || scriptCode ||
//   amount(8) || nSequence(4) || hashOutputs(32) ||
//   nLocktime(4) || nHashType(4)
// sighash = dsha256(preimage)；nHashType = SIGHASH_ALL(0x01) | SIGHASH_FORKID(0x40) = 0x41。

import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { getPublicKey, sign } from "@noble/secp256k1";
import type { PrivateKeyMaterial } from "@keymaster/contracts";
import type { P2pkhUtxo, UtxoAllocation } from "./p2pkhContracts.js";

export interface TxInput {
  prevTxid: string;
  prevVout: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface TxOutput {
  value: number;
  script: Uint8Array;
}

export interface UnsignedTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
}

const SIGHASH_ALL_FORKID = 0x41;

/** 从 32 字节 hex 私钥派生 P2PKH 压缩公钥与主网地址。 */
export function deriveP2pkhAddress(privateKeyHex: string, network: "main" | "test" = "main"): {
  publicKeyHex: string;
  address: string;
} {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) throw new Error("Private key must be 32 bytes");
  const pub = getPublicKey(priv, true);
  const sha = sha256(pub);
  const ripe = ripemd160(sha);
  const versionByte = network === "main" ? 0x00 : 0x6f;
  const payload = concatBytes(new Uint8Array([versionByte]), ripe);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return {
    publicKeyHex: bytesToHex(pub),
    address: base58Encode(concatBytes(payload, checksum))
  };
}

/** 构造未签名 P2PKH 交易。 */
export function buildP2pkhTx(params: {
  allocation: UtxoAllocation;
  recipientAddress: string;
  changeAddress: string;
}): UnsignedTx {
  const { allocation, recipientAddress, changeAddress } = params;
  const inputs: TxInput[] = allocation.selected.map((u) => ({
    prevTxid: u.txid,
    prevVout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: 0xfffffffe
  }));
  const outputs: TxOutput[] = [
    { value: allocation.requestedSatoshis, script: addressToP2pkhScript(recipientAddress) }
  ];
  if (allocation.changeSatoshis > 0) {
    outputs.push({ value: allocation.changeSatoshis, script: addressToP2pkhScript(changeAddress) });
  }
  return { version: 1, inputs, outputs, lockTime: 0 };
}

/** 签名并返回 raw tx hex。 */
export async function signP2pkhTx(
  unsigned: UnsignedTx,
  utxos: P2pkhUtxo[],
  key: PrivateKeyMaterial,
  publicKeyHex: string
): Promise<string> {
  const priv = hexToBytes(key.hex);
  if (priv.length !== 32) throw new Error("Private key must be 32 bytes");
  const pub = hexToBytes(publicKeyHex);

  const signedInputs: TxInput[] = unsigned.inputs.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));

  for (let i = 0; i < unsigned.inputs.length; i++) {
    const utxo = utxos[i]!;
    const scriptCode = addressToP2pkhScript(utxo.address);
    const sighash = calcBip143Sighash(unsigned, i, scriptCode, utxo.value);
    const sig = sign(sighash, priv, { lowS: true });
    const der = encodeDERSignature(sig.r, sig.s);
    const sigWithType = concatBytes(der, new Uint8Array([SIGHASH_ALL_FORKID]));
    signedInputs[i] = {
      ...signedInputs[i]!,
      scriptSig: concatBytes(
        new Uint8Array([sigWithType.length]),
        sigWithType,
        new Uint8Array([pub.length]),
        pub
      )
    };
  }

  return bytesToHex(serializeTx({ ...unsigned, inputs: signedInputs }));
}

/**
 * 计算 BIP143 sighash。
 * 设计缘由：BSV 2018-fork 后 P2PKH 必须用 BIP143 preimage + dsha256；旧的 legacy
 * sighash 已被废止。用错会被全网拒绝（mined 不会上链）。
 */
function calcBip143Sighash(
  tx: UnsignedTx,
  inputIndex: number,
  scriptCode: Uint8Array,
  prevValue: number
): Uint8Array {
  // hashPrevouts = dsha256(concat of (txid LE + vout LE) for all inputs)
  const prevoutsConcat = concatBytes(
    ...tx.inputs.map((i) => concatBytes(hexToBytes(swapEndian(i.prevTxid)), u32LE(i.prevVout)))
  );
  const hashPrevouts = dsha256(prevoutsConcat);

  // hashSequence = dsha256(concat of nSequence for all inputs)
  const sequencesConcat = concatBytes(...tx.inputs.map((i) => u32LE(i.sequence)));
  const hashSequence = dsha256(sequencesConcat);

  // hashOutputs = dsha256(concat of all (value LE + scriptLen + script))
  const outputsConcat = concatBytes(
    ...tx.outputs.map((o) => concatBytes(u64LE(o.value), encodeVarInt(o.script.length), o.script))
  );
  const hashOutputs = dsha256(outputsConcat);

  const input = tx.inputs[inputIndex]!;
  const preimage = concatBytes(
    u32LE(tx.version),
    hashPrevouts,
    hashSequence,
    hexToBytes(swapEndian(input.prevTxid)),
    u32LE(input.prevVout),
    encodeVarInt(scriptCode.length),
    scriptCode,
    u64LE(prevValue),
    u32LE(input.sequence),
    hashOutputs,
    u32LE(tx.lockTime),
    u32LE(SIGHASH_ALL_FORKID)
  );
  return dsha256(preimage);
}

/** dsha256 = sha256(sha256(x))。 */
function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** 把 r, s 整数编码为 ECDSA-DER。 */
function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
  const encodeInt = (n: bigint): Uint8Array => {
    let hex = n.toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;
    let bytes = hexToBytes(hex);
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) {
      bytes = bytes.slice(1);
    }
    if (bytes[0]! >= 0x80) {
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes, 1);
      bytes = padded;
    }
    return concatBytes(new Uint8Array([0x02, bytes.length]), bytes);
  };
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const seqLen = rEnc.length + sEnc.length;
  return concatBytes(
    new Uint8Array([0x30, seqLen]),
    rEnc,
    sEnc
  );
}

function serializeTx(tx: UnsignedTx): Uint8Array {
  const parts: Uint8Array[] = [u32LE(tx.version)];
  parts.push(encodeVarInt(tx.inputs.length));
  for (const i of tx.inputs) {
    parts.push(hexToBytes(swapEndian(i.prevTxid)));
    parts.push(u32LE(i.prevVout));
    parts.push(encodeVarInt(i.scriptSig.length));
    parts.push(i.scriptSig);
    parts.push(u32LE(i.sequence));
  }
  parts.push(encodeVarInt(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64LE(o.value));
    parts.push(encodeVarInt(o.script.length));
    parts.push(o.script);
  }
  parts.push(u32LE(tx.lockTime));
  return concatBytes(...parts);
}

function addressToP2pkhScript(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error("Invalid P2PKH address length");
  }
  const expected = sha256(sha256(decoded.subarray(0, 21))).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (decoded[21 + i] !== expected[i]) throw new Error("Invalid P2PKH address checksum");
  }
  const hash = decoded.subarray(1, 21);
  return concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]),
    hash,
    new Uint8Array([0x88, 0xac])
  );
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58 character");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    let c = carry;
    while (c > 0) {
      bytes.push(c & 0xff);
      c = (c / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i]! * 256 + carry;
      digits[i] = v % 58;
      carry = (v / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  return "1".repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function u64LE(n: number): Uint8Array {
  // 关键修复：BSV 金额是 uint64，旧实现把高 4 字节固定为 0，
  // 任何 > 4,294,967,295 sats（约 42.95 BSV）的输入 / 输出 / 找零都会
  // 被截断，导致交易序列化和 BIP143 sighash 全部错误。
  // 使用 BigInt 保证完整 64 位范围。
  const big = BigInt(n);
  return new Uint8Array([
    Number(big & 0xffn),
    Number((big >> 8n) & 0xffn),
    Number((big >> 16n) & 0xffn),
    Number((big >> 24n) & 0xffn),
    Number((big >> 32n) & 0xffn),
    Number((big >> 40n) & 0xffn),
    Number((big >> 48n) & 0xffn),
    Number((big >> 56n) & 0xffn)
  ]);
}

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n < 0x10000) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function swapEndian(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = clean.length - 2; i >= 0; i -= 2) {
    out.push(clean.substring(i, i + 2));
  }
  return out.join("");
}
