// packages/plugin-vault/src/sessionCryptoProtocol.ts
// Session Crypto Worker / client 间的消息协议。
//
// 设计缘由：
//   - worker 与 client 共享同一份显式消息 schema，避免两边各自定义
//     私钥能力传输形状导致漂移。
//   - 只定义序列化 payload，不定义任何实现逻辑或私钥材料持久化。
//
// 施工单 001：signDigest 消息必须携带 format 字段

import type { EcdsaSignatureFormat, ProviderSealedMessageRecord } from "@keymaster/contracts";

export interface SessionCryptoEncryptedKeyMaterial {
  publicKeyHex: string;
  cipherVersion: "v1" | "v2";
  cipherSaltB64: string;
  cipherIvB64: string;
  cipherB64: string;
  /** 非密码保护器可提供自己的版本化 AAD。 */
  aad?: string;
}

export interface SessionCryptoBootstrapInput {
  sessionId: string;
  publicKeyHex: string;
  passwordKey: CryptoKey;
  encryptedPrivateKey: SessionCryptoEncryptedKeyMaterial;
  label: string;
  capabilities: string[];
  createdAt: string;
}

export interface SessionCryptoInitMessage extends SessionCryptoBootstrapInput {
  kind: "init";
  requestId: string;
}

export interface SessionCryptoSignDigestMessage {
  kind: "signDigest";
  requestId: string;
  publicKeyHex: string;
  digest: ArrayBuffer;
  format: EcdsaSignatureFormat;
}

export interface SessionCryptoDeriveAddressMessage {
  kind: "deriveP2pkhAddress";
  requestId: string;
  publicKeyHex: string;
  network: "main" | "test";
}

export interface SessionCryptoSealSendInputMessage {
  kind: "sealSendInput";
  requestId: string;
  input: {
    sender: { senderPublicKeyHex: string; senderOrigin?: string; senderAppId?: string };
    recipient: { recipientPublicKeyHex: string; recipientOrigin?: string; recipientAppId?: string };
    contentType: "text/plain" | "text/markdown";
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  };
}

export interface SessionCryptoOpenSealedMessage {
  kind: "openSealed";
  requestId: string;
  rec: ProviderSealedMessageRecord;
}

export interface SessionCryptoEncryptVaultKeyMaterialMessage {
  kind: "encryptVaultKeyMaterial";
  requestId: string;
  publicKeyHex: string;
  material: {
    hex: string;
    wif?: string;
  };
}

export interface SessionCryptoDisposeMessage {
  kind: "dispose";
  requestId: string;
  reason: string;
}

export type SessionCryptoRequestMessage =
  | SessionCryptoInitMessage
  | SessionCryptoSignDigestMessage
  | SessionCryptoDeriveAddressMessage
  | SessionCryptoSealSendInputMessage
  | SessionCryptoOpenSealedMessage
  | SessionCryptoEncryptVaultKeyMaterialMessage
  | SessionCryptoDisposeMessage;

export type SessionCryptoResponseMessage<T = unknown> =
  | { requestId: string; ok: true; result: T }
  | { requestId: string; ok: false; error: string };
