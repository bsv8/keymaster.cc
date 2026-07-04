// packages/plugin-appmsg/src/appmsgCrypto.ts
// 消息加密 / 解密 / 签名 / 验签（施工单 2026-07-04 004 硬切换）。
//
// 这是 plugin-appmsg **唯一**负责"消息密码学"的边界：
//   - ECDH（secp256k1 static-static）
//   - HKDF-SHA256
//   - AES-256-GCM
//   - envelope 编 / 解码
//   - 签名 / 验签
//
// 设计缘由（施工单 §5.3）：
//   - sender 侧：`plaintext -> ciphertext -> envelope -> signature`；
//   - recipient / sender replay 侧：
//     `signature verify -> ciphertext decrypt -> plaintext`；
//   - 失败一律 fail-closed：验签 / 解密失败抛 `AppMsgCryptoError`，
//     调用方（appmsgCore）按"丢弃 + 记录日志 + 同步状态标红"处理；
//   - 严格"先 verify 后 decrypt"——避免对不可信密文做无谓的 AES-GCM
//     运算并降低对攻击者的 oracle 风险。
//
// 失败语义（施工单 §7.1 / §7.2）：
//   - 验签失败（envelope 被篡改 / 公钥不匹配 / 服务端返回坏数据）
//     → `reason = "verify_failed"`；
//   - 解密失败（nonce 坏 / ciphertext 坏 / route 正常但正文解不开）
//     → `reason = "decrypt_failed"`；
//   - envelope 形状不合法（字段类型 / 长度）
//     → `reason = "envelope_malformed"`；
//   - 任何失败 → 抛出，**不**落本地明文。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN,
  APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
  APPMSG_ENVELOPE_VERSION_V1,
  APPMSG_PLAINTEXT_VERSION_V1,
  APPMSG_SEAL_SUITE_ID_V1,
  APPMSG_SEAL_V1_HKDF_INFO,
  cborDecode,
  cborEncode,
  type AppMsgContentType,
  type AppMsgEnvelopeV1,
  type AppMsgPlaintextV1,
  type SignedAppMsgEnvelopeV1
} from "@keymaster/contracts";

/* ============== AppMsgCryptoError ============== */

/**
 * appmsg 加密 / 解密 / 签名 / 验签失败抛出的 typed error。
 *
 * 调用方（`AppMsgCoreImpl`）按 `reason` 字段决定"丢弃 / 记录日志 / 同步
 * 状态标红"——**不**对 message 字符串解析。
 */
export class AppMsgCryptoError extends Error {
  readonly reason: AppMsgCryptoErrorReason;
  constructor(reason: AppMsgCryptoErrorReason, message: string) {
    super(message);
    this.name = "AppMsgCryptoError";
    this.reason = reason;
  }
}

export type AppMsgCryptoErrorReason =
  /** envelope 字段类型 / 长度不合法。 */
  | "envelope_malformed"
  /** sender 签名与 envelope / 公钥不匹配（验签失败）。 */
  | "verify_failed"
  /** AES-GCM 解密失败（密文 / nonce / route 与密钥不一致）。 */
  | "decrypt_failed"
  /** 上游 caller 提供的输入形状不合法（如 contentType 非法）。 */
  | "input_invalid";

/* ============== 工具：hex / bytes ============== */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) {
    throw new Error("hexToBytes: invalid hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("hexToBytes: invalid hex characters");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/** 校验 33-byte compressed secp256k1 公钥。 */
export function assertCompressedSecp256k1PubKey(bytes: Uint8Array, where: string): void {
  if (bytes.length !== 33) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `${where}: public key must be 33 bytes (compressed), got ${bytes.length}`
    );
  }
  const prefix = bytes[0];
  if (prefix !== 2 && prefix !== 3) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `${where}: compressed secp256k1 public key must start with 0x02 or 0x03`
    );
  }
}

/** 校验 32 字节 AES-GCM nonce。 */
export function assertNonceLength(bytes: Uint8Array, where: string): void {
  if (bytes.length !== 12) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `${where}: nonce must be 12 bytes, got ${bytes.length}`
    );
  }
}

/* ============== 编 / 解：AppMsgEnvelopeV1（确定性 CBOR 字节） ============== */

/**
 * 把 `AppMsgEnvelopeV1` 编码为 deterministic CBOR 真值字节。
 *
 * 关键约束：
 *   - 数组顺序固定 = 施工单 §4.2 列出的字段顺序；
 *   - endpoint kind 编码为整数（1 = origin, 2 = plugin）；
 *   - `envelopeVersion` 固定为 1；
 *   - `sealSuiteId` 固定为 1（static-static ECDH）。
 */
export function encodeEnvelope(env: AppMsgEnvelopeV1): Uint8Array {
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

/** 把 deterministic CBOR 真值字节解码回 `AppMsgEnvelopeV1`。 */
export function decodeEnvelope(bytes: Uint8Array): AppMsgEnvelopeV1 {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 12) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `envelope must be a 12-element array, got ${Array.isArray(raw) ? raw.length : typeof raw}`
    );
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
    throw new AppMsgCryptoError(
      "envelope_malformed",
      "envelope: field type mismatch"
    );
  }
  if (envelopeVersion !== APPMSG_ENVELOPE_VERSION_V1) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `envelopeVersion must be ${APPMSG_ENVELOPE_VERSION_V1}, got ${envelopeVersion}`
    );
  }
  if (sealSuiteId !== APPMSG_SEAL_SUITE_ID_V1) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `unsupported sealSuiteId ${sealSuiteId}; only ${APPMSG_SEAL_SUITE_ID_V1} is accepted`
    );
  }
  if (
    senderEndpointKind !== APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN &&
    senderEndpointKind !== APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN
  ) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `senderEndpointKind must be ${APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN} or ${APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN}, got ${senderEndpointKind}`
    );
  }
  if (
    recipientEndpointKind !== APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN &&
    recipientEndpointKind !== APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN
  ) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `recipientEndpointKind must be ${APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN} or ${APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN}, got ${recipientEndpointKind}`
    );
  }
  assertCompressedSecp256k1PubKey(senderPublicKeyBytes, "senderPublicKey");
  assertCompressedSecp256k1PubKey(recipientPublicKeyBytes, "recipientPublicKey");
  assertNonceLength(nonceBytes, "nonce");
  return {
    envelopeVersion: APPMSG_ENVELOPE_VERSION_V1,
    senderPublicKeyBytes,
    senderEndpointKind,
    senderEndpointId,
    recipientPublicKeyBytes,
    recipientEndpointKind,
    recipientEndpointId,
    clientMessageId,
    createdAtMs,
    sealSuiteId: APPMSG_SEAL_SUITE_ID_V1,
    nonceBytes,
    ciphertext
  };
}

/** 把 `AppMsgPlaintextV1` 编码为 deterministic CBOR 真值字节。 */
export function encodePlaintext(plain: AppMsgPlaintextV1): Uint8Array {
  if (
    plain.contentType !== "text/plain" &&
    plain.contentType !== "text/markdown"
  ) {
    throw new AppMsgCryptoError(
      "input_invalid",
      `unsupported contentType ${plain.contentType}`
    );
  }
  return cborEncode([
    plain.plaintextVersion,
    plain.contentType,
    plain.body
  ]);
}

/** 把 deterministic CBOR 真值字节解码回 `AppMsgPlaintextV1`。 */
export function decodePlaintext(bytes: Uint8Array): AppMsgPlaintextV1 {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new AppMsgCryptoError(
      "decrypt_failed",
      `plaintext must be a 3-element array, got ${Array.isArray(raw) ? raw.length : typeof raw}`
    );
  }
  const [plaintextVersion, contentType, body] = raw;
  if (
    typeof plaintextVersion !== "number" ||
    typeof contentType !== "string" ||
    !(body instanceof Uint8Array)
  ) {
    throw new AppMsgCryptoError(
      "decrypt_failed",
      "plaintext: field type mismatch"
    );
  }
  if (plaintextVersion !== APPMSG_PLAINTEXT_VERSION_V1) {
    throw new AppMsgCryptoError(
      "decrypt_failed",
      `plaintextVersion must be ${APPMSG_PLAINTEXT_VERSION_V1}, got ${plaintextVersion}`
    );
  }
  if (contentType !== "text/plain" && contentType !== "text/markdown") {
    throw new AppMsgCryptoError(
      "decrypt_failed",
      `plaintext: unsupported contentType ${contentType}`
    );
  }
  return {
    plaintextVersion: APPMSG_PLAINTEXT_VERSION_V1,
    contentType,
    body
  };
}

/* ============== 加密核心：static-static ECDH + HKDF + AES-256-GCM ============== */

/**
 * 计算 ECDH 共享 secret = secp256k1.sharedSecret(sendPriv, recvPub) → x 坐标。
 *
 * 输入：sender 32 字节私钥 + recipient 33 字节 compressed 公钥。
 * 输出：32 字节 shared secret bytes（仅 x 坐标）。
 *
 * noble 的 `getSharedSecret(priv, pub, true)` 返回 33 字节
 * `[prefix(0x02|0x03) || x(32)]`；剥掉首字节前缀拿 32 字节 x 坐标。
 * `getSharedSecret(priv, pub, false)` 返回 65 字节 uncompressed point
 * `[0x04 || x(32) || y(32)]`——**不**适合直接喂 HKDF（会包含 y 坐标
 * 噪声）。
 */
function ecdhSharedSecret(senderPrivBytes: Uint8Array, recipientPubBytes: Uint8Array): Uint8Array {
  const compressed = secp256k1.getSharedSecret(senderPrivBytes, recipientPubBytes, true);
  if (compressed.length !== 33) {
    throw new AppMsgCryptoError(
      "envelope_malformed",
      `ecdh: expected 33-byte compressed shared secret, got ${compressed.length}`
    );
  }
  // 剥掉 0x02 / 0x03 前缀，保留 32 字节 x 坐标。
  return compressed.subarray(1);
}

/**
 * 派生出 32 字节 AES-256 key：
 *   messageKey = HKDF-SHA256(ikm=sharedSecret, salt=empty, info=APPMSG_SEAL_V1_HKDF_INFO)
 */
function deriveMessageKey(sharedSecret: Uint8Array): Uint8Array {
  const emptySalt = new Uint8Array(0);
  const info = new TextEncoder().encode(APPMSG_SEAL_V1_HKDF_INFO);
  // HKDF-SHA256 输出 32 字节；hkdf(hash, ikm, salt, info, length) 返回 Uint8Array。
  return hkdf(sha256, sharedSecret, emptySalt, info, 32);
}

/* ============== seal（sender 侧） ============== */

/**
 * seal 输入参数。
 *
 * 关键约束：
 *   - `senderPrivateKeyHex` = sender 长期 secp256k1 私钥（32 字节 hex）；
 *   - `recipientPublicKeyHex` = recipient 长期 secp256k1 公钥（33 字节
 *     compressed hex）；
 *   - `senderEndpoint` / `recipientEndpoint` = 端点 id + kind；缺省按
 *     "plugin + 空字符串" 处理（**仅**系统内部调用允许；业务路径必须在
 *     endpoint service 层就拒绝）。
 */
export interface SealInput {
  senderPrivateKeyHex: string;
  senderPublicKeyHex: string;
  recipientPublicKeyHex: string;
  senderEndpoint: { kind: "origin" | "plugin"; id: string };
  recipientEndpoint: { kind: "origin" | "plugin"; id: string };
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}

/**
 * seal 输出：envelope 真值字节 + sender 签名 + 12 字节 nonce（也已在
 * envelope 内）。
 */
export interface SealOutput {
  envelope: SignedAppMsgEnvelopeV1;
}

/**
 * sender 侧 seal + sign。
 *
 * 流程：
 *   1. 编码 plaintext（CBOR）；
 *   2. 派生 ECDH 共享 secret → HKDF 派生 messageKey；
 *   3. 用 messageKey + 12 字节随机 nonce 对 plaintext 做 AES-GCM；
 *   4. 把 plaintext nonce + ciphertext 装入 `AppMsgEnvelopeV1` 真值；
 *   5. 用 sender owner 私钥对 SHA-256(envelopeBytes) 做 compact secp256k1
 *      签名；签名只对 envelopeBytes 真值字节本身，**不**再做 prehash。
 */
export function sealAppMessage(input: SealInput): SealOutput {
  // 0. 校验 endpoint 形状。
  if (input.senderEndpoint.kind !== "origin" && input.senderEndpoint.kind !== "plugin") {
    throw new AppMsgCryptoError(
      "input_invalid",
      `senderEndpoint.kind must be "origin" or "plugin"`
    );
  }
  if (input.recipientEndpoint.kind !== "origin" && input.recipientEndpoint.kind !== "plugin") {
    throw new AppMsgCryptoError(
      "input_invalid",
      `recipientEndpoint.kind must be "origin" or "plugin"`
    );
  }
  // 1. plaintext bytes。
  const bodyBytes = new TextEncoder().encode(input.body);
  const plaintextBytes = encodePlaintext({
    plaintextVersion: APPMSG_PLAINTEXT_VERSION_V1,
    contentType: input.contentType,
    body: bodyBytes
  });
  // 2. ECDH + HKDF。
  const senderPrivBytes = hexToBytes(input.senderPrivateKeyHex);
  const recipientPubBytes = hexToBytes(input.recipientPublicKeyHex);
  assertCompressedSecp256k1PubKey(recipientPubBytes, "recipientPublicKey");
  const sharedSecret = ecdhSharedSecret(senderPrivBytes, recipientPubBytes);
  const messageKey = deriveMessageKey(sharedSecret);
  // 3. AES-256-GCM 加密 plaintext。
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const cipher = gcm(messageKey, nonceBytes);
  const ciphertext = cipher.encrypt(plaintextBytes);
  // 4. envelope 真值。
  const envelope: AppMsgEnvelopeV1 = {
    envelopeVersion: APPMSG_ENVELOPE_VERSION_V1,
    senderPublicKeyBytes: hexToBytes(input.senderPublicKeyHex),
    senderEndpointKind:
      input.senderEndpoint.kind === "origin"
        ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
    senderEndpointId: input.senderEndpoint.id,
    recipientPublicKeyBytes: recipientPubBytes,
    recipientEndpointKind:
      input.recipientEndpoint.kind === "origin"
        ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
    recipientEndpointId: input.recipientEndpoint.id,
    clientMessageId: input.clientMessageId,
    createdAtMs: input.createdAtMs,
    sealSuiteId: APPMSG_SEAL_SUITE_ID_V1,
    nonceBytes,
    ciphertext
  };
  const envelopeBytes = encodeEnvelope(envelope);
  // 5. 签名：SHA-256(envelopeBytes) → secp256k1 compact 64-byte。
  const signatureBytes = signEnvelopeBytes(senderPrivBytes, envelopeBytes);
  return {
    envelope: { envelopeBytes, signatureBytes }
  };
}

/* ============== open（recipient / sender replay 侧） ============== */

/**
 * open 输入参数。
 *
 * 关键约束：
 *   - 接收方拿到 sealed record 后必须**先 verify 后 decrypt**；
 *   - `recipientPrivateKeyHex` = recipient owner 私钥；
 *   - envelope 真值里的 senderPublicKeyBytes 直接用作验签公钥（无需
 *     二次查表）；
 *   - 解密用 recipientPrivateKey + envelope.recipientPublicKeyBytes 派生
 *     同一把 messageKey——这是 `static-static ECDH` 天然对称性。
 */
export interface OpenInput {
  signed: SignedAppMsgEnvelopeV1;
  recipientPrivateKeyHex: string;
}

/**
 * open 输出：原始 plaintext + 路由头镜像（sender / recipient owner pub
 * + endpoint id）。
 *
 * plaintext 的 `body` 是 UTF-8 字节；调用方按业务层 `AppMsgContentType`
 * 还原成字符串。
 */
export interface OpenOutput {
  contentType: AppMsgContentType;
  bodyUtf8: Uint8Array;
  /** 解出的 clientMessageId（= envelope 真值字段）。 */
  clientMessageId: string;
  createdAtMs: number;
  /** 解出的 sender owner 公钥 hex（mirror envelope 真值）。 */
  senderPublicKeyHex: string;
  senderEndpointId: string;
  senderEndpointKind: "origin" | "plugin";
  recipientPublicKeyHex: string;
  recipientEndpointId: string;
  recipientEndpointKind: "origin" | "plugin";
}

/**
 * 接收方 / sender replay 侧 verify + decrypt。
 *
 * 失败语义（施工单 §7.1 / §7.2）：
 *   - 验签失败 → `AppMsgCryptoError("verify_failed", ...)`；
 *   - 解密失败 → `AppMsgCryptoError("decrypt_failed", ...)`；
 *   - envelope 形状不合法 → `AppMsgCryptoError("envelope_malformed", ...)`；
 *   - 任何失败一律 fail-closed——**不**返回部分结果。
 */
export function openAppMessage(input: OpenInput): OpenOutput {
  // 1. 解码 envelope（结构 / 字段类型校验）。
  const envelope = decodeEnvelope(input.signed.envelopeBytes);
  // 2. 验签：sender envelope 真值里的 senderPublicKeyBytes 作公钥。
  const ok = verifyEnvelopeBytes(
    input.signed.signatureBytes,
    input.signed.envelopeBytes,
    envelope.senderPublicKeyBytes
  );
  if (!ok) {
    throw new AppMsgCryptoError(
      "verify_failed",
      "envelope signature verification failed"
    );
  }
  // 3. 解密：shared secret 派生。
  //
  // ECDH 对称性：ECDH(recipient.priv, sender.pub) == ECDH(sender.priv,
  // recipient.pub)。
  //
  // 两种合法场景：
  //   - **正常收件**：caller = recipient；用 recipient.priv + envelope
  //     .sender.pub。
  //   - **sender 自己回放历史**：caller = sender（施工单 §7.4）；此时
  //     caller 的 priv 对应的 pub 与 envelope.sender.pub 一致。
  //     我们**不**再单独存 sender 一份 ciphertext（§2.4），而是让 sender
  //     用自己的 priv + envelope.recipient.pub 重派生同一把 shared secret。
  const recipientPrivBytes = hexToBytes(input.recipientPrivateKeyHex);
  const callerDerivedPub = secp256k1.getPublicKey(recipientPrivBytes, true);
  const isSenderReplaying =
    bytesToHex(callerDerivedPub) === bytesToHex(envelope.senderPublicKeyBytes);
  const sharedSecret = isSenderReplaying
    ? ecdhSharedSecret(recipientPrivBytes, envelope.recipientPublicKeyBytes)
    : ecdhSharedSecret(recipientPrivBytes, envelope.senderPublicKeyBytes);
  const messageKey = deriveMessageKey(sharedSecret);
  let plaintextBytes: Uint8Array;
  try {
    const cipher = gcm(messageKey, envelope.nonceBytes);
    plaintextBytes = cipher.decrypt(envelope.ciphertext);
  } catch {
    throw new AppMsgCryptoError(
      "decrypt_failed",
      "AES-GCM decryption failed (nonce / ciphertext / messageKey mismatch)"
    );
  }
  // 4. 解码 plaintext。
  const plaintext = decodePlaintext(plaintextBytes);
  return {
    contentType: plaintext.contentType,
    bodyUtf8: plaintext.body,
    clientMessageId: envelope.clientMessageId,
    createdAtMs: envelope.createdAtMs,
    senderPublicKeyHex: bytesToHex(envelope.senderPublicKeyBytes),
    senderEndpointKind:
      envelope.senderEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        ? "origin"
        : "plugin",
    senderEndpointId: envelope.senderEndpointId,
    recipientPublicKeyHex: bytesToHex(envelope.recipientPublicKeyBytes),
    recipientEndpointKind:
      envelope.recipientEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        ? "origin"
        : "plugin",
    recipientEndpointId: envelope.recipientEndpointId
  };
}

/* ============== envelope 签名 / 验签 ============== */

/**
 * 对 envelope 真值字节做 secp256k1 compact 64-byte 签名。
 *
 * 关键约束：
 *   - 签名对象 = `SHA-256(envelopeBytes)`；**不**用 noble 的 prehash 行为
 *     对 envelopeBytes 再次 mod n 缩减；
 *   - 输出 64 字节 r||s。
 */
export function signEnvelopeBytes(
  senderPrivateKeyBytes: Uint8Array,
  envelopeBytes: Uint8Array
): Uint8Array {
  if (senderPrivateKeyBytes.length !== 32) {
    throw new AppMsgCryptoError(
      "input_invalid",
      `signEnvelopeBytes: private key must be 32 bytes, got ${senderPrivateKeyBytes.length}`
    );
  }
  const digest = sha256(envelopeBytes);
  const sig = secp256k1.sign(digest, senderPrivateKeyBytes, {
    prehash: false,
    format: "compact"
  });
  if (sig.length !== 64) {
    throw new AppMsgCryptoError(
      "input_invalid",
      "signEnvelopeBytes: compact signature must be 64 bytes"
    );
  }
  return sig;
}

/**
 * 验签：直接对 envelope 真值字节做 secp256k1 compact 64-byte 验签。
 *
 * 失败语义：返回 `false`（**不**抛错）；调用方（openAppMessage）按 false
 * 翻译成 `verify_failed`。
 */
export function verifyEnvelopeBytes(
  signatureBytes: Uint8Array,
  envelopeBytes: Uint8Array,
  senderPublicKeyBytes: Uint8Array
): boolean {
  if (signatureBytes.length !== 64) {
    return false;
  }
  if (senderPublicKeyBytes.length !== 33) {
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

/* ============== helper：endianness-safe 本地 envelope 字段读取 ============== */

/**
 * 从 sealed record 解析"对外 sender / recipient 公钥 hex + endpoint
 * kind/id"——调用方在入站边界拿到 sealed record 后**不必**重新
 * decode envelope 也能拿到路由头。
 *
 * 用于 plugin-appmsgCore 在 inbound 阶段做本地 DB 写路径：写本地库前
 * 必须先把 sealed record → 公开 `AppMsgMessage`；这一步只读 envelope
 * 解出的路由头，验签 / 解密在 openAppMessage 内一次性做完。
 */
export function readEnvelopeRoute(envelopeBytes: Uint8Array): {
  senderPublicKeyHex: string;
  senderEndpointKind: "origin" | "plugin";
  senderEndpointId: string;
  recipientPublicKeyHex: string;
  recipientEndpointKind: "origin" | "plugin";
  recipientEndpointId: string;
} {
  const env = decodeEnvelope(envelopeBytes);
  return {
    senderPublicKeyHex: bytesToHex(env.senderPublicKeyBytes),
    senderEndpointKind:
      env.senderEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN ? "origin" : "plugin",
    senderEndpointId: env.senderEndpointId,
    recipientPublicKeyHex: bytesToHex(env.recipientPublicKeyBytes),
    recipientEndpointKind:
      env.recipientEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN ? "origin" : "plugin",
    recipientEndpointId: env.recipientEndpointId
  };
}

/* ============== helper：sender 公钥 ↔ 私钥一致性 ============== */

/**
 * 校验 sender 私钥确实对应声明的公钥 hex。
 *
 * 用于 plugin-appmsgCore 在 seal 前做一次一致性校验——避免"声明公钥
 * 与实际私钥不匹配"导致服务端收到无法验签的 envelope。
 */
export function assertSenderPrivMatchesPub(
  senderPrivateKeyHex: string,
  senderPublicKeyHex: string
): void {
  const priv = hexToBytes(senderPrivateKeyHex);
  if (priv.length !== 32) {
    throw new AppMsgCryptoError(
      "input_invalid",
      "assertSenderPrivMatchesPub: private key must be 32 bytes"
    );
  }
  const derived = secp256k1.getPublicKey(priv, true);
  const derivedHex = bytesToHex(derived);
  if (derivedHex.toLowerCase() !== senderPublicKeyHex.toLowerCase()) {
    throw new AppMsgCryptoError(
      "input_invalid",
      "assertSenderPrivMatchesPub: derived public key does not match declared senderPublicKeyHex"
    );
  }
}