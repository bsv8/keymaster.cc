// 受控 active-key 会话密码学的纯函数核心。
//
// 这里只保留 P2PKH/协议层需要的签名与地址派生。ChannelProtocol 的公开消息和
// owner inbox 加密全部由 Coordinator 调用 ChannelProtocol SDK，Vault 不再复制
// 消息信封格式。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { signAsync } from "@noble/secp256k1";
import type { EcdsaSignatureFormat } from "@keymaster/contracts";
import { publicKeyHexToP2pkhAddress } from "./p2pkhAddress.js";

export interface SessionCryptoInit {
  /** 期望的压缩公钥 hex。 */
  publicKeyHex: string;
  /** 32 字节私钥，仅在受控 Worker 内存中存在。 */
  privateKeyBytes: Uint8Array;
}

export function verifySessionKeyPair(init: SessionCryptoInit): void {
  const derived = bytesToHex(secp256k1.getPublicKey(init.privateKeyBytes, true));
  if (derived !== init.publicKeyHex) throw new Error("session_key_mismatch");
}

/** 生成严格短格式 DER 签名。 */
export function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
  const encodeInteger = (value: bigint): Uint8Array => {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    let bytes = hexToBytes(hex);
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) bytes = bytes.slice(1);
    if ((bytes[0] ?? 0) >= 0x80) bytes = new Uint8Array([0, ...bytes]);
    return concatBytes(new Uint8Array([0x02, bytes.length]), bytes);
  };
  const rEncoded = encodeInteger(r);
  const sEncoded = encodeInteger(s);
  return concatBytes(new Uint8Array([0x30, rEncoded.length + sEncoded.length]), rEncoded, sEncoded);
}

function assertStrictDer(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes[0] !== 0x30) throw new Error("Invalid DER signature");
  const length = bytes[1] ?? 0;
  if (length & 0x80 || length + 2 !== bytes.length) throw new Error("Invalid DER signature length");
}

/** 对 32 字节摘要签名；format 必须显式指定。 */
export async function signEcdsaDigest(input: {
  privateKeyBytes: Uint8Array;
  digest: Uint8Array;
  format: EcdsaSignatureFormat;
}): Promise<Uint8Array> {
  if (input.digest.length !== 32) throw new Error("signEcdsaDigest: digest must be 32 bytes");
  if (input.format !== "der" && input.format !== "compact") throw new Error("Unknown signature format");
  const signature = await signAsync(input.digest, input.privateKeyBytes, { lowS: true });
  if (input.format === "compact") {
    const bytes = signature.toCompactRawBytes();
    if (bytes.length !== 64) throw new Error("Invalid compact signature length");
    return bytes;
  }
  const der = encodeDERSignature(signature.r, signature.s);
  assertStrictDer(der);
  return der;
}

export function deriveP2pkhAddress(publicKeyHex: string, network: "main" | "test"): string {
  return publicKeyHexToP2pkhAddress(publicKeyHex, network);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}
