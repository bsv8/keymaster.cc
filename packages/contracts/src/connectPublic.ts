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
  BroadcastMessagePublicView,
  BroadcastMessageReceivedEventData,
  BroadcastPublishParams,
  BroadcastPublishResult,
  BroadcastSubscriptionListParams,
  BroadcastSubscriptionListResult,
  BroadcastSubscriptionSetParams,
  BroadcastSubscriptionSetResult,
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
  ResolvedClaimValue,
  AppMsgGetParams,
  AppMsgGetResult,
  AppMsgListParams,
  AppMsgMessageReceivedEventData,
  AppMsgSendParams
} from "./protocol.js";

export type {
  AppIdentityProofV1,
  AppIdentitySnapshot,
  AppRequirement,
  VerifiedAppIdentity
} from "./appIdentity.js";

export type {
  AppMsgContentType,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgRecipient,
  AppMsgSendResult
} from "./appmsg.js";

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
