// packages/contracts/src/activeKeyCrypto.ts
// 受控 active key 密码学能力契约。
//
// 设计目标：
//   - 只暴露“可执行的能力”，不暴露 raw key bytes。
//   - capability 以 session 范围存在，调用方只能拿到公开身份和显式操作。

import type { KeyIdentity } from "./keyspace.js";
import type { AppMsgMessage, AppMsgSendInput } from "./appmsg.js";
import type { ProviderSealedMessageRecord } from "./messageProvider.js";

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

export interface ActiveKeyCryptoSignDigestInput {
  publicKeyHex: string;
  digest: ArrayBuffer;
}

export interface ActiveKeyCryptoSignDigestResult {
  publicKeyHex: string;
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
