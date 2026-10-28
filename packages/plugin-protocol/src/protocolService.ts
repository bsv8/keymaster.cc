import { applicationKey, requiresApplicationApproval, readApplicationPermissions, setApplicationPermission } from "./applicationPermissions.js";
import { projectNetworkIdentity, sameNetworkIdentity, type NetworkIdentity } from "@keymaster/contracts";
import { requireUnlockedWalletIdentity } from "@keymaster/contracts";
async function appPaymentChannelId(owner: string, name: string, paymentType: string, network: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["keymaster.app-payment-channel.v1", owner, name, paymentType, network]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "pay." + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
function publisherPaymentOwner(publisher: string): string {
  return "publisher." + publisher.toLowerCase();
}
async function publisherPaymentChannelId(publisher: string, paymentType: PaymentChannelRegisterParams["paymentType"], network: NetworkIdentity["bsvNetwork"]): Promise<string> {
  return appPaymentChannelId(publisherPaymentOwner(publisher), "publisher-single.v1", paymentType, network);
}
async function publisherPaymentSessionId(sessionId: string): Promise<string> {
  return appPaymentChannelId("connect-session", sessionId, "publisher-single.v1", "session");
}
async function authenticateAppWallet(
  vault: Pick<import("@keymaster/contracts").VaultService, "verifyPassword">,
  publicKeyHex: string,
  password: string,
  walletState: Pick<import("@keymaster/contracts").VaultWalletState, "snapshot">,
): Promise<void> {
  const issued = walletState.snapshot();
  const assertLive = () => {
    const current = walletState.snapshot();
    if (issued.status !== "unlocked" || issued.activePublicKeyHex !== publicKeyHex
      || current.status !== issued.status || current.activePublicKeyHex !== issued.activePublicKeyHex
      || current.sessionEpoch !== issued.sessionEpoch || current.runGeneration !== issued.runGeneration
      || current.walletGeneration !== issued.walletGeneration
      || current.activeKeyIdentity?.bsvNetwork !== issued.activeKeyIdentity?.bsvNetwork) {
      throw new Error("Active wallet key session has been revoked");
    }
  };
  assertLive();
  await vault.verifyPassword(password);
  assertLive();
}
import { createProviderDispatch } from "./providerDispatch.js";
import { KeymasterConnectReceiver, type ReceiverRequest } from "keymaster-connect/server";
import type * as ConnectPublic from "keymaster-connect/protocol";
import type { ProtocolResultMessage } from "keymaster-connect/protocol";
import type { AppStorageBinding, AppStorageClient } from "@keymaster/contracts";
// packages/plugin-protocol/src/protocolService.ts
// 钱包 Connect 宿主：解锁/授权 UI 调度、串行执行、Vault 与实际业务、持久责任。
// Client/Receiver 的协议校验、来源/绑定、在途去重与封包统一由独立 KeymasterConnect 实现。
// 历史费用池执行代码保留责任处理用途，不代表公开 Connect v1 开放费用池。
//
// 设计缘由（施工单 2026-06-27 001 硬切换 + 施工单 2026-06-28 002 硬切换 +
// Connect Storage 施工单）：
//   - 会话锁状态 (`ProtocolPopupLockState`) 与请求状态 (`ProtocolCommandPhase`)
//     分层；不再共享一个中心 phase。
//   - 内部数据：
//       * `requestsByRecordId: Map<recordId, RequestRecord>`：所有活
//         请求 + 终态历史；唯一真相源。
//       * `executionQueue: recordId[]`：按入队顺序 FIFO 的已确认队列。
//       * `executingRecordId`：当前唯一正在执行的 recordId（null = 空）。
//       * `timersByRecordId: Map<recordId, ConfirmTimeoutState>`：每条
//         confirming request 独立的 timeout 信息。
//       * `lockState: "locked" | "unlocked"`：会话级状态，UI 用此决定
//         渲染锁屏页还是主 popup 页面。
//   - 新 request 到达 → 立即建独立 record，按 lockState + auto-approve
//     决定初始 phase：
//       * locked + manual → `waiting_unlock_manual`
//       * locked + auto → `waiting_unlock_auto`
//       * unlocked + manual → `confirming`（启动 timeout）
//       * unlocked + auto → `queued`
//   - 本类消费 Receiver 已验证的请求，internalExecutionParams 再附加内部钱包上下文。
//     `walletPublicKeyHex` 只属于内部执行 DTO，外部 wire 不接受钱包或网络选择字段。
//     accept 阶段同步预校验 session 真值（fail-fast）：
//       - session 不存在 / 已 revoke / origin 不匹配 / owner key 不 ready
//         → 直接 phase=failed，对外回 user_rejected / invalid_origin；
//       - 不进 waiting_unlock / confirming / 解锁 UI。
//   - **owner 唯一真值 = `ownerPublicKeyHex`**：`ownerKeyId` **不**出现
//     在 record / result payload / 内部 pendingOp 字段里。执行时按
//     `session.ownerPublicKeyHex` 查 walletState.getKey() 拿当前 vault 内
//   - record 在创建时立即绑定 `walletPublicKeyHex` + `ownerPublicKeyHex`；
//     record 生命周期内**不**可漂移。执行阶段再次校验 session 仍有效
//     （logout 后同 session 下旧 request 后续执行必须失败）。
//   - `feepool` 持久化 key 维度补 `ownerPublicKeyHex`：
//     `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`，
//     同 origin 不同 owner 不再串池。
//   - `cancel(id)` 按 `source + origin + transportRequestId` 命中具体
//     request；命中后转 rejected，并写本地 `failureReason=client_canceled`；
//     对外仍回原 request 的 user_rejected。
//   - 在途 `requestId` 去重由 Receiver 唯一持有，业务卡不再维护第二套协议判定。
//   - 解锁后批量推进：所有 `waiting_unlock_*` 一次性扫描，manual →
//     `confirming`（启动 timeout），auto → `queued`。
//   - 全局串行执行：每条确认 / auto 的 request 进 `executionQueue`；
//     `drainExecutionQueue` 单独调度，同一时刻只允许一条 `executing`。
//   - relock 硬收口：`confirming` 全部回到 `waiting_unlock_manual` 并清
//     timeout；queued 保持；executing 当前这一条允许跑完；执行器暂停
//     取新任务，直到再次 unlocked。
//   - 不做按资源加锁；不做无条件完全并发。
//   - popup 卸载 / 刷新 → 所有 pending feepool operation 立即失效；
//     endSession 把所有未终态 request 强制收尾为 rejected。
//
// 隐私边界：余额不足 / 费用池缺失 / K-V 不可用 / 未知 op / 跨 origin
// operationId，**全部**对外回 `user_rejected`；本地原因只写
// `ProtocolCommandRecord.failureReason`。
//
// Payment 缺少持久幂等账本时必须拒绝；协议运行态清理不能抹除已签责任。
//
// 不依赖 React；可单测。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { deriveAppStorageName, deriveThirdPartyStorageModuleId } from "@keymaster/contracts";
import {
  PROTOCOL_VERSION,
  LaunchAppViewError,
  type AppBootstrapPayload,
  type ConnectChannelRuntime,
  type ChannelMessageReceivedEvent,
  type ChannelMessageReceivedEventData,
  type ChannelSubscriptionSetParams,
  type ChannelSubscriptionSetResult,
  type ChannelPublishParams,
  type ChannelPublishResult,
  type AppViewContext,
  type BinaryField,
  type AppIdentitySnapshot,
  type AppIdentityProofV1,
  type AppCatalogResolution,
  type AppCatalogResolver,
  type CipherDecryptParams,
  type CipherDecryptResult,
  type CipherEncryptParams,
  type CipherEncryptResult,
  type ConnectLaunchParams,
  type ConnectLaunchResult,
  type ConnectLoginParams,
  type ConnectLoginResult,
  type ConnectLogoutParams,
  type ConnectLogoutResult,
  type ConnectResumeParams,
  type ConnectResumeResult,
  type ConnectSessionRecord,
  type FeepoolCommitParams,
  type FeepoolCommitResult,
  type FeepoolPrepareParams,
  type FeepoolPrepareResult,
  type IdentityGetParams,
  type IdentityGetResult,
  type IntentSignParams,
  type IntentSignResult,
  type KeyIdentity,
  type VaultWalletState,
  type LaunchAppViewInput,
  type LaunchAppViewResult,
  type MethodParams,
  type MethodResult,
  type OwnerExecutionRuntime,
  type SessionRuntimeBootstrap,
  type P2pkhProtocolAdapter,
  type P2pkhTransferAssetId,
  type PaymentChannelRegisterParams,
  type PaymentChannelRegisterResult,
  type PaymentPayParams,
  type PaymentPayResult,
  type PaymentStatusParams,
  type PaymentStatusResult,
  type ProtocolConnectPaymentRecord,
  type P2pkhTransferParams,
  type P2pkhTransferResult,
  type ProtocolClosingMessage,
  type ProtocolCommandFeedState,
  type ProtocolCommandRecord,
  type ProtocolConnectAuthSnapshot,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolEventMessage,
  type ProtocolFailureReason,
  type ProtocolFeePoolAction,
  type ProtocolFeePoolDeliveryRecord,
  type ProtocolFeePoolRecord,
  type ProtocolLockSummary,
  PROTOCOL_METHODS,
  type ProtocolMethod,
  type ProtocolOriginSettings,
  type ProtocolOriginSettingsRecord,
  type ProtocolPopupLockState,
  type ProtocolReadyMessage,
  type ProtocolService,
  type ProtocolSessionPhase,
  type ProtocolSessionSnapshot,
  type ProtocolStorageRepository,
  type StorageRuntimeStatusService,
  type OwnerAppStorageGrant,
  type MsFileService,
  type MsFileConnectAppContext,
  type MsFileStatResult,
  type MsFileReadResult,
  type StorageListResult,
  type StorageDirectoryResult,
  type StoragePutResult,
  type StorageGetResult,
  type StorageDeleteResult,
  type VaultService
} from "@keymaster/contracts";
import { AppIdentityValidationError, identityDigestBytes, verifyAppIdentityProof } from "./appIdentity.js";
import { ProtocolValidationError, internalExecutionParams, validateExactChannel } from "./protocolValidation.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveSiteKey,
  getCompressedPubHexFromPrivHex,
  sha256Bytes,
  signCompactSecp256k1
} from "./protocolCrypto.js";
import { cborDecode, cborEncode, type CborValue } from "./protocolCbor.js";
import { buildClaimProjectionFromParams, resolveBuiltinClaim, resolveClaims } from "./protocolClaims.js";
import { buildAppBootstrapPayload } from "./applicationLaunch.js";
import { bindWalletIdentity } from "@keymaster/contracts";
import type { FeepoolPendingOpsMap } from "./feepoolOperations.js";
import {
  calcTxidFromRawTxHex,
  feePoolInputOutpoints,
  feePoolInputTxids,
  feePoolOutputFacts,
  type FeePoolTransactionSigner,
  sdkBuildBaseTx,
  sdkBuildInitialDraftSpendTx,
  sdkClientSignInitialSpendTx,
  sdkClientSignUpdatedSpendTx,
  sdkLoadDraftSpendTx,
  sdkVerifyServerInitialSpendSig,
  sdkVerifyServerUpdateSig,
  FINAL_LOCKTIME
} from "./feepoolSdk.js";

/** p2pkh auto-approve 缺省 fee rate。 */
const DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB = 100;

/** 公开资产标识 -> p2pkh 内部 assetId（施工单 2026-09-18 001）。 */
function toInternalP2pkhAssetId(
  assetId: P2pkhTransferAssetId
): "bsv" | "bsvtest" {
  return assetId === "bsv-testnet" ? "bsvtest" : "bsv";
}

/**
 * 费用池 poolKey。
 *
 * 设计缘由（施工单 2026-09-18 001）：mainnet 保持旧 3 段 key 形状，
 * 不迁移历史池；testnet 追加 `::bsv-testnet` 后缀，主网与 testnet 不串池。
 */
function feePoolKeyFor(
  origin: string,
  ownerPublicKeyHex: string,
  counterpartyPublicKeyHex: string,
  assetId: P2pkhTransferAssetId
): string {
  const base = `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`;
  return assetId === "bsv-testnet" ? `${base}::bsv-testnet` : base;
}

/**
 * 确认超时缺省秒数（施工单 003 硬切换：per-origin 确认超时）。
 *
 * 设计缘由：
 *   - 缺省 30 秒是 per-origin 策略的保守默认值；K-V / 缓存 / UI 都按
 *     "空 / 非整数 / <= 0 → 30" 规范化。
 *   - 不引入"关闭 timeout"语义：用户明确要 timeout，0 / 负数 / 空 都
 *     不视为"关闭"，而是回退到缺省 30。
 */
const DEFAULT_CONFIRM_TIMEOUT_SECONDS = 30;

/**
 * 把 K-V 读到的 origin 记录补齐新字段默认值。**纯函数**；不改入参，不读 K-V。
 */
function normalizeOriginSettings(
  rec: ProtocolOriginSettingsRecord | null | undefined,
  origin: string
): ProtocolOriginSettingsRecord {
  return {
    ...rec,
    origin,
    identityAutoApproveEnabled: rec?.identityAutoApproveEnabled ?? false,
    cipherAutoApproveEnabled: rec?.cipherAutoApproveEnabled ?? false,
    confirmTimeoutSeconds:
      rec?.confirmTimeoutSeconds && rec.confirmTimeoutSeconds > 0
        ? rec.confirmTimeoutSeconds
        : DEFAULT_CONFIRM_TIMEOUT_SECONDS,
    updatedAt: rec?.updatedAt ?? 0
  };
}

/** ProtocolService 构造依赖。 */
export interface ProtocolServiceDeps {
  vault: VaultService;
  walletState: VaultWalletState;
  /**
   * 协议存储 K-V（command-history / durable-policy / sessions）。生产 manifest
   * 必须注入；测试可传内存 fake。独立构造时缺失绑定只允许读路径安全降级，
   * 必要写入会抛错。
   */
  storageRepository?: ProtocolStorageRepository;
  /**
   * 可选 P2PKH 业务适配。manifest 从 plugin-p2pkh 暴露的 `p2pkh.service`
   * capability 取值注入；缺时 `p2pkh.transfer` 走 internal_error。
   */
  p2pkhService?: P2pkhProtocolAdapter;
  /** 延迟解析 P2PKH capability；允许 Protocol 先于 owner-apps 装配。 */
  getP2pkhService?: () => P2pkhProtocolAdapter | undefined;
  /** Session Window 使用的已验证 Connect Channel facade。 */
  connectChannelRuntime?: ConnectChannelRuntime;
  /** Optional Storage platform capability; absence only disables storage.*. */
  storageController?: StorageRuntimeStatusService;
  /** Explicit Storage provider; the gateway supplies verified session facts, never a namespace. */
  bindAppStorage?: (binding: AppStorageBinding) => AppStorageClient;
  /** Resolve the current Storage capability at request/lifecycle time. */
  getStorageController?: () => StorageRuntimeStatusService | undefined;
  /**
   * Optional MSFile platform capability（可选 MSFile 平台能力）。
   * 缺失时只让 `msfile.*` fail closed；不得影响其他方法族。
   */
  msfileService?: MsFileService;
  getMsfileService?: () => MsFileService | undefined;
  /** Keymaster 本地 catalog resolver；不得反向依赖 plugin-apps。 */
  appCatalogResolver?: AppCatalogResolver;
  /** 延迟读取 resolver，避免 protocol -> apps capability 初始化循环。 */
  getAppCatalogResolver?: () => AppCatalogResolver | undefined;
  /** 自定义 source window（默认取 `window.opener`）。 */
  resolveOpener?: () => Window | null;
  /** 自定义 ready 发送目标（默认 `target.postMessage(msg, "*")`）。 */
  postReady?: (target: Window, msg: ProtocolReadyMessage) => void;
  /** 自定义 result 发送（默认 `target.postMessage(msg, origin)`）。 */
  postResult?: (target: Window, origin: string, msg: ProtocolResultMessage) => void;
  /**
   * 自定义 closing 发送（默认 `target.postMessage(msg, "*")`）。依赖中暴露
   * 这条通道是为了让 ProtocolPopupPage 在页面卸载路径上复用同一幂等门禁。
   */
  postClosing?: (target: Window, msg: ProtocolClosingMessage) => void;
  /**
   * vault 锁状态变化时由 vault 调用，service 用此同步 lockState。
   * 缺省依赖 vault.status() 同步查询。
   */
  notifyLockChanged?: () => void;
  /**
   * 自定义 ID 生成器。默认用 `crypto.randomUUID()`；测试可注入稳定 id。
   */
  generateId?: () => string;
  /* ============== Session Window（施工单 2026-06-29 001） ============== */
  /**
   * 当前 Session Window 启动模式。`undefined` 时按 `connect` 走。
   * 设计缘由：mode 在启动期由 URL `?boot=appView` 一次性解析；service
   * 不再次解析——避免 URL 被中途篡改。
   */
  bootMode?: "connect" | "appView";
  /** 主钱包接管新 App 的独立 Receiver/运行上下文，不经窗口 bootstrap。 */
  acceptApplicationLaunch?: (payload: AppBootstrapPayload, source: Window) => Promise<void>;
  applicationPermissionChanged?: () => Promise<void>;
  /** Shared main-wallet connection: App logout must not lock the whole wallet. */
  hostedApplication?: boolean;
  applicationLoggedOut?: () => void;
  /** 接收端确认应用身份后通知主钱包宿主；身份信息不从未验证消息直接展示。 */
  applicationIdentified?: (origin: string, identity?: AppIdentitySnapshot) => Promise<void>;
}

/**
 * 内部 request 记录。**唯一真相源**：request store 里每条活记录 + 终态
 * 历史都对应一个 RequestRecord；recordId 与 transport requestId 解耦。
 */
interface RequestRecord {
  /** 协议权威由独立 Receiver 签发，UI/业务记录不能自行重建。 */
  readonly protocol: ReceiverRequest;
  readonly walletGeneration: string;
  readonly runGeneration: string;
  readonly bindingId?: string;
  applicationKey?: string;
  manualApprovedAt?: number;
  paymentPreview?: import("@keymaster/contracts").P2pkhConnectPaymentPreview;
  paymentStatus?: import("@keymaster/contracts").ConnectPaymentStatus;
  paymentApproval?: (approved: boolean) => void;
  networkIdentity: NetworkIdentity;
  /** service 内部稳定主键；与 transport requestId 解耦。 */
  recordId: string;
  /** 顶层 request 报文的 id（transport 关联）。 */
  transportRequestId: string;
  /** 来源 window。 */
  source: Window;
  /** 来源 origin（exact event.origin）。 */
  origin: string;
  method: ProtocolMethod;
  params: MethodParams<ProtocolMethod>;
  /** 当前 phase（request 级状态机）。 */
  phase: ProtocolCommandPhase;
  /** 终态决策；中间态为 "pending"。 */
  decision: "pending" | "approved" | "rejected" | "failed";
  /** 与 `decision` 类似的稳定字符串，给 UI 直接展示用。 */
  status: string;
  /** 当前活跃起点（createdAt / 进入 confirming 的时刻等）。 */
  enteredPhaseAt: number;
  /** 是否被 auto-approve 路径命中（p2pkh / feepool / identity / cipher）。 */
  autoApproved: boolean;
  /**
   * 该 record 所属 connect sessionId（施工单 2026-06-28 002 硬切换）。
   *
   * 关键不变量：所有外部业务方法在 record 创建时立即绑定 sessionId；
   * `connect.login` record 上该字段为空（login 自身负责建 session）。
   * record 生命周期内**不**可漂移；不允许"旧请求漂进新 session"。
   */
  walletPublicKeyHex: string;
  payloadSize?: number;
  /**
   * record 在创建时快照的 owner public key hex（施工单 2026-06-28 002
   * 硬切换：owner 唯一真值）。
   *
   * 业务方法：取自 `connectSession.ownerPublicKeyHex`（由 accept 阶段
   * 预校验 session 真值时同步落到 record）。
   * `connect.login`：用户确认当前唯一钱包后固定为该钱包公钥。
   *
   * 后续写卡**不**再读 walletState.snapshot() / 钱包全局 active key；
   * 旧卡片的 `ownerPublicKeyHex` 字段保持 record 创建时的快照值，不被
   * 污染——即使用户在 popup 会话里切换 active key 也不影响。
   *
   * `ownerKeyId` **不**作为 owner 身份出现在 record / result / 分支
   * 判断里；vault 内部借用句柄按需从 walletState.getKey() 解析。
   */
  ownerPublicKeyHex: string;
  /** 创建时间，unix milliseconds。 */
  createdAt: number;
  /** 最近一次状态更新时间，unix milliseconds。 */
  updatedAt: number;
  /** 终态时间；中间态为 0。 */
  finishedAt: number;
  /** 错误码；终态失败时填写；隐私敏感场景统一 user_rejected。 */
  errorCode: string;
  /** 错误 message；英文。 */
  errorMessage: string;
  /** AbortController owned by the request while provider I/O is running. */
  abortController?: AbortController;
  cancelRequested?: boolean;
  /** 本地终态原因（写本地）；隐私敏感场景与对外解耦。 */
  failureReason?: ProtocolFailureReason;
  /* ============== 施工单 2026-06-28 001：connect.* 字段 ============== */
  /** Read-only presentation of the receiver's only wallet; not a selection list. */
  connectLoginWallet?: { publicKeyHex: string; label: string };
  connectAuthBackend?: "software";

  /** connect.* auth 是否已经提交过；用于阻止未提交 login 被 resume 抢占。 */
  connectAuthSubmittedAt?: number;
  /**
   * `connect.resume` 进入时的 session 快照（ownerPublicKeyHex /
   * ownerLabel / claimsSnapshot）；只在 `method === "connect.resume"`
   * 时有值。confirming 视图直接拿这个做展示，不需要再查 K-V。
   *
   * 关键（施工单 2026-06-28 002 硬切换）：`ownerKeyId` **不**记录在
   * snapshot 里；owner 唯一真值 = `ownerPublicKeyHex`。
   */
  connectResumeSnapshot?: {
    sessionId: string;
    ownerPublicKeyHex: string;
    ownerLabel: string;
    claimsSnapshot: Record<string, import("@keymaster/contracts").ResolvedClaimValue>;
  };
  /**
   * 标记 record 在 unlock 后**不**走 confirming 视图，直接 queued → executing。
   *
   * 设计缘由（施工单 2026-06-28 001 硬切换 4.3 / 5.1.2）：
   *   - connect.resume：unlock 后"只补解锁，自动恢复"，**不**再点确认。
   *   - connect.logout：unlocked 路径"可无额外交互"，locked 路径解锁后
   *     也直接入队，不弹额外 UI。
   *   - cipher.* / connect.resume fail-fast：session 预校验失败、locked
   *     路径解锁后直接 queued，让执行阶段抛 user_rejected。
   */
  autoExecuteAfterUnlock?: boolean;
}

/** request 级状态机：扩展开关掉旧 `waiting_unlock` / `waiting_confirm`，新加 `queued` / `timed_out`。 */
export type ProtocolCommandPhase =
  | "waiting_unlock_manual"
  | "waiting_unlock_auto"
  | "confirming"
  | "queued"
  | "executing"
  | "approved"
  | "rejected"
  | "failed"
  | "timed_out";

/** 单条 confirming request 的 timeout 状态。 */
interface ConfirmTimeoutState {
  /** timeout 截止时间（epoch ms）。 */
  deadlineMs: number;
  /** setInterval handle；每 1s 触发一次 emitFeed 让 UI 倒计时重渲染。 */
  tickHandle: ReturnType<typeof setInterval>;
  /** 起点（epoch ms）；用于 cache-miss clamp 时维持总等待时长稳定。 */
  startedAtMs: number;
  /**
   * 进入 confirming 时是否走了默认 30s 兜底（true）还是同步 cache
   * 命中（false）。决定 `refreshTimeoutFromOriginConfig` 是否允许
   * 异步 clamp down——`true` 才允许 clamp；`false` 永不热更新。
   * （施工单 2026-06-28 002 硬切换 timeout 收口）
   */
  startedFromFallback: boolean;
}


function requireVaultCommandAccepted(result: Awaited<ReturnType<import("@keymaster/contracts").VaultService["unlock"]>>, operation: string): void {
  if (result.status === "accepted" || result.status === "already-unlocked" || (operation === "lock" && result.status === "ok")) return;
  const message = "message" in result
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : `${operation} failed: ${result.status}`;
  throw new Error(message);
}

export class ProtocolServiceImpl implements ProtocolService {
  /** 会话级锁状态（施工单 2026-06-27 001 硬切换）。 */
  private lockStateValue: ProtocolPopupLockState = "locked";
  /** 旧 session phase 兼容字段：在多 request 模型下主要用于 "至少有一条 confirming / queued" 的活跃态呈现；详细见 `snapshot()`。 */
  private phase: ProtocolSessionPhase = "waiting";
  private sessionRevision = 0;
  private listeners = new Set<(snap: ProtocolSessionSnapshot) => void>();
  private feedListeners = new Set<(state: ProtocolCommandFeedState) => void>();

  /**
   * 当前 origin（exact event.origin，**不**归一化）。
   *
   * 与旧"绑定 source 后才能 set currentOrigin"语义不同：现在每条
   * request 独立建记录 + 各自 origin；currentOrigin 表示最近一条
   * request 的 origin，UI 用其展示"当前服务哪个站点"。
   */
  private currentOriginValue: string | null = null;
  /** 当前 origin 下的命令流（最新在前；按 updatedAt desc）。 */
  private feedCommands: ProtocolCommandRecord[] = [];
  /** 命令流 K-V 是否可用。false 时 UI 顶部显示"历史不可用"。 */
  private historyAvailableFlag: boolean;
  /**
   * K-V 加载按 origin 隔离的 in-flight promise map（施工单 2026-06-27 002
   * 反馈修复）。
   *
   * 旧实现用单一全局 `historyLoadInFlight: Promise<void> | null`，复
   * 用条件是"currentOriginValue === origin"——这个条件在 acceptRequest
   * 里已被改成新 origin，结果旧 origin 的 in-flight 会被新 origin 错
   * 误复用。新实现按 origin key 隔离：同 origin 复用 in-flight；不同
   * origin 各自独立，配合 `historyLoadToken` 防旧批次晚到回写。
   */
  private historyLoadInFlightByOrigin: Map<string, Promise<void>> = new Map();
  /**
   * 历史加载当前批次的递增 token；切换 origin / 重新触发时递增。旧 token
   * 晚到的批次结果直接丢弃，**不**回写当前视图。
   */
  private historyLoadToken: number = 0;

  /**
   * request store（施工单 2026-06-27 001 硬切换）。
   *
   * 所有活请求 + 终态历史都在这里。每条 key 是内部 recordId。
   * 值是 RequestRecord（带 phase）。
   *
   * 旧 `binding` / `currentRecordId` / `pendingRequestSnapshot` / `timeoutRecordId`
   * 全部收敛到这里。
   */
  private requestsByRecordId: Map<string, RequestRecord> = new Map();

  /** 已确认待执行的 recordId 队列（FIFO）。 */
  private executionQueue: string[] = [];

  /** 当前正在执行的 recordId；同一时刻最多 1。 */
  private executingRecordId: string | null = null;
  /** Prevent concurrent drain calls from racing before executingRecordId is set. */
  private drainingExecutionQueue = false;

  /** 每条 confirming request 独立的 timeout 状态。 */
  private timersByRecordId: Map<string, ConfirmTimeoutState> = new Map();

  /** feepool pending operations：仅本 popup 会话内存有效，endSession 清空。 */
  private pendingOps: FeepoolPendingOpsMap = new Map();

  /**
   * origin 配置内存 cache（同步 auto-approve 判断用）。
   */
  private originCache: Map<string, ProtocolOriginSettingsRecord> = new Map();

  /** popup 当前会话是否已经向 opener 发过 `closing`。 */
  /** auth 页触发的解锁是否还在进行中；用于抑制全局 unlock 批量推进。 */
  private authUnlockInProgress: string | null = null;

  /* ============== Session Window（施工单 2026-06-29 001） ============== */
  /**
   * 当前 Session Window boot mode。
   *
   * 设计缘由：
   *   - 一次性解析，**不**可变；URL 中的 `?boot=appView` 在 popup 挂载时
   *     解析一次并通过 deps.bootMode 注入；service 不再二次解析 URL。
   *   - 缺省 `connect`。
   */
  private readonly bootModeValue: "connect" | "appView";

  /**
   * 当前 appView 上下文；仅在 appView mode + bootstrap 成功后非空。
   *
   * 设计缘由：
   *   - 用于 UI / 启动决策 / `connect.launch` 的 caller origin 校验。
   */
  private currentAppViewContext: AppViewContext | null = null;

  /**
   * appView 运行期当前绑定的 client app window。
   *
   * 设计缘由：
   *   - connect mode 下 transport 对端 = `window.opener`；
   *   - appView mode 下 launcher 只是 bootstrap 提供方，真正发
   *     `connect.launch` / `identity.*` 的对端是被
   *     Session Window 打开的 child app 窗口；
   *   - 因此 appView **不能**继续把 `window.opener` 当成唯一合法 source。
   *   - 本字段在 appView 下绑定"当前合法 client app source"：
   *       1. 第一次收到合法 child `ready` 时绑定（方向对称；
   *          施工单 2026-06-30 003）；
   *       2. 若 child `ready` 还没到，则第一次收到合法 `connect.launch`
   *          时再绑定（向后兼容：部分 client 可能漏发 `ready` 直接发
   *          `connect.launch`，仍然要让请求能跑）；
   *       3. 绑定后后续 `ready` / request 只接受这一个 source。
   */
  private currentAppClientSource: Window | null = null;
  /**
   * launchToken 内存 Map：token -> LaunchTokenRecord（V1 **不**落盘）。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换）：
   *   - launchToken 只在 Session Window 当前内存有效；Session Window 刷新
   *     / 关闭即失效。
   *   - 不允许通过 platform K-V repository 持久化，避免"刷新后旧 token 仍能消费"。
   */
  private readonly launchTokensByToken: Map<
    string,
    {
      appId: string;
      appOrigin: string;
      appUrl: string;
      networkIdentity: NetworkIdentity;
      walletPublicKeyHex: string;
      ownerPublicKeyHex: string;
      resolvedClaims: Record<string, unknown>;
      resolvedAt: number;
      consumed: boolean;
    }
  > = new Map();

  /**
   * Session Window 当前已注册 owner runtime 内存 Map（施工单 2026-06-30 002
   * 硬切换）：
   * `walletPublicKeyHex -> { runtime: SessionRuntimeBootstrap; createdAt: number }`。
   *
   * 设计缘由：
 *   - 来源 = `bootstrap_runtime`：launcher consume bootstrap 后**只**在
 *     当前窗口内存注册 owner runtime；**不**导入 unlock runtime，
 *     **不**把 vault 切到 unlocked 态。
 *   - 与 `walletPublicKeyHex` 一一对应；业务方法按 `walletPublicKeyHex`
 *     取 runtime。runtime 不存在时仅 connect mode 允许再尝试
 *     `vault_runtime` 来源；从 vault 借 owner 私钥 hex 提供同一份 runtime。
 *   - 两条来源对外行为一致（同一把 owner 同一份私钥 hex）；仅 connect
 *     mode 允许同一 session 在窗口生命周期内从 `bootstrap_runtime`
 *     切到 `vault_runtime`；appView mode 不允许这样回退。
 *   - 刷新 / 关闭 Session Window 后 bootstrap runtime 随窗口内存
 *     丢失；connect mode 下用户在本窗口后续 unlock 可按同 owner 从
 *     vault 重建；appView mode 不允许这样回退。
   */
  private readonly ownerRuntimesBySessionId: Map<
    string,
    { runtime: SessionRuntimeBootstrap; createdAt: number }
  > = new Map();

  /**
   * 当前 transport 对端绑定的 Connect session。Channel 方法不再从 App
   * params 读取 session id；这里是 Session Window 在成功 login/resume/
   * launch 后建立的 transport 上下文真值。
   */
  private readonly channelSessionBySource: Map<
    Window,
    { origin: string; sessionId: string; networkIdentity: NetworkIdentity; ownerPublicKeyHex: string; epoch: number }
  > = new Map();
  /** 每个 Connect session 的虚拟精确频道集合。物理订阅由 Coordinator 统一复用。 */
  private readonly channelSubscriptionsBySessionId: Map<string, string[]> = new Map();
  private channelRuntimeUnsubscribe: (() => void) | undefined;
  private readonly channelQuotaBySessionId: Map<string, { publishes: number[]; bytes: Array<{ at: number; size: number }>; inFlight: number }> = new Map();
  private channelSessionEpoch = 0;
  /** 协议绑定/在途关联只由独立 Receiver 持有；本类只保存业务执行记录。 */
  private readonly receiver: KeymasterConnectReceiver;

  private assertWalletGeneration(rec: RequestRecord): void {
    const lifecycle = this.deps.walletState.snapshot();
    if (!rec.walletGeneration || lifecycle.walletGeneration !== rec.walletGeneration || lifecycle.runGeneration !== rec.runGeneration) {
      throw new ProtocolValidationError("connection_expired", "Wallet connection expired; reconnect explicitly");
    }
  }

  private disposeSessionRuntimeBootstrap(
    runtime: SessionRuntimeBootstrap | undefined,
    reason: string
  ): void {
    if (!runtime) return;
    try {
      runtime.crypto.dispose(reason);
    } catch {
      /* noop */
    }
  }

  /**
   * 按 sessionId 清理当前 appView 注入的 bootstrap runtime。
   *
   * 设计缘由：
   *   - connect.logout / session-reset / window-close 都需要把对应 session
   *     的 owner capability 从当前窗口内存里摘掉；
   *   - 只 lock vault 不够：appView 里 bootstrap_runtime 是独立于 vault
   *     状态的常驻 capability，必须显式释放。
   */
  private clearSessionRuntimeBootstrap(
    sessionId: string,
    reason: "logout" | "session-reset" | "window-close" | "replaced"
  ): void {
    const entry = this.ownerRuntimesBySessionId.get(sessionId);
    if (!entry) return;
    this.disposeSessionRuntimeBootstrap(entry.runtime, reason);
    this.ownerRuntimesBySessionId.delete(sessionId);
  }

  constructor(private readonly deps: ProtocolServiceDeps) {
    this.historyAvailableFlag = Boolean(deps.storageRepository);
    this.bootModeValue = deps.bootMode ?? "connect";
    this.receiver = new KeymasterConnectReceiver({
      peer: () => this.bootModeValue === "appView"
        ? { mode: "appView", origin: this.currentAppViewContext?.appOrigin ?? "", source: this.currentAppClientSource }
        : { mode: "popup", source: this.getOpener() },
      lifecycle: () => { const snapshot = deps.walletState.snapshot(); return { walletGeneration: snapshot.walletGeneration, runGeneration: snapshot.runGeneration }; },
      identity: async () => {
        const key = await deps.vault.getCurrentKey();
        if (!key) throw new Error("Wallet identity is not ready");
        return projectNetworkIdentity(key);
      },
      send: (target, origin, message) => this.postMessage(target as Window, origin, message),
      control: (target, message) => {
        if (message.type === "ready" && deps.postReady) deps.postReady(target as Window, message);
        else if (message.type === "closing" && deps.postClosing) deps.postClosing(target as Window, message);
        else target.postMessage(message, "*");
      },
    });
    // Channel 事件已经在 Coordinator 完成验签、解密和固定协议分派。
    // Session Window 只做当前 session + exact channel 的最后一层隔离。
    if (deps.connectChannelRuntime) {
      this.channelRuntimeUnsubscribe = deps.connectChannelRuntime.subscribe((event) => {
        this.dispatchChannelMessageReceived(event);
      });
    }
  }

  /** Resolve the current Storage capability after an independent plugin restart. */
  private currentStorageController(): StorageRuntimeStatusService | undefined {
    if (this.deps.getStorageController) {
      try {
        return this.deps.getStorageController();
      } catch {
        return undefined;
      }
    }
    return this.deps.storageController;
  }

  /** MSFile capability 是可选依赖；缺失时 `msfile.*` fail closed。 */
  private currentMsfileService(): MsFileService | undefined {
    if (this.deps.getMsfileService) {
      try {
        return this.deps.getMsfileService();
      } catch {
        return undefined;
      }
    }
    return this.deps.msfileService;
  }

  /** P2PKH capability 是 owner-apps-ready 才保证存在的可选依赖。 */
  private currentP2pkhService(): P2pkhProtocolAdapter | undefined {
    if (this.deps.getP2pkhService) {
      try {
        return this.deps.getP2pkhService();
      } catch {
        return undefined;
      }
    }
    return this.deps.p2pkhService;
  }

  /**
   * 在服务已经启动后接入协议存储。
   *
   * purpose-scoped K-V repository 只承载历史、站点配置和 session 持久化。
   * 生产 manifest 在 setup 生命周期内完成绑定；本方法保留给 service 的
   * 独立构造 / 测试场景，并会传播回补写失败。
   */
  async attachProtocolStorageRepository(storageRepository: ProtocolStorageRepository): Promise<void> {
    if (this.deps.storageRepository) return;
    this.deps.storageRepository = storageRepository;
    this.historyAvailableFlag = true;

    // K-V 尚未就绪期间完成的终态记录仍在内存中；接入后补写，避免一次短暂
    // 初始化延迟导致本次会话的历史永久丢失。
    await Promise.all(
      Array.from(this.requestsByRecordId.values())
        .filter((request) => this.isTerminalPhase(request.phase))
        .map((request) => this.persistRecord(this.makeCommandRecord(request)))
    );

    // 当前站点已存在时立即回补历史和站点配置；没有当前站点则只刷新
    // historyAvailable 投影，等第一条请求到达后再按 origin 加载。
    if (this.currentOriginValue) {
      void this.loadHistoryForOrigin(this.currentOriginValue);
    } else {
      this.emitFeed();
    }
  }

  /**
   * 内部稳定 id 生成器。
   */
  private nextRecordId(): string {
    if (this.deps.generateId) {
      return this.deps.generateId();
    }
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ============== 启动 / 关闭 ============== */

  /**
   * 启动会话。挂在 window.message 监听**之后**再调用，确保 ready 不丢。
   *
   * 多 request 模型下不再有"绑定 request"动作；只重置 lockState / 内存
   * 数据结构 / 发 ready。
   *
   * 关键：startSession 必须**完整**重置所有会话级内存数据，包括：
   *   - 清掉所有 setInterval 句柄（不只是 Map.clear()）；
   *   - 清掉 feedCommands / currentOriginValue；
   *   - 清掉历史载入中的 promise（避免与新会话的 origin 串）。
   *
   * 旧实现只调 `timersByRecordId.clear()` 没 clearInterval，旧 setInterval
   * 回调仍会跑；feedCommands / currentOriginValue 也没清，旧命令流 / 旧
   * origin 会残留到新会话里——违反 ProtocolService.startSession 接口契约。
   */
  startSession(): void {
    this.sessionRevision++;
    this.receiver.reset();
    this.releaseAllChannelSessions();
    this.channelSessionBySource.clear();
    this.channelSubscriptionsBySessionId.clear();
    this.channelQuotaBySessionId.clear();
    this.channelSessionEpoch++;
    // 1. 先 clearInterval 所有 timer，避免旧会话的 setInterval 继续跑回调。
    this.timersByRecordId.forEach((t) => clearInterval(t.tickHandle));
    this.timersByRecordId.clear();
    // 2. 清空 request store + 执行队列 + 当前执行。
    this.requestsByRecordId.clear();
    this.executionQueue = [];
    this.executingRecordId = null;
    // 3. 清空 feepool pendingOps（operationId 与旧会话绑定，不允许跨会话复用）。
    this.pendingOps.clear();
    // 4. 重置 origin / 命令流 / 历史载入状态——旧会话的 origin 与命令流
    //    不应泄漏到新会话。
    this.currentOriginValue = null;
    this.feedCommands = [];
    this.historyLoadInFlightByOrigin.clear();
    this.historyLoadToken++;
    // 5. 先回收上一轮 appView owner runtime，再重置会话级 phase / lockState /
    //    closing 标志。lockState 必须读取"清理后的"真值，否则会把上一轮
    //    bootstrap_runtime 的 unlocked 状态带进新会话。
    for (const { runtime } of this.ownerRuntimesBySessionId.values()) {
      this.disposeSessionRuntimeBootstrap(runtime, "session-reset");
    }
    this.ownerRuntimesBySessionId.clear();
    // 6. 重置会话级 phase / lockState / closing 标志。
    this.phase = "waiting";
    this.lockStateValue = this.readVaultLockState();
    // 7. 清空 appView 启动上下文 + launchToken 缓存 + bootstrap 监听：
    //    Session Window 重新启动会话时不允许复用旧 launcher handoff。
    this.currentAppViewContext = null;
    this.currentAppClientSource = null;
    // 施工单 2026-06-30 003：appView UI 两段式。重启会话时 child `ready`
    // 必须重置回 false，否则新会话会在第一次启动时就直接进入 popup 阶段。
    this.launchTokensByToken.clear();
    this.emit();
    this.emitFeed();
    this.postReadyIfPossible();
  }

  /**
   * 关闭当前会话并清理内部状态。
   *
   * 行为（施工单 2026-06-27 001 硬切换）：
   *   - 把所有未终态 request 强制收尾为 rejected（best-effort）。
   *   - 清空所有 timer、execution queue、pendingOps。
   *   - 把 `currentOriginValue` 置回 `null`、`feedCommands` 清空。
   *   - 同时 `emit()` + `emitFeed()`：feed 订阅者必须收到"命令流已
   *     清空 / origin 已清空"的通知，否则 UI 仍展示上一个会话的状态。
   *   - 不发 `closing`（closing 由 pageUnloading 路径负责）。
   */
  endSession(): void {
    this.sessionRevision++;
    this.receiver.clear();
    this.releaseAllChannelSessions();
    this.channelSessionBySource.clear();
    this.channelSubscriptionsBySessionId.clear();
    this.channelQuotaBySessionId.clear();
    this.channelSessionEpoch++;
    const sessionIds = new Set<string>();
    for (const rec of this.requestsByRecordId.values()) {
      if (rec.walletPublicKeyHex) sessionIds.add(rec.walletPublicKeyHex);
      if (
        rec.phase === "executing" &&
        (rec.method.startsWith("storage.") || rec.method.startsWith("msfile."))
      ) {
        rec.cancelRequested = true;
        rec.abortController?.abort();
      }
    }
    const storageController = this.currentStorageController();
    const msfileService = this.currentMsfileService();
    for (const sessionId of sessionIds) {
      void storageController?.abortSession(sessionId);
      void msfileService?.abortSession(sessionId);
      void sessionId;
    }
    // 把所有未终态 request 强制收尾为 rejected（不发 result 给 opener）。
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.phase === "approved" || rec.phase === "rejected" || rec.phase === "failed" || rec.phase === "timed_out") {
        continue;
      }
      rec.paymentApproval?.(false);
      rec.paymentApproval = undefined;
      rec.phase = "rejected";
      rec.decision = "rejected";
      rec.status = "rejected";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
    }
    // 先 clearInterval 再 clear Map，避免旧 setInterval 回调继续跑。
    this.timersByRecordId.forEach((t) => clearInterval(t.tickHandle));
    this.timersByRecordId.clear();
    this.requestsByRecordId.clear();
    this.executionQueue = [];
    this.executingRecordId = null;
    this.pendingOps.clear();
    // 重置 origin + feed + 历史载入状态：旧会话的 origin / 命令流不应
    // 残留到下一轮 startSession 之前的快照读取里。
    this.currentOriginValue = null;
    this.feedCommands = [];
    this.historyLoadInFlightByOrigin.clear();
    this.historyLoadToken++;
    this.authUnlockInProgress = null;
    this.phase = "waiting";
    // 同时推 session 快照 + feed 快照：feed 订阅者拿到空 feed；
    // session 订阅者拿到 phase="waiting" + lockState 不变（vault 状态
    // 与 popup 生命周期解耦，由 syncWalletState 单独管理）。
    this.currentAppViewContext = null;
    this.currentAppClientSource = null;
    // 施工单 2026-06-30 003：endSession 同样要把 child `ready` 等待态
    // 重置；否则下次 startSession 启动新会话时等待态可能跨会话污染。
    this.launchTokensByToken.clear();
    // 施工单 2026-06-30 002 硬切换：endSession 清空 owner runtimes。
    for (const { runtime } of this.ownerRuntimesBySessionId.values()) {
      this.disposeSessionRuntimeBootstrap(runtime, "window-close");
    }
    this.ownerRuntimesBySessionId.clear();
    this.lockStateValue = this.readVaultLockState();
    this.emit();
    this.emitFeed();
  }

  /* ============== 公开只读接口 ============== */

  /** 同步取当前快照。 */
  snapshot(): ProtocolSessionSnapshot {
    return this.snapshotInternal();
  }

  /** 订阅会话状态变化；立即把当前快照喂给 handler。 */
  subscribe(handler: (snap: ProtocolSessionSnapshot) => void): () => void {
    this.listeners.add(handler);
    handler(this.snapshotInternal());
    return () => this.listeners.delete(handler);
  }

  /** 当前 origin（exact event.origin）。未收到第一条 request 时为 null。 */
  currentOrigin(): string | null {
    return this.currentOriginValue;
  }

  /** 同步取当前命令流 feed 状态。 */
  feedSnapshot(): ProtocolCommandFeedState {
    return {
      currentOrigin: this.currentOriginValue,
      commands: this.feedCommands.slice(),
      historyAvailable: this.historyAvailableFlag,
      lockSummary: this.lockSummarySnapshot()
    };
  }

  /** 订阅命令流变化。立即把当前 feed 状态喂给 handler。 */
  subscribeFeed(handler: (state: ProtocolCommandFeedState) => void): () => void {
    this.feedListeners.add(handler);
    handler(this.feedSnapshot());
    return () => this.feedListeners.delete(handler);
  }

  /**
   * 同步取锁屏摘要。从 request store 派生，**不**维护第二份可变状态。
   */
  lockSummarySnapshot(): ProtocolLockSummary | null {
    if (this.lockStateValue !== "locked") return null;
    let waitingUnlockManual = 0;
    let waitingUnlockAuto = 0;
    let queued = 0;
    let executing = 0;
    const methodCounts = new Map<ProtocolMethod, number>();
    for (const [, rec] of this.requestsByRecordId) {
      switch (rec.phase) {
        case "waiting_unlock_manual":
          waitingUnlockManual++;
          methodCounts.set(rec.method, (methodCounts.get(rec.method) ?? 0) + 1);
          break;
        case "waiting_unlock_auto":
          waitingUnlockAuto++;
          methodCounts.set(rec.method, (methodCounts.get(rec.method) ?? 0) + 1);
          break;
        case "queued":
          queued++;
          methodCounts.set(rec.method, (methodCounts.get(rec.method) ?? 0) + 1);
          break;
        case "executing":
          executing++;
          methodCounts.set(rec.method, (methodCounts.get(rec.method) ?? 0) + 1);
          break;
        default:
          break;
      }
    }
    const byMethod = Array.from(methodCounts.entries()).map(([method, count]) => ({ method, count }));
    return {
      pendingTotal: waitingUnlockManual + waitingUnlockAuto + queued + executing,
      waitingUnlockManual,
      waitingUnlockAuto,
      queued,
      executing,
      byMethod
    };
  }

  /**
   * 读 origin 配置。K-V 不可用或该 origin 尚未配置时返回 null。
   */
  async getOriginSettings(origin: string): Promise<ProtocolOriginSettings | null> {
    if (!this.deps.storageRepository) return null;
    try {
      const raw = await this.deps.storageRepository.getOrigin(origin);
      if (raw) {
        const normalized = normalizeOriginSettings(raw, origin);
        this.originCache.set(origin, normalized);
        return { origin: normalized.origin, identityAutoApproveEnabled: normalized.identityAutoApproveEnabled, cipherAutoApproveEnabled: normalized.cipherAutoApproveEnabled, confirmTimeoutSeconds: normalized.confirmTimeoutSeconds, updatedAt: normalized.updatedAt };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 写 origin 配置。K-V 不可用时 throw。写入时同步刷内存 cache。
   */
  async setOriginSettings(record: ProtocolOriginSettings): Promise<void> {
    const allowed = new Set(["origin", "identityAutoApproveEnabled", "cipherAutoApproveEnabled", "confirmTimeoutSeconds", "updatedAt"]);
    if (Object.keys(record).some(key => !allowed.has(key))) throw new TypeError("Unknown origin setting");
    if (!this.deps.storageRepository) {
      throw new Error("Protocol storage K-V is not available");
    }
    const stored = await this.deps.storageRepository.getOrigin(record.origin);
    const next = normalizeOriginSettings({ ...stored, ...record }, record.origin);
    next.updatedAt = Date.now();
    await this.deps.storageRepository.putOrigin(next);
    this.originCache.set(record.origin, next);
  }

  /* ============== 消息处理 ============== */

  /**
   * 处理来自 `window` 的 message 事件。
   *
   * 设计缘由（施工单 2026-06-27 001 硬切换）：
   *   - 不再"已绑定则忽略其它 request"——多 request 并存。
   *   - cancel 按 `source + origin + transportRequestId` 命中具体 request。
   *   - 重复 requestId（按 source + origin + transportRequestId）拒绝：
   *     只要存在未终态记录，后续同 id 直接忽略。
   *   - 新 request 立刻建 record，按 lockState + auto-approve 决定初始 phase。
   */
  async handleMessage(event: MessageEvent): Promise<void> {
    // 施工单 2026-06-30 003 硬切换：appView 模式下先把顶层 `ready` 单独
    // 识别出来——它**不是** request / cancel，是 transport-ready 信号，
    // 由 child app 主动向 Session Window（opener）发，方向对称于传统
    // popup 流的 `Session Window -> client web`。
    if ((event.data as { type?: unknown } | null)?.type === "ready") {
      this.tryAcceptChildReady(event);
      return;
    }
    // 宿主只选择处理分支，控制帧与请求合法性都由 Receiver 判断。
    if ((event.data as { type?: unknown } | null)?.type === "cancel") {
      const parsed = this.receiver.acceptCancel(event);
      if (!parsed) return;
      // 命中：source + origin + transportRequestId 都匹配 + 当前 phase
      // **不**是 executing。
      const rec = this.findRequestByTransportId(event.source as Window | null, event.origin, parsed.id);
      if (!rec) return;
      if (!this.isRequestCancellable(rec)) return;
      // 施工单 2026-06-30 003 硬切换：cancel 与首条 request 同属"合法
      // child 协议消息"——即便 record 是从已 bound source 创建的
      //（childReady 理论上已翻 true），这里仍对齐：防御性同步
      // childReady + 清等待态 / 软超时提示，确保任何路径到达都不
      // 留遗漏。`markChildAliveFromBoundSource` 幂等，已 true 时
      // 不重复 emit。
      await this.finalizeRequestByCancel(rec.recordId, "client_canceled");
      return;
    }

    const revision = this.sessionRevision;
    const context = await this.receiver.accept(event);
    if (!context || revision !== this.sessionRevision) return;
    const method = PROTOCOL_METHODS.find(method => method === context.method);
    if (!method) {
      this.receiver.replyError(context, { code: "invalid_request", message: "Method is not available in this wallet" });
      return;
    }
    if (this.bootModeValue === "appView") this.currentAppClientSource = context.source as Window;
    const parsed = { ...context, method, protocol: context, params: internalExecutionParams(method, context.params, context.networkIdentity) };

    // 来源、绑定、公开范围、wire 参数和重复在途 ID 已由独立 Receiver 校验。
    await this.acceptRequest(event, parsed);
  }

  /**
   * 用户在确认页点击"确认"。把对应 record 从 `confirming` 推进到
   * `queued`，并触发全局串行执行。
   *
   * recordId 缺省时取"当前任意一张 confirming request"（兼容旧 UI）；
   * 新 UI 应始终传 recordId。
   */
  async confirmByUser(recordId?: string, rememberApplicationPermission = false): Promise<void> {
    const rec = this.resolveRecordForConfirm(recordId);
    if (!rec || rec.phase !== "confirming") return;
    try {
      this.assertWalletGeneration(rec);
      this.receiver.assertCurrent(rec.protocol);
    } catch (error) {
      this.clearConfirmTimeout(rec.recordId);
      rec.phase = "failed";
      const failure = toProtocolError(error);
      rec.errorCode = failure.code; rec.errorMessage = failure.message;
      rec.finishedAt = rec.updatedAt = Date.now();
      rec.paymentApproval?.(false); rec.paymentApproval = undefined;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, failure.code, failure.message);
      this.emit(); return;
    }
    if (this.confirmDeadlineMs(rec.recordId) !== null && this.confirmDeadlineMs(rec.recordId)! <= Date.now()) {
      await this.finalizeRequestByTimeout(rec.recordId); return;
    }
    if (rememberApplicationPermission && rec.applicationKey && requiresApplicationApproval(rec.method)) {
      await readApplicationPermissions(this.deps.storageRepository, rec.applicationKey);
      this.assertWalletGeneration(rec);
      if (rec.phase !== "confirming" || rec.cancelRequested) return;
      await setApplicationPermission(this.deps.storageRepository, rec.applicationKey, rec.method, true);
      await this.deps.applicationPermissionChanged?.();
      this.assertWalletGeneration(rec);
      if (rec.phase !== "confirming") return;
      const deadline = this.confirmDeadlineMs(rec.recordId);
      if (deadline !== null && deadline <= Date.now()) { await this.finalizeRequestByTimeout(rec.recordId); return; }
    }
    rec.manualApprovedAt = Date.now();
    if (rec.paymentApproval) {
      const resolve = rec.paymentApproval;
      rec.paymentApproval = undefined;
      this.clearConfirmTimeout(rec.recordId);
      this.setRecordPhase(rec.recordId, "executing");
      resolve(true);
      this.emit(); this.emitFeed();
      return;
    }
    // 清掉 timer；进入 queued。
    this.clearConfirmTimeout(rec.recordId);
    this.setRecordPhase(rec.recordId, "queued");
    rec.enteredPhaseAt = Date.now();
    rec.updatedAt = Date.now();
    this.executionQueue.push(rec.recordId);
    this.emit();
    this.emitFeed();
    await this.drainExecutionQueue();
  }

  /**
   * 用户在确认页或解锁页点击"取消"。
   *
   * recordId 缺省时取"当前任意一张可取消 request"（兼容旧 UI）。
   */
  async rejectByUser(recordId?: string): Promise<void> {
    const rec = this.resolveRecordForCancel(recordId);
    if (!rec) return;
    if (!this.isRequestCancellable(rec)) return;
    await this.finalizeRequestByCancel(rec.recordId, "user_canceled");
  }

  /**
   * 解锁推进（施工单 2026-06-27 001 硬切换）：
   *   - 如果 lockState 还是 locked → 切 unlocked；批量把 `waiting_unlock_*`
   *     推到对应状态。
   *   - 如果已经 unlocked（重入 / 单 record unlock）→ 仅对该 record 推进。
   *
   * recordId 缺省时按 lockState 路径处理。
   *
   * 注意：manual record 进入 `confirming` 时**必须**同时调
   * `refreshTimeoutFromOriginConfig()`（与 `acceptRequest` 路径一致）。
   * 锁屏期间积累的 manual request 解锁时同样需要按 K-V 真值 clamp
   * deadline——否则会固定吃 30 秒默认值，per-origin timeout 配置
   * 不生效。
   */
  async resumeAfterUnlock(recordId?: string): Promise<void> {
    if (this.authUnlockInProgress) {
      return;
    }
    if (this.lockStateValue === "locked") {
      // 整个会话解锁。
      this.lockStateValue = "unlocked";
      this.phase = this.snapshotPhaseFromRequests();
      // 批量推进所有 waiting_unlock_*。
      const manualRecs: RequestRecord[] = [];
      const autoRecs: RequestRecord[] = [];
      for (const [, rec] of this.requestsByRecordId) {
        if (rec.phase === "waiting_unlock_manual") manualRecs.push(rec);
        else if (rec.phase === "waiting_unlock_auto") autoRecs.push(rec);
      }
      // manual 分两类：autoExecuteAfterUnlock=true（connect.* / cipher.* fail-fast）
      // → 直接 queued；否则走 confirming（启动 timeout + 异步 clamp）。
      for (const rec of manualRecs) {
        if (rec.autoExecuteAfterUnlock) {
          this.setRecordPhase(rec.recordId, "queued");
          rec.enteredPhaseAt = Date.now();
          this.executionQueue.push(rec.recordId);
        } else {
          this.setRecordPhase(rec.recordId, "confirming");
          rec.enteredPhaseAt = Date.now();
          // 推进到 confirming 的瞬间决定 timeout 快照：
          // sync cache 命中 → 用 cache 真值（不热更新）；
          // cache miss → 30s 兜底（允许后续 clamp down）。
          const snapshot = this.resolveConfirmTimeoutSnapshot(rec.origin);
          this.startConfirmTimeout(
            rec.recordId,
            snapshot.initialSeconds,
            snapshot.startedFromFallback
          );
          // 同步等待 refresh 落定：cache miss 时 timer 用 30s 兜底启动，
          // refresh 会 clamp 到 K-V 真值；如果 clamp 触发了 finalize，由
          // await 链保证后续 setPhase/emit 不会跟 finalize 收尾冲突。
          await this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
        }
      }
      for (const rec of autoRecs) {
        this.setRecordPhase(rec.recordId, "queued");
        rec.enteredPhaseAt = Date.now();
        this.executionQueue.push(rec.recordId);
      }
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
      return;
    }
    // 已经 unlocked：单个 record 推进（兼容旧 UI 用法）。
    if (!recordId) return;
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.phase === "waiting_unlock_manual") {
      if (rec.autoExecuteAfterUnlock) {
        this.setRecordPhase(rec.recordId, "queued");
        rec.enteredPhaseAt = Date.now();
        this.executionQueue.push(rec.recordId);
      } else {
        this.setRecordPhase(rec.recordId, "confirming");
        rec.enteredPhaseAt = Date.now();
        // 推进到 confirming 的瞬间决定 timeout 快照：
        // sync cache 命中 → 用 cache 真值（不热更新）；
        // cache miss → 30s 兜底（允许后续 clamp down）。
        const snapshot = this.resolveConfirmTimeoutSnapshot(rec.origin);
        this.startConfirmTimeout(
          rec.recordId,
          snapshot.initialSeconds,
          snapshot.startedFromFallback
        );
        await this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
      }
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
    } else if (rec.phase === "waiting_unlock_auto") {
      this.setRecordPhase(rec.recordId, "queued");
      rec.enteredPhaseAt = Date.now();
      this.executionQueue.push(rec.recordId);
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
    }
  }

  /**
   * 页面层 best-effort 触发：用户手工关闭窗口 / 刷新 / 卸载时由
   * ProtocolPopupPage 调用。
   */
  pageUnloading(): void {
    const sessionIds = new Set<string>();
    for (const rec of this.requestsByRecordId.values()) {
      if (rec.walletPublicKeyHex) sessionIds.add(rec.walletPublicKeyHex);
      if (
        rec.phase === "executing" &&
        (rec.method.startsWith("storage.") || rec.method.startsWith("msfile."))
      ) {
        rec.cancelRequested = true;
        rec.abortController?.abort();
      }
    }
    const storageController = this.currentStorageController();
    const msfileService = this.currentMsfileService();
    for (const sessionId of sessionIds) {
      void storageController?.abortSession(sessionId);
      void msfileService?.abortSession(sessionId);
    }
    this.sendClosingBestEffort();
  }

  /** Dispose subscriptions as well as runtime authority; only used when the host drops this instance. */
  dispose(): void {
    this.endSession();
    this.channelRuntimeUnsubscribe?.();
    this.channelRuntimeUnsubscribe = undefined;
  }

  /**
   * 当前已绑定 request 的拷贝。
   *
   * 兼容旧 UI：在多 request 模型下，返回首张非终态记录的 transport id。
   * 新代码不应再依赖此接口；直接读 `feedSnapshot().commands`。
   */
  currentRequest(): { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null {
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.phase !== "approved" && rec.phase !== "rejected" && rec.phase !== "failed" && rec.phase !== "timed_out") {
        return { id: rec.transportRequestId, method: rec.method, params: rec.params };
      }
    }
    return null;
  }

  /** 当前已绑定 request 是否走了 auto-approve。 */
  currentRequestAutoApproved(): boolean {
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.phase !== "approved" && rec.phase !== "rejected" && rec.phase !== "failed" && rec.phase !== "timed_out") {
        return rec.autoApproved;
      }
    }
    return false;
  }

  /**
   * 同步取会话级锁状态。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换 4.5）：
   *   - 真值从"本地 vault 是否解锁"收口为"当前 Session Window 是否拥有
   *     可执行 owner runtime"。
   *   - 任一来源就绪即 unlocked：
   *       * `bootstrap_runtime`（appView mode 下 `applyLauncherBootstrap`
   *         注册到 `ownerRuntimesBySessionId`）；
   *       * `vault_runtime`（本窗口用户后续解锁，vault.status() 返回
   *         `"unlocked"`）。
   *   - 两者皆不可用才是 locked。
   *   - UI 据此决定渲染锁屏页还是主 popup；accept 阶段据此决定 request
   *     推进到 `confirming` / `queued` 还是 `waiting_unlock_*`。
   */
  lockState(): ProtocolPopupLockState {
    return this.lockStateValue;
  }

  /**
   * 当前 connect auth owner 的只读快照。
   *
   * 优先级固定为：有效 resume > 未提交 login > null。
   */
  connectAuthSnapshot(): ProtocolConnectAuthSnapshot | null {
    return this.resolveConnectAuthSnapshot();
  }

  /**
   * 当前正在计时的截止时间（epoch ms；null = 没在计时）。
   *
   * recordId 缺省时返回任意一张 confirming 的 deadline（兼容旧 UI）。
   * 新 UI 应**始终**传 recordId。
   */
  confirmDeadlineMs(recordId?: string): number | null {
    if (recordId) {
      const t = this.timersByRecordId.get(recordId);
      return t ? t.deadlineMs : null;
    }
    for (const [, t] of this.timersByRecordId) {
      return t.deadlineMs;
    }
    return null;
  }

  /* ============== 施工单 2026-06-28 001：connect.* UI 接口 ============== */

  /**
   * 同步读取当前 connect login 视图信息。
   *
   * 行为：
   *   - 优先按 recordId 取；缺省时按 createdAt asc 取首张 method
   *     === "connect.login" 且 phase 处于 `waiting_unlock_manual` /
   *     `confirming` 的 record；
   *   - 返回当前 ready key 候选列表；popup 用此渲染"选 key + 确认"视图。
   *   - 候选列表为空时返回 null candidates 数组（**不**返回 null 整体）：
   *     UI 据此展示"无可用 key，请先创建或导入"的兜底文案。
   */
  connectLoginRecord(recordId?: string): {
    recordId: string;
    method: "connect.login";
    wallet?: { publicKeyHex: string; label: string };
  } | null {
    const rec = this.pickConnectRecord("connect.login", recordId);
    if (!rec) return null;
    return {
      recordId: rec.recordId,
      method: "connect.login",
      wallet: rec.connectLoginWallet
    };
  }

  /**
   * 同步读取当前 connect resume 视图信息。
   *
   * 行为：
   *   - 优先按 recordId 取；缺省时按 createdAt asc 取首张 method
   *     === "connect.resume" 且 phase 处于 `waiting_unlock_manual` /
   *     `confirming` 的 record；
   *   - 返回 owner 快照（ownerPublicKeyHex / ownerLabel）；UI 据此渲染
   *     "恢复会话"视图。
   *   - snapshot 缺失（K-V 不可用 / session 失效）时返回 null：UI 据此
   *     展示"该会话已失效，请重新登录"并禁用"恢复"按钮（仍可"取消"）。
   */
  connectResumeRecord(recordId?: string): {
    recordId: string;
    method: "connect.resume";
    ownerPublicKeyHex: string;
    ownerLabel: string;
  } | null {
    const rec = this.pickConnectRecord("connect.resume", recordId);
    if (!rec) return null;
    if (!rec.connectResumeSnapshot) return null;
    return {
      recordId: rec.recordId,
      method: "connect.resume",
      ownerPublicKeyHex: rec.connectResumeSnapshot.ownerPublicKeyHex,
      ownerLabel: rec.connectResumeSnapshot.ownerLabel
    };
  }

  /**
   * UI 确认当前唯一钱包后调用；认证并校验世代后推进串行执行。
   *
   * 行为：
   *   - 校验 recordId 存在 + method === "connect.login" + 当前 phase
   *     处于 `waiting_unlock_manual` 或 `confirming`；
   *   - 钱包公钥取自接收端固定的当前钱包，不接受 UI 选择；
   *   - 清 timer（与 confirmByUser 同语义）；
   *   - 固定 rec.ownerPublicKeyHex；切到 queued；入执行队列；
   *     drainExecutionQueue 异步触发。
   *
   * 失败语义：
   *   - 上述校验失败时**不**抛错（best-effort；UI 可以在调用前先
   *     `connectLoginRecord()` 检查）；任何路径出错时保持 best-effort，不阻塞
   *     其它请求。
   */
  async confirmConnectLogin(recordId: string, password: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.method !== "connect.login") return;
    if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") return;
    if (rec.connectAuthSubmittedAt) return;
    this.assertWalletGeneration(rec);
    const ownerPublicKeyHex = rec.connectLoginWallet?.publicKeyHex;
    if (!ownerPublicKeyHex || ownerPublicKeyHex.toLowerCase() !== rec.networkIdentity.publicKeyHex) return;
    if (this.lockStateValue === "locked") {
      this.authUnlockInProgress = recordId;
      rec.connectAuthSubmittedAt = Date.now();
      try {
        requireVaultCommandAccepted(await this.deps.vault.unlock(password), "unlock");
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        this.authUnlockInProgress = null;
        throw err;
      } finally {
        this.authUnlockInProgress = null;
      }
    } else {
      rec.connectAuthSubmittedAt = Date.now();
      try {
        await authenticateAppWallet(this.deps.vault, ownerPublicKeyHex, password, this.deps.walletState);
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        throw err;
      }
    }
    // 认证 RPC 在等待期间允许取消；旧结果不能重新把已拒绝请求排入执行队列。
    if (rec.cancelRequested || (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming")) return;
    this.assertWalletGeneration(rec);
    // 关键（施工单 2026-06-28 002 硬切换）：login record 在用户点确认时
    // 立即把 ownerPublicKeyHex 落到 rec；executeConnectLogin 之后建的
    // session record 与该 ownerPublicKeyHex 一致。
    rec.ownerPublicKeyHex = ownerPublicKeyHex;
    rec.manualApprovedAt = Date.now();
    this.clearConfirmTimeout(recordId);
    this.setRecordPhase(recordId, "queued");
    rec.enteredPhaseAt = Date.now();
    this.executionQueue.push(recordId);
    this.emit();
    this.emitFeed();
    await this.drainExecutionQueue();
  }

  /**
   * UI 点"恢复"后调用：把 connect.resume record 推进到 queued。
   *
   * 行为：
   *   - 校验 recordId 存在 + method === "connect.resume" + 当前 phase
   *     处于 `waiting_unlock_manual` 或 `confirming`；
   *   - snapshot 缺失（K-V 不可用 / session 失效）时不推进，UI 应当展示
   *     "该会话已失效，请重新登录"。
   */
  async confirmConnectResume(recordId: string, password: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.method !== "connect.resume") return;
    if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") return;
    if (rec.connectAuthSubmittedAt) return;
    if (!rec.connectResumeSnapshot) {
      return;
    }
    if (this.lockStateValue === "locked") {
      this.authUnlockInProgress = recordId;
      rec.connectAuthSubmittedAt = Date.now();
      try {
        requireVaultCommandAccepted(await this.deps.vault.unlock(password), "unlock");
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        this.authUnlockInProgress = null;
        throw err;
      } finally {
        this.authUnlockInProgress = null;
      }
    } else {
      rec.connectAuthSubmittedAt = Date.now();
      try {
        await authenticateAppWallet(this.deps.vault, rec.connectResumeSnapshot.ownerPublicKeyHex, password, this.deps.walletState);
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        throw err;
      }
    }
    if (rec.cancelRequested || (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming")) return;
    this.clearConfirmTimeout(recordId);
    this.setRecordPhase(recordId, "queued");
    rec.enteredPhaseAt = Date.now();
    this.executionQueue.push(recordId);
    this.emit();
    this.emitFeed();
    await this.drainExecutionQueue();
  }

  /**
   * 用户在 connect 视图点"取消"。
   *
   * 行为：
   *   - 校验 recordId 存在 + 当前 phase 处于可取消状态
   *     （waiting_unlock_* / confirming / queued）；
   *   - 走与 `rejectByUser` 同语义路径：写 failureReason="user_canceled"，
   *     对外回 `user_rejected`。
   */
  async rejectConnectRequest(recordId: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (!this.isRequestCancellable(rec)) return;
    await this.finalizeRequestByCancel(recordId, "user_canceled");
  }

  /** 主钱包的受信装配入口，不对外部 App 暴露，也不再进行跨钱包窗口的 bootstrap 交接。 */
  async acceptLaunchedApplication(payload: AppBootstrapPayload, source: Window): Promise<void> {
    await this.applyApplicationLaunch(payload);
    this.currentAppClientSource = source;
  }

  /* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

  /** 目录启动只信任本地已验证 proof；运行上下文由主钱包接管，直接导航外部 App。 */
  private resolveAppCatalog(
    origin: string,
    supplied?: AppIdentityProofV1,
    appId?: string
  ): { proof?: AppIdentityProofV1; snapshot?: AppIdentitySnapshot } {
    const resolver = this.deps.getAppCatalogResolver?.() ?? this.deps.appCatalogResolver;
    const resolution: AppCatalogResolution = resolver?.resolve(origin) ?? {
      kind: "known-invalid",
      reason: "local catalog resolver unavailable"
    };
    if (resolution.kind === "known-invalid") {
      throw new LaunchAppViewError(
        "invalid_app_config",
        `launchAppView: catalog app identity invalid (${resolution.reason})`
      );
    }
    if (resolution.kind === "unknown") {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: origin is not registered in local catalog"
      );
    }
    if (resolution.appId !== undefined && resolution.appId !== appId) {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: app id does not match local catalog"
      );
    }
    let proof: AppIdentityProofV1 | undefined;
    if (resolution.proof) {
      try { verifyAppIdentityProof(resolution.proof); proof = resolution.proof; }
      catch { throw new LaunchAppViewError("invalid_app_config", "launchAppView: invalid local app identity proof"); }
    }
    if (supplied && !proof) {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: caller app identity cannot upgrade an app without local proof"
      );
    }
    if (proof && supplied) {
      try { verifyAppIdentityProof(supplied); } catch { throw new LaunchAppViewError("invalid_app_config", "launchAppView: invalid caller app identity proof"); }
      const expectedDigest = identityDigestBytes(proof);
      const suppliedDigest = identityDigestBytes(supplied);
      if (expectedDigest.some((byte, index) => byte !== suppliedDigest[index])) {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: caller app identity does not match local catalog"
      );
      }
    }
    if (!proof) return {};
    const snapshot = verifyAppIdentityProof(proof);
    return { proof, snapshot };
  }

  /** requirements 是启动前置条件，不是 capability permission。 */
  private assertAppRequirements(proof: AppIdentityProofV1 | undefined, keyReady: boolean): void {
    if (!proof) return;
    if (proof.requirements.includes("private-key") && !keyReady) {
      throw new LaunchAppViewError(
        "no_active_key",
        "launchAppView: private key requirement is not ready"
      );
    }
    if (proof.requirements.includes("storage")) {
      const storage = this.deps.getStorageController?.() ?? this.deps.storageController;
      if (!storage || storage.status() !== "ready") {
        throw new LaunchAppViewError(
          "requirement_unavailable",
          "launchAppView: storage requirement is not ready"
        );
      }
    }
  }

  private assertLoginRequirements(proof: AppIdentityProofV1, keyReady: boolean): void {
    if (proof.requirements.includes("private-key") && !keyReady) {
      throw localFailure(
        "internal_error",
        "connect.login: private key requirement is not ready"
      );
    }
    if (proof.requirements.includes("storage")) {
      const storage = this.deps.getStorageController?.() ?? this.deps.storageController;
      if (!storage || storage.status() !== "ready") {
        throw protocolError(
          "storage_unavailable",
          "connect.login: storage requirement is not ready"
        );
      }
    }
  }

  async launchAppView(input: LaunchAppViewInput): Promise<LaunchAppViewResult> {
    // 1) 校验入参基本完整性。
    if (
      !input ||
      !input.appId ||
      !input.appOrigin ||
      !input.appUrl ||
      typeof input.password !== "string" ||
      !input.password
    ) {
      throw new Error("launchAppView: missing app fields");
    }
    // 2) 校验 vault 已解锁。
    if (this.deps.vault.status() !== "unlocked") {
      throw new LaunchAppViewError("vault_locked", "launchAppView: vault not unlocked");
    }
    if ("publicKeyHex" in input || "ownerPublicKeyHex" in input || "network" in input) throw new TypeError("App launches do not accept wallet selectors");
    // Capture the sole authority before any asynchronous work. Never rebind an old launch.
    let wallet: ReturnType<typeof bindWalletIdentity>;
    try { wallet = bindWalletIdentity(this.deps.walletState); }
    catch { throw new LaunchAppViewError("no_active_key", "launchAppView: wallet identity unavailable"); }
    const key = wallet.identity;
    // 3) 校验 app 配置合法：appOrigin 是合法 origin，且 new URL(appUrl).origin === appOrigin。
    let parsedAppUrl: URL;
    try {
      parsedAppUrl = new URL(input.appUrl);
    } catch {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: invalid appUrl"
      );
    }
    if (parsedAppUrl.origin !== input.appOrigin) {
      throw new LaunchAppViewError(
        "invalid_app_config",
        "launchAppView: appOrigin does not match appUrl.origin"
      );
    }
    const catalog = this.resolveAppCatalog(input.appOrigin, input.appIdentity, input.appId);
    // Catalog/storage/identity checks are synchronous and precede the gesture popup.
    this.assertAppRequirements(catalog.proof, true);
    if (typeof window === "undefined") {
      throw new LaunchAppViewError(
        "window_unavailable",
        "launchAppView: window undefined"
      );
    }
    if (!this.deps.storageRepository) {
      throw new LaunchAppViewError(
        "session_storage_unavailable",
        "launchAppView: session storage unavailable"
      );
    }
    // 4) 必须在用户点击的同步调用栈中预开窗口。iOS Safari 会在任意
    //    async 边界后清掉 user activation；等密码派生、会话落库完成后才
    //    调 window.open 会被当作脚本弹窗拦截。先开 about:blank，待
    //    bootstrap 就绪后再导航，opener 关系仍可保持不变。
    let popup: Window | null = null;
    try {
      popup = window.open("about:blank", "_blank");
    } catch (err) {
      throw new LaunchAppViewError(
        "open_session_window_failed",
        "launchAppView: window.open popup failed"
      );
    }
    if (!popup) {
      throw new LaunchAppViewError(
        "open_session_window_blocked",
        "launchAppView: window.open returned null"
      );
    }

    let sessionWindowNavigated = false;
    let stagedAppViewSessionId: string | undefined;
    try {
    wallet.assertActive();
    // 6) 解析 claims 快照（与 connect.login 同语义）。
    const resolvedClaims = resolveClaims(input.claims ?? [], (name) =>
      resolveBuiltinClaim(name, { activeKeyLabel: key.label })
    );
    // 7) 创建新 connect session：原子落库 + 吊销同 origin 旧 session。
    //    施工单 2026-06-30 002 硬切换：session 真值收口为三元组
    //    （sessionId + origin + ownerPublicKeyHex），不再写
    //    `runtimeBinding`——执行路径不允许靠"当前 bootMode"临时猜测，
    //    必须读 session 真值。runtime 来源由 `resolveOwnerRuntime`
    //    在每次执行时按当前窗口状态决定。
    const now = Date.now();
    const sessionId = await this.connectBindingKey(key, input.appOrigin);
    wallet.assertActive();
    const sessionRecord: ConnectSessionRecord = {
      sessionId,
      origin: input.appOrigin,
      networkIdentity: projectNetworkIdentity(key),
      ownerPublicKeyHex: key.publicKeyHex,
      ownerLabel: key.label,
      claimsSnapshot: resolvedClaims,
      ...(catalog.snapshot ? { appIdentity: catalog.snapshot } : {}),
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    };
    // 8) 先认证并获得专属 capability，再落库；失败不能吊销仍有效的旧 App 会话。
    let sessionRuntimeBootstrap: SessionRuntimeBootstrap;
    try {
      const crypto = await this.deps.vault.createAppViewSession({
        sessionId,
        password: input.password
      });
      stagedAppViewSessionId = sessionId;
      try { wallet.assertActive(); } catch (error) { crypto.dispose("launch-authority-revoked"); throw error; }
      const identity = crypto.getIdentity();
      sessionRuntimeBootstrap = {
        networkIdentity: projectNetworkIdentity(identity),
        ownerPublicKeyHex: identity.publicKeyHex,
        ownerLabel: key.label,
        capabilities: [...key.capabilities],
        createdAt: now,
        crypto
      };
    } catch (err) {
      throw new LaunchAppViewError(
        "export_owner_runtime_failed",
        "launchAppView: failed to export owner runtime bootstrap"
      );
    }
    try {
      await this.deps.storageRepository.putConnectSessionAndRevokeOriginPeers(sessionRecord);
    } catch (err) {
      throw new LaunchAppViewError("session_storage_unavailable", "launchAppView: session storage unavailable");
    }
    // 存储等待期间断线/锁定，旧 capability 也不能用来导航或建立可执行会话。
    sessionRuntimeBootstrap.crypto.getIdentity();
    wallet.assertActive();
    // 9) 生成新 launchToken。
    const launchToken = this.deps.generateId
      ? `launch-${this.deps.generateId()}`
      : `launch-${crypto.randomUUID()}`;
    // 10) 拼 client app URL：把 launchToken 拼到 appUrl 的 query 上。
    const appUrlWithLaunchToken = (() => {
      try {
        const u = new URL(input.appUrl);
        u.searchParams.set("launchToken", launchToken);
        return u.toString();
      } catch {
        return input.appUrl;
      }
    })();
    // 11) 组装 AppBootstrapPayload（含 `sessionRuntimeBootstrap`，不含 `runtimeBinding`）。
    const bootstrap = buildAppBootstrapPayload({
      appId: input.appId,
      appOrigin: input.appOrigin,
      appUrl: appUrlWithLaunchToken,
      walletPublicKeyHex: key.publicKeyHex,
      networkIdentity: projectNetworkIdentity(key),
      ownerPublicKeyHex: key.publicKeyHex,
      resolvedClaims: resolvedClaims as Record<string, unknown>,
      resolvedAt: now,
      ...(catalog.snapshot ? { appIdentity: catalog.snapshot } : {}),
      launchToken,
      expiresAt: now + 24 * 60 * 60 * 1000,
      sessionRuntimeBootstrap
    });
    // 主钱包内接管应用；外部窗口只收到一次性 launchToken 和钱包 origin。
    if (!this.deps.acceptApplicationLaunch) throw new Error("Application connection host unavailable");
    await this.deps.acceptApplicationLaunch(bootstrap, popup);
    wallet.assertActive();
    const clientUrl = new URL(appUrlWithLaunchToken);
    clientUrl.searchParams.set("sessionWindowOrigin", window.location.origin);
    if (popup.closed) throw new Error("App window was closed during launch");
    popup.location.replace(clientUrl.toString());
    sessionWindowNavigated = true;
    return {
      appWindowOpened: true,
      networkIdentity: projectNetworkIdentity(key),
      walletPublicKeyHex: key.publicKeyHex,
      launchToken,
      appUrl: clientUrl.toString()
    };
    } finally {
      if (!sessionWindowNavigated) {
        if (stagedAppViewSessionId) this.deps.vault.disposeAppViewSession(stagedAppViewSessionId, "AppView launch did not complete");
        try {
          popup.close();
        } catch {
          // The browser may already have closed the reserved window.
        }
      }
    }
  }

  /** 同一钱包内接收受控 App 句柄，保留原身份与运行代际，不导入整套 unlock runtime。 */
  private async applyApplicationLaunch(payload: AppBootstrapPayload): Promise<void> {
    const runtime = payload.sessionRuntimeBootstrap;
    // DTO 来自同一受信钱包宿主；仅保留实际句柄是否仍有效的运行态判断。
    runtime.crypto.getIdentity();
    // 2) 写入 appViewContext + launchToken 缓存 + owner runtime。
    //    注意 Session Window **不**调 `vault.importUnlockRuntime*`——
    //    那是 unlock runtime 模型下的旧接口，本单已删除。appView mode
    //    下 vault 仍可能处于 `locked` 态；业务方法是否可执行只看
    //    `OwnerExecutionRuntime` 当前能否解析到（connect mode 下的
    //    `bootstrap_runtime` 或 `vault_runtime`；appView mode 只认
    //    bootstrap runtime）——**不**再依"是否 locked"。
    const claimsSnapshot = payload.resolvedClaims as AppViewContext["resolvedClaims"];
    this.currentAppViewContext = {
      appId: payload.app.appId,
      appOrigin: payload.app.appOrigin,
      appUrl: payload.app.appUrl,
      walletPublicKeyHex: payload.walletPublicKeyHex,
      ownerPublicKeyHex: payload.ownerPublicKeyHex,
      resolvedClaims: claimsSnapshot,
      resolvedAt: payload.resolvedAt,
      ...(payload.appIdentity ? { appIdentity: payload.appIdentity } : {})
    };
    this.launchTokensByToken.set(payload.launchToken, {
      appId: payload.app.appId,
      appOrigin: payload.app.appOrigin,
      appUrl: payload.app.appUrl,
      networkIdentity: payload.networkIdentity,
      walletPublicKeyHex: payload.walletPublicKeyHex,
      ownerPublicKeyHex: payload.ownerPublicKeyHex,
      resolvedClaims: claimsSnapshot,
      resolvedAt: payload.resolvedAt,
      consumed: false
    });
    const previousRuntime = this.ownerRuntimesBySessionId.get(payload.walletPublicKeyHex)?.runtime;
    if (previousRuntime) {
      this.disposeSessionRuntimeBootstrap(previousRuntime, "replaced");
    }
    this.ownerRuntimesBySessionId.set(payload.walletPublicKeyHex, {
      runtime,
      createdAt: Date.now()
    });
    // 3) 状态写入完成。bootstrap consume 已成功：不再做超时 / listener
    //    收尾（direct consume 模型没有 listener）。
    //
    // 施工单 2026-06-30 003 硬切换 4.5：appView bootstrap 成功并建立
    // 可执行 owner runtime 后，Session Window 应视为 unlocked。即使
    // 本地 vault 仍是 locked，bootstrap_runtime 来源已足够跑业务方法。
    // 这里同步已提交的权威执行状态，让
    // `computeLockState()` 重新计算；如果之前因 vault locked 已经有
    // `waiting_unlock_*` record，这里会顺便批量推进到 confirming /
    // queued。如果 lockState 已是 unlocked，syncWalletState 内部
    // 早返回，不重复触发收口。
    this.syncWalletState();
    this.emit();
    // 注：**不**向 launcher 发 ack。用户已确认"session window 不需要
    // 和 launcher 做任何沟通"；launcher 自己决定何时关窗（信任开窗即
    // 成功，或信任用户在 UI 上重试）。launcher 端 `acquire` 命中后会从
    // registry 删除 entry，token 一次性消费。
  }

  /**
   * 从私钥 hex（32 字节十六进制）推出压缩公钥 hex（33 字节）。
   *
   * 设计缘由（施工单 2026-06-29 003）：`applyLauncherBootstrap` 用
   * 此方法校验 launcher 交过来的 capability identity 真的对应
   * `ownerPublicKeyHex`；不一致 → fail-closed。
   */
  private async deriveCompressedPubHexFromPrivHex(privHex: string): Promise<string> {
    if (privHex.length !== 64) {
      throw new Error("priv hex must be 32 bytes");
    }
    return getCompressedPubHexFromPrivHex(privHex.toLowerCase());
  }

  /**
   * 计算当前 auth owner 快照。
   *
   * 规则：
   *   - resume 有效时优先于 login；
   *   - login 只在未被 resume 取代时显示；
   *   - 两者都没有时返回 null。
   */
  private resolveConnectAuthSnapshot(): ProtocolConnectAuthSnapshot | null {
    const origin = this.currentOriginValue ?? undefined;
    const resume = this.pickConnectRecord("connect.resume", undefined, origin);
    if (resume && resume.connectResumeSnapshot) {
      return {
        ownerType: "resume",
        recordId: resume.recordId,
        canSubmit: !resume.connectAuthSubmittedAt,
        submitted: Boolean(resume.connectAuthSubmittedAt),
        backend: resume.connectAuthBackend ?? "software",
        login: null,
        resume: {
          recordId: resume.recordId,
          ownerPublicKeyHex: resume.connectResumeSnapshot.ownerPublicKeyHex,
          ownerLabel: resume.connectResumeSnapshot.ownerLabel
        }
      };
    }
    const login = this.pickConnectRecord("connect.login", undefined, origin);
    if (login) {
      return {
        ownerType: "login",
        recordId: login.recordId,
        canSubmit: !login.connectAuthSubmittedAt && Boolean(login.connectLoginWallet),
        submitted: Boolean(login.connectAuthSubmittedAt),
        backend: login.connectAuthBackend ?? "software",
        login: {
          recordId: login.recordId,
          wallet: login.connectLoginWallet
        },
        resume: null
      };
    }
    return null;
  }

  /**
   * 按 method + recordId 选取"等待用户处理"的 connect record。
   *
   * - `recordId` 优先；存在但 method 不符 / phase 不符时返回 null。
   * - 缺省时按 createdAt asc 取首张 method 匹配 + phase ∈ {waiting_unlock_manual,
   *   confirming} 的 record。
   */
  private pickConnectRecord(
    method: "connect.login" | "connect.resume",
    recordId?: string,
    origin?: string
  ): RequestRecord | null {
    if (recordId) {
      const rec = this.requestsByRecordId.get(recordId);
      if (!rec) return null;
      if (rec.method !== method) return null;
      if (origin && rec.origin !== origin) return null;
      if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") return null;
      return rec;
    }
    let pick: RequestRecord | null = null;
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.method !== method) continue;
      if (origin && rec.origin !== origin) continue;
      if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") continue;
      if (!pick || rec.createdAt < pick.createdAt) pick = rec;
    }
    return pick;
  }

  /* ============== 内部 ============== */

  private snapshotInternal(): ProtocolSessionSnapshot {
    const rec = this.firstAliveRequest();
    return {
      phase: this.snapshotPhaseFromRequests(),
      boundSource: rec?.source ?? null,
      boundOrigin: rec?.origin ?? null,
      method: rec?.method ?? null,
      requestId: rec?.transportRequestId ?? null,
      lockState: this.lockStateValue
    };
  }

  private setPhase(phase: ProtocolSessionPhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshotInternal();
    for (const l of this.listeners) l(snap);
  }

  private emitFeed(): void {
    const state = this.feedSnapshot();
    for (const l of this.feedListeners) l(state);
  }

  private postReadyIfPossible(): void {
    const opener = this.getOpener();
    if (!opener) {
      this.setPhase("error");
      return;
    }
    this.postReadyToTarget(opener);
  }

  /** ready 只表示已登记的外部窗口可通信，不再承担独立页面切段。 */
  private tryAcceptChildReady(event: MessageEvent): void {
    if (this.receiver.acceptReady(event)) this.currentAppClientSource = event.source as Window;
  }

  /** 向已登记的真实外部窗口发送传输就绪通知；不授予业务权限。 */
  private postReadyToTarget(target: Window): void {
    this.receiver.sendReady(target);
  }

  /**
   * 当前 Session Window 拥有的"可执行 owner runtime"真值
   * （施工单 2026-06-30 003 硬切换 4.5）。
   *
   * 设计缘由：
   *   - `lockStateValue` 公开语义从"本地 vault 是否已解锁"正式收口为
   *     "当前 Session Window 是否已经拥有可执行 owner runtime"。
   *   - 可执行 owner runtime 的两种来源：
   *       1. `bootstrap_runtime`：launcher 一次性注入的 owner runtime
   *          材料，appView mode 下 `applyLauncherBootstrap` 注册到
   *          `ownerRuntimesBySessionId` 后即对当前窗口持续有效。
 *       2. `vault_runtime`：仅 connect mode 下，本窗口用户后续解锁 +
 *          walletState 中 owner key 可读时由 `resolveOwnerRuntime` 切换到
 *          vault_runtime 来源。
 *   - connect mode 下任一来源可用 → `unlocked`；二者皆不可用 → `locked`。
 *   - appView mode 只认 bootstrap runtime，bootstrap 缺失必须 fail-closed。
   *   - 任一来源可用 → `unlocked`；两者皆不可用 → `locked`。
   *   - 这条真值收口让 appView popup 阶段不再"UI 看似 unlocked，但 accept
   *     阶段仍按 locked 推 waiting_unlock_*"——accept / UI 收口逻辑全部
   *     统一读这一份真值。
   */
  private hasExecutableOwnerRuntime(): boolean {
    // 优先 bootstrap_runtime：哪怕 vault 后续被 relock，runtime 仍有效。
    if (this.ownerRuntimesBySessionId.size > 0) return true;
    // appView 没有 bootstrap_runtime 时必须 fail-closed——即使本地 vault
    // unlocked 也不能返回 true，否则 UI 会显示 unlocked 但 execute 阶段
    // resolveOwnerRuntime() 仍按 locked 处理，造成 UI/执行状态不一致。
    if (this.bootModeValue === "appView") return false;
    // connect mode 下，靠 vault 解锁。
    return this.deps.vault.status() === "unlocked";
  }

  /**
   * 按当前 Session Window 状态计算 `lockStateValue`（施工单 2026-06-30 003）。
   *
   * 不读 `this.lockStateValue` 旧值；只读两类真值源。这样所有"谁能执行"
   * 的判定都走同一个出口，避免再出现"旧值没刷新导致 accept / UI 错位"。
   */
  private computeLockState(): ProtocolPopupLockState {
    return this.hasExecutableOwnerRuntime() ? "unlocked" : "locked";
  }

  private readVaultLockState(): ProtocolPopupLockState {
    // 施工单 2026-06-30 003：startSession 时清空 ownerRuntimesBySessionId，
    // 此时 hasExecutableOwnerRuntime 完全由 vault 状态决定——行为与旧语义一致。
    return this.computeLockState();
  }

  /**
   * 接收一条新 request：建 record，决定初始 phase。
   *
   * 初始 phase 决策（施工单 2026-06-27 001 硬切换）：
   *   - auto-approve 命中 + unlocked → queued（直接入执行队列）。
   *   - auto-approve 命中 + locked → waiting_unlock_auto（解锁后入队）。
   *   - locked + 其它 manual → waiting_unlock_manual（解锁后进 confirming）。
   *   - unlocked + 其它 manual → confirming（启动 timeout）。
   *
   * 注意：auto-approve 命中但 vault 仍 locked 时，**不**直接执行；
   * 必须等 unlock 后再入 queued 执行队列。这是"硬切换"明确要求的
   * 边界，避免 auto-confirm 绕过解锁直接执行。
   */
  private async acceptRequest(
    event: MessageEvent,
    parsed: { protocol: ReceiverRequest; id: string; networkIdentity: NetworkIdentity; method: ProtocolMethod; params: MethodParams<ProtocolMethod>; walletGeneration: string; runGeneration: string; bindingId?: string }
  ): Promise<void> {
    // origin 切换：触发历史载入 + 立即清空旧 origin 视图（施工单 2026-06-27
    // origin 切换：触发历史载入 + 立即清空旧 origin 视图（施工单 2026-06-27
    // 002 反馈修复）。
    //   - 旧实现只更新 `currentOriginValue` 并异步加载历史，旧 origin 的
    //     卡片仍留在 `feedCommands` 里。后续 setRecordPhase → upsertFeedCommand
    //     会拿"旧 origin 历史 + 新 origin 活卡"一起 buildFeedDisplay，让用户
    //     短暂看到跨 origin 混排。
    //   - 新实现：切 origin 时立即把 `feedCommands` 清成"只含新 origin 内
    //     存活记录的投影"；旧 origin 数据仍保留在 `requestsByRecordId` 里
    //     便于切回，但当前视图只显示新 origin。`loadHistoryForOrigin`
    //     完成后再用 K-V 历史重建当前 origin 视图。
    if (this.currentOriginValue !== event.origin) {
      this.currentOriginValue = event.origin;
      this.feedCommands = this.buildFeedDisplay(
        this.currentOriginLiveCommands(event.origin)
      );
      void this.loadHistoryForOrigin(event.origin);
    }

    const recordId = this.nextRecordId();
    const now = Date.now();
    const source = event.source as Window;
    const origin = event.origin;
    const method = parsed.method;

    const rec: RequestRecord = {
      ...(this.currentAppViewContext ? { applicationKey: applicationKey(origin, this.currentAppViewContext.appIdentity) } : {}),
      protocol: parsed.protocol,
      recordId,
      transportRequestId: parsed.id,
      walletGeneration: parsed.walletGeneration,
      runGeneration: parsed.runGeneration,
      bindingId: parsed.bindingId,
      networkIdentity: parsed.networkIdentity,
      source,
      origin,
      method,
      params: parsed.params,
      phase: "waiting_unlock_manual", // 临时占位，下方会立刻覆盖
      decision: "pending",
      status: "pending",
      enteredPhaseAt: now,
      autoApproved: false,
      // 关键（施工单 2026-06-28 002 硬切换）：`walletPublicKeyHex` +
      // `ownerPublicKeyHex` 在 record 创建时立即绑定一次。后续写卡
      // **不**再读 walletState.snapshot()——即使 popup 会话里用户切换 active
      // key，这条 record 的 owner / session 归属也不会被污染。
      // 业务方法在下方 method 分支里**先**做 session 预校验，再回填
      // 这两个字段；`connect.login` 在 bootstrapConnectLoginRecord
      // 之后回填。
      walletPublicKeyHex: "",
      ownerPublicKeyHex: "",
      createdAt: now,
      updatedAt: now,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    };
    this.requestsByRecordId.set(recordId, rec);

    if (this.deps.applicationIdentified && (method === "connect.login" || method === "connect.resume")) {
      try {
        const proof = (parsed.params as ConnectLoginParams | ConnectResumeParams).appIdentity;
        const identity = proof ? verifyAppIdentityProof(proof) : method === "connect.resume"
          ? (await this.deps.storageRepository?.getConnectSession(rec.networkIdentity, origin))?.appIdentity
          : undefined;
        rec.applicationKey = applicationKey(origin, identity);
        await this.deps.applicationIdentified(origin, identity);
        this.assertWalletGeneration(rec);
        this.receiver.assertCurrent(rec.protocol);
      } catch {
        await this.scheduleFailFastRequest(recordId, "invalid_request", "internal_error");
        return;
      }
    }

    // 决定初始 phase。`setRecordPhase` 只更新内存 feed 卡（施工单
    // 2026-06-27 002 硬切换：feed 投影走 `buildFeedDisplay`，活卡按
    // createdAt asc 稳定排序，不再做"先占位后改 phase"的两次写）。
    //
    // connect.* 三方法（施工单 2026-06-28 001 硬切换）：
    //   - login：locked → waiting_unlock_manual；unlocked → confirming
    //     （UI 渲染"选 key + 确认"视图）。需要拉 walletState.ready keys
    //     候选列表，落到 rec.connectLoginCandidates。session 预校验
    //     不适用——login 阶段还没有 session。
    //   - resume：locked → waiting_unlock_manual；unlocked → 直接 queued
    //     （**不**经过 confirming；施工单 4.3 + 9.2/9.3 明确要求 unlock 后
    //     "只补解锁，自动恢复"——不再多一次人工确认）。session 预校验
    //     失败时（不存在 / 已 revoke / origin 不匹配 / owner 不 ready）
    //     走 fail-fast：locked 时仍要求解锁，unlocked 时直接 queued →
    //     executing → failed（不进 confirming）。
    //   - logout：locked → waiting_unlock_manual；unlocked → 直接 queued
    //     （不需要额外确认 UI，"可无额外交互"）。locked + 手动解锁后
    //     也直接入 queued。**执行完成后**调 vault.lock() 清掉 popup
    //     当前 unlock runtime（施工单 4.4 + 5.1.3 明确要求）。
    if (method === "connect.logout") {
      // logout：unlock 后直接 queued → executing；不需要额外确认 UI。
      rec.autoExecuteAfterUnlock = true;
      this.applyManualPhaseDecision(recordId, origin, /* skipConfirmWhenUnlocked */ true);
      return;
    }
    if (method === "connect.login") {
      await this.bootstrapConnectLoginRecord(rec, parsed.params as ConnectLoginParams);
      // login：用户必须选 key → 走 confirming 视图（与现有 manual 路径一致）。
    } else if (method === "connect.resume") {
      // 同步预校验 session 真值（fail-fast）。session 无效时**直接**
      // 失败——不进 waiting_unlock / confirming / 解锁 UI。
      const resumeParams = parsed.params as ConnectResumeParams;
      const resumePre = await this.bootstrapConnectResumeRecord(rec, resumeParams, origin);
      if (resumePre !== null) {
        await this.scheduleFailFastRequest(recordId, resumePre.code, resumePre.reason);
        return;
      }
      const pendingLogin = this.pickConnectRecord("connect.login", undefined, origin);
      if (pendingLogin && !pendingLogin.connectAuthSubmittedAt) {
        await this.finalizeRequestByCancel(pendingLogin.recordId, "superseded_by_resume");
      }
      // session 有效：locked → waiting_unlock_manual；unlocked → 直接
      // queued（**不**经过 confirming）。解锁后同样直接 queued。
      rec.walletPublicKeyHex = resumeParams.walletPublicKeyHex;
      rec.ownerPublicKeyHex = rec.connectResumeSnapshot?.ownerPublicKeyHex ?? "";
      rec.autoExecuteAfterUnlock = true;
      this.applyManualPhaseDecision(recordId, origin, /* skipConfirmWhenUnlocked */ true);
      return;
    } else if (method === "connect.launch") {
      // appView 首登：launchToken 是唯一真值；**不**要求 walletPublicKeyHex，
      // **不**需要解锁 / 确认 UI。无论当前 vault 是否 locked，record 都先
      // 入 `executionQueue`；由 `drainExecutionQueue()` 走
      // `probeExecutionCondition` 决定立即执行还是 fail-fast。
      // executeConnectLaunch 内部再用 launchToken + 统一
      // `resolveOwnerRuntime` 做 fail-closed 校验。
      this.setRecordPhase(recordId, "queued");
      rec.enteredPhaseAt = Date.now();
      this.executionQueue.push(recordId);
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
      return;
    } else if (method === "channel.publish" || method === "channel.subscription_set") {
      // Channel 的 session id 属于 Session Window transport context，不属于
      // App params。只能使用此前由同一 source + exact origin 建立的登录会话。
      const channelSession = this.channelSessionBySource.get(source);
      if (!channelSession || channelSession.origin !== origin) {
        await this.scheduleFailFastRequest(recordId, "user_rejected", "internal_error");
        return;
      }
      rec.walletPublicKeyHex = channelSession.sessionId;
      rec.ownerPublicKeyHex = channelSession.ownerPublicKeyHex;
      if (this.lockStateValue === "locked") {
        // 锁定会话立即使 Channel 调用失效；不把 App 请求挂在解锁队列中。
        await this.scheduleFailFastRequest(recordId, "user_rejected", "runtime_missing");
        return;
      }
      rec.autoApproved = true;
      rec.autoExecuteAfterUnlock = true;
      this.setRecordPhase(recordId, "queued");
      rec.enteredPhaseAt = Date.now();
      this.executionQueue.push(recordId);
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
      return;
    } else {
      // 施工单 2026-06-28 002 硬切换：所有外部业务方法都属于某个
      // walletPublicKeyHex。统一预校验 session 真值，session 无效时
      // fail-fast（与 cipher.* 旧逻辑同语义）。
      //
      // 业务方法：identity.get / intent.sign / cipher.encrypt /
      // cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit。
      const sessionParams = parsed.params as { walletPublicKeyHex?: string };
      const sessionId = sessionParams?.walletPublicKeyHex;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        // 校验层应当已经拒绝；这里是兜底——任何缺 walletPublicKeyHex 的
        // 业务 method 都不允许落 record；按 invalid_request 兜底处理。
        await this.scheduleFailFastRequest(recordId, "user_rejected", "internal_error");
        return;
      }
      const sessionFail = await this.preCheckConnectSession({ ...rec.networkIdentity, publicKeyHex: sessionId }, origin);
      if (sessionFail !== null) {
        await this.scheduleFailFastRequest(recordId, sessionFail.code, sessionFail.reason);
        return;
      }
      // Re-read after precheck to detect revocation/storage failure at this boundary.
      // Preserve the bound owner only after the authority read succeeds.
      let session: ConnectSessionRecord | null = null;
      try {
        session = await this.fetchSessionForBinding({ ...rec.networkIdentity, publicKeyHex: sessionId }, rec.origin);
      } catch (err) {
        await this.scheduleFailFastRequest(recordId, "internal_error", "storage_error");
        return;
      }
      if (session === null) {
        // 极端竞态：preCheck 通过 → session 突然被外部 logout / 删除。
        // 走 fail-fast（与 K-V 异常区分）。
        await this.scheduleFailFastRequest(recordId, "user_rejected", "internal_error");
        return;
      } else {
        rec.walletPublicKeyHex = sessionId;
        rec.ownerPublicKeyHex = session.ownerPublicKeyHex;
        rec.applicationKey = applicationKey(origin, session.appIdentity);
        if (!this.deps.hostedApplication && this.deps.storageRepository?.putApplication) {
          try {
            await this.deps.storageRepository.putApplication({ key: rec.applicationKey, origin, name: session.appIdentity?.appName ?? new URL(origin).host, identity: session.appIdentity, updatedAt: now });
          } catch {
            await this.scheduleFailFastRequest(recordId, "internal_error", "storage_error"); return;
          }
        }
        if ((method.startsWith("storage.") || method.startsWith("msfile.")) && !session.appIdentity) {
          // MSFile 与 Storage 一致：无 verified App Identity 的 session 不允许
          // 进入执行；对外用稳定 code fail-fast。
          const identityCode: ProtocolErrorCode =
            method.startsWith("msfile.") ? "msfile_identity_required" : "storage_identity_required";
          await this.scheduleFailFastRequest(recordId, identityCode, "storage_error");
          return;
        }
      }
      if (method === "cipher.encrypt" || method === "cipher.decrypt") {
        // cipher.* session 有效：locked → waiting_unlock_manual；
        // unlocked → confirming（与现有 manual confirm 路径一致）。
      }
    }

    if (this.isTerminalPhase(rec.phase)) return;
    // Payment must first obtain a real frozen preview; its external approval is requested before submit, not at the internal wallet signer.
    if (method === "payment.pay") {
      rec.autoExecuteAfterUnlock = true;
      this.applyManualPhaseDecision(recordId, origin, true);
      return;
    }
    const autoApproved = await this.tryAutoApprove(parsed, origin, rec);
    if (this.isTerminalPhase(rec.phase)) return;
    if (autoApproved) {
      rec.autoApproved = true;
      // auto-approve 路径：unlocked → queued；locked → waiting_unlock_auto。
      if (this.lockStateValue === "unlocked") {
        this.setRecordPhase(recordId, "queued");
        rec.enteredPhaseAt = Date.now();
        this.executionQueue.push(recordId);
        this.emit();
        this.emitFeed();
        void this.drainExecutionQueue();
      } else {
        this.setRecordPhase(recordId, "waiting_unlock_auto");
        rec.enteredPhaseAt = Date.now();
        this.emit();
        this.emitFeed();
      }
      return;
    }

    // storage.* is an auto-execute session capability. It never opens a
    // confirmation card, but a locked Vault still queues it until unlock so
    // the Storage plugin can open its sealed provider config.
    if (
      parsed.method.startsWith("storage.") ||
      parsed.method.startsWith("msfile.")
    ) {
      // msfile.* 与 storage.* 同为 auto-execute session capability；价格确认
      // 由 msfile.service gateway 内部处理，不占用 popup 命令流 confirm UI。
      rec.autoApproved = true;
      rec.autoExecuteAfterUnlock = true;
      if (this.lockStateValue === "locked") {
        this.setRecordPhase(recordId, "waiting_unlock_auto");
        rec.enteredPhaseAt = Date.now();
        this.emit();
        this.emitFeed();
      } else {
        this.setRecordPhase(recordId, "queued");
        rec.enteredPhaseAt = Date.now();
        this.executionQueue.push(recordId);
        this.emit();
        this.emitFeed();
        void this.drainExecutionQueue();
      }
      return;
    }

    // manual confirm 路径（identity.get / intent.sign / p2pkh.transfer /
    // feepool.*）。
    this.applyManualPhaseDecision(recordId, origin, false);
  }

  /**
   * 同步预校验 connect session 真值。
   *
   * 设计缘由（施工单 2026-06-28 001 硬切换 5.1.2 + 5.2 + 2026-06-28 002
   * 硬切换）：在 acceptRequest 阶段同步校验 session 真值，避免无效
   * session 走"等待解锁 / 确认" UI 才被发现；用户对该 origin 的请求
   * 应直接 fail-fast。校验项与执行阶段 `requireConnectSession` 严格
   * 对齐：session 真值存在 + 未 revoke + origin 匹配 + owner key ready。
   *
   * 返回 `null` 表示校验通过；返回 `{code, reason}` 表示校验失败：
   *   - `code` 是对外 result.error.code（user_rejected / invalid_origin / internal_error）；
   *   - `reason` 是本地 ProtocolFailureReason（写进 record.failureReason）。
   *
   * 跨 origin 区分：accept 阶段读出 session 后立即做 origin 比对，
   * origin 不匹配 → `invalid_origin`（与 identity.get 同语义，
   * 让 caller 知道自己"用的 sessionId 不是该 origin 的"）。
   *
   * K-V 不可用或读取失败时，直接 internal_error / storage_error，
   * 不进入确认、签名或执行队列，不把未知授权状态伪装为用户拒绝。
   */
  private async preCheckConnectSession(
    identity: NetworkIdentity,
    origin: string
  ): Promise<{ code: ProtocolErrorCode; reason: ProtocolFailureReason } | null> {
    if (!this.deps.storageRepository) return { code: "internal_error", reason: "storage_error" };
    if (!identity.publicKeyHex) return { code: "internal_error", reason: "internal_error" };
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding(identity, origin);
    } catch (err) {
      // An unavailable authority is not a missing/revoked grant or user rejection.
      // Stop before confirmation/execution; never degrade a failed read into consent.
      return { code: "internal_error", reason: "storage_error" };
    }
    if (session === null) {
      // 校验失败：不存在 / 已 revoke —— 不能直接告诉 caller 哪一种，
      // 统一 `user_rejected`。
      return { code: "user_rejected", reason: "internal_error" };
    }
    // 跨 origin 区分：与 identity.get 同语义。execute 阶段
    // `requireConnectSession` 也会做同样校验，accept 阶段提前
    // 给出精确错误码。
    if (session.origin !== origin) {
      return { code: "invalid_origin", reason: "internal_error" };
    }
    const active = this.deps.walletState.snapshot().activePublicKeyHex;
    if (active && active.toLowerCase() !== session.ownerPublicKeyHex.toLowerCase()) {
      // 单 Key 本地钱包下这是唯一的「owner 不匹配」形态：session 绑定的
      // 公钥不是当前唯一 Key。给出精确 reason，执行阶段的
      // `assertSessionOwnerIsActive` 会给出同一结论。
      return { code: "user_rejected", reason: "session_owner_mismatch" };
    }
    if (!this.requireCurrentOwnerKey(session.ownerPublicKeyHex)) {
      // 没有可用 Key（锁定/未初始化）：session 仍然存在，但当前无法执行。
      return { code: "user_rejected", reason: "internal_error" };
    }
    return null;
  }

  /**
   * 按 sessionId 取 connect session 真值（不区分 origin，由 caller 决定
   * 跨 origin 错误码）。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - 不存在 / 已 revoke → 返回 `null`；caller 触发 fail-fast。
   *   - K-V 异常 / K-V 不可用 → **抛错**。让 caller 区分"session 失效"
   *     与"K-V 异常"两种 case：K-V 异常**不**走 fail-fast 路径——与
   *     旧"K-V unavailable 降级"边界一致：p2pkh / cipher / 业务
   *     方法仍走 manual confirm（execute 阶段再校验）。Fail-fast 只
   *     用于"session 真值确凿无效"，**不**用于"K-V 查不到"。
   *   - 跨 origin 不在本函数判断；caller 拿到 session 后自己
   *     `session.origin !== event.origin` 决定走 `invalid_origin`。
   */
  /** SDK 付款账本只接受 96 字符内的 ID；压缩已有网络/公钥/来源坐标，不签发授权 ID。 */
  private async connectBindingKey(identity: NetworkIdentity, origin: string): Promise<string> {
    const coordinate = JSON.stringify([identity.bsvNetwork, identity.publicKeyHex.toLowerCase(), origin]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(coordinate)));
    return "connect." + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async publicOwnerKey(identity: NetworkIdentity): Promise<KeyIdentity | undefined> {
    const publicKeyHex = identity.publicKeyHex;
    const active = this.requireCurrentOwnerKey(publicKeyHex);
    if (active && sameNetworkIdentity(active, identity)) return active;
    const stored = await this.deps.vault.getCurrentKey();
    if (!stored || !sameNetworkIdentity(stored, identity)) return undefined;
    return { bsvNetwork: stored.bsvNetwork, publicKeyHex: stored.publicKeyHex, label: stored.label,
      backend: "software" as const,
      capabilities: ["p2pkh"], createdAt: new Date().toISOString() };
  }

  private async fetchSessionForBinding(identity: NetworkIdentity, origin: string): Promise<ConnectSessionRecord | null> {
    const publicKeyHex = identity.publicKeyHex;
    if (!/^(02|03)[0-9a-f]{64}$/iu.test(publicKeyHex)) return null;
    if (!this.deps.storageRepository) return null;
    const cached = await this.deps.storageRepository.getConnectSession(identity, origin);
    if (cached?.revokedAt !== null && cached !== null) return null;
    if (cached) return sameNetworkIdentity(cached.networkIdentity, identity) ? cached : null;
    const key = await this.publicOwnerKey(identity);
    if (!key) return null;
    // A valid owner identity is sufficient to reconnect after local reset.
    // This creates current defaults, not restored permissions or an App Identity.
    const now = Date.now();
    const record: ConnectSessionRecord = {
      sessionId: await this.connectBindingKey(key, origin),
      origin, networkIdentity: projectNetworkIdentity(key), ownerPublicKeyHex: key.publicKeyHex,
      ownerLabel: key.label, claimsSnapshot: {}, createdAt: now, lastUsedAt: now, revokedAt: null,
    };
    await this.deps.storageRepository.putConnectSession(record);
    return record;
  }

  /**
   * 让一条已建 record "fail-fast"：直接 phase=failed 并回复错误 result。
   *
   * 设计缘由（施工单 2026-06-28 001 硬切换 5.1.2 / 5.2 + 反例反馈）：
   *   - session 真值无效（不存在 / 已 revoke / origin 不匹配 / owner key
   *     不 ready）时**必须直接失败**：不让用户走任何"解锁" / "确认" UI。
   *   - 无效 session 失败路径**不依赖** vault unlock：replyErrorToRec 只
   *     走 postMessage，不读 vault / walletState 状态。
   *   - 因此 locked 与 unlocked 一视同仁——fail-fast 在两种状态下都直接
   *     收口为 phase=failed，对外回 result(ok=false)。**不**进入
   *     waiting_unlock_manual。
   *
   * 关键不变量：
   *   - fail-fast 的 record 不进 executionQueue / 不 drainExecutionQueue；
   *     executionQueue 的 drain 检查 `lockStateValue === "unlocked"`，
   *     走队列意味着 locked 时会被挂起，违反"直接失败"。
   *   - 不动 syncWalletState / autoExecuteAfterUnlock——fail-fast record
   *     已经没有"unlock 后怎么办"的概念。
   */
  private async scheduleFailFastRequest(
    recordId: string,
    code: ProtocolErrorCode,
    reason: ProtocolFailureReason
  ): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    rec.phase = "failed";
    rec.decision = "failed";
    rec.status = "failed";
    rec.errorCode = code;
    rec.errorMessage =
      code === "invalid_origin"
        ? "invalid origin"
        : code === "asset_not_enabled"
          ? "Requested asset is not enabled in Keymaster settings"
          : "User rejected";
    rec.failureReason = reason;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    // 写 feed 历史卡（终态）。
    await this.persistFeedCommandFor(rec);
    this.emitFeed();
    // 直接向 opener 回 result。fire-and-forget：postMessage 失败不影响
    // 本地 record 终态；与现有 dispatch 收尾保持一致。
    await this.replyErrorToRec(rec, code, rec.errorMessage);
    this.emit();
  }

  /**
   * 决定 manual confirm 路径的初始 phase。
   *
   * `skipConfirmWhenUnlocked`：connect.logout 用此跳过 unlocked 时的 confirming
   * 视图（"可无额外交互，快速完成"）。
   */
  private applyManualPhaseDecision(
    recordId: string,
    origin: string,
    skipConfirmWhenUnlocked: boolean
  ): void {
    if (this.lockStateValue === "locked") {
      this.setRecordPhase(recordId, "waiting_unlock_manual");
      const rec = this.requestsByRecordId.get(recordId);
      if (rec) rec.enteredPhaseAt = Date.now();
      this.emit();
      this.emitFeed();
      return;
    }
    // unlocked：
    if (skipConfirmWhenUnlocked) {
      this.setRecordPhase(recordId, "queued");
      const rec = this.requestsByRecordId.get(recordId);
      if (rec) rec.enteredPhaseAt = Date.now();
      this.executionQueue.push(recordId);
      this.emit();
      this.emitFeed();
      void this.drainExecutionQueue();
      return;
    }
    this.setRecordPhase(recordId, "confirming");
    const rec = this.requestsByRecordId.get(recordId);
    if (rec) rec.enteredPhaseAt = Date.now();
    // 推进到 confirming 的瞬间决定 timeout 快照：
    // sync cache 命中 → 用 cache 真值（不热更新）；
    // cache miss → 30s 兜底（允许后续 clamp down）。
    const snapshot = this.resolveConfirmTimeoutSnapshot(origin);
    this.startConfirmTimeout(recordId, snapshot.initialSeconds, snapshot.startedFromFallback);
    this.emit();
    this.emitFeed();
    void this.refreshTimeoutFromOriginConfig(recordId, origin);
  }

  /**
   * 准备 `connect.login` record：读取当前唯一钱包的公开元数据。
   * 任何 K-V / walletState 异常都**不**当场拒掉 request——service 仍按 manual
   * 路径推进；执行阶段会再次校验，失败时回 `user_rejected` + 本地 reason。
   */
  private async bootstrapConnectLoginRecord(rec: RequestRecord, _params: ConnectLoginParams): Promise<void> {
    try {
      // 单 Key 本地钱包：候选列表最多只有一个元素——当前唯一 Key。
      // connect.login 不再让用户在多把 Key 之间选择。
      const current = await this.publicOwnerKey(rec.networkIdentity);
      this.assertWalletGeneration(rec);
      rec.connectAuthBackend = "software";
      rec.connectLoginWallet = current
        ? { publicKeyHex: current.publicKeyHex, label: current.label }
        : undefined;
    } catch (err) {
      rec.connectLoginWallet = undefined;
    }
  }

  /**
   * 准备 `connect.resume` record：按 sessionId 查 session 真值。
   *
   * 设计缘由（施工单 2026-06-28 001 硬切换 5.1.2 + 反例反馈）：
   *   - 这是 acceptRequest 阶段的**同步**预校验；session 无效时**不**
   *     让 request 走 waiting_unlock / confirming UI，直接 fail-fast。
   *   - 校验项与执行阶段 `requireConnectSessionForCipher` 严格对齐：
   *     session 真值存在 + 未 revoke + origin 匹配 + owner key ready。
   *   - 校验**通过**时同步把 session 真值落到 `rec.connectResumeSnapshot`，
   *     避免 execute 阶段再去 K-V 多走一次（执行路径仍以 K-V 当前值为
   *     准，但 snapshot 是热路径上的合理缓存）。
   *
   * 返回：`null` = 校验通过；`{code, reason}` = 校验失败（fail-fast）。
   */
  private async bootstrapConnectResumeRecord(
    rec: RequestRecord,
    params: ConnectResumeParams,
    origin: string
  ): Promise<{ code: ProtocolErrorCode; reason: ProtocolFailureReason } | null> {
    if (!this.deps.storageRepository) {
      return { code: "user_rejected", reason: "internal_error" };
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding({ ...rec.networkIdentity, publicKeyHex: params.walletPublicKeyHex }, origin);
    } catch (err) {
      return { code: "user_rejected", reason: "internal_error" };
    }
    if (!session) return { code: "user_rejected", reason: "internal_error" };
    if (session.revokedAt !== null) return { code: "user_rejected", reason: "internal_error" };
    if (session.origin !== origin) return { code: "invalid_origin", reason: "internal_error" };
    try {
      const key = await this.publicOwnerKey(session.networkIdentity);
      if (!key) {
        return { code: "user_rejected", reason: "internal_error" };
      }
      rec.connectAuthBackend = "software";
    } catch (err) {
      return { code: "user_rejected", reason: "internal_error" };
    }
    if (params.appIdentity) {
      try {
        const appIdentity = verifyAppIdentityProof(params.appIdentity);
        this.assertLoginRequirements(params.appIdentity, true);
        session = { ...session, appIdentity };
        await this.deps.storageRepository.putConnectSession(session);
      } catch {
        return { code: "user_rejected", reason: "internal_error" };
      }
    }
    rec.connectResumeSnapshot = {
      sessionId: session.sessionId,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      ownerLabel: session.ownerLabel,
      claimsSnapshot: session.claimsSnapshot
    };
    return null;
  }

  /** External operation grants belong to the application, independently for each method.
   * Unknown grants never silently authorize execution. Payment obtains a frozen preview and checks its own grant before submission.
   * Connection, wallet-generation and real business-state checks remain in the execution path; no wallet-internal approval is installed here.
   */
  private async tryAutoApprove(
    parsed: { id: string; networkIdentity: NetworkIdentity; method: ProtocolMethod; params: MethodParams<ProtocolMethod> },
    origin: string,
    _rec: RequestRecord
  ): Promise<boolean> {
    if (requiresApplicationApproval(parsed.method)) {
      if (!_rec.applicationKey) return false;
      try { return (await readApplicationPermissions(this.deps.storageRepository, _rec.applicationKey)).includes(parsed.method); }
      catch { return false; } // unknown permission never silently authorizes execution
    }
    if (parsed.method === "payment.channel.register" || parsed.method === "payment.status" || parsed.method === "p2pkh.transfer" || parsed.method === "feepool.prepare" || parsed.method === "feepool.commit") return true;
    // connect.* 走 manual 路径（施工单 2026-06-28 001）：
    //   - connect.login / resume：用户必须明确点确认（login 还要选 key）；
    //   - connect.logout：unlocked 时直接入队执行（不需要额外确认 UI），
    //     locked 时进入 waiting_unlock_manual，解锁后直接入队。
    // auto-approve 配置对 connect.* 不生效——caller 主动发 connect.* 已经是
    // "希望走 connect 流程"的信号，不应被 per-origin auto-approve 跳过。
    return false;
  }

  private async getOriginSettingsCached(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
    const cached = this.originCache.get(origin);
    if (cached) return cached;
    if (!this.deps.storageRepository) return null;
    try {
      const raw = await this.deps.storageRepository.getOrigin(origin);
      if (raw) {
        const normalized = normalizeOriginSettings(raw, origin);
        this.originCache.set(origin, normalized);
        return normalized;
      }
      return raw;
    } catch {
      return null;
    }
  }

  /* ============== 锁屏 / 解锁 / relock ============== */

  /**
   * vault 状态变化时由外部（popup 或 vault）调用：service 同步 lockState
   * 并执行 relock / unlock 收口。
   *
   * 状态仅从当前 Vault 与仍有效的授权 runtime 派生，不接受外部锁屏布尔值。
   * 没有状态变化时不重复撤销 Channel 会话；runtime 就绪后使用同一入口推进等待请求。
   *
   * 收口语义：
   *   - 状态从 unlocked → locked：所有 `confirming` → `waiting_unlock_manual`
   *     + 清 timeout；`queued` 保持；`executing` 当前这条允许跑完。
   *   - 状态从 locked → unlocked：批量推进 `waiting_unlock_*`。
   *     `authUnlockInProgress` 期间跳过批量推进（auth 页自己处理）。
   */
  syncWalletState(...args: []): void {
    if (args.length) throw new TypeError("Wallet state notifications do not accept state arguments");
    const next = this.computeLockState();
    if (this.lockStateValue === next) return;
    if (next === "locked") {
      // Vault 锁定会立即撤销所有 Session Window Channel caller；后续 App
      // 必须重新建立 session/订阅，不能复用锁前的授权上下文。
      this.releaseAllChannelSessions();
      this.channelSessionBySource.clear();
      this.channelSubscriptionsBySessionId.clear();
      this.channelQuotaBySessionId.clear();
      this.channelSessionEpoch++;
    }
    this.lockStateValue = next;
    if (next === "locked") {
      // relock 硬收口：所有 confirming → waiting_unlock_manual，清 timeout。
      for (const [, rec] of this.requestsByRecordId) {
        if (rec.phase === "confirming") {
          this.clearConfirmTimeout(rec.recordId);
          this.setRecordPhase(rec.recordId, "waiting_unlock_manual");
          rec.enteredPhaseAt = Date.now();
        }
      }
      // queued 保持；executing 当前这一条允许跑完。
      // 执行器暂停取新任务：drainExecutionQueue 会判定 lockState。
    } else {
      if (this.authUnlockInProgress) {
        return;
      }
      // unlock 批量推进。
      const manualRecs: RequestRecord[] = [];
      const autoRecs: RequestRecord[] = [];
      for (const [, rec] of this.requestsByRecordId) {
        if (rec.phase === "waiting_unlock_manual") manualRecs.push(rec);
        else if (rec.phase === "waiting_unlock_auto") autoRecs.push(rec);
      }
      for (const rec of manualRecs) {
        // autoExecuteAfterUnlock：connect.resume / connect.logout / cipher.* fail-fast
        // 在解锁后直接 queued（不进入 confirming 视图）。
        if (rec.autoExecuteAfterUnlock) {
          this.setRecordPhase(rec.recordId, "queued");
          rec.enteredPhaseAt = Date.now();
          this.executionQueue.push(rec.recordId);
        } else {
          this.setRecordPhase(rec.recordId, "confirming");
          rec.enteredPhaseAt = Date.now();
          // 推进到 confirming 的瞬间决定 timeout 快照：
          // sync cache 命中 → 用 cache 真值（不热更新）；
          // cache miss → 30s 兜底（允许后续 clamp down）。
          const snapshot = this.resolveConfirmTimeoutSnapshot(rec.origin);
          this.startConfirmTimeout(
            rec.recordId,
            snapshot.initialSeconds,
            snapshot.startedFromFallback
          );
          // 与 resumeAfterUnlock 对齐：cache miss 时 timer 用 30s 兜底启动，
          // refresh 异步 clamp 到 K-V 真值；per-origin timeout 配置必须生效。
          void this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
        }
      }
      for (const rec of autoRecs) {
        this.setRecordPhase(rec.recordId, "queued");
        rec.enteredPhaseAt = Date.now();
        this.executionQueue.push(rec.recordId);
      }
      void this.drainExecutionQueue();
    }
    this.phase = this.snapshotPhaseFromRequests();
    this.emit();
    this.emitFeed();
  }

  /* ============== Confirming Timeout ============== */

  /**
   * 启动某条 confirming request 的 timeout 计时器。
   *
   * 设计要点（施工单 2026-06-27 001 硬切换 + 施工单 003）：
   *   - 每条 confirming request 独立 timer；进入 confirming 时启动。
   *   - cache miss 用缺省 30 兜底；K-V 返回后**clamp down**（不 extend）。
   *   - 修改站点 timeout **不**热更新当前正在倒计时的 request。
   */
  /**
   * 启动单条 confirming request 的 timeout 倒计时。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换 timeout 收口）：
   *   - 调用方在“进入 confirming 的那个瞬间”已经决定本次 request 的
   *     超时快照（同步 cache 命中 → 用 cache 值 / cache miss →
   *     默认 30s 兜底）；本函数**不**再读全局 `originCache`——避免
   *     cache 在 preCheck / loadHistoryForOrigin microtask flush 期间
   *     被提前填充，timer 误读到 60s 而非走 30s 兜底。
   *   - `startedFromFallback`：true 表示本次走了 30s 兜底，后续
   *     `refreshTimeoutFromOriginConfig` 才允许 clamp down；false
   *     表示本次已拿到 cache 真值，后续不允许热更新（K-V 真值晚到
   *     也**不** extend）。
   */
  private startConfirmTimeout(
    recordId: string,
    initialSeconds: number,
    startedFromFallback: boolean
  ): void {
    this.clearConfirmTimeout(recordId);
    const now = Date.now();
    const startedAtMs = now;
    const deadlineMs = now + initialSeconds * 1000;
    const tickHandle = setInterval(() => {
      const t = this.timersByRecordId.get(recordId);
      if (!t || !t.tickHandle) return;
      const rec = this.requestsByRecordId.get(recordId);
      // request 已不在 confirming（被 confirm / reject / cancel / 收尾）→ 退出。
      if (!rec || rec.phase !== "confirming") {
        this.clearConfirmTimeout(recordId);
        return;
      }
      if (Date.now() >= t.deadlineMs) {
        this.clearConfirmTimeout(recordId);
        void this.finalizeRequestByTimeout(recordId);
        return;
      }
      this.emitFeed();
    }, 1000);
    this.timersByRecordId.set(recordId, {
      deadlineMs,
      tickHandle,
      startedAtMs,
      startedFromFallback
    });
    this.emit();
  }

  /**
   * 异步刷 origin 配置后，按 K-V 真值重新评估当前 request 的
   * timeout deadline。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换 timeout 收口）：
   *   - **只**对 `startedFromFallback === true` 的 request 生效——已经
   *     走同步 cache 命中的 request **不**允许 K-V 真值晚到后再热更新。
   *     收口掉“修改站点 timeout 配置热更新正在倒计时的 request”的边界。
   *   - `newDeadline < currentDeadline` 才更新（只缩短，不延长）。
   *   - `newDeadline <= Date.now()` 时立即 `finalizeRequestByTimeout`，
   *     不等下一个 tick——晚到的小 timeout 立即生效。
   */
  private async refreshTimeoutFromOriginConfig(recordId: string, origin: string): Promise<void> {
    const cached = await this.getOriginSettingsCached(origin);
    const t = this.timersByRecordId.get(recordId);
    if (!t) return;
    if (!t.startedFromFallback) return; // 已走 cache 真值 → 不热更新
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec || rec.phase !== "confirming") return;
    if (!cached) return;
    const actualSeconds = cached.confirmTimeoutSeconds;
    if (!actualSeconds || actualSeconds <= 0) return;
    const actualMs = actualSeconds * 1000;
    const currentDeadline = t.deadlineMs;
    const newDeadline = t.startedAtMs + actualMs;
    if (newDeadline < currentDeadline) {
      t.deadlineMs = newDeadline;
      this.emitFeed();
      this.emit();
      if (newDeadline <= Date.now()) {
        // 新 deadline 已过去 / 即将过去（不变量 cache miss → 5s 真值晚到
        // 仍应立即 timeout，不等下一个 tick）。
        await this.finalizeRequestByTimeout(recordId);
      }
    }
  }

  private clearConfirmTimeout(recordId: string): void {
    const t = this.timersByRecordId.get(recordId);
    if (t) {
      clearInterval(t.tickHandle);
      this.timersByRecordId.delete(recordId);
    }
  }

  /**
   * 决定本次 request 进入 confirming 时的 timeout 快照。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换 timeout 收口）：
   *   - 同步 cache 命中 → 用 cache 真值启动 timer；后续 K-V 真值晚到**不**
   *     热更新（`startedFromFallback = false`）。
   *   - 同步 cache miss → 用 `DEFAULT_CONFIRM_TIMEOUT_SECONDS`
   *     （30s）兜底；后续 K-V 真值晚到**只**允许 clamp down
   *     （`startedFromFallback = true`）。
   *
   * 谁把 request 推进到 `confirming`，谁就在“推进那个瞬间”调用本
   * helper 拿快照，**不**让 `startConfirmTimeout` 隐式读全局 cache。
   */
  private resolveConfirmTimeoutSnapshot(origin: string): {
    initialSeconds: number;
    startedFromFallback: boolean;
  } {
    const cached = this.originCache.get(origin);
    if (cached && cached.confirmTimeoutSeconds > 0) {
      return { initialSeconds: cached.confirmTimeoutSeconds, startedFromFallback: false };
    }
    return { initialSeconds: DEFAULT_CONFIRM_TIMEOUT_SECONDS, startedFromFallback: true };
  }

  /**
   * timeout 收尾：phase/decision 走 failed，status 单独 timed_out，
   * failureReason = "request_timeout"；对外仍回 user_rejected。
   */
  private async finalizeRequestByTimeout(recordId: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.phase !== "confirming") return;
    this.clearConfirmTimeout(recordId);
    rec.paymentApproval?.(false);
    rec.paymentApproval = undefined;
    rec.phase = "timed_out";
    rec.errorCode = "user_rejected";
    rec.errorMessage = "User rejected";
    rec.failureReason = "request_timeout";
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    await this.persistFeedCommandFor(rec);
    this.emitFeed();
    await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    this.emit();
  }

  /* ============== Cancel ============== */

  /**
   * cancel 收尾：对外统一 `user_rejected`，本地用 `failureReason`
   * 区分"用户本地取消"与"client 主动 cancel"。
   */
  private async finalizeRequestByCancel(
    recordId: string,
    failureReason: "user_canceled" | "client_canceled" | "superseded_by_resume"
  ): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.phase === "executing") {
      rec.cancelRequested = true;
      rec.abortController?.abort();
      // 取消只作用于本条请求：中止它的 AbortSignal 即可，媒体之外的持久写
      // 都由 IndexedDB 事务原子提交，不存在需要额外回收的远端上传会话。
      return;
    }
    // queued：从执行队列里移除。
    if (rec.phase === "queued") {
      this.executionQueue = this.executionQueue.filter((id) => id !== recordId);
    }
    this.clearConfirmTimeout(recordId);
    rec.paymentApproval?.(false);
    rec.paymentApproval = undefined;
    rec.phase = "rejected";
    rec.errorCode = "user_rejected";
    rec.errorMessage = "User rejected";
    rec.failureReason = failureReason;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    await this.persistFeedCommandFor(rec);
    await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    this.emitFeed();
    this.emit();
  }

  /* ============== 全局串行执行 ============== */

  /**
   * 执行器：从 `executionQueue` FIFO 取一条执行；同一时刻只允许一条
   * `executing`。
   *
   * 施工单 2026-06-30 002 硬切换：取消 `lockStateValue === "unlocked"`
   * 作为所有 request 的统一前置门。每条 record 在入队执行前都先
   * `probeExecutionCondition(rec)`：
   *   - 当前 record 能解析到 owner runtime → 立即执行；
   *   - 当前 record 解析不到 owner runtime，但 unlock 后能从 vault
   *     重建 → 推到 `waiting_unlock_manual`（沿用旧 manual 卡路径）；
   *   - 当前 record 解析不到 owner runtime，且解锁也无法成立 →
   *     fail-fast，本地 reason = `runtime_missing`，对外
   *     `user_rejected`。
   *
   * 这样 lockState 不再是"全局总闸"；locked 时只要 bootstrap owner
   * runtime 已就绪，`connect.launch` 等业务请求照常执行——正是本次硬切
   * 要修复的现场故障。
   */
  private async drainExecutionQueue(): Promise<void> {
    if (this.executingRecordId !== null) return; // 已有正在执行的；当前条跑完后由 `runRequest` 内的 finally 触发下一次 drain。
    if (this.executionQueue.length === 0) return;
    if (this.drainingExecutionQueue) return;
    this.drainingExecutionQueue = true;
    try {
      while (this.executionQueue.length > 0 && this.executingRecordId === null) {
        const recordId = this.executionQueue[0];
        if (typeof recordId !== "string") {
          // 防御性：executionQueue 在代码内只 push 字符串，但 TS 推导
          // 出 `string | undefined`（数组下标）；非字符串时直接 shift。
          this.executionQueue.shift();
          continue;
        }
        const rec = this.requestsByRecordId.get(recordId);
        if (!rec) {
          this.executionQueue.shift();
          continue;
        }
        if (rec.phase !== "queued") {
          this.executionQueue.shift();
          continue;
        }
      // 按当前 record 自己判定能否执行——不再用全局 lockState 卡。
        const decision = await this.probeExecutionCondition(rec);
        if (decision.kind === "block_unlock") {
        // 等 vault 解锁；保持队首，等待 `syncWalletState()` 后
        // 由它触发的 drainExecutionQueue 再走一遍。
          this.setRecordPhase(rec.recordId, decision.targetPhase);
          rec.enteredPhaseAt = Date.now();
          this.executionQueue.shift();
          this.emit();
          this.emitFeed();
          continue;
        }
        if (decision.kind === "fail") {
        // runtime 真拿不到（bootstrap lost 且 vault 也不能重建）——
        // 立即 fail-fast，写本地 reason = `runtime_missing`，对外
        // `user_rejected`。
          this.executionQueue.shift();
          rec.phase = "failed";
          rec.errorCode = decision.storageError ? "internal_error" : "user_rejected";
          rec.errorMessage = decision.storageError ? "Connect session storage unavailable" : "User rejected";
          rec.failureReason = decision.storageError ? "storage_error" : "runtime_missing";
          rec.finishedAt = Date.now();
          rec.updatedAt = rec.finishedAt;
          try {
            await this.persistFeedCommandFor(rec);
          } catch (error) {
            rec.errorCode = "internal_error";
            rec.errorMessage = "Command history could not be persisted";
            rec.failureReason = "storage_error";
            await this.replyErrorToRec(rec, "internal_error", rec.errorMessage);
            this.emitFeed();
            this.emit();
            continue;
          }
          await this.replyErrorToRec(rec, decision.storageError ? "internal_error" : "user_rejected", rec.errorMessage);
          this.emitFeed();
          this.emit();
          continue;
        }
        // decision.kind === "execute"：取出队首并执行。
        this.executionQueue.shift();
        this.executingRecordId = recordId;
        this.setRecordPhase(recordId, "executing");
        rec.enteredPhaseAt = Date.now();
        try {
          await this.runRequest(rec);
        } catch {
        } finally {
          this.executingRecordId = null;
        }
      }
    } finally {
      this.drainingExecutionQueue = false;
    }
  }

  /**
   * 按当前 record 自己判定能否立即执行。
   *
   * 设计缘由（施工单 2026-06-30 002 硬切换）：
   *   - 不再用全局 `lockState === "unlocked"` 做总闸；
   *   - 改为按 record 实际能拿到的 owner runtime 决定：
   *       - `execute`: 当前能解析到 owner runtime（任一来源）；
   *       - `block_unlock`: 当前解析不到，但解锁后能从 vault 重建；
   *       - `fail`: 解析不到，且解锁也无法成立。
   *   - `connect.login` / `connect.resume` / `connect.logout` 由
   *     connect.* auth 流程单独处理；这里只覆盖外部业务方法（含
   *     `connect.launch`）。
   *
   * 返回 `targetPhase`：当返回 `block_unlock` 时推到该 phase，便于 caller
   * （`drainExecutionQueue`）把 record 状态写入。
   */
  private async probeExecutionCondition(
    rec: RequestRecord
  ): Promise<
    | { kind: "execute" }
    | { kind: "block_unlock"; targetPhase: "waiting_unlock_manual" | "waiting_unlock_auto" }
    | { kind: "fail"; storageError?: true }
  > {
    // connect.* 自有登录 UI / 流程，由 service 走专门的 connect auth
    // 路径；不依赖 owner runtime resolver。直接 execute。
    if (
      rec.method === "connect.login" ||
      rec.method === "connect.resume" ||
      rec.method === "connect.logout"
    ) {
      return { kind: "execute" };
    }
    // connect.launch 是唯一的非 walletPublicKeyHex 业务入口；session 真值
    // 通过 launchToken 在 `launchTokensByToken` 内取。
    let sessionId: string | undefined;
    if (rec.method === "connect.launch") {
      const token = (rec.params as { launchToken?: string } | undefined)?.launchToken;
      if (!token) {
        return { kind: "fail" };
      }
      const record = this.launchTokensByToken.get(token);
      if (!record) {
        return { kind: "fail" };
      }
      sessionId = record.walletPublicKeyHex;
    } else if (rec.method === "channel.publish" || rec.method === "channel.subscription_set") {
      sessionId = rec.walletPublicKeyHex || undefined;
    } else {
      const params = rec.params as { walletPublicKeyHex?: string } | undefined;
      sessionId = params?.walletPublicKeyHex;
    }
    if (!sessionId) {
      return { kind: "fail" };
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding({ ...rec.networkIdentity, publicKeyHex: sessionId }, rec.origin);
    } catch {
      return { kind: "fail", storageError: true };
    }
    if (!session || session.revokedAt !== null) {
      return { kind: "fail" };
    }
    // 1. bootstrap_runtime 来源：刚启动 Session Window 时已有。
    if (this.ownerRuntimesBySessionId.has(session.sessionId)) {
      return { kind: "execute" };
    }
    // 2. vault_runtime 来源：本窗口 vault 已 unlock 且能拿到 owner key。
    if (this.lockStateValue === "unlocked") {
      try {
        const key = this.requireCurrentOwnerKey(session.ownerPublicKeyHex);
        if (key) {
          return { kind: "execute" };
        }
      } catch {
        // fallthrough
      }
      // unlocked 但解析不到 owner → fail-fast。
      return { kind: "fail" };
    }
    // 3. 当前窗口 locked。
    //   - 先**预判**"解锁后能不能拿到 owner runtime"——这一步只读
    //     walletState 元数据，**不**要求 vault 解锁：
    //       - session 绑定的 owner 公钥不是当前唯一 Key（钱包已重置并
    //         重新初始化为另一把 Key）→ 解锁了也拿不到 → 直接 fail-fast，
    //         让用户明确知道 "session 绑定的 Key 已不是本钱包的 Key"。
    //       - owner 公钥与当前唯一 Key 一致 → 等解锁；解锁后由 syncWalletState
    //         重新触发 drainExecutionQueue → 走第 2 步拿到 execute。
    //   - 这把 "locked + 等下去也无解" 的请求挡在 unlocked 流程之前；
    //     避免无谓解锁。
    //
    // 关键：这里**不能**用 requireCurrentOwnerKey()——它在锁定态必然返回
    // undefined，会把"owner 就是这把 Key、只是还没解锁"误判成 fail-fast。
    // 判定只需要比对公钥身份，那是纯投影读取。
    const active = this.deps.walletState.snapshot().activePublicKeyHex;
    if (active && active.toLowerCase() !== session.ownerPublicKeyHex.toLowerCase()) {
      return { kind: "fail" };
    }
    // - 如果该方法是 connect.launch，bootstrap 没就绪就根本不会被
    //   consume；这里 probe 也会命中该路径。
    return {
      kind: "block_unlock",
      targetPhase: rec.autoApproved ? "waiting_unlock_auto" : "waiting_unlock_manual"
    };
  }

  /**
   * 执行单条 request。收尾：成功 → approved；失败 → failed。
   */
  private async runRequest(rec: RequestRecord): Promise<void> {
    rec.abortController = new AbortController();
    try {
      this.assertWalletGeneration(rec);
      this.receiver.assertCurrent(rec.protocol);
      const boot = rec.walletPublicKeyHex ? this.ownerRuntimesBySessionId.get(rec.walletPublicKeyHex)?.runtime : undefined;
      const activeIdentity = boot?.networkIdentity ?? this.requireCurrentOwnerKey(rec.networkIdentity.publicKeyHex);
      if (!activeIdentity || !sameNetworkIdentity(activeIdentity, rec.networkIdentity)) throw new ProtocolValidationError("invalid_request", "Network identity mismatch");
      const result = await this.dispatch(rec);
      if (this.isTerminalPhase(rec.phase)) return;
      await this.rememberChannelSessionFromResult(rec, result);
      if (
      rec.cancelRequested &&
      (rec.method.startsWith("storage.") || rec.method.startsWith("msfile.")) &&
      rec.phase !== "rejected" &&
      rec.phase !== "failed"
    ) {
        rec.phase = "rejected";
        rec.errorCode = "user_rejected";
        rec.errorMessage = "User rejected";
        rec.failureReason = "client_canceled";
        rec.finishedAt = Date.now();
        rec.updatedAt = rec.finishedAt;
        await this.persistFeedCommandFor(rec);
        await this.replyErrorToRec(rec, "user_rejected", "User rejected");
      } else if (result) {
        rec.phase = "approved";
        rec.finishedAt = Date.now();
        rec.updatedAt = rec.finishedAt;
        await this.persistFeedCommandFor(rec);
        await this.replyResultToRec(rec, result);
        if (rec.method === "connect.logout") this.deps.applicationLoggedOut?.();
      }
      this.emitFeed();
      this.emit();
    } catch (err) {
      // Failed persistence of an approved result must still become a visible error.
      // Only an independently cancelled/timed-out request has already been replied to.
      if (rec.phase === "rejected" || rec.phase === "timed_out") return;
      const protoErr = toProtocolError(err);
      rec.phase = "failed";
      rec.errorCode = protoErr.code;
      rec.errorMessage = protoErr.message;
      rec.failureReason = "storage_error";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, protoErr.code, protoErr.message);
      this.emitFeed();
      this.emit();
    } finally {
      rec.abortController = undefined;
    }
  }

  private readonly providerDispatch = createProviderDispatch<RequestRecord, MethodResult | null>({
    "payment.channel.register": rec => this.executePaymentChannelRegister(rec),
    "identity.get": rec => this.executeIdentityGet(rec),
    "intent.sign": rec => this.executeIntentSign(rec),
    "cipher.encrypt": rec => this.executeCipherEncrypt(rec),
    "cipher.decrypt": rec => this.executeCipherDecrypt(rec),
    "p2pkh.transfer": async rec => { await this.executeP2pkhTransferAndFinalize(rec); return null; },
    "payment.pay": rec => this.executePaymentPay(rec),
    "payment.status": rec => this.executePaymentStatus(rec),
    "feepool.prepare": async rec => { await this.executeFeepoolPrepareAndFinalize(rec); return null; },
    "feepool.commit": async rec => { await this.executeFeepoolCommitAndFinalize(rec); return null; },
    "connect.login": rec => this.executeConnectLogin(rec),
    "connect.resume": rec => this.executeConnectResume(rec),
    "connect.logout": rec => this.executeConnectLogout(rec),
    "connect.launch": rec => this.executeConnectLaunch(rec),
    "channel.publish": rec => this.executeChannelPublish(rec),
    "channel.subscription_set": rec => this.executeChannelSubscriptionSet(rec),
    "storage.list": rec => this.executeStorageList(rec),
    "storage.directory.create": rec => this.executeStorageDirectoryCreate(rec),
    "storage.directory.delete": rec => this.executeStorageDirectoryDelete(rec),
    "storage.put": rec => this.executeStoragePut(rec),
    "storage.get": rec => this.executeStorageGet(rec),
    "storage.delete": rec => this.executeStorageDelete(rec),
    "msfile.stat": rec => this.executeMsfileStat(rec),
    "msfile.seed.read": rec => this.executeMsfileSeedRead(rec),
    "msfile.block.read": rec => this.executeMsfileBlockRead(rec),
  });

  private async dispatch(rec: RequestRecord): Promise<MethodResult | null> {
    try {
      return await this.providerDispatch.get(rec.method)!(rec);
    } catch (err) {
      // 业务错误：本地 record 写 failed + 对外回真实 errCode（p2pkh /
      // feepool 已经内部 catch 处理过）；这里只是兜底。
      let errCode: ProtocolErrorCode;
      let errMessage: string;
      let localReason: ProtocolFailureReason | undefined;
      if (rec.cancelRequested) {
        errCode = "user_rejected";
        errMessage = "User rejected";
        localReason = "client_canceled";
        rec.phase = "rejected";
      } else if (err && typeof err === "object" && "localReason" in err) {
        localReason = (err as { localReason?: unknown }).localReason as
          | ProtocolFailureReason
          | undefined;
        errCode = "user_rejected";
        errMessage = "User rejected";
      } else {
        const protoErr = toProtocolError(err);
        errCode = protoErr.code;
        errMessage = protoErr.message;
      }
      if (!rec.cancelRequested) rec.phase = "failed";
      rec.errorCode = errCode;
      rec.errorMessage = errMessage;
      rec.failureReason = localReason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, errCode, errMessage);
      return null;
    }
    return null;
  }

  private async requireStorageContext(rec: RequestRecord, walletPublicKeyHex: string): Promise<AppStorageClient> {
    const service = this.currentStorageController();
    if (!service || !this.deps.bindAppStorage) throw protocolError("storage_unavailable", "Storage service is unavailable");
    const session = await this.requireConnectSession(rec, walletPublicKeyHex);
    if (!session.appIdentity) throw protocolError("storage_identity_required", "Storage requires a verified app identity proof snapshot");
    if (!session.ownerPublicKeyHex) throw protocolError("storage_identity_required", "Storage requires an active owner");
    const summary = await service.summary();
    if (!summary.walletGeneration) throw protocolError("storage_unavailable", "Storage requires an initialized wallet");
    const lifecycle = this.deps.walletState.snapshot();
    return this.deps.bindAppStorage({ ...session.networkIdentity, walletPublicKeyHex: session.ownerPublicKeyHex, transportOrigin: rec.origin,
      appIdentity: session.appIdentity, sessionEpoch: lifecycle.sessionEpoch,
      walletGeneration: summary.walletGeneration, runGeneration: lifecycle.runGeneration,
    });
  }

  private async executeStorageList(rec: RequestRecord): Promise<StorageListResult> {
    const params = rec.params as import("@keymaster/contracts").StorageListParams;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.list( { prefix: params.prefix, cursor: params.cursor, limit: params.limit, signal: rec.abortController?.signal });
  }

  private async executeStorageDirectoryCreate(rec: RequestRecord): Promise<StorageDirectoryResult> {
    const params = rec.params as import("@keymaster/contracts").StorageDirectoryParams;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.createDirectory( { path: params.path, overwrite: params.overwrite, signal: rec.abortController?.signal });
  }

  private async executeStorageDirectoryDelete(rec: RequestRecord): Promise<StorageDirectoryResult> {
    const params = rec.params as import("@keymaster/contracts").StorageDirectoryParams;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.deleteDirectory( { path: params.path, signal: rec.abortController?.signal });
  }

  private async executeStoragePut(rec: RequestRecord): Promise<StoragePutResult> {
    const params = rec.params as import("@keymaster/contracts").StoragePutParams;
    rec.payloadSize = params.content.bytes.byteLength;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.put( { path: params.path, content: params.content, contentType: params.contentType, overwrite: params.overwrite, signal: rec.abortController?.signal });
  }

  private async executeStorageGet(rec: RequestRecord): Promise<StorageGetResult> {
    const params = rec.params as import("@keymaster/contracts").StorageGetParams;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.getRange( { path: params.path, offset: params.offset, length: params.length, ifMatch: params.ifMatch, signal: rec.abortController?.signal });
  }

  private async executeStorageDelete(rec: RequestRecord): Promise<StorageDeleteResult> {
    const params = rec.params as import("@keymaster/contracts").StorageDeleteParams;
    const client = await this.requireStorageContext(rec, params.walletPublicKeyHex);
    return client.delete( { path: params.path, signal: rec.abortController?.signal });
  }

  /* ============== MSFile 执行 ============== */

  private async requireMsfileContext(
    rec: RequestRecord,
    walletPublicKeyHex: string
  ): Promise<{ service: MsFileService; context: MsFileConnectAppContext }> {
    const service = this.currentMsfileService();
    if (!service) throw protocolError("msfile_unavailable", "MSFile service is unavailable");
    const session = await this.requireConnectSession(rec, walletPublicKeyHex);
    if (!session.appIdentity) {
      throw protocolError("msfile_identity_required", "MSFile requires a verified app identity proof snapshot");
    }
    return {
      service,
      context: {
        ...session.networkIdentity,
        walletPublicKeyHex: session.ownerPublicKeyHex,
        transportOrigin: rec.origin,
        ownerPublicKeyHex: session.ownerPublicKeyHex,
        appIdentity: session.appIdentity
      }
    };
  }

  private async executeMsfileStat(rec: RequestRecord): Promise<MsFileStatResult> {
    const params = rec.params as import("@keymaster/contracts").MsFileStatParams;
    const { service, context } = await this.requireMsfileContext(rec, params.walletPublicKeyHex);
    return service.connect.stat(context, { seedHashHex: params.seedHashHex, signal: rec.abortController?.signal });
  }

  private async executeMsfileSeedRead(rec: RequestRecord): Promise<MsFileReadResult> {
    const params = rec.params as import("@keymaster/contracts").MsFileSeedReadParams;
    const { service, context } = await this.requireMsfileContext(rec, params.walletPublicKeyHex);
    return service.connect.readSeed(context, {
      sourceId: params.sourceId,
      seedHashHex: params.seedHashHex,
      signal: rec.abortController?.signal
    });
  }

  private async executeMsfileBlockRead(rec: RequestRecord): Promise<MsFileReadResult> {
    const params = rec.params as import("@keymaster/contracts").MsFileBlockReadParams;
    const { service, context } = await this.requireMsfileContext(rec, params.walletPublicKeyHex);
    return service.connect.readBlock(context, {
      sourceId: params.sourceId,
      seedHashHex: params.seedHashHex,
      blockHashHex: params.blockHashHex,
      signal: rec.abortController?.signal
    });
  }

  /* ============== 执行身份 / 签名 / 加解密 ============== */

  private async executeIdentityGet(rec: RequestRecord): Promise<IdentityGetResult> {
    const params = rec.params as IdentityGetParams;
    if (params.aud !== rec.origin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    // 施工单 2026-06-28 002 硬切换：subject 取自 session 绑定 owner，
    // 不再读钱包全局 active key。session 真值在 accept 阶段已预校验
    // 过一次；执行阶段再校验一次防"中段时间窗"内 session 注销 / 失效。
    // 施工单 2026-06-30 002 硬切换：签名 / 公钥派生走统一 owner
    // runtime resolver（`bootstrap_runtime` / `vault_runtime` 来源对外
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    const publicKeyBytes = await this.fetchPublicKeyBytesWithSession(session);
    const label = session.ownerLabel;

    const { resolvedClaims, projection } = buildClaimProjectionFromParams(params, {
      activeKeyLabel: label
    });

    const envelopeInput: CborValue[] = [
      2,
      rec.transportRequestId,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      publicKeyBytes,
      projection.map(([name, val]) => [name, valToCbor(val)]),
      session.networkIdentity.bsvNetwork
    ];
    const envelopeCbor = cborEncode(envelopeInput);
    const signature = await this.signWithSessionOwner(session, envelopeCbor, "identity");

    return {
      identityEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature),
      subject: { publicKey: toBinaryField(publicKeyBytes) },
      resolvedClaims
    };
  }

  private async executeIntentSign(rec: RequestRecord): Promise<IntentSignResult> {
    const params = rec.params as IntentSignParams;
    if (params.aud !== rec.origin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    // 签名主体公钥取自 session 绑定 owner；走统一 `resolveOwnerRuntime`
    // resolver，两条来源（`bootstrap_runtime` / `vault_runtime`）对外行为一致。
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    const publicKeyBytes = await this.fetchPublicKeyBytesWithSession(session);
    const contentSha256 = sha256Bytes(new Uint8Array(params.content.bytes));
    const envelopeCbor = cborEncode([
      2,
      rec.transportRequestId,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      params.contentType,
      contentSha256,
      publicKeyBytes,
      session.networkIdentity.bsvNetwork
    ]);
    const signature = await this.signWithSessionOwner(session, envelopeCbor, "intent", new Uint8Array(params.content.bytes));
    return {
      signedEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature)
    };
  }

  private async executeCipherEncrypt(rec: RequestRecord): Promise<CipherEncryptResult> {
    const params = rec.params as CipherEncryptParams;
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    const siteKey = await this.deriveSiteKeyWithSession(session, rec.origin);
    const inner = cborEncode([
      PROTOCOL_VERSION,
      params.contentType,
      new Uint8Array(params.content.bytes)
    ]);
    const { nonce, cipherbytes } = aesGcmEncrypt(siteKey, inner);
    await this.touchConnectSession(session);
    return {
      nonce: toBinaryField(nonce),
      cipherbytes: toBinaryField(cipherbytes)
    };
  }

  private async executeCipherDecrypt(rec: RequestRecord): Promise<CipherDecryptResult> {
    const params = rec.params as CipherDecryptParams;
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    let siteKey: Uint8Array;
    try {
      siteKey = await this.deriveSiteKeyWithSession(session, rec.origin);
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    let plain: Uint8Array;
    try {
      plain = aesGcmDecrypt(
        siteKey,
        new Uint8Array(params.nonce.bytes),
        new Uint8Array(params.cipherbytes.bytes)
      );
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    let decoded: CborValue;
    try {
      decoded = cborDecode(plain);
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    if (!Array.isArray(decoded) || decoded.length !== 3) {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    const [v, contentType, contentBytes] = decoded;
    if (
      v !== PROTOCOL_VERSION ||
      typeof contentType !== "string" ||
      !(contentBytes instanceof Uint8Array)
    ) {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    await this.touchConnectSession(session);
    return {
      contentType,
      content: toBinaryField(contentBytes)
    };
  }

  /* ============== connect.login / connect.resume / connect.logout（施工单 2026-06-28 001） ============== */

  /**
   * 校验所有业务方法 / connect.* 用的 connect session 真值。
   *
   * 校验项（缺一不可）：
   *   - sessionId 对应的 ConnectSessionRecord 必须存在；
   *   - session.origin === rec.origin（不允许跨 origin 复用 session）；
   *   - session.revokedAt === null（已吊销 session 立即拒掉）；
   *   - session.ownerPublicKeyHex 对应的 key 必须仍存在且 identityStatus
   *     === "ready"（已删 / failed / uninitialized 一律拒掉）。
   *
   * 失败语义：
   *   - session 不存在 / 跨 origin / 已 revoked / owner 不 ready 一律对外
   *     回 `user_rejected`；本地 reason 写 `internal_error`（具体原因
   *     不对外暴露，避免 site 通过 result 反推本地状态）。
   *   - K-V 不可用时也按 internal_error 拒掉——cipher / connect.* / 业务
   *     方法路径不接受"session 不可查"的中间态。
   *   - 跨 origin 单独走 `invalid_origin`（与 identity.get 同语义），
   *     其它失败统一 `user_rejected`。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - accept 阶段已校验过 session 真值；执行阶段再校验一次防"中段时间
   *     窗"内 session 被 logout / key 被删除——"旧请求漂进新 session" /
   *     "session 失效但旧 request 继续跑"都是不允许的。
   */
  private async requireConnectSession(
    rec: RequestRecord,
    sessionId: string
  ): Promise<ConnectSessionRecord> {
    if (!this.deps.storageRepository) {
      throw localFailure("internal_error", "connect session storage unavailable");
    }
    if (!sessionId) {
      throw localFailure("internal_error", "connect session id missing");
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding({ ...rec.networkIdentity, publicKeyHex: sessionId }, rec.origin);
    } catch (err) {
      throw protocolError("internal_error", "connect session storage unavailable");
    }
    if (!session) {
      // 重新做一次更精确的区分：可能是被删 / 被 revoke / 跨 origin。
      // 跨 origin 必须给 caller `invalid_origin` 让其能定位问题；
      // 其它统一 `user_rejected`。
      let raw: ConnectSessionRecord | null = null;
      try {
        raw = await this.deps.storageRepository.getConnectSession(rec.networkIdentity, rec.origin);
      } catch {
        throw localFailure("internal_error", "connect session storage unavailable");
      }
      if (raw && raw.origin !== rec.origin) {
        throw protocolError("invalid_origin", "connect session origin mismatch");
      }
      throw localFailure("internal_error", "connect session not found / revoked");
    }
    this.assertWalletGeneration(rec);
    this.receiver.assertCurrent(rec.protocol);
    // 施工单 2026-06-30 002 硬切换：session 真值上不再带 runtime 来源。
    if (!session.networkIdentity || session.networkIdentity.publicKeyHex.toLowerCase() !== session.ownerPublicKeyHex.toLowerCase() || !sameNetworkIdentity(session.networkIdentity, rec.networkIdentity)) throw localFailure("session_owner_mismatch", "Connect network identity mismatch");
    // 业务路径一律走 `resolveOwnerRuntime(session)`；accept 阶段
    // 不再为 `runtimeBinding === "vault"` 这条已删除的旧路径预校验
    // owner key——执行阶段 `resolveOwnerRuntime` 走 `bootstrap_runtime`
    // → `vault_runtime` 顺序按当前窗口状态决定能不能拿到 runtime。
    return session;
  }

  /**
   * 硬切换 002 收尾：protocol 层显式校验 session owner == 当前
   * active key。硬门禁（`walletState.openOwnerAppStore` 要求
   * `active === input.publicKeyHex`）会在底层挡掉，但「Key storage
   * is not ready」是偶发底层错误，**不**适合作为协议失败语义。
   * 提前在协议层以 `user_rejected / session_owner_mismatch` 显式
   * fail-closed，让 caller / UI 拿到明确错误。
   *
   * 边界：
   *   - 任何用到 `session.ownerPublicKeyHex` 调
   *     `p2pkh.transfer` / `feepool.prepare` 走 P2PKH value 的入口
   *     都必须先过这个断言。
   *   - 「不依赖 owner」的命令（不需要 P2PKH value 的命令）**不**
   *     走这个断言。
   */
  private assertSessionOwnerIsActive(session: ConnectSessionRecord): void {
    const active = this.deps.walletState.snapshot().activePublicKeyHex;
    if (!active) {
      throw localFailure(
        "session_owner_mismatch",
        "connect session owner is not bound to current active key: no active key"
      );
    }
    if (active !== session.ownerPublicKeyHex || !this.deps.walletState.snapshot().activeKeyIdentity || !sameNetworkIdentity(this.deps.walletState.snapshot().activeKeyIdentity!, session.networkIdentity)) {
      throw localFailure(
        "session_owner_mismatch",
        `connect session owner is not bound to current active key: session=${session.ownerPublicKeyHex}, active=${active}`
      );
    }
  }

  /**
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换）：`ownerKeyId` **不**允许
   * 落 session 持久化；执行时按 `ownerPublicKeyHex` → walletState.getKey() →
   *
   * 施工单 2026-06-30 002 硬切换：本方法仅在 `resolveOwnerRuntime`
   * 走 `vault_runtime` 来源时调用；`bootstrap_runtime` 来源直接拿
   * `sessionRuntimeBootstrap.crypto`。
   */
  private async resolveOwnerKeyMaterial(
    ownerPublicKeyHex: string
  ): Promise<{ publicKeyHex: string; label: string } | null> {
    const key = this.requireCurrentOwnerKey(ownerPublicKeyHex);
    if (!key) return null;
    return { publicKeyHex: key.publicKeyHex, label: key.label };
  }

  /**
   * 单 Key 本地钱包下的 owner 身份解析（docs/存储.md）。
   *
   * 系统里只有一把 Key，所以 `walletState` 不再提供 `getKey(hex)`：这里的
   * 「按公钥查 Key」退化为「这个公钥就是当前唯一 Key 吗」。业务对象与 Connect
   * session 里的 `ownerPublicKeyHex` 仍然是证据与身份核对字段，必须与当前
   * 身份严格比对，但它们不能用来列举或切换第二把 Key。
   *
   * 返回 undefined 表示：当前没有已解锁的 Key，或者该公钥不是当前唯一 Key。
   */
  private requireCurrentOwnerKey(ownerPublicKeyHex: string): KeyIdentity | undefined {
    const active = this.deps.walletState.snapshot().activePublicKeyHex;
    if (!active || active.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) return undefined;
    try {
      return requireUnlockedWalletIdentity(this.deps.walletState.snapshot());
    } catch {
      // active() 已投影但 requireUnlockedWalletIdentity() 失败 = 锁定过渡态：同样 fail closed。
      return undefined;
    }
  }

  /**
   * 统一 owner execution runtime resolver（施工单 2026-06-30 002 硬切换）。
   *
   * 设计缘由：
   *   - 业务方法（`identity.*` / `intent.sign` / `cipher.*` / `p2pkh.transfer` /
   *     `feepool.*`）**统一**走这一个入口解析 owner 执行
   *     材料；**不**再各自手写：
   *       - `walletState.getKey(...)`
   *       - `vault.createActiveKeyCrypto(...)`
   *       - 直接读 `walletState.snapshot()` 的 active key
   *   - 解析顺序固定为：
   *       1. **`bootstrap_runtime`**：当前 Session Window 内存里已
   *          bootstrap 注入的 owner runtime；命中后直接拿私钥 hex，
   *          **不**再读 walletState / vault。这是 launcher 启动早期
   *          与 `vault.locked` 态下的主要来源。
   *       2. `connect` mode 下，若 bootstrap 不存在，才允许走
   *          `vault_runtime`：当前窗口 vault 已 unlocked 且
   *          `ownerPublicKeyHex` 对应的 key 可读 → 用
   *          `vault.createActiveKeyCrypto(publicKeyHex)` 取 capability。
   *       3. `appView` mode 下，bootstrap 缺失即 fail-closed，不再回退
   *          到 `vault_runtime`。
   *       4. 解析失败：抛 `runtime_missing`（对外 `user_rejected`）。
   *   - 业务方法拿到的 `OwnerKeyResolution` 与签名 / 加解密链路
   *     共享同一份 owner 真值——cipher / intent.sign / p2pkh / feepool
   *     走同一条 owner 解析路径。
   */
  private async resolveOwnerRuntime(
    session: ConnectSessionRecord
  ): Promise<OwnerExecutionRuntime> {
    // 1) bootstrap_runtime 来源：拿当前窗口已注入的 owner runtime。
    const bootEntry = this.ownerRuntimesBySessionId.get(session.ownerPublicKeyHex);
    if (bootEntry) {
      const runtime = bootEntry.runtime;
      // 公钥比较统一 toLowerCase：launcher 端可能用大小写不一。
      if (runtime.ownerPublicKeyHex.toLowerCase() !== session.ownerPublicKeyHex.toLowerCase() || !sameNetworkIdentity(runtime.networkIdentity, session.networkIdentity)) {
        throw localFailure(
          "internal_error",
          "owner runtime ownerPublicKeyHex mismatch"
        );
      }
      return {
        ownerPublicKeyHex: session.ownerPublicKeyHex,
        source: "bootstrap_runtime",
        crypto: runtime.crypto
      };
    }
    if (this.bootModeValue === "appView") {
      throw localFailure(
        "runtime_missing",
        "appView bootstrap runtime missing: session was started without launcher capability"
      );
    }
    // 2) vault_runtime 来源：仅 connect mode 下才允许本窗口 vault 解锁后从本地 vault 重建。
    let crypto;
    try {
      crypto = await this.deps.vault.createActiveKeyCrypto();
    } catch {
      throw localFailure(
        "runtime_missing",
        "owner runtime not available in current window: please reopen the app from Keymaster"
      );
    }
    return {
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      source: "vault_runtime",
      crypto
    };
  }

  /**
   * 用 session 绑定的 owner public key 派生站点密钥。
   *
   * 设计缘由：cipher.* 必须基于 session 绑定的 key；**不**读取钱包全局
   * active key。
   *
   * 施工单 2026-06-30 002 硬切换：cipher 路径改走
   * `resolveOwnerRuntime(session)` 统一入口；无论 runtime 来源
   * （`bootstrap_runtime` / `vault_runtime`），对外行为完全一致。
   */
  private async deriveSiteKeyWithSession(
    session: ConnectSessionRecord,
    exactOrigin: string
  ): Promise<Uint8Array> {
    return deriveSiteKey(session.ownerPublicKeyHex, exactOrigin, session.networkIdentity.bsvNetwork);
  }

  /**
   * 从 `rec` 上拿 connect session 真值（施工单 2026-06-30 002）。
   *
   * `vault.createActiveKeyCrypto(publicKeyHex)`；本单让所有业务方法统一走
   * `resolveOwnerRuntime` 后，session 真值通过 `rec.walletPublicKeyHex`
   * + `fetchSessionForBinding` 取出。
   */
  private async requireSessionFromRec(
    rec: RequestRecord
  ): Promise<ConnectSessionRecord> {
    if (!rec.walletPublicKeyHex) {
      throw localFailure("internal_error", "rec.walletPublicKeyHex missing");
    }
    const session = await this.fetchSessionForBinding({ ...rec.networkIdentity, publicKeyHex: rec.walletPublicKeyHex }, rec.origin);
    if (!session) {
      throw localFailure("internal_error", "connect session not found");
    }
    return session;
  }

  /**
   * 在 session 绑定的 owner 私钥上做 secp256k1 签名（compact 64 字节）。
   *
   * 施工单 001 硬切换：显式请求 compact 格式。
   */
  private async signWithSessionOwner(
    session: ConnectSessionRecord,
    bytes: Uint8Array,
    kind: "identity" | "intent",
    content?: Uint8Array
  ): Promise<Uint8Array> {
    const resolution = await this.resolveOwnerRuntime(session);
    if(resolution.crypto.signConnectEnvelope) {
      resolution.crypto.getIdentity();
      // cborg can return Node Buffer in the native host; Buffer.slice() aliases a larger slab.
      // Construct an ordinary Uint8Array so only the exact envelope enters the capability.
      const result=await resolution.crypto.signConnectEnvelope({ kind, envelope:new Uint8Array(bytes).buffer as ArrayBuffer, ...(content ? {content:new Uint8Array(content).buffer as ArrayBuffer} : {}), appSessionId:session.sessionId });
      resolution.crypto.getIdentity();
      if(result.format!=="compact"||result.signature.byteLength!==64||result.publicKeyHex!==resolution.ownerPublicKeyHex)throw new Error("Invalid Connect signature result");
      return new Uint8Array(result.signature);
    }
    return signCompactSecp256k1(async (digest) => {
      const result = await resolution.crypto.signDigest({ digest: digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer, format: "compact" });
      // P0: 校验回包 format 为 compact
      if (result.format !== "compact") {
        throw new Error(
          `signWithSessionOwner format mismatch: requested "compact", got "${result.format}"`
        );
      }
      return new Uint8Array(result.signature);
    }, bytes);
  }

  /**
   * 取 session 绑定的 owner 压缩公钥字节（envelope / subject 字段用）。
   *
   */
  private async fetchPublicKeyBytesWithSession(
    session: ConnectSessionRecord
  ): Promise<Uint8Array> {
    const resolution = await this.resolveOwnerRuntime(session);
    return hexToBytes(resolution.ownerPublicKeyHex);
  }

  /**
   * 更新 session.lastUsedAt。该写入属于授权 session 的用户可见真值，
   * 因此主路径必须等待并传播存储错误。
   */
  private async touchConnectSession(session: ConnectSessionRecord): Promise<void> {
    if (!this.deps.storageRepository) {
      throw new Error("connect session storage unavailable");
    }
    const next: ConnectSessionRecord = { ...session, lastUsedAt: Date.now() };
    await this.deps.storageRepository.putConnectSession(next);
    session.lastUsedAt = next.lastUsedAt;
  }

  /**
   * 执行 connect.login。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - ownerPublicKeyHex 必须是用户在 UI 上选定的那把 key 公钥 hex
   *     （来自当前钱包；用户在 confirmConnectLogin 时确认）；
   *   - owner 唯一真值 = `ownerPublicKeyHex`；`ownerKeyId` **不**落
   *   - owner key 必须在 walletState 内可查，且 identityStatus === "ready"；
   *   - K-V 不可用时直接拒掉（fail-closed）。
   */
  private async executeConnectLogin(rec: RequestRecord): Promise<ConnectLoginResult> {
    const params = rec.params as ConnectLoginParams;
    const ownerPublicKeyHex = rec.ownerPublicKeyHex;
    if (!ownerPublicKeyHex) {
      throw localFailure("internal_error", "connect.login: no owner selected");
    }
    const key = this.requireCurrentOwnerKey(ownerPublicKeyHex);
    if (!key) {
      throw localFailure("internal_error", "connect.login: owner key not found");
    }
    // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready。
    if (!this.deps.storageRepository) {
      throw localFailure("internal_error", "connect.login: session storage unavailable");
    }
    // 一次解析 claims 真值快照（与 identity.get 同语义，但不构造
    // envelope / signature）。仅 user-provided claim 不在 builtin claim
    // 里时落 "unresolved"，与现有 claim projection 行为一致。
    //
    // 不直接复用 buildClaimProjectionFromParams：它要求 params 是
    // IdentityGetParams 类型；connect.login 没有 aud/iat/exp 语义，
    // 只用 `claims` 列表走 builtin claim 解析。
    const resolvedClaims = resolveClaims(params.claims, (name) =>
      resolveBuiltinClaim(name, { activeKeyLabel: key.label })
    );
    let appIdentity: AppIdentitySnapshot | undefined;
    if (params.appIdentity) {
      try {
        verifyAppIdentityProof(params.appIdentity);
        this.assertLoginRequirements(params.appIdentity, Boolean(key.publicKeyHex));
        appIdentity = verifyAppIdentityProof(params.appIdentity);
      } catch (error) {
        if (error instanceof AppIdentityValidationError) throw localFailure("internal_error", error.message);
        throw error;
      }
    }
    const now = Date.now();
    const sessionId = await this.connectBindingKey(key, rec.origin);
    const record: ConnectSessionRecord = {
      sessionId,
      origin: rec.origin,
      networkIdentity: projectNetworkIdentity(key),
      ownerPublicKeyHex: key.publicKeyHex,
      ownerLabel: key.label,
      claimsSnapshot: resolvedClaims,
      ...(appIdentity ? { appIdentity } : {}),
      // 施工单 2026-06-30 002 硬切换：session 真值收口为三元组
      // （sessionId + origin + ownerPublicKeyHex），**不**写
      // `runtimeBinding`——执行路径走统一 owner runtime resolver，
      // 不再依赖 session 真值上的分叉。
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    };
    await this.deps.storageRepository.putConnectSessionAndRevokeOriginPeers(record);
    return {
      walletPublicKeyHex: key.publicKeyHex,
      networkIdentity: projectNetworkIdentity(key),
      ownerPublicKeyHex: key.publicKeyHex,
      resolvedClaims: resolvedClaims,
      resolvedAt: now,
      ...(appIdentity ? { appIdentity } : {})
    };
  }

  /**
   * 执行 connect.resume。
   *
   * 关键不变量：
   *   - session 真值必须仍在 K-V 内（rec.connectResumeSnapshot 由
   *     `bootstrapConnectResumeRecord` 在 acceptRequest 时预填，执行时
   *     仍以 K-V 当前值为准；中间态变化以 K-V 为真值）；
   *   - origin / revokedAt / owner ready 三道闸在执行时**重新**校验一次
   *     （即使 popup 当前文档 unlock runtime 仍在，session 也可能被外部
   *     logout / key 删除 / 别的 tab 改 K-V）；
   *   - 失败语义与 cipher 路径一致。
   */
  private async executeConnectResume(rec: RequestRecord): Promise<ConnectResumeResult> {
    const params = rec.params as ConnectResumeParams;
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    const storageRepository = this.deps.storageRepository;
    if (!storageRepository) {
      throw localFailure("internal_error", "connect.resume: session storage unavailable");
    }
    const key = this.requireCurrentOwnerKey(session.ownerPublicKeyHex);
    if (!key) {
      throw localFailure("internal_error", "connect.resume: owner key not found");
    }
    // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready。
    const now = Date.now();
    const next: ConnectSessionRecord = { ...session, lastUsedAt: now };
    await storageRepository.putConnectSession(next);
    return {
      walletPublicKeyHex: session.ownerPublicKeyHex,
      networkIdentity: session.networkIdentity,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      resolvedClaims: session.claimsSnapshot,
      resolvedAt: now,
      ...(session.appIdentity ? { appIdentity: session.appIdentity } : {})
    };
  }

  /**
   * 执行 connect.logout。
   *
   * 关键不变量（施工单 2026-06-28 001 硬切换 4.4 / 5.1.3）：
   *   - 找不到 session 不算错——返回 ok=true，revokedAt 取当前时刻
   *     （幂等 logout）；
   *   - 跨 origin 的 sessionId 直接拒掉（`requireConnectSessionForCipher`
   *     的 origin 校验一致语义）；
   *   - 写 revokedAt 失败时按 internal_error 拒掉——caller 必须能感知
   *     logout 没真正生效，否则下一次 resume 仍可能成功。
   *   - **执行成功后**清掉 popup 当前 unlock runtime：调 `vault.lock()`。
   *     这是施工单 4.4 + 5.1.3 明确要求的"清掉 popup unlock runtime"。
   *     `vault.locked` 事件触发 popup 顶层 `vault.onStatusChange` 监听，
   *     调用 `syncWalletState()`：
   *       - 当前 executing 的 logout request 走完，结果照常发；
   *       - 其它 confirming / queued request 进入 waiting_unlock_manual
   *         （与现有 relock 行为一致）；
   *       - vault.lock 内部还会 publish `vault.locked` 事件，业务插件
   *         释放 namespace 资源。
   *   - logout 在 locked 路径上的"幂等成功"也调 vault.lock——只要 caller
   *     显式 logout，就清 unlock runtime；不允许"logout 成功但 vault 还
   *     unlocked"的中间态。
   */
  private async executeConnectLogout(rec: RequestRecord): Promise<ConnectLogoutResult> {
    const params = rec.params as ConnectLogoutParams;
    if (!this.deps.storageRepository) {
      throw localFailure("internal_error", "connect.logout: session storage unavailable");
    }
    const existing = await this.deps.storageRepository.getConnectSession(rec.networkIdentity, rec.origin);
    const now = Date.now();
    let result: ConnectLogoutResult;
    if (!existing) {
      // 幂等：session 不存在也直接回 ok=true。site 自己应当处理
      // "sessionId 本地丢失 → 不需要 logout"的情况，但即使重复 logout
      // 也不报错。
      result = {
        walletPublicKeyHex: params.walletPublicKeyHex,
        revokedAt: now
      };
    } else if (existing.origin !== rec.origin) {
      throw protocolError("invalid_origin", "connect.logout: session origin mismatch");
    } else if (existing.revokedAt !== null) {
      // 已 revoke 视为幂等成功。
      result = {
        walletPublicKeyHex: existing.ownerPublicKeyHex,
        revokedAt: existing.revokedAt
      };
    } else {
      const next: ConnectSessionRecord = { ...existing, revokedAt: now };
      await this.deps.storageRepository.putConnectSession(next);
      result = {
        walletPublicKeyHex: existing.ownerPublicKeyHex,
        revokedAt: now
      };
    }
    // revoke 成功后，立刻清掉当前窗口内该 session 的 bootstrap runtime。
    // 这一步不依赖 vault.lock 成功与否：session 一旦 logout，旧 owner
    // capability 就不应继续常驻内存。
    this.clearSessionRuntimeBootstrap(result.walletPublicKeyHex, "logout");
    await this.currentStorageController()?.abortSession(result.walletPublicKeyHex);
    await this.currentMsfileService()?.abortSession(result.walletPublicKeyHex);
    // 清掉 popup 当前 unlock runtime。**同步** await：施工单 4.4 + 5.1.3
    // 要求 logout 同时"吊销 session + 清 popup unlock runtime"——
    // 任意一步失败即视为 logout 不完整；fire-and-forget 会让 caller 在
    // vault.lock 抛出（例如 walletState.onVaultLocked 失败 / 业务订阅者抛
    // 错）时仍收到 ok=true，导致"session 已吊销但 unlock runtime 还在"
    // 的状态错位。
    //
    // 副作用：K-V 里 session.revokedAt 已被本次写入；即使 vault.lock
    // 抛错、对外回 ok=false，session 真值层面 logout 已生效——下次
    // connect.resume / cipher.* 仍会按 fail-fast 路径失败（session
    // revoked）。这是 fail-closed 的安全语义，不是 bug。
    // App logout revokes its own connection, never locks the shared main wallet.
    if (!this.deps.hostedApplication) {
      try {
        requireVaultCommandAccepted(await this.deps.vault.lock(), "lock");
      } catch {
        throw localFailure("internal_error", "connect.logout: vault lock failed");
      }
    }
    return result;
  }

  /* ============== connect.launch（施工单 2026-06-29 001 硬切换） ============== */

  /**
   * 执行 connect.launch。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换）：
   *   - `connect.launch` 是 `appView` mode 下 client app 的唯一首登入口；
   *     消费 launcher 在 bootstrap 阶段交给 Session Window 的 launchToken。
   *   - 不在 `connect` mode 下使用；非 appView mode 一律 fail-closed。
   *   - launchToken 必须存在、未消费；caller origin 必须与 bootstrap 期
   *     launcher 给的 `app.appOrigin` 一致。
   *   - launchToken 一次性消费；成功立即标记 consumed=true。
   *   - 成功结果与 `connect.login` 对齐：返回 sessionId + owner + claims
   *     快照。后续 caller 走同一套 connect.resume / cipher.*。
   */
  private async executeConnectLaunch(rec: RequestRecord): Promise<ConnectLaunchResult> {
    if (this.bootModeValue !== "appView") {
      throw localFailure(
        "internal_error",
        "connect.launch only allowed in appView mode"
      );
    }
    const params = rec.params as ConnectLaunchParams;
    if (!params.launchToken) {
      throw protocolError("invalid_request", "connect.launch: missing launchToken");
    }
    if (!params.appIdentity) {
      throw protocolError("invalid_request", "connect.launch: appIdentity is required");
    }
    let suppliedIdentity: AppIdentitySnapshot;
    try { suppliedIdentity = verifyAppIdentityProof(params.appIdentity); }
    catch (error) { throw protocolError("invalid_request", error instanceof Error ? error.message : "connect.launch: invalid appIdentity"); }
    const record = this.launchTokensByToken.get(params.launchToken);
    if (!record) {
      throw localFailure("internal_error", "connect.launch: unknown launchToken");
    }
    if (record.consumed) {
      throw localFailure("internal_error", "connect.launch: launchToken already consumed");
    }
    if (record.appOrigin !== rec.origin) {
      throw protocolError(
        "invalid_origin",
        "connect.launch: caller origin does not match bootstrap app origin"
      );
    }
    // 校验 Session Window 当前 appViewContext 与 token 记录一致——避免
    // "token 与当前 app 不匹配" 的中间态。
    const ctx = this.currentAppViewContext;
    if (!ctx || ctx.appId !== record.appId || ctx.appOrigin !== record.appOrigin) {
      throw localFailure(
        "internal_error",
        "connect.launch: appViewContext not aligned with launchToken"
      );
    }
    if (!this.deps.storageRepository) {
      throw localFailure(
        "internal_error",
        "connect.launch: session storage unavailable"
      );
    }
    // 校验 session 真值（与 connect.resume 同一路径）：session 不存在 /
    // 已 revoke / origin 不匹配 / owner 不 ready 都拒掉。
    const session = await this.deps.storageRepository.getConnectSession(record.networkIdentity, record.appOrigin);
    if (!session) {
      throw localFailure(
        "internal_error",
        "connect.launch: connect session not found"
      );
    }
    if (session.revokedAt !== null) {
      throw localFailure(
        "internal_error",
        "connect.launch: connect session revoked"
      );
    }
    if (session.origin !== record.appOrigin) {
      throw protocolError(
        "invalid_origin",
        "connect.launch: session origin mismatch"
      );
    }
    if (!session.appIdentity || session.appIdentity.identityDigestHex !== suppliedIdentity.identityDigestHex) {
      throw protocolError("invalid_request", "connect.launch: appIdentity does not match launcher proof");
    }
    // 施工单 2026-06-30 002 硬切换：session 真值上不再带 runtime 来源；
    // `connect.launch` 校验的不是 `runtimeBinding`，而是
    // `sessionId + origin + ownerPublicKeyHex` 三元组 + 当前窗口能
    // 解析到 owner runtime。具体说来：
    //   - launchToken 必须存在、未消费；
    //   - 上面已经校过 token 与 appViewContext 一致；
    //   - 上面已经校过 session 的 origin 与 owner 与 bootstrap 同源；
    //   - `resolveOwnerRuntime(session)` 应在 `drainExecutionQueue` 阶段
    //     通过 probe 验证过；如果到这里仍然解析不到，再单独做一次
    //     兜底校验，明确告诉用户"runtime 丢失请重新打开 app"。
    await this.resolveOwnerRuntime(session);
    const now = Date.now();
    const next: ConnectSessionRecord = { ...session, lastUsedAt: now };
    await this.deps.storageRepository.putConnectSession(next);
    // 消费 token：一次性，幂等。只有 session 真值写入成功后才消费，
    // 这样失败可由调用方观察并重试，而不会留下半成功的内存状态。
    this.launchTokensByToken.set(params.launchToken, { ...record, consumed: true });
    return {
      walletPublicKeyHex: session.ownerPublicKeyHex,
      networkIdentity: session.networkIdentity,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      resolvedClaims: session.claimsSnapshot,
      resolvedAt: now,
      ...(session.appIdentity ? { appIdentity: session.appIdentity } : {})
    };
  }

  /* ============== channel.*（施工单 2026-09-02） ==============

   * Connect App 的 Channel 请求只使用 Session Window 已验证的 transport
   * context。owner、公钥签名、消息编号、时间和 SSP 投递全部由 Coordinator
   * 完成；协议页不接触私钥、Supplier、Wire 或远端历史。
   */

  private channelCallerFor(context: {
    networkIdentity: NetworkIdentity;
    origin: string;
    sessionId: string;
    ownerPublicKeyHex: string;
  }): import("@keymaster/contracts").ConnectChannelCaller {
    return {
      ...context.networkIdentity,
      walletPublicKeyHex: context.ownerPublicKeyHex,
      origin: context.origin,
      ownerPublicKeyHex: context.ownerPublicKeyHex
    };
  }

  private async rememberChannelSessionFromResult(
    rec: RequestRecord,
    result: MethodResult | null
  ): Promise<void> {
    if (
      rec.method !== "connect.login" &&
      rec.method !== "connect.resume" &&
      rec.method !== "connect.launch"
    ) {
      return;
    }
    if (!result || typeof result !== "object") return;
    const value = result as {
      walletPublicKeyHex?: unknown;
      ownerPublicKeyHex?: unknown;
    };
    if (
      typeof value.walletPublicKeyHex !== "string" ||
      value.walletPublicKeyHex.length === 0 ||
      typeof value.ownerPublicKeyHex !== "string" ||
      value.ownerPublicKeyHex.length === 0
    ) {
      return;
    }
    const epoch = this.channelSessionEpoch;
    const session = await this.deps.storageRepository?.getConnectSession(rec.networkIdentity, rec.origin);
    if (!session || epoch !== this.channelSessionEpoch) return;
    const previous = this.channelSessionBySource.get(rec.source);
    if (previous && previous.sessionId !== session.sessionId) {
      this.deps.connectChannelRuntime?.release(this.channelCallerFor(previous));
      this.channelSubscriptionsBySessionId.delete(previous.sessionId);
      this.channelQuotaBySessionId.delete(previous.sessionId);
    }
    this.channelSessionBySource.set(rec.source, {
      networkIdentity: rec.networkIdentity,
      origin: rec.origin,
      sessionId: session.sessionId,
      ownerPublicKeyHex: value.ownerPublicKeyHex,
      epoch: this.channelSessionEpoch
    });
  }

  private releaseAllChannelSessions(): void {
    for (const context of this.channelSessionBySource.values()) {
      try {
        this.deps.connectChannelRuntime?.release(this.channelCallerFor(context));
      } catch {
      }
    }
    this.channelSubscriptionsBySessionId.clear();
    this.channelQuotaBySessionId.clear();
  }

  private async requireChannelContext(rec: RequestRecord): Promise<{
    networkIdentity: NetworkIdentity;
    sessionId: string;
    origin: string;
    ownerPublicKeyHex: string;
  }> {
    const context = this.channelSessionBySource.get(rec.source);
    if (
      !context ||
      context.epoch !== this.channelSessionEpoch ||
      context.origin !== rec.origin ||
      context.ownerPublicKeyHex !== rec.walletPublicKeyHex ||
      context.ownerPublicKeyHex !== rec.ownerPublicKeyHex
    ) {
      throw localFailure("runtime_missing", "Channel transport session is no longer valid");
    }
    const session = await this.requireConnectSession(rec, context.ownerPublicKeyHex);
    if (
      session.origin !== context.origin ||
      session.ownerPublicKeyHex !== context.ownerPublicKeyHex ||
      session.revokedAt !== null
    ) {
      throw localFailure("runtime_missing", "Channel Connect session is no longer valid");
    }
    return context;
  }

  private reserveChannelPublish(sessionId: string, content: ChannelPublishParams["content"]): () => void {
    const now = Date.now();
    const bucket = this.channelQuotaBySessionId.get(sessionId) ?? {
      publishes: [],
      bytes: [],
      inFlight: 0
    };
    bucket.publishes = bucket.publishes.filter((at) => now - at < 10_000);
    bucket.bytes = bucket.bytes.filter((entry) => now - entry.at < 10_000);
    const encoded = JSON.stringify(content);
    const size = new TextEncoder().encode(encoded ?? "null").byteLength;
    if (bucket.publishes.length >= 32) {
      throw protocolError("invalid_request", "channel.publish frequency limit exceeded");
    }
    if (bucket.bytes.reduce((total, entry) => total + entry.size, 0) + size > 512 * 1024) {
      throw protocolError("invalid_request", "channel.publish byte limit exceeded");
    }
    if (bucket.inFlight >= 4) {
      throw protocolError("invalid_request", "channel.publish concurrency limit exceeded");
    }
    bucket.publishes.push(now);
    bucket.bytes.push({ at: now, size });
    bucket.inFlight++;
    this.channelQuotaBySessionId.set(sessionId, bucket);
    return () => {
      const current = this.channelQuotaBySessionId.get(sessionId);
      if (current) current.inFlight = Math.max(0, current.inFlight - 1);
    };
  }

  private async executeChannelPublish(rec: RequestRecord): Promise<ChannelPublishResult> {
    const params = rec.params as ChannelPublishParams;
    const context = await this.requireChannelContext(rec);
    if (isReservedInboxChannel(params.channel)) {
      throw protocolError("invalid_request", "bsv8.inbox.* is a reserved private channel");
    }
    const runtime = this.deps.connectChannelRuntime;
    if (!runtime) throw localFailure("runtime_missing", "Channel runtime is unavailable");
    const release = this.reserveChannelPublish(context.sessionId, params.content);
    try {
      return await runtime.publish(this.channelCallerFor(context), params);
    } finally {
      release();
    }
  }

  private async executeChannelSubscriptionSet(
    rec: RequestRecord
  ): Promise<ChannelSubscriptionSetResult> {
    const params = rec.params as ChannelSubscriptionSetParams;
    const context = await this.requireChannelContext(rec);
    if (params.channels.length > 64) {
      throw protocolError("invalid_request", "channel.subscription_set exceeds 64 channels");
    }
    for (const channel of params.channels) {
      validateExactChannel(channel);
      if (isReservedInboxChannel(channel)) {
        throw protocolError("invalid_request", "bsv8.inbox.* is a reserved private channel");
      }
    }
    const runtime = this.deps.connectChannelRuntime;
    if (!runtime) throw localFailure("runtime_missing", "Channel runtime is unavailable");
    const result = await runtime.subscriptionSet(
      this.channelCallerFor(context),
      [...params.channels]
    );
    if (result.channels.length === 0) {
      this.channelSubscriptionsBySessionId.delete(context.sessionId);
    } else {
      this.channelSubscriptionsBySessionId.set(context.sessionId, [...result.channels]);
    }
    return result;
  }

  private dispatchChannelMessageReceived(event: ChannelMessageReceivedEvent): void {
    const message = event;
    for (const [source, context] of this.channelSessionBySource) {
      if (context.epoch !== this.channelSessionEpoch) continue;
      if (!this.channelSubscriptionsBySessionId.get(context.sessionId)?.includes(message.channel)) {
        continue;
      }
      const data: ChannelMessageReceivedEventData = {
        channel: message.channel,
        publisherPublicKeyHex: message.publisherPublicKeyHex,
        messageId: message.messageId,
        content: message.content
      };
      this.postEventMessage(source, context.origin, {
        v: PROTOCOL_VERSION,
        type: "event",
        event: "channel.message_received",
        data
      });
    }
  }

  /* ============== payment.pay / payment.status ============== */

  private async executePaymentPay(rec: RequestRecord): Promise<PaymentPayResult> {
    const params = rec.params as PaymentPayParams;
    const p2pkhService = this.currentP2pkhService();
    if (!p2pkhService?.prepareTransfer) throw protocolError("internal_error", "p2pkh service not available");
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    this.assertSessionOwnerIsActive(session);
    if (!session.appIdentity) throw protocolError("identity_required", "Connect payment requires a verified app identity");
    const repo = this.deps.storageRepository;
    if (!repo?.claimConnectPayment || !repo.putConnectPayment || !repo.getConnectPayment) {
      throw protocolError("internal_error", "Connect payment idempotency storage is unavailable");
    }
    const publicAssetId = params.assetId ?? (session.networkIdentity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet");
    const internalAssetId = toInternalP2pkhAssetId(publicAssetId);
    const normalized = normalizePaymentPayParams(params, publicAssetId);
    const identity = {
      origin: rec.origin,
      ownerPublicKeyHex: session.ownerPublicKeyHex.toLowerCase(),
      network: session.networkIdentity.bsvNetwork,
      appId: session.appIdentity.appId,
      publisherPublicKeyHex: session.appIdentity.publisherPublicKeyHex.toLowerCase(),
    };
    const assertBoundPayment = () => {
      this.assertWalletGeneration(rec);
      this.receiver.assertCurrent(rec.protocol);
      this.assertSessionOwnerIsActive(session);
    };
    const requestDigest = paymentRequestDigest(identity, normalized);
    const key = paymentRequestKey(identity, params.clientRequestId);
    const now = Date.now();
    const record: ProtocolConnectPaymentRecord = {
      key,
      paymentId: this.nextRecordId(),
      clientRequestId: params.clientRequestId,
      origin: identity.origin,
      ownerPublicKeyHex: identity.ownerPublicKeyHex,
      networkIdentity: session.networkIdentity,
      appId: identity.appId,
      publisherPublicKeyHex: identity.publisherPublicKeyHex,
      requestDigest,
      params: normalized,
      status: "pending",
      recipientOwnership: "unknown",
      createdAt: now,
      updatedAt: now,
    };
    let claimed: { created: boolean; record: ProtocolConnectPaymentRecord };
    try {
      claimed = await repo.claimConnectPayment(record, { maxPending: 64 });
    } catch (error) {
      if (error instanceof Error && error.message === "payment-pending-limit") {
        throw protocolError("payment_pending_limit", "Too many pending Connect payments for this origin");
      }
      throw error;
    }
    if (!claimed.created) {
      if (claimed.record.requestDigest !== requestDigest) throw protocolError("id_conflict", "clientRequestId was already used with different payment facts");
      const existing = await this.refreshConnectPaymentFromManager(rec, claimed.record);
      rec.paymentStatus = existing.status;
      return paymentResultFromRecord(existing);
    }
    let current = claimed.record;
    let submissionStarted = false;
    try {
      assertBoundPayment();
      const channelId = await publisherPaymentChannelId(session.appIdentity.publisherPublicKeyHex, params.paymentType, session.networkIdentity.bsvNetwork);
      assertBoundPayment();
      if (params.channelId !== channelId) throw protocolError("invalid_request", "Register a publisher single-payment channel before creating a new payment");
      const paymentSessionId = await publisherPaymentSessionId(session.sessionId);
      void paymentSessionId;
      assertBoundPayment();
      const preview = await p2pkhService.prepareTransfer({
        paymentContext: { channelId: params.channelId, sessionId: paymentSessionId },
        amountSatoshis: params.amountSatoshis,
        feeRateSatoshisPerKb: params.feeRateSatoshisPerKb ?? DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB,
        payment: {
          paymentId: current.paymentId,
          clientRequestId: params.clientRequestId,
          paymentType: params.paymentType,
          businessKind: params.businessKind,
          recipient: params.recipient,
          appId: identity.appId,
          appName: session.appIdentity.appName,
          origin: identity.origin,
          publisherPublicKeyHex: identity.publisherPublicKeyHex,
        },
      });
      assertBoundPayment();
      const payment = (preview as { payment?: import("@keymaster/contracts").P2pkhConnectPaymentPreview }).payment;
      if (!payment) throw new Error("Connect payment preview is missing its frozen plan");
      current = {
        ...current,
        allocationId: (preview as { managerAllocationId?: string }).managerAllocationId,
        previewId: (preview as { previewId?: string }).previewId,
        recipientOwnership: payment.recipientOwnership,
        feeSatoshis: Number(payment.feeSats),
        changeSatoshis: Number(payment.changeAmountSats),
        updatedAt: Date.now(),
      };
      current = await storeConnectPaymentRecord(repo, current);
      assertBoundPayment();
      rec.paymentPreview = payment;
      const permitted = await readApplicationPermissions(repo, rec.applicationKey!);
      assertBoundPayment();
      rec.autoApproved = permitted.includes("payment.pay");
      if (!rec.autoApproved) {
        const approved = await new Promise<boolean>(resolve => {
          rec.paymentApproval = resolve;
          this.setRecordPhase(rec.recordId, "confirming");
          const timeout = this.resolveConfirmTimeoutSnapshot(rec.origin);
          this.startConfirmTimeout(rec.recordId, timeout.initialSeconds, timeout.startedFromFallback);
          this.emit(); this.emitFeed();
        });
        if (!approved) throw protocolError("user_rejected", "External payment was not approved");
      }
      assertBoundPayment();
      submissionStarted = true;
      const submitted = await p2pkhService.submitTransfer({ ...preview, ownerPublicKeyHex: identity.ownerPublicKeyHex } as never);
      const reason = submitted.error ?? submitted.reason ?? "";
      const status: import("@keymaster/contracts").ConnectPaymentStatus =
        submitted.status === "local-confirmed" && submitted.txid
          ? submitted.delivery === "already-known" ? "already_known" : "accepted"
          : submitted.status === "not-dispatched" && reason === "cancelled"
            ? "not_signed"
            : "unknown";
      const candidateTxid = typeof submitted.txid === "string" && /^[0-9a-f]{64}$/iu.test(submitted.txid) ? submitted.txid.toLowerCase() : undefined;
      current = {
        ...current,
        status,
        ...(candidateTxid ? { txid: candidateTxid } : {}),
        ...(reason ? { reason: reason.slice(0, 256) } : {}),
        updatedAt: Date.now(),
      };
      current = await storeConnectPaymentRecord(repo, current);
      rec.paymentStatus = current.status;
      if (this.isTerminalPhase(rec.phase)) await this.persistFeedCommandFor(rec);
      return paymentResultFromRecord(current);
    } catch (error) {
      current = {
        ...current,
        status: submissionStarted ? "unknown" : "not_signed",
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 256),
        updatedAt: Date.now(),
      };
      current = await storeConnectPaymentRecord(repo, current).catch(() => current);
      rec.paymentStatus = current.status;
      if (this.isTerminalPhase(rec.phase)) await this.persistFeedCommandFor(rec);
      return paymentResultFromRecord(current);
    }
  }

  /** Pure manager/outbox lookup plus protocol CAS; no signing, query start or chain I/O. */
  private async refreshConnectPaymentFromManager(rec: RequestRecord, record: ProtocolConnectPaymentRecord): Promise<ProtocolConnectPaymentRecord> {
    const assertAuthorized = async () => {
      const session = await this.requireConnectSession(rec, record.ownerPublicKeyHex);
      this.assertSessionOwnerIsActive(session);
      if (session.origin !== record.origin || session.ownerPublicKeyHex.toLowerCase() !== record.ownerPublicKeyHex || session.networkIdentity.bsvNetwork !== record.networkIdentity.bsvNetwork || session.appIdentity?.appId !== record.appId || session.appIdentity?.publisherPublicKeyHex.toLowerCase() !== record.publisherPublicKeyHex) throw localFailure("session_owner_mismatch", "Connect payment lookup identity changed");
    };
    await assertAuthorized();
    if (["accepted", "already_known", "not_signed", "failed"].includes(record.status)) return record;
    const service = this.currentP2pkhService();
    if (!service?.getPaymentStatus) return record;
    const value = await service.getPaymentStatus({ paymentId: record.paymentId });
    await assertAuthorized();
    const manager = value;
    if (manager.status === "not_found") return record;
    if (manager.status === "pending" && record.txid) throw protocolError("id_conflict", "Signed payment lost its manager exact");
    if (manager.status === "not_signed" && (record.txid || record.status === "signed_not_dispatched" || record.release)) throw protocolError("id_conflict", "Unsigned release contradicts signed payment facts");
    if ((record.allocationId && manager.allocationId && manager.allocationId !== record.allocationId) || (record.txid && manager.txid && manager.txid !== record.txid.toLowerCase())) throw protocolError("id_conflict", "Manager payment identity/exact mismatch");
    const release = manager.conclusion ? {
      releasedSatoshis: manager.conclusion.releasedSats,
      releasedInputCount: manager.conclusion.releasedInputs.length,
      spentInputCount: manager.conclusion.spentInputs.length,
      heldInputCount: manager.conclusion.heldInputs.length,
    } : undefined;
    const updated = await storeConnectPaymentRecord(this.deps.storageRepository!, {
      ...record, status: manager.status,
      allocationId: manager.allocationId ?? record.allocationId,
      ...(manager.txid ? { txid: manager.txid } : {}),
      ...(release ? { release, reason: "input-conflict" } : manager.status === "not_signed" ? { reason: "cancelled" } : manager.status === "accepted" ? { reason: undefined } : {}),
      updatedAt: Date.now(),
    });
    await assertAuthorized();
    return updated;
  }

  private async executePaymentStatus(rec: RequestRecord): Promise<PaymentStatusResult> {
    const params = rec.params as PaymentStatusParams;
    const repo = this.deps.storageRepository;
    if (!repo?.getConnectPayment) throw protocolError("internal_error", "Connect payment storage is unavailable");
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    this.assertSessionOwnerIsActive(session);
    if (!session.appIdentity) throw protocolError("identity_required", "Connect payment status requires a verified app identity");
    const identity = {
      origin: rec.origin,
      ownerPublicKeyHex: session.ownerPublicKeyHex.toLowerCase(),
      network: session.networkIdentity.bsvNetwork,
      appId: session.appIdentity.appId,
      publisherPublicKeyHex: session.appIdentity.publisherPublicKeyHex.toLowerCase(),
    };
    let record = await repo.getConnectPayment(paymentRequestKey(identity, params.clientRequestId));
    if (!record
      || record.origin !== identity.origin
      || record.ownerPublicKeyHex !== identity.ownerPublicKeyHex
      || record.networkIdentity.bsvNetwork !== identity.network
      || record.appId !== identity.appId
      || record.publisherPublicKeyHex !== identity.publisherPublicKeyHex) {
      throw protocolError("payment_not_found", "Connect payment was not found for this identity");
    }
    if (this.currentP2pkhService()?.getPaymentStatus) {
      // The production adapter always uses the read-only Worker manager RPC.
      // No txid is needed: paymentId locates the original allocation/outbox.
      return paymentResultFromRecord(await this.refreshConnectPaymentFromManager(rec, record));
    }
    // Legacy adapters without manager lookup retain their read-only observation
    // compatibility. Production must never fall back here after lookup failure.
    // If the protocol write lost its txid, recover the exact bytes from the
    // Vault journal by paymentId. The exact is persisted before broadcast, so
    // a chain-accepted payment is still discoverable.
    void record;
    // Chain-observation reconciliation: a crash after broadcast but before
    // the terminal protocol write leaves a pending/unknown record with a
    // canonical txid. Only a trusted raw transaction with the same canonical
    // txid upgrades it; absent/unavailable observations never downgrade.
    if ((record.status === "pending" || record.status === "unknown" || record.status === "signed_not_dispatched")
      && record.txid && this.currentP2pkhService()?.getRawTransaction) {
      try {
        const raw = await this.currentP2pkhService()!.getRawTransaction!(record.txid);
        if (calcTxidFromRawTxHex(raw).toLowerCase() === record.txid.toLowerCase()) {
          record = await storeConnectPaymentRecord(repo, { ...record, status: "accepted" as const, updatedAt: Date.now() });
        }
      } catch {
        // Not observed yet (or WoC unavailable): keep the existing state.
      }
    }
    return paymentResultFromRecord(record);
  }

  /* ============== p2pkh.transfer ============== */

  private async paymentOwner(session: ConnectSessionRecord): Promise<string> {
    if (!session.appIdentity) throw protocolError("identity_required", "Payment settings require a verified publisher");
    return publisherPaymentOwner(session.appIdentity.publisherPublicKeyHex);
  }
  private async legacyPaymentOwner(session: ConnectSessionRecord): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.origin)));
    return "connect." + Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  }
  private async executePaymentChannelRegister(rec: RequestRecord): Promise<PaymentChannelRegisterResult> {
    const params = rec.params as PaymentChannelRegisterParams;
    const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
    this.assertSessionOwnerIsActive(session);
    const owner = await this.paymentOwner(session);
    const network = params.assetId === "bsv-testnet" ? "test" : "main";
    if (network !== session.networkIdentity.bsvNetwork) throw localFailure("asset_not_enabled", "Payment network differs from session identity");
    const channelId = await publisherPaymentChannelId(session.appIdentity!.publisherPublicKeyHex, params.paymentType, network);
    void channelId; void owner; void network;
    await this.requireConnectSession(rec, params.walletPublicKeyHex);
    this.assertSessionOwnerIsActive(session);
    return {channelId};
  }
  /* ============== p2pkh.transfer ============== */

  private async executeP2pkhTransferAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as P2pkhTransferParams;
    const p2pkhService = this.currentP2pkhService();
    if (!p2pkhService) {
      rec.phase = "failed";
      rec.errorCode = "internal_error";
      rec.errorMessage = "p2pkh service not available";
      rec.failureReason = "internal_error";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "internal_error", "p2pkh service not available");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：p2pkh.transfer 走 session 绑定 owner，
      // 不再读全局 active key。execute 阶段先 requireConnectSession 校验
      // session 仍有效，再把 session 绑定的 owner public key 交给
      // 走选币 + 签名）。
      const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
      const ownerPublicKeyHex = session.ownerPublicKeyHex;
      // 硬切换 002 收尾：protocol 层显式校验 session owner == 当前
      // active key。硬门禁（`walletState.openOwnerAppStore` 要求
      // `active === input.publicKeyHex`）会在底层挡掉，但「Key
      // storage is not ready」是偶发底层错误，**不**适合作为协议
      // 失败语义。提前在协议层以「session is no longer bound to
      // active key」显式 fail-closed，让 caller / UI 拿到明确错误。
      this.assertSessionOwnerIsActive(session);
      const publicAssetId = params.assetId ?? (session.networkIdentity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet");
      const internalAssetId = toInternalP2pkhAssetId(publicAssetId);
      // 渠道按 App 来源稳定注册；同一次 Connect 连接的所有渠道共享 sessionId。
      // 这里只建立零额度渠道，免确认额度只能由钱包设置提高。
      const paymentOwner = await this.paymentOwner(session);
      const paymentChannelId = params.channelId;
      const paymentSessionId = await publisherPaymentSessionId(session.sessionId);
      const expectedChannelId = await publisherPaymentChannelId(session.appIdentity!.publisherPublicKeyHex, "p2pkh", session.networkIdentity.bsvNetwork);
      if (paymentChannelId !== expectedChannelId) throw protocolError("invalid_request", "Register a publisher single-payment channel before creating a new transfer");
      void paymentSessionId; void paymentOwner;
      const card = this.feedCommands.find((c) => c.id === rec.recordId);
      if (card) {
        card.recipientAddress = params.recipientAddress;
        card.amountSatoshis = params.amountSatoshis;
        card.assetId = publicAssetId;
        card.autoApproved = rec.autoApproved;
        card.updatedAt = Date.now();
      }
      const preview = await p2pkhService.prepareTransfer({
        paymentContext: {channelId: paymentChannelId, sessionId: paymentSessionId},
        recipientAddress: params.recipientAddress,
        amountSatoshis: params.amountSatoshis,
        feeRateSatoshisPerKb: params.feeRateSatoshisPerKb ?? DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB
      });
      this.assertSessionOwnerIsActive(session);
      if (preview.ownerPublicKeyHex !== ownerPublicKeyHex) throw localFailure("session_owner_mismatch", "Transfer preview identity mismatch");
      const submitted = await p2pkhService.submitTransfer(preview);
      const txid = submitted.txid ?? preview.txid;
      const result: P2pkhTransferResult = {
        assetId: publicAssetId,
        txid,
        rawTxHex: submitted.rawTxHex,
        feeSatoshis: preview.estimatedFeeSatoshis
      };
      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyResultToRec(rec, result);
    } catch (err) {
      const reason = classifyP2pkhFailure(err);
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = reason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /* ============== feepool.prepare ============== */

  private async executeFeepoolPrepareAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as FeepoolPrepareParams;
    if (!this.deps.storageRepository) {
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = "fee_pool_db_unavailable";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：feepool 走 session 绑定 owner；
      // poolKey 补 ownerPublicKeyHex 维度（不再仅按 origin + counterparty）。
      const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
      const ownerPublicKeyHex = session.ownerPublicKeyHex;
      // 硬切换 002 收尾：feepool.prepare 会通过 `buildAndMaybeBuildBaseTx`
      // 走 `p2pkhService.listUtxos({ ownerPublicKeyHex })` 取 value。协议
      // 层必须先校验 session owner == 当前 active key，否则底层硬门禁
      // 挡掉时只会冒出「Key storage is not ready」这种偶发错误，不适
      // 合作为协议失败语义。
      this.assertSessionOwnerIsActive(session);
      const publicAssetId = params.assetId ?? (session.networkIdentity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet");
      const internalAssetId = toInternalP2pkhAssetId(publicAssetId);
      // 施工单 2026-09-18 001：池 key 带上资产维度；mainnet 保持旧 3 段
      // key 形状（不迁移历史池），testnet 追加 `::bsv-testnet`。
      const poolKey = feePoolKeyFor(
        rec.origin,
        ownerPublicKeyHex,
        params.counterpartyPublicKeyHex,
        publicAssetId
      );
      const prior = await this.deps.storageRepository.getFeePool(poolKey);
      // 旧记录没有 assetId 字段，按 mainnet 归一化后再比较。
      const priorAssetId =
        (prior as { assetId?: P2pkhTransferAssetId } | null)?.assetId ?? "bsv-mainnet";
      if (prior && priorAssetId !== publicAssetId) {
        throw localFailure(
          "internal_error",
          "fee pool record assetId does not match the requested asset"
        );
      }
      const originSettings = await this.getOriginSettingsCached(rec.origin);

      let action: ProtocolFeePoolAction;
      let nextServerAmount: number;
      if (!prior) {
        action = "create";
        nextServerAmount = params.amountSatoshis;
      } else if (prior.serverAmount + params.amountSatoshis <= prior.totalAmount) {
        action = "spend";
        nextServerAmount = prior.serverAmount + params.amountSatoshis;
      } else {
        action = "close_and_recreate";
        nextServerAmount = params.amountSatoshis;
      }

      // 施工单 2026-06-30 002 硬切换：feepool 走统一 owner runtime
      // resolver；`bootstrap_runtime` / `vault_runtime` 两条来源对外
      // 行为一致，都返回同一份 owner capability。
      const resolution = await this.resolveOwnerRuntime(session);
      const clientPublicKeyHex = resolution.ownerPublicKeyHex;
      const sourceCache=new Map<string,string>();
      const network=publicAssetId==='bsv-testnet'?'test':'main';
      const source=async(txid:string)=>{
        const cached=sourceCache.get(txid);if(cached)return cached;
        const adapter=this.currentP2pkhService();
        if(!adapter?.getRawTransaction)throw new Error('Fee pool previous transaction evidence unavailable');
        const raw=await adapter.getRawTransaction(txid);sourceCache.set(txid,raw);return raw;
      };
      const paymentOwner=await this.legacyPaymentOwner(session);
      const channelId=params.channelId;
      void paymentOwner; void channelId; void session;
      const signTransaction=(stage:'fund'|'state'):FeePoolTransactionSigner=>async rawTxHex=>{
        void stage; void rawTxHex;
        throw new Error("Connect fee-pool signing removed (approval deleted)");
      };
      const operationId = this.nextRecordId();
      const preparedAt = Date.now();
      // 交付给站点的钱包 UTXO（A-Tx 的真实输入）。它们的责任必须先落盘，
      // 再把签名字节交出去（E01）。
      const baseTxInputs: Array<{ txid: string; vout: number; value: number }> = [];

      const priorPoolSnapshot = prior
        ? {
            baseTxid: prior.baseTxid,
            totalAmount: prior.totalAmount,
            serverAmount: prior.serverAmount,
            draftSpendTxHex: prior.draftSpendTxHex
          }
        : null;

      let draftSpendTxHex = "";
      let draftClientSignBytes: Uint8Array = new Uint8Array(0);
      let draftTotalAmount = 0;
      let closeDraftTxHex: string | undefined;
      let closeClientSignBytes: Uint8Array | undefined;
      let baseTxHex: string | undefined;
      let baseTxOutputIndex: number | undefined;

      if (action === "create") {
        const poolAmount = originSettings?.feePoolDefaultFundSatoshis ?? 0;
        if (poolAmount <= 0) {
          throw localFailure("internal_error", "origin feePoolDefaultFundSatoshis not configured");
        }
        if (params.amountSatoshis > poolAmount) {
          throw localFailure(
            "internal_error",
            `amountSatoshis (${params.amountSatoshis}) exceeds pool size (${poolAmount})`
          );
        }
        const baseResp = await this.buildAndMaybeBuildBaseTx(
          prior,
          signTransaction('fund'),
          clientPublicKeyHex,
          params.counterpartyPublicKeyHex,
          poolAmount,
          ownerPublicKeyHex,
          internalAssetId
        );
        sourceCache.set(baseResp.baseTxid,baseResp.baseTxHex);
        baseTxHex = baseResp.baseTxHex;
        baseTxOutputIndex = baseResp.baseTxOutputIndex;
        draftTotalAmount = baseResp.amount;
        baseTxInputs.push(...baseResp.inputs);
        const initialDraft = await sdkBuildInitialDraftSpendTx({
          prevTxId: baseResp.baseTxid,
          totalAmount: draftTotalAmount,
          serverAmount: params.amountSatoshis,
          endHeight: 0,
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          feeRate: 1
        });
        const clientSig = await sdkClientSignInitialSpendTx({
          txHex: initialDraft.txHex,
          totalAmount: draftTotalAmount,
          signTransaction: signTransaction('state'),
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        draftSpendTxHex = initialDraft.txHex;
        draftClientSignBytes = clientSig;
      } else if (action === "spend") {
        if (!prior) throw localFailure("internal_error", "prior missing for spend");
        const loaded = await sdkLoadDraftSpendTx({
          prevDraftHex: prior.draftSpendTxHex,
          locktime: undefined,
          sequenceNumber: 0xfffffffe,
          serverAmount: nextServerAmount,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          targetAmount: prior.totalAmount
        });
        const clientSig = await sdkClientSignUpdatedSpendTx({
          txHex: loaded.txHex,
          sourceSatoshis: prior.totalAmount,
          signTransaction: signTransaction('state'),
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        draftSpendTxHex = loaded.txHex;
        draftClientSignBytes = clientSig;
        draftTotalAmount = prior.totalAmount;
      } else {
        if (!prior) throw localFailure("internal_error", "prior missing for close_and_recreate");
        const newPoolAmount = originSettings?.feePoolDefaultFundSatoshis ?? 0;
        if (newPoolAmount <= 0) {
          throw localFailure("internal_error", "origin feePoolDefaultFundSatoshis not configured");
        }
        if (params.amountSatoshis > newPoolAmount) {
          throw localFailure(
            "internal_error",
            `amountSatoshis (${params.amountSatoshis}) exceeds new pool size (${newPoolAmount})`
          );
        }
        const closeLoaded = await sdkLoadDraftSpendTx({
          prevDraftHex: prior.draftSpendTxHex,
          locktime: FINAL_LOCKTIME,
          sequenceNumber: 0xffffffff,
          serverAmount: prior.serverAmount,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          targetAmount: prior.totalAmount
        });
        const closeClientSig = await sdkClientSignUpdatedSpendTx({
          txHex: closeLoaded.txHex,
          sourceSatoshis: prior.totalAmount,
          signTransaction: signTransaction('state'),
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        closeDraftTxHex = closeLoaded.txHex;
        closeClientSignBytes = closeClientSig;
        const baseResp = await this.buildAndMaybeBuildBaseTx(
          prior,
          signTransaction('fund'),
          clientPublicKeyHex,
          params.counterpartyPublicKeyHex,
          newPoolAmount,
          ownerPublicKeyHex,
          internalAssetId
        );
        sourceCache.set(baseResp.baseTxid,baseResp.baseTxHex);
        baseTxHex = baseResp.baseTxHex;
        baseTxOutputIndex = baseResp.baseTxOutputIndex;
        draftTotalAmount = baseResp.amount;
        baseTxInputs.push(...baseResp.inputs);
        const newInitialDraft = await sdkBuildInitialDraftSpendTx({
          prevTxId: baseResp.baseTxid,
          totalAmount: draftTotalAmount,
          serverAmount: params.amountSatoshis,
          endHeight: 0,
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          feeRate: 1
        });
        const newClientSig = await sdkClientSignInitialSpendTx({
          txHex: newInitialDraft.txHex,
          totalAmount: draftTotalAmount,
          signTransaction: signTransaction('state'),
          clientPublicKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        draftSpendTxHex = newInitialDraft.txHex;
        draftClientSignBytes = newClientSig;
      }

      // 关键（施工单 2026-06-28 002 硬切换）：pending op 必须绑定
      // walletPublicKeyHex + ownerPublicKeyHex。commit 阶段按 origin +
      // walletPublicKeyHex + ownerPublicKeyHex + counterpartyPublicKeyHex
      // 四元组校验 op，禁止跨 session / 跨 owner 复用 operationId。
      this.pendingOps.set(operationId, {
        operationId,
        channelId: params.channelId,
        origin: rec.origin,
        walletPublicKeyHex: rec.walletPublicKeyHex,
        ownerPublicKeyHex,
        counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
        assetId: publicAssetId,
        action,
        preparedAt,
        baseTxHex,
        baseTxOutputIndex,
        draftSpendTxHex,
        draftClientSignBytes,
        draftTotalAmount,
        amountSatoshis: params.amountSatoshis,
        nextServerAmount,
        closeDraftTxHex,
        closeClientSignBytes,
        priorPool: prior
      });

      const card = this.feedCommands.find((c) => c.id === rec.recordId);
      if (card) {
        card.action = action;
        card.operationId = operationId;
        card.counterpartyPublicKeyHex = params.counterpartyPublicKeyHex;
        card.amountSatoshis = params.amountSatoshis;
        card.assetId = publicAssetId;
        card.updatedAt = Date.now();
      }

      // E01：签名字节交给站点之前，先把「可能已外露」的责任落盘。写失败
      // 必须拒绝交付（站点收不到签名原文）；落盘后、回复前崩溃时保守留责。
      await this.recordFeePoolDeliveries({
        operationId,
        origin: rec.origin,
        ownerPublicKeyHex,
        counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
        assetId: publicAssetId,
        channelId: params.channelId,
        sessionId: session.sessionId,
        action,
        baseTxHex,
        baseTxInputs,
        draftSpendTxHex,
        draftClientSignBytes,
        closeDraftTxHex,
        closeClientSignBytes,
        source,
      });

      const result: FeepoolPrepareResult = {
        operationId,
        action,
        assetId: publicAssetId,
        counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
        amountSatoshis: params.amountSatoshis,
        draftSpendTxHex,
        draftClientSignBytes: bytesToBinaryField(draftClientSignBytes),
        priorPoolRecord: priorPoolSnapshot
      };
      if (action === "create" || action === "close_and_recreate") {
        result.baseTxHex = baseTxHex;
        result.baseTxOutputIndex = baseTxOutputIndex;
      }
      if (action === "close_and_recreate" && closeDraftTxHex) {
        result.closeDraftTxHex = closeDraftTxHex;
        if (closeClientSignBytes) {
          result.closeClientSignBytes = bytesToBinaryField(closeClientSignBytes);
        }
      }

      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyResultToRec(rec, result);
    } catch (err) {
      let reason: ProtocolFailureReason = "internal_error";
      if (err && typeof err === "object" && "localReason" in err) {
        reason = (err as { localReason?: unknown }).localReason as ProtocolFailureReason ?? "internal_error";
      }
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = reason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /**
   * E03/E04：可信观察结算。
   *
   * 只有当链上能取到**同一笔** exact 交易原文时，才把该交付责任标记为已
   * 结算。站点承诺、404、session 结束、popup 关闭都不是证据；观察不到就
   * 继续保留责任。
   */
  private async settleObservedFeePoolDeliveries(origin: string): Promise<void> {
    const repository = this.deps.storageRepository;
    if (!repository) return;
    const p2pkhService = this.currentP2pkhService();
    if (!p2pkhService?.getRawTransaction) return;
    const records = await repository.listFeePoolDeliveriesByOrigin(origin);
    for (const record of records) {
      if (record.settledTxid) continue;
      if (record.kind !== "base-transaction") continue;
      let txid: string;
      try {
        txid = calcTxidFromRawTxHex(record.rawTxHex);
      } catch {
        continue;
      }
      const network = record.assetId === "bsv-testnet" ? "test" : "main";
      let observed: string | null = null;
      try {
        observed = await p2pkhService.getRawTransaction(txid);
      } catch {
        continue;
      }
      if (!observed) continue;
      // 观察到的必须是同一笔 exact 交易：txid 相同还不够，字节也要相同。
      let observedTxid: string;
      try {
        observedTxid = calcTxidFromRawTxHex(observed);
      } catch {
        continue;
      }
      if (observedTxid !== txid) continue;
      await repository.settleFeePoolDelivery(record.id, txid, Date.now());
    }
  }

  /* ============== feepool base tx helper ============== */

  /**
   * E01：把本次「交给站点的签名」写成持久责任。
   *
   * - `base-transaction`：完整签名的 A-Tx。站点可以在钱包之外广播它，
   *   因此钱包未派发不能证明它没被广播；责任保留到可信观察结算。
   * - `state-signature`：部分签名的 B-Tx 草稿。对方还能补齐并花费，
   *   责任同样保留。
   *
   * 每份原文按**它自己的**输入登记：旧 close 草稿花的是旧池，不能记成
   * 新池的输出点。输入的金额来自该输入的前序交易原文（可信 source bytes），
   * 不是调用方的自报值。
   *
   * 记录与 popup 会话无关：`operationId` 失效不消灭资金责任。
   * 写失败必须让调用方拒绝交付（这里抛错）。
   */
  private async recordFeePoolDeliveries(input: {
    operationId: string;
    origin: string;
    ownerPublicKeyHex: string;
    counterpartyPublicKeyHex: string;
    assetId: P2pkhTransferAssetId;
    channelId: string;
    sessionId: string;
    action: ProtocolFeePoolAction;
    baseTxHex: string | undefined;
    baseTxInputs: Array<{ txid: string; vout: number; value: number }>;
    draftSpendTxHex: string;
    draftClientSignBytes: Uint8Array;
    closeDraftTxHex: string | undefined;
    closeClientSignBytes: Uint8Array | undefined;
    source?: (txid: string) => Promise<string>;
  }): Promise<void> {
    const repository = this.deps.storageRepository;
    if (!repository) throw localFailure("internal_error", "fee pool delivery ledger unavailable");
    const now = Date.now();
    const common = {
      operationId: input.operationId,
      origin: input.origin,
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
      assetId: input.assetId,
      channelId: input.channelId,
      sessionId: input.sessionId,
      action: input.action,
      createdAt: now,
    };
    /**
     * 解析一份原文真实花费的输入，并用可信前序原文核对每个输入的金额。
     * 拿不到前序原文就拒绝交付：责任必须能定位到真实输入。
     */
    const artifactInputs = async (rawTxHex: string): Promise<Array<{ txid: string; vout: number; value: number; scriptHex: string }>> => {
      const rows: Array<{ txid: string; vout: number; value: number; scriptHex: string }> = [];
      for (const prevout of feePoolInputOutpoints(rawTxHex)) {
        let value = 0;
        let scriptHex = "";
        if (input.source) {
          const raw = await input.source(prevout.txid);
          const outputs = feePoolOutputFacts(raw);
          const output = outputs[prevout.vout];
          if (!output) throw new Error(`Fee pool previous transaction output is missing: ${prevout.txid}:${prevout.vout}`);
          value = output.value;
          scriptHex = output.scriptHex;
        }
        rows.push({ txid: prevout.txid, vout: prevout.vout, value, scriptHex });
      }
      return rows;
    };
    const records: ProtocolFeePoolDeliveryRecord[] = [];
    if (input.baseTxHex) {
      const totalInSatoshis = input.baseTxInputs.reduce((sum, row) => sum + row.value, 0);
      records.push({
        ...common,
        id: `${input.operationId}:base-transaction`,
        kind: "base-transaction",
        rawTxHex: input.baseTxHex,
        inputs: input.baseTxInputs,
        totalInSatoshis,
        reason: "signed base transaction delivered outside the wallet",
      });
    }
    if (input.draftSpendTxHex && input.draftClientSignBytes.length > 0) {
      const related = await artifactInputs(input.draftSpendTxHex);
      records.push({
        ...common,
        id: `${input.operationId}:state-signature`,
        kind: "state-signature",
        rawTxHex: input.draftSpendTxHex,
        signatureHex: bytesToHex(input.draftClientSignBytes),
        inputs: related,
        totalInSatoshis: related.reduce((sum, row) => sum + row.value, 0),
        reason: "partial signature delivered outside the wallet",
      });
    }
    if (input.closeDraftTxHex && input.closeClientSignBytes && input.closeClientSignBytes.length > 0) {
      // 旧 close 草稿花的是**旧池**：按它自己的输入登记。
      const related = await artifactInputs(input.closeDraftTxHex);
      records.push({
        ...common,
        id: `${input.operationId}:close-state-signature`,
        kind: "state-signature",
        rawTxHex: input.closeDraftTxHex,
        signatureHex: bytesToHex(input.closeClientSignBytes),
        inputs: related,
        totalInSatoshis: related.reduce((sum, row) => sum + row.value, 0),
        reason: "partial close signature delivered outside the wallet",
      });
    }
    // F08：交付前先让 UTXO Manager 占住 artifact 花费的钱包输入。否则被
    // 交付的 artifact 花掉的输入仍会被当作可花余额。占用失败即拒绝交付。
    for (const record of records) {
      // 只有**完整交易**能进 manager 的占用责任：部分签名草稿的最终字节与
      // txid 会在补齐签名后变化，不能拿草稿 txid 当 exact 的结算身份；草稿的
      // 责任留在 E01 账本（外露签名责任模型）。
      if (record.kind !== "base-transaction") continue;
      const artifact = this.deps.getP2pkhService?.() ?? this.deps.p2pkhService;
      const occupy = artifact?.occupyDeliveredArtifact?.bind(artifact);
      if (!occupy) throw new Error("P2PKH artifact occupation is unavailable; refusing to deliver");
      // 输入的金额与脚本来自**可信前序原文**；输出清单来自 artifact 本身。
      const outputs = feePoolOutputFacts(record.rawTxHex);
      const totalOut = outputs.reduce((sum, output) => sum + output.value, 0);
      const fee = record.totalInSatoshis - totalOut;
      if (fee < 0) throw new Error(`Fee pool delivery ${record.id} spends more than its inputs`);

      const wallet = bindWalletIdentity(this.deps.walletState);
      if (wallet.identity.publicKeyHex !== record.ownerPublicKeyHex || wallet.identity.bsvNetwork !== (record.assetId === "bsv-testnet" ? "test" : "main")) throw new Error("Artifact responsibility belongs to another wallet");
      const verifiedInputs = await artifactInputs(record.rawTxHex);
      wallet.assertActive();
      const occupied = await occupy({
        artifactId: record.id,
        // 形状以已签字节为准：manager 冻结的是交易骨架（不含 scriptSig）。
        unsignedTxHex: record.rawTxHex,
        signedTxHex: record.rawTxHex,
        inputs: verifiedInputs.map((row) => ({ txid: row.txid, vout: row.vout, value: String(row.value), scriptHex: row.scriptHex })),
        outputs: outputs.map((output) => ({ scriptHex: output.scriptHex, value: String(output.value) })),
        businessAmountSatoshis: String(record.totalInSatoshis),
        // 不再按实际消耗反推费率（Q05：3 sats / 192 bytes 曾被反推成
        // 16 sat/kB，与 manager 的取整叠加后判需 4 sats）。这里传 SDK 构建
        // 这些 artifact 时使用的基础费率 1 sat/kB，作为**下界**；费用授权
        // 仍由 feeCapSats（真实费用）承担，内核的签前下界检查保持原样。
        feeRateSatoshisPerKb: "1",
        feeCapSats: String(fee),
        protocolKind: record.action === "close_and_recreate" ? "close" : "state",
      });
      wallet.assertActive();
      record.managerAllocationId = occupied.allocationId;
    }
    for (const record of records) {
      const existing = await repository.getFeePoolDelivery(record.id);
      if (existing) {
        // 稳定 ID 已存在时必须检查内容一致，不能无条件跳过：同一责任 ID
        // 出现不同内容说明有东西在改写证据。
        if (existing.rawTxHex !== record.rawTxHex
          || existing.signatureHex !== record.signatureHex
          || JSON.stringify(existing.inputs) !== JSON.stringify(record.inputs)) {
          throw new Error(`Fee pool delivery record ${record.id} already exists with different content`);
        }
        continue;
      }
      await repository.putFeePoolDelivery(record);
    }
  }

  /**
   * 建 A-Tx（client P2PKH UTXO → 2-of-2 multisig output）；create /
   * close_and_recreate 复用。返回 `baseTxHex` / `baseTxOutputIndex` /
   * `baseTxid` / `amount`（multisig output 大小）。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换）：
   *   - UTXO 选币按 `ownerPublicKeyHex`（session 绑定 owner）走，**不**
   *     读全局 active key 的 namespace。`clientPrivateKeyHex` 由调用方
   *     在 plugin-p2pkh 内部必须同源。
   *   - 旧实现读 `listUtxos({ assetId: "bsv" })` 等于"取当前 active key
   *     namespace"——会与签名 key 错位。本实现强制传 owner 让 plugin-p2pkh
   *     内部按 owner 过滤 UTXO。
   */
  private async buildAndMaybeBuildBaseTx(
    prior: ProtocolFeePoolRecord | null,
    signTransaction: FeePoolTransactionSigner,
    clientPublicKeyHex: string,
    serverPublicKeyHex: string,
    poolAmount: number,
    ownerPublicKeyHex: string,
    assetId: "bsv" | "bsvtest"
  ): Promise<{
    baseTxHex: string;
    baseTxOutputIndex: number;
    baseTxid: string;
    amount: number;
    inputs: Array<{ txid: string; vout: number; value: number }>;
  }> {
    const p2pkhService = this.currentP2pkhService();
    if (!p2pkhService) {
      throw localFailure("internal_error", "p2pkh service required for fee pool base tx");
    }
    // 关键（002 硬切换）：UTXO 选币按 owner 走，**不**读全局 active key。
    // plugin-p2pkh 内部 `listUtxos` filter 已支持 `ownerPublicKeyHex`。
    // 施工单 2026-09-18 001：assetId 由调用方按公开资产映射后传入。
    const captured = this.deps.walletState.snapshot();
    const assertIdentity = () => {
      const now = this.deps.walletState.snapshot();
      if (now.sessionEpoch !== captured.sessionEpoch || !this.requireCurrentOwnerKey(ownerPublicKeyHex)
        || now.activeKeyIdentity?.bsvNetwork !== (assetId === "bsvtest" ? "test" : "main")) {
        throw localFailure("session_owner_mismatch", "Wallet identity revoked during UTXO lookup");
      }
    };
    assertIdentity();
    const projection = await p2pkhService.getAvailableUtxos();
    assertIdentity();
    if (!projection.hasResult) throw localFailure("internal_error", "Wallet UTXO result has not been obtained");
    const utxos = projection.utxos;
    if (utxos.length === 0) {
      throw localFailure(
        "internal_error",
        `No P2PKH UTXOs to fund fee pool for owner ${ownerPublicKeyHex}`
      );
    }
    const resp = await sdkBuildBaseTx({
      clientUtxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, satoshis: u.value })),
      signTransaction,
      clientPublicKeyHex,
      serverPublicKeyHex,
      feepoolAmount: poolAmount,
      feeRate: 1
    });
    return {
      baseTxHex: resp.txHex,
      baseTxOutputIndex: resp.outputIndex,
      baseTxid: resp.txid,
      amount: resp.amount,
      inputs: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
    };
  }

  /* ============== feepool.commit ============== */

  private async executeFeepoolCommitAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as FeepoolCommitParams;
    if (!this.deps.storageRepository) {
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = "fee_pool_db_unavailable";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：feepool.commit 必须按 origin +
      // walletPublicKeyHex + ownerPublicKeyHex + counterpartyPublicKeyHex
      // 四元组校验 pending op，禁止跨 session / 跨 owner 复用 operationId。
      const session = await this.requireConnectSession(rec, params.walletPublicKeyHex);
      const op = this.pendingOps.get(params.operationId);
      if (!op) {
        throw localFailure("unknown_operation", "operationId not found in current session");
      }
      if (op.origin !== rec.origin) {
        throw localFailure("cross_origin_operation", "operationId from a different origin");
      }
      if (op.channelId !== params.channelId) throw localFailure("internal_error", "operationId bound to a different payment channel");
      if (op.walletPublicKeyHex !== session.ownerPublicKeyHex) {
        throw localFailure("internal_error", "operationId from a different connect session");
      }
      if (op.ownerPublicKeyHex !== session.ownerPublicKeyHex) {
        throw localFailure("internal_error", "operationId bound to a different owner");
      }
      if (op.counterpartyPublicKeyHex !== params.counterpartyPublicKeyHex) {
        throw localFailure("internal_error", "counterpartyPublicKeyHex mismatch");
      }
      // 施工单 2026-09-18 001：commit 的资产必须与 prepare 一致；缺省
      // `bsv-mainnet`，禁止跨资产复用 operationId。
      const publicAssetId = params.assetId ?? (session.networkIdentity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet");
      if (op.assetId !== publicAssetId) {
        throw localFailure("internal_error", "operationId bound to a different asset");
      }
      if (params.counterpartySignatures.length === 0) {
        throw localFailure("internal_error", "counterpartySignatures must not be empty");
      }
      const clientPublicKeyHex = session.ownerPublicKeyHex;
      const mainServerSignBytes = binaryFieldsToBytes(params.counterpartySignatures);
      const closeServerSignBytes =
        params.closeCounterpartySignatures && params.closeCounterpartySignatures.length > 0
          ? binaryFieldsToBytes(params.closeCounterpartySignatures)
          : null;

      if (op.action === "create") {
        if (!op.draftSpendTxHex || !op.draftClientSignBytes.length) {
          throw localFailure("internal_error", "create pending op missing draft / client sign");
        }
        const draftValid = await sdkVerifyServerInitialSpendSig({
          txHex: op.draftSpendTxHex,
          totalAmount: op.draftTotalAmount,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          serverSignBytes: mainServerSignBytes
        });
        if (!draftValid) {
          throw localFailure("internal_error", "draft signature verification failed");
        }
      } else if (op.action === "spend") {
        if (!op.draftSpendTxHex || !op.draftClientSignBytes.length || !op.priorPool) {
          throw localFailure("internal_error", "spend pending op missing draft / client sign / priorPool");
        }
        const draftValid = await sdkVerifyServerUpdateSig({
          txHex: op.draftSpendTxHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          serverSignBytes: mainServerSignBytes
        });
        if (!draftValid) {
          throw localFailure("internal_error", "draft update signature verification failed");
        }
      } else {
        if (
          !op.closeDraftTxHex ||
          !op.closeClientSignBytes?.length ||
          !op.draftSpendTxHex ||
          !op.draftClientSignBytes.length
        ) {
          throw localFailure(
            "internal_error",
            "close_and_recreate pending op missing close draft / new draft / client signs"
          );
        }
        if (!closeServerSignBytes) {
          throw localFailure("internal_error", "close_and_recreate requires closeCounterpartySignatures");
        }
        const closeValid = await sdkVerifyServerUpdateSig({
          txHex: op.closeDraftTxHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          serverSignBytes: closeServerSignBytes
        });
        if (!closeValid) {
          throw localFailure("internal_error", "close draft signature verification failed");
        }
        const draftValid = await sdkVerifyServerInitialSpendSig({
          txHex: op.draftSpendTxHex,
          totalAmount: op.draftTotalAmount,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          clientPublicKeyHex,
          serverSignBytes: mainServerSignBytes
        });
        if (!draftValid) {
          throw localFailure("internal_error", "draft signature verification failed");
        }
      }

      // 施工单 2026-06-28 002 硬切换：poolKey 补 ownerPublicKeyHex 维度。
      // 施工单 2026-09-18 001：testnet 再追加资产后缀（mainnet 保持旧形状）。
      const poolKey = feePoolKeyFor(
        rec.origin,
        session.ownerPublicKeyHex,
        params.counterpartyPublicKeyHex,
        publicAssetId
      );
      let newRecord: ProtocolFeePoolRecord | null = null;
      const draftTxid = await computeTxidFromHex(op.draftSpendTxHex);
      const draftTxHex = op.draftSpendTxHex;
      let closeDraftTxid: string | undefined;

      // E03：commit 时按可信观察结算此前交付的 A-Tx 责任。观察不到就继续
      // 保留；站点没有 commit 不是证据。
      await this.settleObservedFeePoolDeliveries(rec.origin);

      if (op.action === "create" || op.action === "close_and_recreate") {
        const baseTxid = await computeTxidFromHex(op.baseTxHex ?? "");
        newRecord = {
          poolKey,
          origin: rec.origin,
          ownerPublicKeyHex: session.ownerPublicKeyHex,
          counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
          assetId: publicAssetId,
          baseTxid,
          baseTxHex: op.baseTxHex ?? "",
          totalAmount: op.draftTotalAmount,
          serverAmount: op.nextServerAmount,
          draftSpendTxHex: op.draftSpendTxHex,
          draftClientSignBytes: bytesToBinaryField(op.draftClientSignBytes),
          lastOperationId: op.operationId,
          updatedAt: Date.now()
        };
        await this.deps.storageRepository.putFeePool(newRecord);
      } else if (op.action === "spend" && op.priorPool) {
        const baseTxid = op.priorPool.baseTxid;
        const baseTxHex = op.priorPool.baseTxHex;
        newRecord = {
          poolKey: op.priorPool.poolKey,
          origin: rec.origin,
          ownerPublicKeyHex: session.ownerPublicKeyHex,
          counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
          assetId: publicAssetId,
          baseTxid,
          baseTxHex,
          totalAmount: op.draftTotalAmount,
          serverAmount: op.nextServerAmount,
          draftSpendTxHex: op.draftSpendTxHex,
          draftClientSignBytes: bytesToBinaryField(op.draftClientSignBytes),
          lastOperationId: op.operationId,
          updatedAt: Date.now()
        };
        await this.deps.storageRepository.putFeePool(newRecord);
      }
      if (op.action === "close_and_recreate" && op.closeDraftTxHex) {
        closeDraftTxid = await computeTxidFromHex(op.closeDraftTxHex);
      }
      this.pendingOps.delete(op.operationId);

      const card = this.feedCommands.find((c) => c.id === rec.recordId);
      if (card) {
        card.action = op.action;
        card.operationId = op.operationId;
        card.assetId = publicAssetId;
        card.updatedAt = Date.now();
      }

      const result: FeepoolCommitResult = {
        operationId: op.operationId,
        action: op.action,
        assetId: publicAssetId,
        draftTxid,
        draftTxHex,
        poolRecord: newRecord,
        closeDraftTxid
      };

      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyResultToRec(rec, result);
    } catch (err) {
      let reason: ProtocolFailureReason = "internal_error";
      if (err && typeof err === "object" && "localReason" in err) {
        reason = (err as { localReason?: unknown }).localReason as ProtocolFailureReason ?? "internal_error";
      }
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = reason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      await this.persistFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /* ============== vault / 私钥 helpers ============== */

  // 硬切换 002 收尾：旧 `getActiveKeyHex` / `signWithOwnerKey` /
  // `fetchPublicKeyBytes` 三个 legacy helper 已删除。vault 不再携带
  // 任何 key 域 surrogate id 维度——所有业务方法的 owner 借用都按
  // `vault.createActiveKeyCrypto(publicKeyHex)` 唯一入口走，不存在
  //
  // 路径存在；2026-07-02 硬切换收尾后 `KeyIdentity` / `KeyRef` 不再
  // 直接复用 `resolveOwnerRuntime`
  // 即可。

  /* ============== 发送 ============== */

  private async replyResultToRec(rec: RequestRecord, result: MethodResult): Promise<void> {
    this.assertWalletGeneration(rec);
    // 只在宿主适配内部 DTO；协议封包、绑定签发、失效围栏与关联终态归 Receiver。
    let wireResult: unknown = result;
    if (["connect.login", "connect.resume", "connect.launch"].includes(rec.method)) {
      const { walletPublicKeyHex: _wallet, ownerPublicKeyHex: _owner, ...identityResult } = result as ConnectLoginResult;
      wireResult = identityResult;
    } else if (rec.method === "connect.logout") wireResult = { revokedAt: (result as ConnectLogoutResult).revokedAt };
    this.receiver.replyResult(rec.protocol, wireResult as ConnectPublic.MethodResult);
  }

  private async replyErrorToRec(
    rec: RequestRecord,
    code: ProtocolErrorCode,
    errorMessage: string
  ): Promise<void> {
    this.receiver.replyError(rec.protocol, { code, message: errorMessage });
  }

  private postEventMessage(target: Window, origin: string, message: ProtocolEventMessage): void {
    this.receiver.sendEvent(target, origin, message);
  }

  private postMessage(target: Window, origin: string, message: ProtocolResultMessage): void {
    if (this.deps.postResult) {
      this.deps.postResult(target, origin, message);
      return;
    }
    try {
      target.postMessage(message, origin);
    } catch {
    }
  }

  private sendClosingBestEffort(): void {
    // 宿主只决定窗口归属，closing 帧及幂等门禁由协议栈实现。
    const target = this.requestsByRecordId.values().next().value?.source ?? this.getOpener();
    if (target) this.receiver.sendClosing(target);
  }

  private getOpener(): Window | null {
    if (this.deps.resolveOpener) {
      return this.deps.resolveOpener();
    }
    if (typeof window === "undefined") return null;
    return window.opener;
  }

  /**
   * request source 白名单校验。
   *
   * 设计缘由：
   *   - connect mode 沿用旧语义：只接受 `window.opener`；
   *   - appView mode 下真正的 transport peer 是 child app，不是 launcher；
   *   - appView 只允许一条稳定 source：
   *       - 若已绑定 `currentAppClientSource`，只接受该 source；
   *       - 否则**首条合法 child request**按 `appOrigin` 绑定 source
   *         并放行（施工单 2026-06-30 003 硬切换 4.1 + 7.1）。
   *
   * 设计缘由（首条 request 不再只限 `connect.launch`）：
   *   - 旧实现要求"首条 request 必须是 `connect.launch`"才能绑 source；
   *     这与文档"首条合法 child 协议消息即可成为 child alive 信号"
   *     的表述不一致——其他 connect.* / cipher.* / identity.* 等
   *     业务方法首条到达时会被静默拒绝，request 处理逻辑根本走不到。
   *   - 新实现：首条任意 method 只要 origin + bootstrap 校验通过，
   *     都允许绑定 + 翻 childReady + 进入正常 request 处理。
   *   - 安全兜底：命名窗口 + origin 校验两道闸；appView mode 之外
   *     仍走 connect mode 旧逻辑（opener 白名单）。
   *   - 不再需要 method 维度判断。
   */

  /* ============== 命令流（feed）+ K-V ============== */

  /**
   * 当前 record 的 phase 是否已经走到终态（不可再被 `confirmByUser` /
   * `rejectByUser` 影响，仍可作为历史展示）。
   *
   * 终态集合（与 `ProtocolCommandPhase` 同步）：
   *   approved / rejected / failed / timed_out
   *
   * 旧 `waiting_unlock` / `waiting_confirm` 是 K-V 历史 schema 上的 alias，
   * 现在新写入只会落到 `waiting_unlock_manual` / `waiting_unlock_auto`；
   * 这里把 `waiting_unlock` / `waiting_confirm` 也视为**中间态**——它们
   * 一定来自旧历史记录，按活请求区展示策略走（它们不可能出现在新写
   * 路径里）。
   */
  private isTerminalPhase(phase: ProtocolCommandPhase | "waiting_unlock" | "waiting_confirm"): boolean {
    return (
      phase === "approved" ||
      phase === "rejected" ||
      phase === "failed" ||
      phase === "timed_out"
    );
  }

  /**
   * 派生展示投影（施工单 2026-06-27 002 硬切换）。
   *
   * 规则：
   *   - 活请求区：未终态 record，按 createdAt asc；createdAt 相同时按
   *     recordId 作次级稳定排序（避免同 createdAt 抖动）。
   *   - 历史区：  终态 record，按 updatedAt desc。
   *   - 拼接顺序：活请求区在前，历史区在后。
   *
   * 入参 `records` 一般来自 `feedCommands` 或"K-V 历史 + 内存活记录"的
   * 合并结果；本函数只负责按 phase / 时间戳排序，**不**做 id 去重——
   * 调用方负责先按 id 合并（K-V + 内存合并时内存覆盖 K-V）。
   */
  private buildFeedDisplay(records: ProtocolCommandRecord[]): ProtocolCommandRecord[] {
    const live: ProtocolCommandRecord[] = [];
    const history: ProtocolCommandRecord[] = [];
    for (const r of records) {
      if (this.isTerminalPhase(r.phase)) history.push(r);
      else live.push(r);
    }
    live.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    history.sort((a, b) => b.updatedAt - a.updatedAt);
    return [...live, ...history];
  }

  /**
   * 推一条命令到当前 feed。
   *
   * 设计缘由（施工单 2026-06-27 002 硬切换）：
   *   - 旧实现：in-place 覆盖 `feedCommands[idx]`，再整体按 updatedAt
   *     desc 排序。后果：每次状态推进都会让活卡整体跳位（同类 request
   *     "借壳"接管第一格）。
   *   - 新实现：用 `buildFeedDisplay` 派生活请求区 + 历史区投影，活请
   *     求区按 createdAt asc 稳定，活卡相对顺序不被 updatedAt 驱动。
   *
   * 同 `id` 已存在时覆盖；新记录按新建字段插入。
   *
   * 切 origin 时可能携带旧 origin 的 card（如 acceptRequest 阶段尚未
   * 切完）：这里**不**主动过滤，origin 切换收口放在 `acceptRequest` +
   * `loadHistoryForOrigin` 里完成（见 `loadHistoryForOrigin` 中的
   * `currentOriginValue === origin` 守卫）。
   */
  private upsertFeedCommand(record: ProtocolCommandRecord): void {
    const idx = this.feedCommands.findIndex((c) => c.id === record.id);
    if (idx >= 0) {
      this.feedCommands[idx] = record;
    } else {
      this.feedCommands.push(record);
    }
    this.feedCommands = this.buildFeedDisplay(this.feedCommands);
    this.emitFeed();
  }

  /**
   * 把 RequestRecord 投影成 ProtocolCommandRecord，并 upsert。
   *
   * 关键（施工单 2026-06-27 002 反馈修复 + 施工单 2026-06-28 002 硬切换）：
   *   - `walletPublicKeyHex` + `ownerPublicKeyHex` 从 `rec` 字段读取——即 record
   *     创建时快照下来的值，**不**再读 `walletState.snapshot()` / 钱包全局
   *     active key。这样符合 contract `ProtocolCommandRecord.ownerPublicKeyHex`
   *     注释："record 在创建时快照的 owner public key hex"。
   *   - 后续即便用户在 popup 会话里切换 active key，旧卡片的元数据
   *     不会被污染。
   */
  private writeFeedCommandFor(rec: RequestRecord): ProtocolCommandRecord {
    const card = this.makeCommandRecord(rec);
    this.upsertFeedCommand(card);
    return card;
  }

  private async persistFeedCommandFor(rec: RequestRecord): Promise<void> {
    await this.persistRecord(this.writeFeedCommandFor(rec));
  }

  private makeCommandRecord(rec: RequestRecord): ProtocolCommandRecord {
    const isTerminal = this.isTerminalPhase(rec.phase);
    const prev = this.feedCommands.find((c) => c.id === rec.recordId);
    const status =
      rec.phase === "timed_out"
        ? "timed_out"
        : rec.phase === "waiting_unlock_manual"
        ? "waiting_unlock"
        : rec.phase === "waiting_unlock_auto"
        ? "waiting_unlock"
        : rec.phase;
    const decision = isTerminal
      ? rec.phase === "approved"
        ? "approved"
        : rec.phase === "rejected"
        ? "rejected"
        : "failed"
      : "pending";
    return {
      id: rec.recordId,
      ...(rec.applicationKey ? { applicationKey: rec.applicationKey } : {}),
      ...(rec.manualApprovedAt ? { manualApprovedAt: rec.manualApprovedAt } : {}),
      ...(rec.paymentPreview ? { paymentPreview: rec.paymentPreview } : {}),
      ...(rec.paymentStatus ? { paymentStatus: rec.paymentStatus } : {}),
      origin: rec.origin,
      requestId: rec.transportRequestId,
      method: rec.method,
      phase: rec.phase,
      decision,
      status,
      textSummary: this.summarizeText(rec.params),
      claimsSummary: this.summarizeClaims(rec.params),
      contentType: this.summarizeContentType(rec.params),
      payloadSize: rec.payloadSize ?? this.summarizePayloadSize(rec.params),
      walletPublicKeyHex: rec.walletPublicKeyHex,
      ownerPublicKeyHex: rec.ownerPublicKeyHex,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      finishedAt: rec.finishedAt,
      errorCode: rec.errorCode,
      errorMessage: rec.errorMessage,
      ...(this.summarizeRecipientAddress(rec.params)
        ? { recipientAddress: this.summarizeRecipientAddress(rec.params) }
        : {}),
      ...(this.summarizeAmountSatoshis(rec.params) !== null
        ? { amountSatoshis: this.summarizeAmountSatoshis(rec.params)! }
        : {}),
      ...(this.summarizeAssetId(rec.params) !== null
        ? { assetId: this.summarizeAssetId(rec.params)! }
        : {}),
      ...(this.summarizeCounterpartyPublicKeyHex(rec.params)
        ? { counterpartyPublicKeyHex: this.summarizeCounterpartyPublicKeyHex(rec.params) }
        : {}),
      ...(prev?.action ? { action: prev.action } : {}),
      ...(prev?.operationId ? { operationId: prev.operationId } : {}),
      ...(rec.failureReason !== undefined ? { failureReason: rec.failureReason } : {}),
      // 显式写布尔，避免手动确认路径在重建卡片时把 false 折叠成 undefined。
      autoApproved: rec.autoApproved
    };
  }

  private setRecordPhase(recordId: string, phase: ProtocolCommandPhase): void {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    rec.phase = phase;
    rec.updatedAt = Date.now();
    this.writeFeedCommandFor(rec);
  }

  private async persistRecord(record: ProtocolCommandRecord): Promise<void> {
    const storageRepository = this.deps.storageRepository;
    // 施工单 2026-06-27 001/002 明确：活请求只存在于当前 popup 会话内存，
    // popup 刷新 / 关闭后不做会话级活卡恢复。因此 command-history repository 只持久化终态；
    // 中间态（waiting_unlock_* / confirming / queued / executing）即便误写，
    // 也只会制造"UI 看起来有活卡，但内存里已经没有 request"的脏状态。
    if (!this.isTerminalPhase(record.phase)) return;
    if (!storageRepository) {
      throw new Error("Protocol command-history storage is unavailable");
    }
    try {
      await storageRepository.putCommand(record);
    } catch (err) {
      console.error("[protocol.storageRepository] persistRecord failed", {
        id: record.id,
        origin: record.origin,
        error: err instanceof Error ? err.message : String(err)
      });
      if (this.historyAvailableFlag) {
        this.historyAvailableFlag = false;
        this.emitFeed();
      }
      throw err;
    }
  }

  /**
   * 历史加载（施工单 2026-06-27 002 硬切换 + 反馈修复）。
   *
   * 行为：
   *   - 同 origin 内已有的 in-flight load 直接复用返回的 promise（避免
   *     对同 origin 重复 K-V 读取）；**不同 origin 各自独立**——
   *     `historyLoadInFlightByOrigin: Map<origin, Promise>`，不能用
   *     全局 `currentOriginValue` 判断复用（否则切到 B 时复用 A 的 in-flight）。
   *   - 加载完成后，按 recordId 合并 K-V 历史 + 内存活记录，**同 id 以
   *     内存活记录为准**；K-V 旧字段不允许覆盖当前内存里的活卡。
   *   - K-V 里若残留旧版本误写进去的中间态 record（confirming /
   *     waiting_unlock_* / queued / executing），本轮直接忽略：活请求
   *     只能来自当前 popup 会话内存，不能跨会话从 K-V "复活"。
   *   - 合并完成后用 `buildFeedDisplay` 重建展示投影（活请求区
   *     createdAt asc + 历史区 updatedAt desc）。
   *   - 加载完成 / 失败时检查 `currentOriginValue === origin`：如果当前
   *     origin 已切换（旧批次晚到），整批结果丢弃，**不**回写
   *     `feedCommands`；否则把结果写到当前视图。
   *   - 旧 origin 历史保留在 `requestsByRecordId` 里（便于切回），但
   *     `feedCommands` 始终只含**当前 origin**的投影。
   */
  private async loadHistoryForOrigin(origin: string): Promise<void> {
    // 同 origin 已有 in-flight load：复用。
    const existing = this.historyLoadInFlightByOrigin.get(origin);
    if (existing) {
      return existing;
    }
    const storageRepository = this.deps.storageRepository;
    if (!storageRepository) {
      // K-V 不可用：仅当当前 currentOrigin 仍等于本 origin 时把"不可用"
      // 状态写回 feed；旧 origin 的 in-flight 不会污染新 origin 视图。
      if (this.currentOriginValue === origin) {
        this.feedCommands = this.buildFeedDisplay(
          this.currentOriginLiveCommands(origin)
        );
        this.historyAvailableFlag = false;
        this.emitFeed();
      }
      return;
    }
    const token = ++this.historyLoadToken;
    const task = (async () => {
      try {
        const [list, originRec] = await Promise.all([
          storageRepository.listCommandsByOrigin(origin),
          storageRepository.getOrigin(origin)
        ]);
        // 批次隔离：旧 token 晚到 → 丢弃结果。
        if (token !== this.historyLoadToken) {
          return;
        }
        // 关键（002 硬切换 + cancel/timeout 测试稳定）：
        // 推迟 cache 写入到下一个 macrotask——避免在 acceptRequest 的
        // preCheckConnectSession await flush 期间同步写 cache，让
        // startConfirmTimeout 在 cache miss 状态下用 30s 兜底。
        // 直接 cache.set 会导致 002 新增的 preCheck 链路下 microtask
        // flush 时 cache 已被填充，timer 立即读到 60s 而不是兜底 30s。
        if (originRec) {
          setTimeout(() => {
            if (token !== this.historyLoadToken) return;
            this.originCache.set(origin, normalizeOriginSettings(originRec, origin));
          }, 0);
        }
        // 按 recordId 合并：内存活记录优先覆盖 K-V 旧记录。
        const mergedById = new Map<string, ProtocolCommandRecord>();
        for (const c of list) {
          if (!this.isTerminalPhase(c.phase)) continue;
          mergedById.set(c.id, c);
        }
        for (const rec of this.requestsByRecordId.values()) {
          if (rec.origin !== origin) continue;
          const card = this.makeCommandRecord(rec);
          mergedById.set(rec.recordId, card);
        }
        // 写入前再次确认 currentOrigin 没切换；否则丢弃（旧批次晚到）。
        if (this.currentOriginValue === origin) {
          this.feedCommands = this.buildFeedDisplay(
            Array.from(mergedById.values())
          );
          this.historyAvailableFlag = true;
          this.emitFeed();
        }
      } catch (err) {
        console.error("[protocol.storageRepository] loadHistoryForOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        if (token !== this.historyLoadToken) {
          return;
        }
        if (this.currentOriginValue === origin) {
          this.historyAvailableFlag = false;
          this.feedCommands = this.buildFeedDisplay(
            this.currentOriginLiveCommands(origin)
          );
          this.emitFeed();
        }
      } finally {
        this.historyLoadInFlightByOrigin.delete(origin);
      }
    })();
    this.historyLoadInFlightByOrigin.set(origin, task);
    return task;
  }

  /**
   * 取当前 origin 的内存活命令卡（不读 K-V）。
   * 用于切 origin / K-V 不可用时快速重建"当前 origin 视图"。
   */
  private currentOriginLiveCommands(origin: string): ProtocolCommandRecord[] {
    const out: ProtocolCommandRecord[] = [];
    for (const rec of this.requestsByRecordId.values()) {
      if (rec.origin !== origin) continue;
      out.push(this.makeCommandRecord(rec));
    }
    return out;
  }

  /* ============== 摘要工具 ============== */

  private summarizeText(params: MethodParams<ProtocolMethod>): string {
    const p = params as { text?: unknown };
    return typeof p.text === "string" ? p.text : "";
  }

  private summarizeClaims(params: MethodParams<ProtocolMethod>): string[] {
    const p = params as { claims?: unknown };
    if (Array.isArray(p.claims)) {
      return p.claims.filter((c): c is string => typeof c === "string");
    }
    return [];
  }

  private summarizeContentType(params: MethodParams<ProtocolMethod>): string {
    const p = params as { contentType?: unknown };
    return typeof p.contentType === "string" ? p.contentType : "";
  }

  private summarizePayloadSize(params: MethodParams<ProtocolMethod>): number {
    const p = params as {
      content?: { bytes?: { byteLength?: number } };
      cipherbytes?: { bytes?: { byteLength?: number } };
    };
    if (p.content?.bytes && typeof p.content.bytes.byteLength === "number") {
      return p.content.bytes.byteLength;
    }
    if (p.cipherbytes?.bytes && typeof p.cipherbytes.bytes.byteLength === "number") {
      return p.cipherbytes.bytes.byteLength;
    }
    return 0;
  }

  private summarizeRecipientAddress(params: MethodParams<ProtocolMethod>): string {
    const p = params as { recipientAddress?: unknown };
    return typeof p.recipientAddress === "string" ? p.recipientAddress : "";
  }

  private summarizeAmountSatoshis(params: MethodParams<ProtocolMethod>): number | null {
    const p = params as { amountSatoshis?: unknown };
    return typeof p.amountSatoshis === "number" ? p.amountSatoshis : null;
  }

  /** 施工单 2026-09-18 001：命令卡资产摘要；只认识两个公开值。 */
  private summarizeAssetId(params: MethodParams<ProtocolMethod>): P2pkhTransferAssetId | null {
    const p = params as { assetId?: unknown };
    if (p.assetId === "bsv-mainnet" || p.assetId === "bsv-testnet") return p.assetId;
    return null;
  }

  private summarizeCounterpartyPublicKeyHex(params: MethodParams<ProtocolMethod>): string {
    const p = params as { counterpartyPublicKeyHex?: unknown };
    return typeof p.counterpartyPublicKeyHex === "string" ? p.counterpartyPublicKeyHex : "";
  }

  /* ============== 工具：查找 / 状态 ============== */

  private findRequestByTransportId(
    source: Window | null,
    origin: string,
    transportRequestId: string
  ): RequestRecord | null {
    if (!source) return null;
    for (const [, rec] of this.requestsByRecordId) {
      if (
        rec.source === source &&
        rec.origin === origin &&
        rec.transportRequestId === transportRequestId
      ) {
        return rec;
      }
    }
    return null;
  }

  private isAliveRequest(rec: RequestRecord): boolean {
    return (
      rec.phase !== "approved" &&
      rec.phase !== "rejected" &&
      rec.phase !== "failed" &&
      rec.phase !== "timed_out"
    );
  }

  private isRequestCancellable(rec: RequestRecord): boolean {
    return (
      rec.phase === "waiting_unlock_manual" ||
      rec.phase === "waiting_unlock_auto" ||
      rec.phase === "confirming" ||
      rec.phase === "queued" ||
      (rec.phase === "executing" && (rec.method.startsWith("storage.") || rec.method.startsWith("msfile.")))
    );
  }

  /**
   * 取第一条 confirming record（兼容旧 UI：不传 recordId 的 confirmByUser）。
   */
  private resolveRecordForConfirm(recordId?: string): RequestRecord | null {
    if (recordId) {
      const rec = this.requestsByRecordId.get(recordId);
      if (rec && rec.phase === "confirming") return rec;
      return null;
    }
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.phase === "confirming") return rec;
    }
    return null;
  }

  /**
   * 取任意一条可取消 record（兼容旧 UI：不传 recordId 的 rejectByUser）。
   */
  private resolveRecordForCancel(recordId?: string): RequestRecord | null {
    if (recordId) {
      const rec = this.requestsByRecordId.get(recordId);
      if (rec && this.isRequestCancellable(rec)) return rec;
      return null;
    }
    for (const [, rec] of this.requestsByRecordId) {
      if (this.isRequestCancellable(rec)) return rec;
    }
    return null;
  }

  private firstAliveRequest(): RequestRecord | null {
    for (const [, rec] of this.requestsByRecordId) {
      if (this.isAliveRequest(rec)) return rec;
    }
    return null;
  }

  /**
   * 从 request store 派生"旧版"phase：用于兼容 `ProtocolSessionPhase`。
   *
   * 优先级：
   *   - error（opener 缺失）→ error
   *   - 至少一条 confirming → confirming
   *   - 至少一条 queued / executing → executing（兼容旧 UI 把它统一显示成"处理中"）
   *   - 至少一条 waiting_unlock_* → unlocking
   *   - 否则 waiting
   */
  private snapshotPhaseFromRequests(): ProtocolSessionPhase {
    if (this.phase === "error") return "error";
    let hasConfirming = false;
    let hasQueuedOrExecuting = false;
    let hasWaitingUnlock = false;
    for (const [, rec] of this.requestsByRecordId) {
      if (!this.isAliveRequest(rec)) continue;
      if (rec.phase === "confirming") hasConfirming = true;
      else if (rec.phase === "queued" || rec.phase === "executing") hasQueuedOrExecuting = true;
      else if (rec.phase === "waiting_unlock_manual" || rec.phase === "waiting_unlock_auto") hasWaitingUnlock = true;
    }
    if (hasConfirming) return "confirming";
    if (hasQueuedOrExecuting) return "executing";
    if (hasWaitingUnlock) return "unlocking";
    return "waiting";
  }
}

/* ============== helper ============== */

function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolValidationError) {
    return { code: err.code, message: err.message };
  }
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      if (e.code.startsWith("storage_") || e.code.startsWith("msfile_")) {
        return { code: e.code as ProtocolErrorCode, message: e.code };
      }
      return { code: e.code as ProtocolErrorCode, message: e.message };
    }
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : "Internal error" };
}

const CONNECT_PAYMENT_STATUS_TRANSITIONS: Record<import("@keymaster/contracts").ConnectPaymentStatus, ReadonlySet<import("@keymaster/contracts").ConnectPaymentStatus>> = {
  pending: new Set(["not_signed", "signed_not_dispatched", "unknown", "accepted", "already_known", "failed"]),
  signed_not_dispatched: new Set(["unknown", "accepted", "already_known", "failed"]),
  unknown: new Set(["not_signed", "accepted", "already_known", "failed"]),
  failed: new Set([]),
  not_signed: new Set([]),
  accepted: new Set(["already_known"]),
  already_known: new Set([]),
};

function sameConnectPaymentIdentity(left: ProtocolConnectPaymentRecord, right: ProtocolConnectPaymentRecord): boolean {
  return left.key === right.key
    && left.paymentId === right.paymentId
    && left.clientRequestId === right.clientRequestId
    && left.origin === right.origin
    && left.ownerPublicKeyHex === right.ownerPublicKeyHex
    && left.networkIdentity.bsvNetwork === right.networkIdentity.bsvNetwork
    && left.networkIdentity.publicKeyHex === right.networkIdentity.publicKeyHex
    && left.appId === right.appId
    && left.publisherPublicKeyHex === right.publisherPublicKeyHex
    && left.requestDigest === right.requestDigest
    && JSON.stringify(left.params) === JSON.stringify(right.params);
}

/** Apply only allowed monotonic transitions; immutable identity and txid win. */
function mergeConnectPaymentRecord(existing: ProtocolConnectPaymentRecord, next: ProtocolConnectPaymentRecord): ProtocolConnectPaymentRecord {
  if (!sameConnectPaymentIdentity(existing, next)) throw protocolError("id_conflict", "Connect payment immutable facts changed");
  if (next.txid && existing.txid && next.txid.toLowerCase() !== existing.txid.toLowerCase()) {
    throw protocolError("id_conflict", "Connect payment canonical txid changed");
  }
  if ((existing.allocationId && next.allocationId && existing.allocationId !== next.allocationId) || (existing.previewId && next.previewId && existing.previewId !== next.previewId)) throw protocolError("id_conflict", "Connect payment allocation/preview identity changed");
  const sameStatus = existing.status === next.status;
  if (sameStatus && existing.status === "failed") return existing;
  if (existing.reason === "input-conflict" && existing.release && (next.status === "accepted" || next.status === "already_known")) return existing;
  if (next.status === "not_signed" && (existing.txid || existing.release)) return existing;
  if (existing.release && next.release && (BigInt(next.release.releasedSatoshis) < BigInt(existing.release.releasedSatoshis) || next.release.releasedInputCount < existing.release.releasedInputCount || next.release.spentInputCount < existing.release.spentInputCount || next.release.heldInputCount > existing.release.heldInputCount)) return existing;
  if (!sameStatus && !CONNECT_PAYMENT_STATUS_TRANSITIONS[existing.status].has(next.status)) {

    return existing;
  }
  return {
    ...next,
    paymentId: existing.paymentId,
    clientRequestId: existing.clientRequestId,
    origin: existing.origin,
    ownerPublicKeyHex: existing.ownerPublicKeyHex,
    networkIdentity: existing.networkIdentity,
    appId: existing.appId,
    publisherPublicKeyHex: existing.publisherPublicKeyHex,
    requestDigest: existing.requestDigest,
    params: existing.params,
    txid: existing.txid ?? next.txid,
    allocationId: existing.allocationId ?? next.allocationId,
    previewId: existing.previewId ?? next.previewId,
    ...(next.release === undefined && existing.release ? { release: existing.release, reason: existing.reason } : {}),
    createdAt: existing.createdAt,
  };
}

/** Atomic compare-and-set status update; retries re-read and re-evaluate. */
export async function storeConnectPaymentRecord(
  repo: NonNullable<ProtocolServiceDeps["storageRepository"]>,
  record: ProtocolConnectPaymentRecord,
): Promise<ProtocolConnectPaymentRecord> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entry = repo.getConnectPaymentEntry
      ? await repo.getConnectPaymentEntry(record.key)
      : await repo.getConnectPayment?.(record.key).then((value) => value ? { record: value, revision: undefined } : null);
    if (!entry) {
      await repo.putConnectPayment!(record);
      return record;
    }
    const merged = mergeConnectPaymentRecord(entry.record, record);
    if (merged === entry.record || JSON.stringify(merged) === JSON.stringify(entry.record)) return entry.record;
    if (repo.putConnectPaymentIfRevision && entry.revision !== undefined) {
      try {
        await repo.putConnectPaymentIfRevision(merged, entry.revision);
        return merged;
      } catch {
        continue;
      }
    }
    await repo.putConnectPayment!(merged);
    return merged;
  }
  throw protocolError("internal_error", "Connect payment status update retry exhausted");
}

function normalizePaymentPayParams(params: PaymentPayParams, assetId: P2pkhTransferAssetId): PaymentPayParams {
  return {
    ...params,
    assetId,
    recipient: params.recipient.type === "p2pk"
      ? { type: "p2pk", publicKeyHex: params.recipient.publicKeyHex.toLowerCase() }
      : { type: "p2pkh", address: params.recipient.address },
  };
}

function paymentIdentityKey(identity: {
  origin: string;
  ownerPublicKeyHex: string;
  network: "main" | "test";
  appId: string;
  publisherPublicKeyHex: string;
}): string {
  return JSON.stringify([
    "keymaster.connect-payment-id.v1",
    identity.network,
    identity.origin,
    identity.ownerPublicKeyHex,
    identity.appId,
    identity.publisherPublicKeyHex,
  ]);
}

function paymentRequestKey(identity: Parameters<typeof paymentIdentityKey>[0], clientRequestId: string): string {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(JSON.stringify([paymentIdentityKey(identity), clientRequestId]))));
}

function paymentRequestDigest(identity: Parameters<typeof paymentIdentityKey>[0], params: PaymentPayParams): string {
  const recipient = params.recipient.type === "p2pkh" ? params.recipient.address : params.recipient.publicKeyHex;
  return bytesToHex(sha256Bytes(new TextEncoder().encode(JSON.stringify([
    "keymaster.connect-payment-request.v1",
    paymentIdentityKey(identity),
    params.channelId,
    params.clientRequestId,
    params.paymentType,
    params.businessKind,
    params.amountSatoshis,
    params.feeRateSatoshisPerKb ?? 0,
    params.recipient.type,
    recipient,
    params.assetId ?? "",
  ]))));
}

function paymentResultFromRecord(record: ProtocolConnectPaymentRecord): PaymentPayResult {
  const terminal = record.status === "accepted" || record.status === "already_known";
  return {
    paymentId: record.paymentId,
    clientRequestId: record.clientRequestId,
    status: record.status,
    assetId: record.params.assetId ?? (record.networkIdentity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet"),
    paymentType: record.params.paymentType,
    recipientOwnership: record.recipientOwnership,
    ...(terminal && record.txid ? { txid: record.txid } : {}),
    ...(record.feeSatoshis === undefined ? {} : { feeSatoshis: record.feeSatoshis }),
    ...(record.changeSatoshis === undefined ? {} : { changeSatoshis: record.changeSatoshis }),
    ...(record.approval === undefined ? {} : { approval: record.approval }),
    // Keep detailed failures in the local responsibility ledger, never disclose
    // wallet balances, input values or private backend diagnostics to an App.
    ...(record.reason === undefined ? {} : { reason: record.reason === "cancelled" || record.reason === "input-conflict" ? record.reason : "payment-unresolved" }),
    ...(record.release ? { release: { ...record.release } } : {}),
  };
}

function protocolError(code: ProtocolErrorCode, message: string): ProtocolError {
  return { code, message };
}

function localFailure(reason: ProtocolFailureReason, message: string): Error & {
  code: ProtocolErrorCode;
  localReason: ProtocolFailureReason;
} {
  const err = new Error(message) as Error & {
    code: ProtocolErrorCode;
    localReason: ProtocolFailureReason;
  };
  err.code = "user_rejected";
  err.localReason = reason;
  return err;
}

function classifyP2pkhFailure(err: unknown): ProtocolFailureReason {
  if (err && typeof err === "object" && "localReason" in err) {
    const r = (err as { localReason?: unknown }).localReason;
    if (typeof r === "string") return r as ProtocolFailureReason;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("insufficient") || msg.includes("no-utxos") || msg.includes("no utxo")) {
    return "insufficient_balance";
  }
  if (
    msg.includes("recipient address") ||
    msg.includes("invalid base58") ||
    msg.includes("invalid p2pkh")
  ) {
    return "invalid_address";
  }
  if (msg.includes("amount") || msg.includes("fee rate")) {
    return "invalid_amount";
  }
  return "internal_error";
}

function binaryFieldsToBytes(fields: BinaryField[]): Uint8Array {
  if (fields.length !== 1) {
    return fields[0] ? new Uint8Array(fields[0].bytes) : new Uint8Array(0);
  }
  return new Uint8Array(fields[0]!.bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBinaryField(bytes: Uint8Array): BinaryField {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return { $type: "binary" as const, bytes: ab };
}

async function computeTxidFromHex(txHex: string): Promise<string> {
  let txBytes: Uint8Array | null = null;
  try {
    txBytes = hexToBytes(txHex);
  } catch {
    txBytes = null;
  }
  if (!txBytes) {
    throw new Error("Invalid tx hex");
  }
  try {
    const { Transaction } = await import("@bsv/sdk");
    const tx = Transaction.fromHex(txHex);
    const id = tx.id("hex");
    if (typeof id === "string" && id.length === 64) return id;
  } catch {
    // SDK 不可用时走 sha256d(txBytes) 退化路径。
  }
  const first = sha256Bytes(txBytes);
  const second = sha256Bytes(first);
  return bytesToTxid(second);
}

function bytesToTxid(b: Uint8Array): string {
  const out: string[] = [];
  for (let i = b.length - 1; i >= 0; i--) {
    out.push(b[i]!.toString(16).padStart(2, "0"));
  }
  return out.join("");
}

/** Connect App 不能直接发布或订阅 owner inbox；仅 Coordinator 内部使用。 */
function isReservedInboxChannel(channel: string): boolean {
  return typeof channel === "string" && channel.startsWith("bsv8.inbox.");
}

function toBinaryField(bytes: Uint8Array, mime?: string): BinaryField {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return mime
    ? { $type: "binary" as const, bytes: ab, mime }
    : { $type: "binary" as const, bytes: ab };
}
function valToCbor(v: unknown): CborValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(valToCbor);
  if (Array.isArray(v) && v.length === 3 && v[0] === "binary" && typeof v[1] === "string" && v[2] instanceof Uint8Array) {
    return ["binary", v[1] as string, v[2] as Uint8Array];
  }
  if (typeof v === "object" && v && "$type" in v) {
    const f = v as { $type?: unknown; bytes?: unknown; mime?: unknown };
    if (f.$type === "binary" && f.bytes instanceof ArrayBuffer) {
      return new Uint8Array(f.bytes);
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex characters");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function createProtocolService(deps: ProtocolServiceDeps): ProtocolServiceImpl {
  return new ProtocolServiceImpl(deps);
}
