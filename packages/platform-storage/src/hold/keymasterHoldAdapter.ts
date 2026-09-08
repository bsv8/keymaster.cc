// KeymasterHold 适配层。
//
// 桶管理代码只能通过这里接触 SDK，便于统一密码生命周期和错误边界：
// password 只作为当前函数参数存在，调用方必须在 finally 中 dispose context。

import {
  createCryptoContext,
  decryptKey,
  decryptStorage,
  deriveCryptoContext,
  encryptKey,
  encryptStorage,
  parseDocument,
  sealDocument,
  serializeDocument,
  verifyDocument,
  type CipherEnvelope,
  type CryptoContext,
  type HoldDocument,
  type KeyDerivation,
  type KeyRecord,
  type PlainKey,
  type PlainKeyInput,
  type StorageConfig,
  type StorageRecord
} from "keymaster-hold/browser";
import type {
  LocalBucketConnectionConfigV1,
  S3BucketConnectionConfigV1,
  StorageBucketConnectionConfigV1,
  StorageCipherEnvelopeV1,
  StorageHoldIntegrityV1,
  StorageKeyDerivationV1,
  StorageRecordV1
} from "@keymaster/contracts";

export type { CipherEnvelope, HoldDocument, KeyDerivation, KeyRecord, PlainKey, PlainKeyInput, StorageConfig, StorageRecord };

export function toSdkConnectionConfig(config: StorageBucketConnectionConfigV1): StorageConfig {
  // 只复制允许的 SDK 字段，避免把内部目录、桶世代或 UI 字段塞入 Hold。
  if (config.kind === "local") return { kind: "local" } satisfies LocalBucketConnectionConfigV1;
  return {
    kind: "s3",
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle })
  };
}

export function fromSdkConnectionConfig(config: StorageConfig): StorageBucketConnectionConfigV1 {
  if (config.kind === "local") return { kind: "local" };
  return {
    kind: "s3",
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle })
  };
}

export function toContractDerivation(value: KeyDerivation): StorageKeyDerivationV1 {
  return {
    algorithm: value.algorithm,
    passwordEncoding: value.passwordEncoding,
    iterations: value.iterations,
    outputLengthBits: value.outputLengthBits,
    saltB64Url: value.saltB64Url
  };
}

export function toContractStorageRecord(value: StorageRecord): StorageRecordV1 {
  return { cipher: { ...value.cipher } satisfies StorageCipherEnvelopeV1 };
}

export function fromContractDerivation(value: StorageKeyDerivationV1): KeyDerivation {
  return { ...value };
}

export function fromContractStorageRecord(value: StorageRecordV1): StorageRecord {
  return { cipher: { ...value.cipher } };
}

export function integrityFromDocument(document: HoldDocument): StorageHoldIntegrityV1 {
  return { algorithm: document.integrity.algorithm, tagB64Url: document.integrity.tagB64Url };
}

/** 创建新的桶级密码上下文；调用方必须 dispose 返回的上下文。 */
export async function createBucketCryptoContext(password: string): Promise<CryptoContext> {
  return createCryptoContext(password);
}

/** 按已保存公共 KDF 参数派生临时上下文；派生成功不代表密码正确。 */
export async function deriveBucketCryptoContext(password: string, keyDerivation: StorageKeyDerivationV1): Promise<CryptoContext> {
  return deriveCryptoContext(password, fromContractDerivation(keyDerivation));
}

/** 使用一次桶密码加密连接配置，并返回同一上下文的公共参数。 */
export async function encryptBucketConfig(
  config: StorageBucketConnectionConfigV1,
  context: CryptoContext
): Promise<StorageRecordV1> {
  return toContractStorageRecord(await encryptStorage(toSdkConnectionConfig(config), context));
}

export async function decryptBucketConfig(record: StorageRecordV1, context: CryptoContext): Promise<StorageBucketConnectionConfigV1> {
  return fromSdkConnectionConfig(await decryptStorage(fromContractStorageRecord(record), context));
}

export async function encryptBucketKey(input: PlainKeyInput, context: CryptoContext): Promise<KeyRecord> {
  return encryptKey(input, context);
}

export async function decryptBucketKey(record: KeyRecord, context: CryptoContext): Promise<PlainKey> {
  return decryptKey(record, context);
}

/** 对完整记录集合生成新的 Hold 文档及 HMAC；只允许发生在受密码保护的写操作中。 */
export async function sealBucketDocument(storage: StorageRecordV1, keys: KeyRecord[], context: CryptoContext): Promise<HoldDocument> {
  return sealDocument({ storage: fromContractStorageRecord(storage), keys }, context);
}

/** 验证完整 Hold 文档认证；不会解密记录。 */
export async function verifyBucketDocument(document: HoldDocument, context: CryptoContext): Promise<void> {
  await verifyDocument(document, context);
}

/** 冷导入：严格解析结构，但不宣称已通过密码认证。 */
export function parseBucketDocument(input: string | Uint8Array): HoldDocument {
  return parseDocument(input);
}

/** 冷导出：只做结构校验和序列化，不派生、不解密、不重新加密。 */
export function serializeBucketDocument(document: HoldDocument): string {
  return serializeDocument(document);
}
