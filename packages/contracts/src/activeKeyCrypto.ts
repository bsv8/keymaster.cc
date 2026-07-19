// packages/contracts/src/activeKeyCrypto.ts
// 受控 active key 密码学能力契约。
//
// 设计目标：
//   - 只暴露"可执行的能力"，不暴露 raw key bytes。
//   - capability 以 session 范围存在，调用方只能拿到公开身份和显式操作。
//
// 施工单 001：ECDSA 签名格式显式契约硬切换
//   - 所有 signDigest 调用必须显式指定 format（"der" 或 "compact"）
//   - 没有默认格式；缺少或未知格式一律失败

import type { KeyIdentity } from "./keyspace.js";
import type { AppMsgMessage, AppMsgSendInput } from "./appmsg.js";
import type { ProviderSealedMessageRecord } from "./messageProvider.js";

/**
 * ECDSA 签名编码格式枚举。
 *
 * - "der": strict ASN.1 DER ECDSA signature（可变长，通常 70-72 bytes）
 *   用于：P2PKH / fee pool Bitcoin Script
 * - "compact": r(32 bytes) || s(32 bytes)（固定 64 bytes）
 *   用于：Keymaster identity / intent protocol envelope
 */
export type EcdsaSignatureFormat = "der" | "compact";

export type ActiveKeySessionId = string;

export class ActiveKeySessionRevokedError extends Error {
  constructor(message = "Active key session has been revoked") {
    super(message);
    this.name = "ActiveKeySessionRevokedError";
  }
}

export interface ActiveKeyCryptoIdentity extends KeyIdentity {
  sessionId: ActiveKeySessionId;
}

/**
 * signDigest 输入契约（施工单 001 硬切换）。
 *
 * - digest: 已哈希的 32-byte digest，不做隐式二次 hash
 * - format: 必填，显式指定期望的签名编码格式
 */
export interface ActiveKeyCryptoSignDigestInput {
  publicKeyHex: string;
  digest: ArrayBuffer; // 必须恰好 32 bytes
  format: EcdsaSignatureFormat;
}

/**
 * signDigest 输出契约（施工单 001 硬切换）。
 *
 * - format: 回显请求的格式，用于跨 RPC/worker 边界校验
 * - signature: 按 format 编码的签名字节
 */
export interface ActiveKeyCryptoSignDigestResult {
  publicKeyHex: string;
  format: EcdsaSignatureFormat;
  signature: ArrayBuffer;
}

export interface ActiveKeyCryptoDeriveP2pkhAddressInput {
  publicKeyHex: string;
  network: "main" | "test";
}

export interface ActiveKeyCryptoDeriveP2pkhAddressResult {
  publicKeyHex: string;
  address: string;
}

export interface ActiveKeyCryptoExportBackupInput {
  publicKeyHex: string;
}

export interface ActiveKeyCryptoExportBackupResult {
  publicKeyHex: string;
  backup: ArrayBuffer;
}

export interface ActiveKeyCryptoSealSendInputResult {
  record: ProviderSealedMessageRecord;
}

export interface ActiveKeyCrypto {
  getIdentity(): ActiveKeyCryptoIdentity;
  signDigest(input: ActiveKeyCryptoSignDigestInput): Promise<ActiveKeyCryptoSignDigestResult>;
  deriveP2pkhAddress(
    input: ActiveKeyCryptoDeriveP2pkhAddressInput
  ): Promise<ActiveKeyCryptoDeriveP2pkhAddressResult>;
  sealSendInput(input: {
    sender: { senderPublicKeyHex: string; senderOrigin?: string; senderAppId?: string };
    recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string };
    contentType: AppMsgSendInput["contentType"];
    body: AppMsgSendInput["body"];
    clientMessageId: AppMsgSendInput["clientMessageId"];
    createdAtMs: AppMsgSendInput["createdAtMs"];
  }): Promise<ActiveKeyCryptoSealSendInputResult | { error: string }> | ActiveKeyCryptoSealSendInputResult | { error: string };
  openSealed(rec: ProviderSealedMessageRecord): Promise<AppMsgMessage | null>;
  exportEncryptedKeyBackup(
    input: ActiveKeyCryptoExportBackupInput
  ): Promise<ActiveKeyCryptoExportBackupResult>;
  dispose(reason?: string): void;
}
