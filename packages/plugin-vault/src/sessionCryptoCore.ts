// packages/plugin-vault/src/sessionCryptoCore.ts
// 受控 active-key 会话密码学的纯函数核心。
//
// 设计缘由：
//   - Worker-backed session capability 与 main-thread fallback 复用同一套
//     编解码 / 签名 / 加解密逻辑，避免两份实现漂移。
//   - 本文件不持有状态，只提供可共享的纯函数。
//
// 施工单 001：签名格式显式契约硬切换
//   - signEcdsaDigest 替代旧的 signDigestBytes
//   - 必须显式指定 format（"der" 或 "compact"）

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { signAsync } from "@noble/secp256k1";
import type { AppMsgMessage, AppMsgPlaintextV1, EcdsaSignatureFormat, ProviderSealedMessageRecord } from "@keymaster/contracts";
import { APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN, APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN, APPMSG_ENVELOPE_VERSION_V1, APPMSG_PLAINTEXT_VERSION_V1, APPMSG_SEAL_SUITE_ID_V1, APPMSG_SEAL_V1_HKDF_INFO, cborDecode, cborEncode, type AppMsgContentType } from "@keymaster/contracts";
import { decryptBytes, decryptBytesWithAad, vaultKeyAad } from "./crypto.js";
import type { SessionCryptoEncryptedKeyMaterial } from "./sessionCryptoProtocol.js";
import { publicKeyHexToP2pkhAddress } from "./p2pkhAddress.js";

export interface SessionCryptoInit {
  publicKeyHex: string;
  privateKeyBytes: Uint8Array;
}

export function verifySessionKeyPair(init: SessionCryptoInit): void {
  const derived = bytesToHex(secp256k1.getPublicKey(init.privateKeyBytes, true));
  if (derived !== init.publicKeyHex) {
    throw new Error("session_key_mismatch");
  }
}

export function encodeDERSignature(r: bigint, s: bigint): Uint8Array {
  const hexToBytesLocal = (hex: string): Uint8Array => {
    const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  };
  const encodeInt = (n: bigint): Uint8Array => {
    let hex = n.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    let bytes = hexToBytesLocal(hex);
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
  return concatBytes(new Uint8Array([0x30, seqLen]), rEnc, sEnc);
}

/**
 * 断言 DER 签名的结构合法性（strict DER parser）。
 *
 * 设计缘由（P1 输出断言）：
 *   - 防止错误 mock 或 runtime 生成无效 DER 字节。
 *   - 仅检查外层 SEQUENCE 结构，不校验 r/s 值域（由 noble 保证）。
 */
function assertStrictDERSignature(der: Uint8Array): void {
  if (der.length < 8) {
    throw new Error(`assertStrictDERSignature: too short (${der.length} bytes)`);
  }
  if (der[0] !== 0x30) {
    throw new Error("assertStrictDERSignature: must start with 0x30 (SEQUENCE)");
  }
  const seqLen = der[1]!;
  if (seqLen & 0x80) {
    // 长格式长度字节
    const lenBytes = seqLen & 0x7f;
    if (lenBytes === 0 || 2 + lenBytes > der.length) {
      throw new Error("assertStrictDERSignature: invalid long-form length");
    }
  } else {
    // 短格式：剩余字节数必须等于 seqLen
    if (2 + seqLen !== der.length) {
      throw new Error(
        `assertStrictDERSignature: SEQUENCE length ${seqLen} does not match remaining ${der.length - 2}`
      );
    }
  }
}

/**
 * ECDSA 签名唯一入口（施工单 001 硬切换）。
 *
 * 固定算法：
 *   ECDSA/secp256k1
 *   digest: 已哈希 32-byte digest（不二次 hash）
 *   prehash: false
 *   lowS: true
 *   format: 调用方必传 der 或 compact
 *
 * @param params.privateKeyBytes 32 字节私钥
 * @param params.digest 32 字节已哈希 digest
 * @param params.format 签名编码格式
 * @returns 按指定格式编码的签名字节
 */
export async function signEcdsaDigest(params: {
  privateKeyBytes: Uint8Array;
  digest: Uint8Array;
  format: EcdsaSignatureFormat;
}): Promise<Uint8Array> {
  const { privateKeyBytes, digest, format } = params;

  if (digest.length !== 32) {
    throw new Error(`signEcdsaDigest: digest must be 32 bytes, got ${digest.length}`);
  }
  if (format !== "der" && format !== "compact") {
    throw new Error(`signEcdsaDigest: unknown format "${format}"`);
  }

  const sig = await signAsync(digest, privateKeyBytes, { lowS: true });

  if (format === "compact") {
    // compact: r(32 bytes) || s(32 bytes)，固定 64 bytes
    const rBytes = sig.toCompactRawBytes();
    // P1: 输出断言 — compact 必须 64 字节
    if (rBytes.length !== 64) {
      throw new Error(`signEcdsaDigest: compact output expected 64 bytes, got ${rBytes.length}`);
    }
    return rBytes;
  }

  // format === "der"
  const derBytes = encodeDERSignature(sig.r, sig.s);
  // P1: 输出断言 — DER 必须能被 strict DER parser 解析（0x30 开头 + 合法长度）
  assertStrictDERSignature(derBytes);
  return derBytes;
}

export async function decryptSessionPrivateKeyBytes(input: {
  passwordKey: CryptoKey;
  encryptedPrivateKey: SessionCryptoEncryptedKeyMaterial;
}): Promise<Uint8Array> {
  const blob = {
    salt: hexToBytes(input.encryptedPrivateKey.cipherSaltB64),
    iv: hexToBytes(input.encryptedPrivateKey.cipherIvB64),
    ciphertext: hexToBytes(input.encryptedPrivateKey.cipherB64)
  };
  const plain =
    input.encryptedPrivateKey.cipherVersion === "v2"
      ? await decryptBytesWithAad(
          input.passwordKey,
          blob,
          input.encryptedPrivateKey.aad ?? vaultKeyAad(input.encryptedPrivateKey.publicKeyHex)
        )
      : await decryptBytes(input.passwordKey, blob);
  const decoded = new TextDecoder().decode(plain);
  const parsed = JSON.parse(decoded) as { hex: string };
  return hexToBytes(parsed.hex);
}

function assertCompressedSecp256k1PubKey(bytes: Uint8Array, where: string): void {
  if (bytes.length !== 33) {
    throw new Error(`${where}: public key must be 33 bytes (compressed), got ${bytes.length}`);
  }
  const prefix = bytes[0];
  if (prefix !== 2 && prefix !== 3) {
    throw new Error(`${where}: compressed secp256k1 public key must start with 0x02 or 0x03`);
  }
}

function assertNonceLength(bytes: Uint8Array, where: string): void {
  if (bytes.length !== 12) {
    throw new Error(`${where}: nonce must be 12 bytes, got ${bytes.length}`);
  }
}

function encodeEnvelope(env: {
  envelopeVersion: number;
  senderPublicKeyBytes: Uint8Array;
  senderEndpointKind: number;
  senderEndpointId: string;
  recipientPublicKeyBytes: Uint8Array;
  recipientEndpointKind: number;
  recipientEndpointId: string;
  clientMessageId: string;
  createdAtMs: number;
  sealSuiteId: number;
  nonceBytes: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  assertCompressedSecp256k1PubKey(env.senderPublicKeyBytes, "senderPublicKey");
  assertCompressedSecp256k1PubKey(env.recipientPublicKeyBytes, "recipientPublicKey");
  assertNonceLength(env.nonceBytes, "nonce");
  return cborEncode([
    env.envelopeVersion,
    env.senderPublicKeyBytes,
    env.senderEndpointKind,
    env.senderEndpointId,
    env.recipientPublicKeyBytes,
    env.recipientEndpointKind,
    env.recipientEndpointId,
    env.clientMessageId,
    env.createdAtMs,
    env.sealSuiteId,
    env.nonceBytes,
    env.ciphertext
  ]);
}

function decodeEnvelope(bytes: Uint8Array) {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 12) {
    throw new Error(`envelope must be a 12-element array, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  const [
    envelopeVersion,
    senderPublicKeyBytes,
    senderEndpointKind,
    senderEndpointId,
    recipientPublicKeyBytes,
    recipientEndpointKind,
    recipientEndpointId,
    clientMessageId,
    createdAtMs,
    sealSuiteId,
    nonceBytes,
    ciphertext
  ] = raw;
  if (
    typeof envelopeVersion !== "number" ||
    !(senderPublicKeyBytes instanceof Uint8Array) ||
    typeof senderEndpointKind !== "number" ||
    typeof senderEndpointId !== "string" ||
    !(recipientPublicKeyBytes instanceof Uint8Array) ||
    typeof recipientEndpointKind !== "number" ||
    typeof recipientEndpointId !== "string" ||
    typeof clientMessageId !== "string" ||
    typeof createdAtMs !== "number" ||
    typeof sealSuiteId !== "number" ||
    !(nonceBytes instanceof Uint8Array) ||
    !(ciphertext instanceof Uint8Array)
  ) {
    throw new Error("envelope: field type mismatch");
  }
  if (envelopeVersion !== APPMSG_ENVELOPE_VERSION_V1) {
    throw new Error(`envelopeVersion must be ${APPMSG_ENVELOPE_VERSION_V1}, got ${envelopeVersion}`);
  }
  if (sealSuiteId !== APPMSG_SEAL_SUITE_ID_V1) {
    throw new Error(`unsupported sealSuiteId ${sealSuiteId}`);
  }
  assertCompressedSecp256k1PubKey(senderPublicKeyBytes, "senderPublicKey");
  assertCompressedSecp256k1PubKey(recipientPublicKeyBytes, "recipientPublicKey");
  assertNonceLength(nonceBytes, "nonce");
  return {
    envelopeVersion,
    senderPublicKeyBytes,
    senderEndpointKind,
    senderEndpointId,
    recipientPublicKeyBytes,
    recipientEndpointKind,
    recipientEndpointId,
    clientMessageId,
    createdAtMs,
    sealSuiteId,
    nonceBytes,
    ciphertext
  };
}

function encodePlaintext(plain: AppMsgPlaintextV1): Uint8Array {
  return cborEncode([plain.plaintextVersion, plain.contentType, plain.body]);
}

function decodePlaintext(bytes: Uint8Array): AppMsgPlaintextV1 {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(`plaintext must be a 3-element array, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  const [plaintextVersion, contentType, body] = raw;
  if (
    typeof plaintextVersion !== "number" ||
    typeof contentType !== "string" ||
    !(body instanceof Uint8Array)
  ) {
    throw new Error("plaintext: field type mismatch");
  }
  if (plaintextVersion !== APPMSG_PLAINTEXT_VERSION_V1) {
    throw new Error(`plaintextVersion must be ${APPMSG_PLAINTEXT_VERSION_V1}, got ${plaintextVersion}`);
  }
  if (contentType !== "text/plain" && contentType !== "text/markdown") {
    throw new Error(`plaintext: unsupported contentType ${contentType}`);
  }
  return { plaintextVersion: APPMSG_PLAINTEXT_VERSION_V1, contentType, body };
}

function ecdhSharedSecret(senderPrivBytes: Uint8Array, recipientPubBytes: Uint8Array): Uint8Array {
  const compressed = secp256k1.getSharedSecret(senderPrivBytes, recipientPubBytes, true);
  if (compressed.length !== 33) {
    throw new Error(`ecdh: expected 33-byte compressed shared secret, got ${compressed.length}`);
  }
  return compressed.subarray(1);
}

function deriveMessageKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, new Uint8Array(0), new TextEncoder().encode(APPMSG_SEAL_V1_HKDF_INFO), 32);
}

function signEnvelopeBytes(senderPrivateKeyBytes: Uint8Array, envelopeBytes: Uint8Array): Uint8Array {
  if (senderPrivateKeyBytes.length !== 32) {
    throw new Error(`signEnvelopeBytes: private key must be 32 bytes, got ${senderPrivateKeyBytes.length}`);
  }
  const digest = sha256(envelopeBytes);
  const sig = secp256k1.sign(digest, senderPrivateKeyBytes, { prehash: false, format: "compact" });
  return sig;
}

function verifyEnvelopeBytes(
  signatureBytes: Uint8Array,
  envelopeBytes: Uint8Array,
  senderPublicKeyBytes: Uint8Array
): boolean {
  if (signatureBytes.length !== 64 || senderPublicKeyBytes.length !== 33) {
    return false;
  }
  try {
    return secp256k1.verify(signatureBytes, sha256(envelopeBytes), senderPublicKeyBytes, {
      prehash: false,
      format: "compact"
    });
  } catch {
    return false;
  }
}

export function sealAppMessageLocalBytes(input: {
  senderPrivateKeyBytes: Uint8Array;
  senderPublicKeyBytes: Uint8Array;
  recipientPublicKeyBytes: Uint8Array;
  senderEndpoint: { kind: "origin" | "plugin"; id: string };
  recipientEndpoint: { kind: "origin" | "plugin"; id: string };
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}): { envelope: Uint8Array; signatureBytes: Uint8Array } {
  const bodyBytes = new TextEncoder().encode(input.body);
  const plaintextBytes = encodePlaintext({
    plaintextVersion: APPMSG_PLAINTEXT_VERSION_V1,
    contentType: input.contentType,
    body: bodyBytes
  });
  const senderPrivBytes = input.senderPrivateKeyBytes;
  const recipientPubBytes = input.recipientPublicKeyBytes;
  const sharedSecret = ecdhSharedSecret(senderPrivBytes, recipientPubBytes);
  const messageKey = deriveMessageKey(sharedSecret);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const cipher = gcm(messageKey, nonceBytes);
  const ciphertext = cipher.encrypt(plaintextBytes);
  const envelopeBytes = encodeEnvelope({
    envelopeVersion: APPMSG_ENVELOPE_VERSION_V1,
    senderPublicKeyBytes: input.senderPublicKeyBytes,
    senderEndpointKind: input.senderEndpoint.kind === "origin" ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
    senderEndpointId: input.senderEndpoint.id,
    recipientPublicKeyBytes: recipientPubBytes,
    recipientEndpointKind:
      input.recipientEndpoint.kind === "origin" ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
    recipientEndpointId: input.recipientEndpoint.id,
    clientMessageId: input.clientMessageId,
    createdAtMs: input.createdAtMs,
    sealSuiteId: APPMSG_SEAL_SUITE_ID_V1,
    nonceBytes,
    ciphertext
  });
  return { envelope: envelopeBytes, signatureBytes: signEnvelopeBytes(senderPrivBytes, envelopeBytes) };
}

export function openAppMessageLocalBytes(input: {
  signed: { envelopeBytes: Uint8Array; signatureBytes: Uint8Array };
  recipientPrivateKeyBytes: Uint8Array;
  recipientPublicKeyBytes: Uint8Array;
}): {
  contentType: AppMsgContentType;
  bodyUtf8: Uint8Array;
  clientMessageId: string;
  createdAtMs: number;
  senderPublicKeyHex: string;
  senderEndpointId: string;
  senderEndpointKind: "origin" | "plugin";
  recipientPublicKeyHex: string;
  recipientEndpointId: string;
  recipientEndpointKind: "origin" | "plugin";
} {
  const envelope = decodeEnvelope(input.signed.envelopeBytes);
  if (
    !verifyEnvelopeBytes(
      input.signed.signatureBytes,
      input.signed.envelopeBytes,
      envelope.senderPublicKeyBytes
    )
  ) {
    throw new Error("envelope signature verification failed");
  }
  const recipientPrivBytes = input.recipientPrivateKeyBytes;
  const sharedSecret = ecdhSharedSecret(recipientPrivBytes, envelope.senderPublicKeyBytes);
  const messageKey = deriveMessageKey(sharedSecret);
  const cipher = gcm(messageKey, envelope.nonceBytes);
  const plaintextBytes = cipher.decrypt(envelope.ciphertext);
  const plain = decodePlaintext(plaintextBytes);
  return {
    contentType: plain.contentType,
    bodyUtf8: plain.body,
    clientMessageId: envelope.clientMessageId,
    createdAtMs: envelope.createdAtMs,
    senderPublicKeyHex: bytesToHex(envelope.senderPublicKeyBytes),
    senderEndpointId: envelope.senderEndpointId,
    senderEndpointKind: envelope.senderEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN ? "origin" : "plugin",
    recipientPublicKeyHex: bytesToHex(input.recipientPublicKeyBytes),
    recipientEndpointId: envelope.recipientEndpointId,
    recipientEndpointKind: envelope.recipientEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN ? "origin" : "plugin"
  };
}

export function deriveP2pkhAddress(publicKeyHex: string, network: "main" | "test"): string {
  return publicKeyHexToP2pkhAddress(publicKeyHex, network);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}
