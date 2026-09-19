/**
 * Canonical public contract surface consumed by `@keymaster/connect`.
 *
 * This module only selects existing protocol declarations. It contains no
 * duplicate wire shapes and no documentation-only projections.
 *
 * 费用池（`feepool.prepare` / `feepool.commit`）不在 SDK 公共面：方法联合
 * 类型、参数/结果映射和 `PROTOCOL_METHODS` 都在这里收窄；Keymaster 协议
 * 自身仍保留这两个方法，本模块只约束 SDK 暴露面。
 */

import {
  PROTOCOL_METHODS as PROTOCOL_METHODS_ALL,
  PROTOCOL_VERSION,
  type MethodParamsMap as MethodParamsMapAll,
  type MethodResultMap as MethodResultMapAll,
  type ProtocolMethod as ProtocolMethodAll
} from "./protocol.js";

export { PROTOCOL_VERSION };

/** 不在 SDK 公共面暴露的协议方法。 */
type ExcludedProtocolMethod = "feepool.prepare" | "feepool.commit";

/** SDK 公开协议方法名集合（全量方法中去除费用池方法）。 */
export const PROTOCOL_METHODS: readonly ProtocolMethod[] = PROTOCOL_METHODS_ALL.filter(
  (method): method is ProtocolMethod =>
    method !== "feepool.prepare" && method !== "feepool.commit"
);

/** SDK 公开协议方法名联合类型。 */
export type ProtocolMethod = Exclude<ProtocolMethodAll, ExcludedProtocolMethod>;

export type MethodParamsMap = Omit<MethodParamsMapAll, ExcludedProtocolMethod>;
export type MethodResultMap = Omit<MethodResultMapAll, ExcludedProtocolMethod>;
export type MethodParams<M extends ProtocolMethod> = MethodParamsMap[M];
export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = MethodResultMap[M];

export type {
  BinaryField,
  CipherDecryptParams,
  CipherDecryptResult,
  CipherEncryptParams,
  CipherEncryptResult,
  ConnectLaunchParams,
  ConnectLaunchResult,
  ConnectLoginParams,
  ConnectLoginResult,
  ConnectLogoutParams,
  ConnectLogoutResult,
  ConnectResumeParams,
  ConnectResumeResult,
  IdentityGetParams,
  IdentityGetResult,
  IntentSignParams,
  IntentSignResult,
  P2pkhTransferAssetId,
  P2pkhTransferParams,
  P2pkhTransferResult,
  ProtocolError,
  ProtocolErrorCode,
  ProtocolEventMessage,
  ProtocolEventName,
  ProtocolResultMessage,
  ResolvedClaimValue
} from "./protocol.js";

export type {
  ChannelMessageReceivedEventData,
  ChannelPublishParams,
  ChannelPublishResult,
  ChannelSubscriptionSetParams,
  ChannelSubscriptionSetResult,
  JSONValue
} from "./channel.js";

export type {
  PriceChangedEventData,
  PriceGetParams,
  PriceGetResult,
  PriceSubscribeParams,
  PriceSubscriptionResult,
  PriceValue
} from "./price.js";

export type {
  AppIdentityProofV1,
  AppIdentitySnapshot,
  AppRequirement,
  VerifiedAppIdentity
} from "./appIdentity.js";

export {
  STORAGE_DEFAULT_LIST_LIMIT,
  STORAGE_MAX_LIST_LIMIT,
  STORAGE_MAX_PARTS,
  STORAGE_MAX_PAYLOAD_BYTES,
  STORAGE_PART_SIZE_BYTES
} from "./storage/kv.js";

export type {
  StorageDeleteParams,
  StorageDeleteResult,
  StorageDirectoryParams,
  StorageDirectoryResult,
  StorageGetParams,
  StorageGetResult,
  StorageListEntry,
  StorageListParams,
  StorageListResult,
  StoragePutParams,
  StoragePutResult,
  StorageUploadAbortParams,
  StorageUploadAbortResult,
  StorageUploadBeginParams,
  StorageUploadBeginResult,
  StorageUploadCompleteParams,
  StorageUploadPartParams,
  StorageUploadPartResult
} from "./connectStorage.js";

export {
  MSFILE_BLOCK_SIZE_BYTES,
  MSFILE_DIGEST_SIZE_BYTES,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_CONTENT_BYTES,
  MSFILE_MAX_ERROR_MESSAGE_BYTES,
  MSFILE_MAX_HEADER_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_PROTOCOL_ID
} from "./msfile.js";

export type {
  MsFileBlockReadParams,
  MsFileReadResult,
  MsFileSeedReadParams,
  MsFileSatoshiAmount,
  MsFileStatAbsentEntry,
  MsFileStatAvailableEntry,
  MsFileStatDiscoveringEntry,
  MsFileStatNetworkErrorEntry,
  MsFileStatParams,
  MsFileStatQuotedEntry,
  MsFileStatResult,
  MsFileSupplierStat
} from "./msfile.js";
