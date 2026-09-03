/**
 * Canonical public contract surface consumed by `@keymaster/connect`.
 *
 * This module only selects existing protocol declarations. It contains no
 * duplicate wire shapes and no documentation-only projections.
 */

export {
  PROTOCOL_METHODS,
  PROTOCOL_VERSION
} from "./protocol.js";

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
  FeepoolCommitParams,
  FeepoolCommitResult,
  FeepoolPrepareParams,
  FeepoolPrepareResult,
  IdentityGetParams,
  IdentityGetResult,
  IntentSignParams,
  IntentSignResult,
  MethodParams,
  MethodParamsMap,
  MethodResult,
  MethodResultMap,
  P2pkhTransferParams,
  P2pkhTransferResult,
  ProtocolError,
  ProtocolErrorCode,
  ProtocolEventMessage,
  ProtocolEventName,
  ProtocolFeePoolAction,
  ProtocolFeePoolRecord,
  ProtocolMethod,
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
} from "./storage.js";

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
} from "./storage.js";

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
