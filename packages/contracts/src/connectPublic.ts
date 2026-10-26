/** Canonical SDK wire surface. Wallet identity is returned by Keymaster, never selected by App parameters. */
import { PROTOCOL_METHODS as ALL, PROTOCOL_VERSION, type ProtocolMethod as InternalMethod, type ConnectWireParams, type ConnectWireResult } from "./protocol.js";
export { PROTOCOL_VERSION };
type ExcludedProtocolMethod = "feepool.prepare" | "feepool.commit";
export type ProtocolMethod = Exclude<InternalMethod, ExcludedProtocolMethod>;
export const PROTOCOL_METHODS: readonly ProtocolMethod[] = ALL.filter((method): method is ProtocolMethod => method !== "feepool.prepare" && method !== "feepool.commit");
export type MethodParamsMap = { [M in ProtocolMethod]: ConnectWireParams<M> };
export type MethodResultMap = { [M in ProtocolMethod]: ConnectWireResult<M> };
export type MethodParams<M extends ProtocolMethod> = MethodParamsMap[M];
export type MethodResult<M extends ProtocolMethod = ProtocolMethod> = MethodResultMap[M];

export type ProtocolEventMessage = import("./protocol.js").ConnectWireEvent;

export interface CipherDecryptParams extends ConnectWireParams<"cipher.decrypt"> {}
export interface CipherEncryptParams extends ConnectWireParams<"cipher.encrypt"> {}
export interface ConnectLaunchParams extends ConnectWireParams<"connect.launch"> {}
export interface ConnectLaunchResult extends ConnectWireResult<"connect.launch"> {}
export interface ConnectLoginParams extends ConnectWireParams<"connect.login"> {}
export interface ConnectLoginResult extends ConnectWireResult<"connect.login"> {}
export interface ConnectLogoutParams extends ConnectWireParams<"connect.logout"> {}
export interface ConnectLogoutResult extends ConnectWireResult<"connect.logout"> {}
export interface ConnectResumeParams extends ConnectWireParams<"connect.resume"> {}
export interface ConnectResumeResult extends ConnectWireResult<"connect.resume"> {}
export interface IdentityGetParams extends ConnectWireParams<"identity.get"> {}
export interface IntentSignParams extends ConnectWireParams<"intent.sign"> {}
export interface P2pkhTransferParams extends ConnectWireParams<"p2pkh.transfer"> {}
export interface PaymentPayParams extends ConnectWireParams<"payment.pay"> {}
export interface PaymentStatusParams extends ConnectWireParams<"payment.status"> {}
export interface PaymentChannelRegisterParams extends ConnectWireParams<"payment.channel.register"> {}
export interface ChannelPublishParams extends ConnectWireParams<"channel.publish"> {}
export interface ChannelSubscriptionSetParams extends ConnectWireParams<"channel.subscription_set"> {}
export interface PriceGetParams extends ConnectWireParams<"price.get"> {}
export interface PriceSubscribeParams extends ConnectWireParams<"price.subscribe"> {}
export interface StorageDeleteParams extends ConnectWireParams<"storage.delete"> {}
export interface StorageDirectoryParams extends ConnectWireParams<"storage.directory.create"> {}
export interface StorageGetParams extends ConnectWireParams<"storage.get"> {}
export interface StorageListParams extends ConnectWireParams<"storage.list"> {}
export interface StoragePutParams extends ConnectWireParams<"storage.put"> {}
export interface MsFileBlockReadParams extends ConnectWireParams<"msfile.block.read"> {}
export interface MsFileSeedReadParams extends ConnectWireParams<"msfile.seed.read"> {}
export interface MsFileStatParams extends ConnectWireParams<"msfile.stat"> {}

export type {
  BinaryField, CipherDecryptResult, CipherEncryptResult, IdentityGetResult, IntentSignResult,
  P2pkhTransferResult, PaymentPayResult, ConnectPaymentStatus, PaymentReleaseSummary,
  PaymentStatusResult, PaymentChannelRegisterResult, ProtocolError, ProtocolErrorCode,
  ProtocolEventName, ProtocolResultMessage, ResolvedClaimValue
} from "./protocol.js";
export type { ChannelMessageReceivedEventData, ChannelPublishResult, ChannelSubscriptionSetResult, JSONValue } from "./channel.js";
export type { PriceChangedEventData, PriceGetResult, PriceSubscriptionResult, PriceValue } from "./price.js";
export type { AppIdentityProofV1, AppIdentitySnapshot, AppRequirement, VerifiedAppIdentity } from "./appIdentity.js";
export { STORAGE_DEFAULT_LIST_LIMIT, STORAGE_MAX_LIST_LIMIT, STORAGE_MAX_PAYLOAD_BYTES } from "./storage/kv.js";
export type { StorageDeleteResult, StorageDirectoryResult, StorageGetResult, StorageListEntry, StorageListResult, StoragePutResult } from "./connectStorage.js";
export { MSFILE_BLOCK_SIZE_BYTES, MSFILE_DIGEST_SIZE_BYTES, MSFILE_MAX_BLOCK_BYTES, MSFILE_MAX_CONTENT_BYTES, MSFILE_MAX_ERROR_MESSAGE_BYTES, MSFILE_MAX_HEADER_BYTES, MSFILE_MAX_SEED_BYTES, MSFILE_PROTOCOL_ID } from "./msfile.js";
export type { MsFileReadResult, MsFileSatoshiAmount, MsFileStatAbsentEntry, MsFileStatAvailableEntry, MsFileStatDiscoveringEntry, MsFileStatNetworkErrorEntry, MsFileStatQuotedEntry, MsFileStatResult, MsFileSupplierStat } from "./msfile.js";
export { validateNetworkIdentity, sameNetworkIdentity } from "./networkIdentity.js";
export type { NetworkIdentity, BsvNetwork } from "./networkIdentity.js";
