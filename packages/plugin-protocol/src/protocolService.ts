// packages/plugin-protocol/src/protocolService.ts
// 协议 service：transport + 校验 + 解锁/确认调度 + 全局串行执行 +
// 调用 vault / keyspace + 构造 envelope + 签名/加解密 + 命令流历史 +
// p2pkh.transfer / feepool.prepare / feepool.commit 执行。
//
// 设计缘由（施工单 2026-06-27 001 硬切换 + 施工单 2026-06-28 002 硬切换 +
// 2026-07-01 001 硬切换：移除 S3 / storage.*）：
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
//   - **所有外部业务方法**（identity.get / intent.sign / cipher.encrypt /
//     cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit）
//     强制要求 `connectSessionId` 入参（施工单 2026-06-28 002 硬切换）。
//     accept 阶段同步预校验 session 真值（fail-fast）：
//       - session 不存在 / 已 revoke / origin 不匹配 / owner key 不 ready
//         → 直接 phase=failed，对外回 user_rejected / invalid_origin；
//       - 不进 waiting_unlock / confirming / 解锁 UI。
//   - **owner 唯一真值 = `ownerPublicKeyHex`**：`ownerKeyId` **不**出现
//     在 record / result payload / 内部 pendingOp 字段里。执行时按
//     `session.ownerPublicKeyHex` 查 keyspace.getKey() 拿当前 vault 内
//     借用句柄（keyId 是 vault 内部细节，按需解析）。
//   - record 在创建时立即绑定 `connectSessionId` + `ownerPublicKeyHex`；
//     record 生命周期内**不**可漂移。执行阶段再次校验 session 仍有效
//     （logout 后同 session 下旧 request 后续执行必须失败）。
//   - `feepool` 持久化 key 维度补 `ownerPublicKeyHex`：
//     `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`，
//     同 origin 不同 owner 不再串池。
//   - `cancel(id)` 按 `source + origin + transportRequestId` 命中具体
//     request；命中后转 rejected，并写本地 `failureReason=client_canceled`；
//     对外仍回原 request 的 user_rejected。
//   - 重复 `requestId` 拒绝：同 source + origin + transportRequestId
//     只要存在未终态记录，后续相同 id 直接忽略。
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
// 隐私边界：余额不足 / 费用池缺失 / DB 不可用 / 未知 op / 跨 origin
// operationId，**全部**对外回 `user_rejected`；本地原因只写
// `ProtocolCommandRecord.failureReason`。
//
// DB 不可用差异化降级：p2pkh 仍可用（auto-approve 被禁用、manual
// confirm 仍可走通）；feepool 直接 fail-closed。
//
// 不依赖 React；可单测。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  PROTOCOL_VERSION,
  LaunchAppViewError,
  type AppBootstrapPayload,
  type AppViewContext,
  type BinaryField,
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
  type KeyspaceService,
  type LaunchAppViewInput,
  type LaunchAppViewResult,
  type LauncherBootstrapRegistry,
  type MethodParams,
  type MethodResult,
  type OwnerExecutionRuntime,
  type OwnerRuntimeBootstrap,
  type P2pkhProtocolAdapter,
  type P2pkhTransferParams,
  type P2pkhTransferResult,
  type ProtocolClosingMessage,
  type ProtocolCommandFeedState,
  type ProtocolCommandRecord,
  type ProtocolConnectAuthSnapshot,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolFailureReason,
  type ProtocolFeePoolAction,
  type ProtocolFeePoolRecord,
  type ProtocolLockSummary,
  type ProtocolMethod,
  type ProtocolOriginSettingsRecord,
  type ProtocolPopupLockState,
  type ProtocolReadyMessage,
  type ProtocolResultMessage,
  type ProtocolService,
  type ProtocolSessionPhase,
  type ProtocolSessionSnapshot,
  type ProtocolStorageDb,
  type VaultService
} from "@keymaster/contracts";
import { ProtocolValidationError, parseCancelMessage, parseRequestMessage } from "./protocolValidation.js";
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
import { consumeLauncherBootstrap, encodeOrigin, parseBootstrapToken } from "./sessionWindowBootstrap.js";
import { buildAppBootstrapPayload } from "./sessionWindowBootstrap.js";
import { installLauncherBootstrapRegistry } from "@keymaster/contracts";
import type { FeepoolPendingOpsMap } from "./feepoolOperations.js";
import {
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

/**
 * 确认超时缺省秒数（施工单 003 硬切换：per-origin 确认超时）。
 *
 * 设计缘由：
 *   - 缺省 30 秒是 per-origin 策略的保守默认值；DB / 缓存 / UI 都按
 *     "空 / 非整数 / <= 0 → 30" 规范化。
 *   - 不引入"关闭 timeout"语义：用户明确要 timeout，0 / 负数 / 空 都
 *     不视为"关闭"，而是回退到缺省 30。
 */
const DEFAULT_CONFIRM_TIMEOUT_SECONDS = 30;

/**
 * Session Window 等待 launcher bootstrap 的最长时间（施工单 2026-06-29 001）。
 *
 * 设计缘由（修复 issue #3）：
 *   - launcher 在合理时间内（如 30s）必须把 bootstrap 发过来；超过这个时间
 *     视同 launcher 已关闭 / 失败 / 走错路径。
 *   - 到点 fail-closed：UI 渲染错误态，让用户关闭 Session Window 重新从
 *     launcher 启动 app。**不**无限等待。
 */
const BOOTSTRAP_TIMEOUT_MS = 30_000;
/**
 * Session Window 等待 child `ready` 的最长时间（施工单 2026-06-30 003）。
 *
 * 设计缘由：
 *   - child `ready` 是 UI 切段信号，到点未到**只**用于提示"连接较慢"。
 *   - 到点只清等待态、提示用户，不重建 `connectSessionId` / `launchToken` /
 *     bootstrap、不偷偷重发 ready。
 *   - 旧 `APPVIEW_READY_RETRY_INTERVAL_MS`（300ms pump 间隔）已删除：
 *     `ready` 方向对称，child 自己声明 listener 就绪，Session Window
 *     不再主动 pump。
 */
const APPVIEW_READY_RETRY_WINDOW_MS = 5_000;

/**
 * Session Window 打开参数。
 *
 * 设计缘由：
 *   - 明确请求浏览器以 popup/window 形态打开，而不是普通新 tab；
 *   - 这只是请求，不是强保证；浏览器可按自己的策略降级；
 *   - **不能**带 `noopener`，否则 Session Window 拿不到 launcher 的
 *     `window.opener`，bootstrap consume 会直接失效。
 */
const SESSION_WINDOW_OPEN_FEATURES = "popup=yes,width=460,height=820,resizable=yes,scrollbars=yes";

/**
 * 把 DB 读到的 origin 记录补齐新字段默认值。**纯函数**；不改入参，不读 DB。
 */
function normalizeOriginSettings(
  rec: ProtocolOriginSettingsRecord | null | undefined,
  origin: string
): ProtocolOriginSettingsRecord {
  return {
    origin,
    p2pkhAutoApproveEnabled: rec?.p2pkhAutoApproveEnabled ?? false,
    p2pkhAutoApproveMaxSatoshis: rec?.p2pkhAutoApproveMaxSatoshis ?? 0,
    identityAutoApproveEnabled: rec?.identityAutoApproveEnabled ?? false,
    cipherAutoApproveEnabled: rec?.cipherAutoApproveEnabled ?? false,
    feePoolAutoSignMaxSatoshis: rec?.feePoolAutoSignMaxSatoshis ?? 0,
    feePoolDefaultFundSatoshis: rec?.feePoolDefaultFundSatoshis ?? 0,
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
  keyspace: KeyspaceService;
  /**
   * 可选协议存储 DB（commands / origins / feePools）。manifest 在 setup 阶段
   * 打开并通过这个钩子注入；测试里可以传一个内存 fake。`undefined` 时按
   * "历史不可用"降级（p2pkh auto-approve 关闭；feepool fail-closed）。
   */
  storageDb?: ProtocolStorageDb;
  /**
   * 可选 P2PKH 业务适配。manifest 从 plugin-p2pkh 暴露的 `p2pkh.service`
   * capability 取值注入；缺时 `p2pkh.transfer` 走 internal_error。
   */
  p2pkhService?: P2pkhProtocolAdapter;
  /** 用于调试 / 日志的 logger（任意形状）。 */
  logger?: { info?: (input: unknown) => void; warn?: (input: unknown) => void; error?: (input: unknown) => void };
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
}

/**
 * 内部 request 记录。**唯一真相源**：request store 里每条活记录 + 终态
 * 历史都对应一个 RequestRecord；recordId 与 transport requestId 解耦。
 */
interface RequestRecord {
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
  connectSessionId: string;
  /**
   * record 在创建时快照的 owner public key hex（施工单 2026-06-28 002
   * 硬切换：owner 唯一真值）。
   *
   * 业务方法：取自 `connectSession.ownerPublicKeyHex`（由 accept 阶段
   * 预校验 session 真值时同步落到 record）。
   * `connect.login`：取自用户在 UI 选定的 key（`connectLoginSelected`）。
   *
   * 后续写卡**不**再读 keyspace.active() / 钱包全局 active key；
   * 旧卡片的 `ownerPublicKeyHex` 字段保持 record 创建时的快照值，不被
   * 污染——即使用户在 popup 会话里切换 active key 也不影响。
   *
   * `ownerKeyId` **不**作为 owner 身份出现在 record / result / 分支
   * 判断里；vault 内部借用句柄按需从 keyspace.getKey() 解析。
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
  /** 本地终态原因（写本地）；隐私敏感场景与对外解耦。 */
  failureReason?: ProtocolFailureReason;
  /* ============== 施工单 2026-06-28 001：connect.* 字段 ============== */
  /**
   * `connect.login` 当前候选 key 列表（来自 `keyspace.listKeys` 过滤掉
   * 非 ready 的）。只在 `method === "connect.login"` 时有值。
   */
  connectLoginCandidates?: Array<{ publicKeyHex: string; label: string }>;
  /**
   * `connect.login` 用户在 UI 选定的那把 key 公钥 hex。用户在 confirming
   * 视图点"确认选 key"时由 `confirmConnectLogin` 写入；执行阶段读此字段。
   */
  connectLoginSelected?: string;
  /** connect.* auth 是否已经提交过；用于阻止未提交 login 被 resume 抢占。 */
  connectAuthSubmittedAt?: number;
  /**
   * `connect.resume` 进入时的 session 快照（ownerPublicKeyHex /
   * ownerLabel / claimsSnapshot）；只在 `method === "connect.resume"`
   * 时有值。confirming 视图直接拿这个做展示，不需要再查 DB。
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

const READY_MESSAGE: ProtocolReadyMessage = { v: PROTOCOL_VERSION, type: "ready" };
const CLOSING_MESSAGE: ProtocolClosingMessage = { v: PROTOCOL_VERSION, type: "closing" };

export class ProtocolServiceImpl implements ProtocolService {
  /** 会话级锁状态（施工单 2026-06-27 001 硬切换）。 */
  private lockStateValue: ProtocolPopupLockState = "locked";
  /** 旧 session phase 兼容字段：在多 request 模型下主要用于 "至少有一条 confirming / queued" 的活跃态呈现；详细见 `snapshot()`。 */
  private phase: ProtocolSessionPhase = "waiting";
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
  /** 命令流 DB 是否可用。false 时 UI 顶部显示"历史不可用"。 */
  private historyAvailableFlag: boolean;
  /**
   * DB 加载按 origin 隔离的 in-flight promise map（施工单 2026-06-27 002
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

  /** 每条 confirming request 独立的 timeout 状态。 */
  private timersByRecordId: Map<string, ConfirmTimeoutState> = new Map();

  /** feepool pending operations：仅本 popup 会话内存有效，endSession 清空。 */
  private pendingOps: FeepoolPendingOpsMap = new Map();

  /**
   * origin 配置内存 cache（同步 auto-approve 判断用）。
   */
  private originCache: Map<string, ProtocolOriginSettingsRecord> = new Map();

  /** popup 当前会话是否已经向 opener 发过 `closing`。 */
  private closingSent = false;
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
   * child app 是否已发来合法 `ready`（施工单 2026-06-30 003 硬切换）。
   *
   * 设计缘由：
   *   - `ready` 方向对称：`client web -> Session Window`。
   *   - 这是 appView UI 的"两段式"切段信号：未 ready → `show app`；
   *     ready → 切回传统 popup 界面。
   *   - `connect mode` 下恒为 false；`appView mode` 但 bootstrap 未完成
   *     时也恒为 false。
   *   - 一旦置 true 不再回 false；同 Session Window 生命周期内
   *     不可重复切段。
   */
  private childReadyFlag: boolean = false;
  /**
   * child `ready` 软超时（施工单 2026-06-30 003）。
   *
   * 设计缘由：
   *   - Session Window 不再向 child 主动泵 `ready`；因此这里的 setTimeout
   *     只表达"等待 child 主动发来 `ready`"的 5s 软超时。
   *   - 到点只把 `appClientConnectTimedOutFlag = true` 并清掉
   *     `appClientWaitingForReadyFlag`，**不**重建 `connectSessionId`、
   *     **不**重新 bootstrap、**不**偷偷重发 ready。
   *   - 旧 `appClientReadyPumpHandle`（setInterval 反复 pump ready）
   *     已删除；`ready` 职责改由 child 自己声明。
   */
  private appClientConnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private appClientConnectTimedOutFlag: boolean = false;
  /**
   * "等待 child `ready`"的活跃等待态（施工单 2026-06-30 003）。
   *
   * 设计缘由：
   *   - 用户点过 `Open App` 且 child `ready` 仍未到、5s 软超时也未触发
   *     → true；UI 据此把 `Open App` 按钮置 disabled。
   *   - child `ready` 到达、软超时触发、`Open App` 打开失败，三者任一
   *     → false。
   */
  private appClientWaitingForReadyFlag: boolean = false;

  /**
   * launchToken 内存 Map：token -> LaunchTokenRecord（V1 **不**落盘）。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换）：
   *   - launchToken 只在 Session Window 当前内存有效；Session Window 刷新
   *     / 关闭即失效。
   *   - 不允许通过 IndexedDB 持久化，避免"刷新后旧 token 仍能消费"。
   */
  private readonly launchTokensByToken: Map<
    string,
    {
      appId: string;
      appOrigin: string;
      appUrl: string;
      connectSessionId: string;
      ownerPublicKeyHex: string;
      resolvedClaims: Record<string, unknown>;
      resolvedAt: number;
      consumed: boolean;
    }
  > = new Map();

  /**
   * Session Window 当前已注册 owner runtime 内存 Map（施工单 2026-06-30 002
   * 硬切换）：
   * `connectSessionId -> { runtime: OwnerRuntimeBootstrap; createdAt: number }`。
   *
   * 设计缘由：
   *   - 来源 = `bootstrap_owner`：launcher consume bootstrap 后**只**在
   *     当前窗口内存注册 owner runtime；**不**导入 unlock runtime，
   *     **不**把 vault 切到 unlocked 态。
   *   - 与 `connectSessionId` 一一对应；业务方法按 `connectSessionId`
   *     取 runtime。runtime 不存在时 service 再尝试 `vault_unlock`
   *     来源；从 vault 借 owner 私钥 hex 提供同一份 runtime。
   *   - 两条来源对外行为一致（同一把 owner 同一份私钥 hex）；允许同一
   *     session 在窗口生命周期内从 `bootstrap_owner` 切到 `vault_unlock`。
   *   - 刷新 / 关闭 Session Window 后 bootstrap runtime 随窗口内存
   *     丢失；用户在本窗口后续 unlock 可按同 owner 从 vault 重建。
   */
  private readonly ownerRuntimesBySessionId: Map<
    string,
    { runtime: OwnerRuntimeBootstrap; createdAt: number }
  > = new Map();

  /**
   * launcher 一次性 bootstrap entries Map：token -> AppBootstrapPayload。
   *
   * 设计缘由（施工单 2026-06-29 002 硬切换 + 用户反馈 issue #1）：
   *   - launcher 同一窗口里**允许多次**点 `Open App` 各自预建 session；
   *     各次点击不能互相打断。
   *   - 旧实现每次 `launchAppView()` 都新建一个**只**含当前 token 的
   *     registry 并 `installLauncherBootstrapRegistry(window, ...)` 覆盖
   *     旧 registry；前一次还没 acquire 的 token 会被**直接覆盖**导致
   *     启动失败。
   *   - 新实现：把 entries Map 提升为 service 实例字段；首次 `launchAppView`
   *     时挂一次 launcher-side registry（其 acquire 直接读 entries Map
   *     并 delete 命中项），后续 `launchAppView` 只往 entries Map 加新
   *     token，**不**重新挂 registry。
   *   - 同一 token 仍保持"一次性消费"语义（acquire 命中即从 Map 删除）。
   */
  private readonly launcherBootstrapEntries: Map<string, AppBootstrapPayload> = new Map();
  private launcherBootstrapRegistryInstalled = false;

  /**
 * 当前 Session Window 一次性 bootstrap consume 状态。
 *
 * 设计缘由（修复 issue #1 / #3）：
 *   - 旧实现用 postMessage listener 等 launcher 推消息，存在时序竞态
 *     （launcher 在子窗口 listener 挂好之前发消息会丢失）。
 *   - 新实现：Session Window mount 时**主动**调
 *     `consumeLauncherBootstrap({ token, opener, ownOrigin, timeoutMs })`，
 *     内部走 `window.opener.__keymaster_session_window_bootstrap__
 *     .acquire(token)` 同源直接调用——**没有**时序竞态。
 *   - 该 flag 用于幂等门禁：避免重复触发 consume；startSession 时重置。
 */
  private bootstrapConsumed: boolean = false;

  /**
   * bootstrap 失败标记。
   *
   * 设计缘由（修复 issue #3）：
   *   - 旧实现失败 / 超时永远停在"等待 launcher"，对用户无意义。
   *   - 新实现：launcher registry 不存在 / acquire 抛错 / 超时 / token
   *     不命中 / vault import 失败 / payload 不全都会设置
   *     `bootstrapFailed = true`，UI 据此渲染明确错误态。
   */
  private bootstrapFailedFlag: boolean = false;
  /** bootstrap 失败原因（local reason；不进对外 result，仅本地历史）。 */
  private bootstrapFailureReasonValue: string | null = null;

  constructor(private readonly deps: ProtocolServiceDeps) {
    this.historyAvailableFlag = Boolean(deps.storageDb);
    this.bootModeValue = deps.bootMode ?? "connect";
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
    // 5. 重置会话级 phase / lockState / closing 标志。
    this.phase = "waiting";
    this.lockStateValue = this.readVaultLockState();
    this.closingSent = false;
    // 6. 清空 appView 启动上下文 + launchToken 缓存 + bootstrap 监听：
    //    Session Window 重新启动会话时不允许复用旧 launcher handoff。
    this.currentAppViewContext = null;
    this.currentAppClientSource = null;
    // 施工单 2026-06-30 003：appView UI 两段式。重启会话时 child `ready`
    // 必须重置回 false，否则新会话会在第一次启动时就直接进入 popup 阶段。
    this.childReadyFlag = false;
    this.appClientWaitingForReadyFlag = false;
    this.stopAppClientConnectTimer();
    this.launchTokensByToken.clear();
    // 施工单 2026-06-30 002 硬切换：startSession 也要清空 owner runtimes
    // 防止上一会话残留的 bootstrap runtime 干扰本会话。
    this.ownerRuntimesBySessionId.clear();
    this.bootstrapConsumed = false;
    this.bootstrapFailedFlag = false;
    this.bootstrapFailureReasonValue = null;
    this.appClientConnectTimedOutFlag = false;
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
    // 把所有未终态 request 强制收尾为 rejected（不发 result 给 opener）。
    for (const [, rec] of this.requestsByRecordId) {
      if (rec.phase === "approved" || rec.phase === "rejected" || rec.phase === "failed" || rec.phase === "timed_out") {
        continue;
      }
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
    // 与 popup 生命周期解耦，由 setVaultLockState 单独管理）。
    this.currentAppViewContext = null;
    this.currentAppClientSource = null;
    // 施工单 2026-06-30 003：endSession 同样要把 child `ready` 等待态
    // 重置；否则下次 startSession 启动新会话时等待态可能跨会话污染。
    this.childReadyFlag = false;
    this.appClientWaitingForReadyFlag = false;
    this.stopAppClientConnectTimer();
    this.appClientConnectTimedOutFlag = false;
    this.launchTokensByToken.clear();
    // 施工单 2026-06-30 002 硬切换：endSession 清空 owner runtimes。
    this.ownerRuntimesBySessionId.clear();
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
   * 读 origin 配置。DB 不可用或该 origin 尚未配置时返回 null。
   */
  async getOriginSettings(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
    if (!this.deps.storageDb) return null;
    try {
      const raw = await this.deps.storageDb.getOrigin(origin);
      if (raw) {
        const normalized = normalizeOriginSettings(raw, origin);
        this.originCache.set(origin, normalized);
        return normalized;
      }
      return null;
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.storageDb",
        event: "getOrigin.failed",
        origin,
        err: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * 写 origin 配置。DB 不可用时 throw。写入时同步刷内存 cache。
   */
  async setOriginSettings(record: ProtocolOriginSettingsRecord): Promise<void> {
    if (!this.deps.storageDb) {
      throw new Error("Protocol storage DB is not available");
    }
    const next = normalizeOriginSettings(record, record.origin);
    next.updatedAt = Date.now();
    await this.deps.storageDb.putOrigin(next);
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
    if (looksLikeReady(event.data)) {
      this.tryAcceptChildReady(event);
      return;
    }
    // 先尝试按 cancel 解析：失败 / 不是 cancel 都按 request 走。
    if (looksLikeCancel(event.data)) {
      let parsed: { id: string };
      try {
        parsed = parseCancelMessage(event.data);
      } catch {
        return;
      }
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
      this.markChildAliveFromBoundSource();
      await this.finalizeRequestByCancel(rec.recordId, "client_canceled");
      return;
    }

    if (!looksLikeRequest(event.data)) return;

    let parsed;
    try {
      parsed = parseRequestMessage(event.data);
    } catch (err) {
      if (err instanceof ProtocolValidationError) {
        return;
      }
      this.deps.logger?.error?.({
        scope: "protocol.validation",
        event: "unexpected",
        data: { err: String(err) }
      });
      return;
    }

    // transport 对端校验：
    //   - connect mode：只接受 `window.opener`；
    //   - appView mode：只接受当前 app client window；launcher 只是 bootstrap
    //     提供方，不再是运行期 request source。
    if (!this.isAllowedRequestSource(event, parsed.method)) return;

    // 施工单 2026-06-30 003 硬切换：appView mode 下首条合法 child 协议
    // 消息（无论是顶层 `ready`，还是首条 `connect.launch` 等 request）
    // 都应把 `childReady` 翻 true，让 UI 从 `show app` 切回传统 popup。
    // `isAllowedRequestSource` 已经在必要时绑定 `currentAppClientSource`，
    // 这里再统一翻 childReady + 清等待态 / 软超时提示。
    this.markChildAliveFromBoundSource();

    // 重复 requestId 拒绝：同 source + origin + transportRequestId 还有
    // 未终态记录，则忽略。
    const existing = this.findRequestByTransportId(
      event.source as Window | null,
      event.origin,
      parsed.id
    );
    if (existing && this.isAliveRequest(existing)) {
      return;
    }

    await this.acceptRequest(event, parsed);
  }

  /**
   * 用户在确认页点击"确认"。把对应 record 从 `confirming` 推进到
   * `queued`，并触发全局串行执行。
   *
   * recordId 缺省时取"当前任意一张 confirming request"（兼容旧 UI）；
   * 新 UI 应始终传 recordId。
   */
  async confirmByUser(recordId?: string): Promise<void> {
    const rec = this.resolveRecordForConfirm(recordId);
    if (!rec) return;
    if (rec.phase !== "confirming") return;
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
   * 锁屏期间积累的 manual request 解锁时同样需要按 DB 真值 clamp
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
          // refresh 会 clamp 到 DB 真值；如果 clamp 触发了 finalize，由
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
    this.sendClosingBestEffort();
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
   *       * `bootstrap_owner`（appView mode 下 `applyLauncherBootstrap`
   *         注册到 `ownerRuntimesBySessionId`）；
   *       * `vault_unlock`（本窗口用户后续解锁，vault.status() 返回
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
   * 暴露底层 vault service 引用，供 popup 顶层监听 vault.onStatusChange。
   *
   * 设计缘由：vault 状态变化（unlock / relock）需要在 `ProtocolPopupPage`
   * 顶层监听（跨 locked / unlocked 视图切换仍生效），不能放在
   * `LockScreenPage` 子组件里——否则解锁切到主页面后 relock 监听会丢。
   * 这里暴露一个 getter，让 popup 用 useCapability("vault.service") 之外的
   * 通道拿到 vault 引用，避免 popup 同时挂两个 vault capability 实例。
   */
  getVaultService(): VaultService {
    return this.deps.vault;
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
    availableKeys: Array<{ publicKeyHex: string; label: string }>;
  } | null {
    const rec = this.pickConnectRecord("connect.login", recordId);
    if (!rec) return null;
    return {
      recordId: rec.recordId,
      method: "connect.login",
      availableKeys: rec.connectLoginCandidates ?? []
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
   *   - snapshot 缺失（DB 不可用 / session 失效）时返回 null：UI 据此
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
   * UI 选定 key 后调用：把 connect.login record 推进到 queued，并触发
   * 全局串行执行。
   *
   * 行为：
   *   - 校验 recordId 存在 + method === "connect.login" + 当前 phase
   *     处于 `waiting_unlock_manual` 或 `confirming`；
   *   - 校验 ownerPublicKeyHex 必须是 record 候选列表里的一员；
   *   - 清 timer（与 confirmByUser 同语义）；
   *   - 写入 rec.connectLoginSelected；切到 queued；入执行队列；
   *     drainExecutionQueue 异步触发。
   *
   * 失败语义：
   *   - 上述校验失败时**不**抛错（best-effort；UI 可以在调用前先
   *     `connectLoginRecord()` 检查）；任何路径出错时记录日志，不阻塞
   *     其它请求。
   */
  async confirmConnectLogin(recordId: string, ownerPublicKeyHex: string, password: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.method !== "connect.login") return;
    if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") return;
    const candidates = rec.connectLoginCandidates ?? [];
    if (!candidates.some((c) => c.publicKeyHex === ownerPublicKeyHex)) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "confirmConnectLogin.invalidCandidate",
        recordId,
        ownerPublicKeyHex
      });
      return;
    }
    if (this.lockStateValue === "locked") {
      this.authUnlockInProgress = recordId;
      rec.connectAuthSubmittedAt = Date.now();
      try {
        await this.deps.vault.unlock(password);
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
        await this.deps.vault.verifyPassword(password);
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        throw err;
      }
    }
    rec.connectLoginSelected = ownerPublicKeyHex;
    // 关键（施工单 2026-06-28 002 硬切换）：login record 在用户点确认时
    // 立即把 ownerPublicKeyHex 落到 rec；executeConnectLogin 之后建的
    // session record 与该 ownerPublicKeyHex 一致。
    rec.ownerPublicKeyHex = ownerPublicKeyHex;
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
   *   - snapshot 缺失（DB 不可用 / session 失效）时不推进，UI 应当展示
   *     "该会话已失效，请重新登录"。
   */
  async confirmConnectResume(recordId: string, password: string): Promise<void> {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    if (rec.method !== "connect.resume") return;
    if (rec.phase !== "waiting_unlock_manual" && rec.phase !== "confirming") return;
    if (!rec.connectResumeSnapshot) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "confirmConnectResume.missingSnapshot",
        recordId
      });
      return;
    }
    if (this.lockStateValue === "locked") {
      this.authUnlockInProgress = recordId;
      rec.connectAuthSubmittedAt = Date.now();
      try {
        await this.deps.vault.unlock(password);
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
        await this.deps.vault.verifyPassword(password);
      } catch (err) {
        rec.connectAuthSubmittedAt = undefined;
        throw err;
      }
    }
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

  /* ============== Session Window 公共 API（施工单 2026-06-29 001） ============== */

  /** Session Window 当前 boot mode。 */
  bootMode(): "connect" | "appView" {
    return this.bootModeValue;
  }

  /** 当前 appView 上下文；仅 appView mode + bootstrap 成功后非空。 */
  appViewContext(): AppViewContext | null {
    return this.currentAppViewContext;
  }

  /**
   * Session Window 一次性 bootstrap consume 入口。
   *
   * 设计缘由（施工单 2026-06-29 001 硬切换 + 用户确认；修复 issue #1）：
   *   - 仅在 appView mode 下启用；connect mode 下是 no-op。
   *   - **不**挂 message listener、**不**做 postMessage handoff——
   *     postMessage 是事件队列，launcher 在子窗口 listener 挂好之前发
   *     消息会**丢失**。
   *   - 改走"Session Window 主动从同源 `window.opener` 直接消费
   *     bootstrap capsule"模型：`consumeLauncherBootstrap()` 内部调
   *     `window.opener.__keymaster_session_window_bootstrap__.acquire(token)`，
   *     是同源普通 JS 函数调用，**没有**事件队列时序竞态。
   *   - consume 内置超时（`BOOTSTRAP_TIMEOUT_MS`）→ 到点未拉到
   *     capsule → fail-closed（`bootstrapFailed = true`，UI 渲染错误态）。
   *   - 该方法**幂等**：第二次调用直接忽略。
   */
  awaitLauncherBootstrap(): void {
    if (this.bootModeValue !== "appView") return;
    if (this.bootstrapConsumed || this.bootstrapFailedFlag) return;
    this.bootstrapConsumed = true;
    if (typeof window === "undefined") {
      this.markBootstrapFailed("window_undefined");
      return;
    }
    const token = parseBootstrapToken(window.location.search);
    void (async () => {
      const out = await consumeLauncherBootstrap({
        token,
        opener: window.opener ?? null,
        ownOrigin: window.location.origin,
        timeoutMs: BOOTSTRAP_TIMEOUT_MS
      });
      if (out.failureReason || !out.bootstrap) {
        this.markBootstrapFailed(out.failureReason ?? "bootstrap_unknown");
        return;
      }
      await this.applyLauncherBootstrap(out.bootstrap);
    })();
  }

  /** bootstrap 是否失败。 */
  bootstrapFailed(): boolean {
    return this.bootstrapFailedFlag;
  }

  /** bootstrap 失败原因（仅本地历史；不进对外 result）。 */
  bootstrapFailureReason(): string | null {
    return this.bootstrapFailureReasonValue;
  }

  appClientConnectTimedOut(): boolean {
    return this.appClientConnectTimedOutFlag;
  }

  /**
   * 是否有"等待 child `ready`"的活跃等待态（施工单 2026-06-30 003）。
   */
  appClientWaitingForReady(): boolean {
    return this.appClientWaitingForReadyFlag;
  }

  /**
   * child app 是否已发来合法 `ready`（施工单 2026-06-30 003 硬切换）。
   *
   * 设计缘由：
   *   - UI 据此决定渲染 `show app` 页（false）还是回传统 popup 页（true）。
   *   - 一旦 true 在当前 Session Window 生命周期内不再回 false；
   *     重新启动会话时由 `startSession` 清回 false。
   */
  childReady(): boolean {
    return this.childReadyFlag;
  }

  /**
   * 把 bootstrap 状态切到 failed；UI 立刻据此渲染错误页。
   *
   * 设计缘由：
   *   - 不抛错：抛错会被 await 的 caller 吞掉、不传到 UI。
   *   - 触发 emit() 让 UI 立即收到状态变更。
   */
  private markBootstrapFailed(reason: string): void {
    if (this.bootstrapFailedFlag) return;
    this.stopAppClientConnectTimer();
    this.currentAppClientSource = null;
    this.bootstrapFailedFlag = true;
    this.bootstrapFailureReasonValue = reason;
    this.deps.logger?.error?.({
      scope: "protocol.sessionWindow",
      event: "bootstrap.failed",
      reason
    });
    this.emit();
  }

  /**
   * Session Window bootstrap 成功后调用：把 client app URL（含 launchToken
   * + `sessionWindowOrigin`）在命名窗口打开。Session Window 与 client app
   * 后续走现有 transport（child → Session Window `ready` → request →
   * result）。
   *
   * 设计缘由（施工单 2026-06-30 003 硬切换 + 2026-06-30 004 硬切换）：
   *   - 仅允许在 appViewContext 非空时调用；否则 throw。
   *   - 命名窗口 target = `keymaster-app-<encodeOrigin(appOrigin)>`：
   *     浏览器按 target 复用同一扇 child app 窗口，避免 `_blank` 每次
   *     点 `Open App` 都新开一扇、多个 client 实例互相打架。
   *   - **不**带 `noopener`：client app 必须能拿到
   *     `window.opener = Session Window`，否则无法把第一条
   *     `connect.launch` 发回，transport 完全失效。
   *   - **不**主动向 child 发 `ready` / 不再走 ready 泵（施工单
   *     2026-06-30 003）：
   *     `ready` 方向对称要求 child 在自己 listener 就绪后向 Session
   *     Window 发 `ready`。Session Window 不再猜测 child listener
   *     是否就绪。
   *   - **显式注入 `sessionWindowOrigin`**（施工单 2026-06-30 004）：
   *     当前 Session Window 的 `window.location.origin` 作为 query 参数
   *     拼到 child URL 上；下游 client app 在 appView 模式下**只**认
   *     这份值做 transport target origin，不再使用 UI / 用户输入的
   *     `targetOrigin`。构造失败一律按 fail-closed 返回 null，不重建
   *     session / launchToken / bootstrap。
   *   - 5s 软超时只用于 UI 提示"连接较慢"；到点只清等待态，**不**重建
   *     `connectSessionId` / `launchToken` / bootstrap。
   *   - 返回被打开的 window；失败返回 null（best-effort）。
   *   - **不**在打开后立即绑定 `currentAppClientSource`——`ready` 应当
   *     由 child 自己声明，source 绑定由 child `ready` 到达后做；
   *     若 child 漏发 `ready` 直接发 `connect.launch`，再由
   *     `isAllowedRequestSource` 兜底绑定。
   */
  openClientApp(): Window | null {
    const ctx = this.currentAppViewContext;
    if (!ctx) {
      throw new Error("openClientApp: appViewContext not set");
    }
    if (typeof window === "undefined") return null;
    // 施工单 2026-06-30 003：命名窗口 target。浏览器按 target 复用同一扇
    // child 窗口；encodeOrigin 来自 sessionWindowBootstrap，仅用于
    // 构造 window.name target，不承载任何业务真值。
    const target = `keymaster-app-${encodeOrigin(ctx.appOrigin)}`;
    // 施工单 2026-06-30 004：显式注入 `sessionWindowOrigin`。以当前
    // Session Window `window.location.origin` 为真值，写入 child URL
    // 的 query 里；下游 client app 用它做 transport target origin。
    // 不读 UI 默认 `targetOrigin`、不读 popup targetOrigin；当前窗口
    // origin 缺失 / 非法时按 fail-closed 返回 null（不开窗）。
    const sessionWindowOrigin =
      typeof window.location?.origin === "string" && window.location.origin.length > 0
        ? window.location.origin
        : "";
    let childUrlWithSessionWindowOrigin: string;
    if (!sessionWindowOrigin) {
      this.deps.logger?.error?.({
        scope: "protocol.sessionWindow",
        event: "openClientApp.sessionWindowOrigin.missing"
      });
      this.appClientWaitingForReadyFlag = false;
      this.stopAppClientConnectTimer();
      return null;
    }
    try {
      const u = new URL(ctx.appUrl);
      u.searchParams.set("sessionWindowOrigin", sessionWindowOrigin);
      childUrlWithSessionWindowOrigin = u.toString();
    } catch {
      this.deps.logger?.error?.({
        scope: "protocol.sessionWindow",
        event: "openClientApp.sessionWindowOrigin.invalid_app_url",
        appUrl: ctx.appUrl
      });
      this.appClientWaitingForReadyFlag = false;
      this.stopAppClientConnectTimer();
      return null;
    }
    try {
      const opened = window.open(childUrlWithSessionWindowOrigin, target);
      // 失败 / null：视为打开失败。`show app` 页面据此展示错误，
      // 用户可再次点击；不新建 session，不重建 launchToken。
      if (!opened) {
        this.appClientWaitingForReadyFlag = false;
        this.stopAppClientConnectTimer();
        return null;
      }
      // 打开成功：进入 5s 等待 child `ready` 的软超时。超时**只**清等待态
      // 和标记"连接较慢"提示，**不**重建 session / launchToken / bootstrap。
      this.beginAppClientConnectTimer();
      return opened;
    } catch (err) {
      this.appClientWaitingForReadyFlag = false;
      this.stopAppClientConnectTimer();
      this.deps.logger?.error?.({
        scope: "protocol.sessionWindow",
        event: "openClientApp.failed",
        err: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /* ============== plugin-apps launcher 启动入口（施工单 2026-06-29 002 硬切换） ============== */

  /**
   * Keymaster 内部 app launcher 启动入口（`plugin-apps` 唯一允许调用）。
   *
   * 设计缘由（施工单 2026-06-29 002 硬切换 + 2026-06-30 002 硬切换）：
   *   - plugin-apps 是**唯一**允许调用本入口的业务插件；plugin-apps 自己
   *     **不**直接 import / 操作：
   *       - `protocolStorageDb`
   *       - `buildAppBootstrapPayload`
   *       - `installLauncherBootstrapRegistry`
   *       - `window.open("/protocol/v1/popup?...")`
   *   - 完整 launcher 流程在 service 内部一次性收口：
   *       1. 校验 vault 已解锁（否则 throw "vault_locked"）；
   *       2. 校验当前 keyspace active key ready（否则 throw "no_active_key"）；
   *       3. 校验 app 配置合法（`appOrigin` 是合法 origin；
   *          `new URL(appUrl).origin === appOrigin`；否则 throw "invalid_app_config"）；
   *       4. 解析 claims 快照（按 input.claims 走 builtin claim 解析，与
   *          `connect.login` 一致）；
   *       5. 创建新 `connectSessionId`，按 session 真值三元组落库
   *          （sessionId + origin + ownerPublicKeyHex，无 `runtimeBinding`）；
   *       6. 用现有 `vault.withPrivateKey(keyId, fn)` 借出 owner 私钥
   *          hex，组装 `OwnerRuntimeBootstrap`；
   *       7. 生成新 `launchToken`（`crypto.randomUUID()`）；
   *       8. 组装 `AppBootstrapPayload`（含 `ownerRuntimeBootstrap`）；
   *       9. 在 launcher `window` 上挂一次性 bootstrap registry；
   *       10. `window.open("/protocol/v1/popup?boot=appView&bootstrapToken=...")`；
   *       11. `window.open` 失败 → throw "open_session_window_*"。
   *   - 任何一道闸失败：throw，**不**补偿、**不**回退、**不**做"半启动"。
   *   - session 在 launcher 点击 `Open App` 时**预建**；`connect.launch`
   *     只消费 `launchToken`、不创建 session。
   *   - 借 owner 私钥 hex 失败时 throw `export_owner_runtime_failed`；
   *     `exportUnlockRuntimeForSessionWindow` / `UnlockRuntimeHandoff`
   *     已删除，不再向 Session Window 交接整套 vault unlock runtime。
   */
  async launchAppView(input: LaunchAppViewInput): Promise<LaunchAppViewResult> {
    // 1) 校验入参基本完整性。
    if (!input || !input.appId || !input.appOrigin || !input.appUrl) {
      throw new Error("launchAppView: missing app fields");
    }
    // 2) 校验 vault 已解锁。
    if (this.deps.vault.status() !== "unlocked") {
      throw new LaunchAppViewError("vault_locked", "launchAppView: vault not unlocked");
    }
    // 3) 校验 active key ready。
    const active = this.deps.keyspace.active().activePublicKeyHex;
    if (!active) {
      throw new LaunchAppViewError("no_active_key", "launchAppView: no active key");
    }
    const key = await this.deps.keyspace.getKey(active);
    if (!key || !key.publicKeyHex) {
      throw new LaunchAppViewError(
        "no_active_key",
        "launchAppView: owner key not found"
      );
    }
    if (key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
      throw new LaunchAppViewError(
        "no_active_key",
        "launchAppView: owner key not ready"
      );
    }
    if (!key.keyId) {
      throw new LaunchAppViewError(
        "no_active_key",
        "launchAppView: owner key has no vault keyId"
      );
    }
    // 4) 校验 app 配置合法：appOrigin 是合法 origin，且 new URL(appUrl).origin === appOrigin。
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
    if (typeof window === "undefined") {
      throw new LaunchAppViewError(
        "window_unavailable",
        "launchAppView: window undefined"
      );
    }
    if (!this.deps.storageDb) {
      throw new LaunchAppViewError(
        "session_storage_unavailable",
        "launchAppView: session storage unavailable"
      );
    }
    // 5) 解析 claims 快照（与 connect.login 同语义）。
    const resolvedClaims = resolveClaims(input.claims ?? [], (name) =>
      resolveBuiltinClaim(name, { activeKeyLabel: key.label })
    );
    // 6) 创建新 connect session：原子落库 + 吊销同 origin 旧 session。
    //    施工单 2026-06-30 002 硬切换：session 真值收口为三元组
    //    （sessionId + origin + ownerPublicKeyHex），不再写
    //    `runtimeBinding`——执行路径不允许靠"当前 bootMode"临时猜测，
    //    必须读 session 真值。runtime 来源由 `resolveOwnerRuntime`
    //    在每次执行时按当前窗口状态决定。
    const now = Date.now();
    const sessionId = this.deps.generateId ? this.deps.generateId() : crypto.randomUUID();
    const sessionRecord: ConnectSessionRecord = {
      sessionId,
      origin: input.appOrigin,
      ownerPublicKeyHex: key.publicKeyHex,
      ownerLabel: key.label,
      claimsSnapshot: resolvedClaims,
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    };
    await this.deps.storageDb.putConnectSessionAndRevokeOriginPeers(sessionRecord);
    // 7) 用现有 `vault.withPrivateKey` 借 owner 私钥 hex，组装
    //    `OwnerRuntimeBootstrap`（施工单 2026-06-30 002 硬切换）。
    //    `exportUnlockRuntimeForSessionWindow` / `UnlockRuntimeHandoff`
    //    已删除；不再向 Session Window 交接整套 vault unlock runtime。
    let ownerRuntimeBootstrap: OwnerRuntimeBootstrap;
    try {
      ownerRuntimeBootstrap = await this.deps.vault.withPrivateKey(
        key.keyId,
        async (material) => ({
          ownerPublicKeyHex: key.publicKeyHex!,
          ownerLabel: key.label,
          privateKeyHex: material.hex,
          capabilities: Array.isArray(key.capabilities) ? key.capabilities : [],
          createdAt: now
        })
      );
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.launcher",
        event: "exportOwnerRuntime.failed",
        err: err instanceof Error ? err.message : String(err)
      });
      throw new LaunchAppViewError(
        "export_owner_runtime_failed",
        "launchAppView: failed to export owner runtime bootstrap"
      );
    }
    // 8) 生成新 launchToken。
    const launchToken = this.deps.generateId
      ? `launch-${this.deps.generateId()}`
      : `launch-${crypto.randomUUID()}`;
    // 9) 拼 client app URL：把 launchToken 拼到 appUrl 的 query 上。
    const appUrlWithLaunchToken = (() => {
      try {
        const u = new URL(input.appUrl);
        u.searchParams.set("launchToken", launchToken);
        return u.toString();
      } catch {
        return input.appUrl;
      }
    })();
    // 10) 组装 AppBootstrapPayload（含 `ownerRuntimeBootstrap`，不含 `runtimeBinding`）。
    const bootstrap = buildAppBootstrapPayload({
      appId: input.appId,
      appOrigin: input.appOrigin,
      appUrl: appUrlWithLaunchToken,
      connectSessionId: sessionId,
      ownerPublicKeyHex: key.publicKeyHex,
      resolvedClaims: resolvedClaims as Record<string, unknown>,
      resolvedAt: now,
      launchToken,
      expiresAt: now + 24 * 60 * 60 * 1000,
      ownerRuntimeBootstrap
    });
    // 11) 在 launcher window 上挂一次性 bootstrap registry。
    //     设计缘由（issue #1）：同一 launcher 窗口里多次点 `Open App` 时
    //     不能互相覆盖。这里用 service 实例字段 `launcherBootstrapEntries`
    //     + 一次性 install；后续 `launchAppView()` 只往 entries Map 加新
    //     token，**不**重新挂 registry。token 一次性消费（命中即 delete）。
    const token = `bt-${launchToken}`;
    this.launcherBootstrapEntries.set(token, bootstrap);
    if (!this.launcherBootstrapRegistryInstalled && typeof window !== "undefined") {
      const registry: LauncherBootstrapRegistry = {
        acquire: async (t: string) => {
          const v = this.launcherBootstrapEntries.get(t);
          if (!v) return null;
          this.launcherBootstrapEntries.delete(t);
          return v;
        }
      };
      installLauncherBootstrapRegistry(window, registry);
      this.launcherBootstrapRegistryInstalled = true;
    }
    // 12) 打开 Session Window。
    //     显式请求 popup features，提高浏览器把它作为独立窗口打开的概率；
    //     launcher 自身不跳转、不被中断。
    const popupUrl = `/protocol/v1/popup?boot=appView&bootstrapToken=${encodeURIComponent(token)}`;
    let popup: Window | null = null;
    try {
      popup = window.open(popupUrl, "_blank", SESSION_WINDOW_OPEN_FEATURES);
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.launcher",
        event: "openSessionWindow.failed",
        err: err instanceof Error ? err.message : String(err)
      });
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
    this.deps.logger?.info?.({
      scope: "protocol.launcher",
      event: "launchAppView.ok",
      appId: input.appId,
      appOrigin: input.appOrigin,
      sessionId,
      launchToken
    });
    return {
      sessionWindowOpened: true,
      connectSessionId: sessionId,
      launchToken,
      appUrl: appUrlWithLaunchToken
    };
  }

  /**
   * 应用 launcher bootstrap payload（施工单 2026-06-30 002 硬切换）。
   *
   * 设计缘由：
   *   - 校验 payload 完整性 + owner runtime bootstrap 真值（hex 派生
   *     的压缩公钥必须等于 payload.ownerPublicKeyHex）；
   *   - 校验通过后**只**在当前 Session Window 内存里注册 owner runtime，
   *     `OwnerRuntimeSource = "bootstrap_owner"`；**不**调用
   *     `vault.importUnlockRuntime*`（已删除）；
   *   - 写 `appViewContext` + launchToken 缓存 + 内部
   *     `ownerRuntimesBySessionId`。
   *
   * 关键约束：
   *   - **不**导入 unlock runtime；**不**把 vault 切到 unlocked 态。
   *   - 校验失败一律 fail-closed：不缓存半残 runtime / 不写 appViewContext /
   *     不打开 client app。`bootstrapFailed = true` 让 UI 渲染错误页。
   */
  private async applyLauncherBootstrap(payload: AppBootstrapPayload): Promise<void> {
    if (!payload || !payload.app || !payload.launchToken) {
      this.markBootstrapFailed("bootstrap_payload_invalid");
      return;
    }
    if (!payload.ownerRuntimeBootstrap) {
      this.markBootstrapFailed("bootstrap_owner_runtime_missing");
      return;
    }
    const runtime = payload.ownerRuntimeBootstrap;
    if (
      !runtime.ownerPublicKeyHex ||
      !runtime.privateKeyHex ||
      runtime.privateKeyHex.length !== 64
    ) {
      this.markBootstrapFailed("bootstrap_owner_runtime_invalid");
      return;
    }
    if (runtime.ownerPublicKeyHex.toLowerCase() !== payload.ownerPublicKeyHex.toLowerCase()) {
      this.markBootstrapFailed("bootstrap_owner_runtime_pubkey_mismatch");
      return;
    }
    // 1) 校验私钥 hex 确实对应声明的 ownerPublicKeyHex：直接派生
    //    压缩公钥并比对；不一致 → fail-closed。
    //    派生得到的是小写 hex；payload / runtime 内的 hex 可能大小写不一，
    //    比较时统一 toLowerCase。
    let derivedPubHex: string;
    try {
      derivedPubHex = await this.deriveCompressedPubHexFromPrivHex(runtime.privateKeyHex);
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.sessionWindow",
        event: "ownerRuntimePubkeyDerive.failed",
        err: err instanceof Error ? err.message : String(err)
      });
      this.markBootstrapFailed("bootstrap_owner_runtime_invalid");
      return;
    }
    if (derivedPubHex !== runtime.ownerPublicKeyHex.toLowerCase()) {
      this.markBootstrapFailed("bootstrap_owner_runtime_pubkey_mismatch");
      return;
    }
    // 2) 写入 appViewContext + launchToken 缓存 + owner runtime。
    //    注意 Session Window **不**调 `vault.importUnlockRuntime*`——
    //    那是 unlock runtime 模型下的旧接口，本单已删除。appView mode
    //    下 vault 仍可能处于 `locked` 态；业务方法是否可执行只看
    //    `OwnerExecutionRuntime` 当前能否解析到（`bootstrap_owner` 或
    //    后续 `vault_unlock`）——**不**再依"是否 locked"。
    const claimsSnapshot = payload.resolvedClaims as AppViewContext["resolvedClaims"];
    this.currentAppViewContext = {
      appId: payload.app.appId,
      appOrigin: payload.app.appOrigin,
      appUrl: payload.app.appUrl,
      connectSessionId: payload.connectSessionId,
      ownerPublicKeyHex: payload.ownerPublicKeyHex,
      resolvedClaims: claimsSnapshot,
      resolvedAt: payload.resolvedAt
    };
    this.launchTokensByToken.set(payload.launchToken, {
      appId: payload.app.appId,
      appOrigin: payload.app.appOrigin,
      appUrl: payload.app.appUrl,
      connectSessionId: payload.connectSessionId,
      ownerPublicKeyHex: payload.ownerPublicKeyHex,
      resolvedClaims: claimsSnapshot,
      resolvedAt: payload.resolvedAt,
      consumed: false
    });
    this.ownerRuntimesBySessionId.set(payload.connectSessionId, {
      runtime,
      createdAt: Date.now()
    });
    // 3) 状态写入完成。bootstrap consume 已成功：不再做超时 / listener
    //    收尾（direct consume 模型没有 listener）。
    //
    // 施工单 2026-06-30 003 硬切换 4.5：appView bootstrap 成功并建立
    // 可执行 owner runtime 后，Session Window 应视为 unlocked。即使
    // 本地 vault 仍是 locked，bootstrap_owner 来源已足够跑业务方法。
    // 这里走 `setVaultLockState(vault.status() === "unlocked")` 让
    // `computeLockState()` 重新计算；如果之前因 vault locked 已经有
    // `waiting_unlock_*` record，这里会顺便批量推进到 confirming /
    // queued。如果 lockState 已是 unlocked，setVaultLockState 内部
    // 早返回，不重复触发收口。
    this.setVaultLockState(this.deps.vault.status() === "unlocked");
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
   * 此方法校验 launcher 交过来的 `privateKeyHex` 真的对应
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
        canSubmit: !login.connectAuthSubmittedAt && (login.connectLoginCandidates?.length ?? 0) > 0,
        submitted: Boolean(login.connectAuthSubmittedAt),
        login: {
          recordId: login.recordId,
          availableKeys: login.connectLoginCandidates ?? []
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

  /**
   * 启动 child `ready` 软超时（施工单 2026-06-30 003）。
   *
   * 设计缘由：
   *   - 旧实现这里用 setInterval 反复 pump `ready`；新实现已删除 pump，
   *     `ready` 方向对称要求 child 自己声明。
   *   - 这里只启动 5s setTimeout：到点只把 `appClientConnectTimedOut = true`
   *     并清掉等待态，**不**重建 `connectSessionId` / `launchToken` /
   *     bootstrap、**不**重发 `ready`、**不**自动补救。
   *   - child `ready` 到达或 child request 到达都会清掉 timer。
   */
  private beginAppClientConnectTimer(): void {
    this.stopAppClientConnectTimer();
    this.appClientWaitingForReadyFlag = true;
    this.appClientConnectTimeoutHandle = setTimeout(() => {
      this.appClientConnectTimeoutHandle = null;
      this.appClientWaitingForReadyFlag = false;
      this.markAppClientConnectTimedOut();
    }, APPVIEW_READY_RETRY_WINDOW_MS);
  }

  /**
   * 停止 child `ready` 软超时 timer（施工单 2026-06-30 003）。
   *
   * 设计缘由：
   *   - 旧 `stopAppClientReadyPump` 同时 clearInterval + clearTimeout；
   *     新实现不再有 setInterval，仅 clearTimeout 一项。
   *   - 本方法**不**改 waiting / 软超时提示 flag；flag 由
   *     `markChildReady` / `markAppClientConnectTimedOut` /
   *     `clearAppClientConnectTimeout` 单独维护。
   */
  private stopAppClientConnectTimer(): void {
    if (this.appClientConnectTimeoutHandle !== null) {
      clearTimeout(this.appClientConnectTimeoutHandle);
      this.appClientConnectTimeoutHandle = null;
    }
  }

  /**
   * 标记 app 已触发连接超时提示。
   *
   * 设计缘由：
   *   - 这是 UI 层的软超时，不是协议硬失败；
   *   - 5s 到点后只提示用户"连接较慢/超时"；
   *   - 迟到的 `ready` / `connect.launch` 仍允许恢复，因此**不能**复用
   *     `bootstrapFailed` 这条 fail-closed 真值。
   *   - 施工单 2026-06-30 003：到点**不**重建 session / launchToken /
   *     bootstrap；只翻 flag 让 UI 把按钮恢复可点 + 显示提示。
   */
  private markAppClientConnectTimedOut(): void {
    if (this.appClientConnectTimedOutFlag) return;
    this.appClientConnectTimedOutFlag = true;
    this.appClientWaitingForReadyFlag = false;
    this.deps.logger?.warn?.({
      scope: "protocol.sessionWindow",
      event: "appClient.connectTimeout"
    });
    this.emit();
  }

  /**
   * child app 连回后清掉软超时提示（施工单 2026-06-30 003）。
   *
   * 设计缘由：
   *   - 由 `tryAcceptChildReady` 与"bound source 收到 request"路径调用；
   *   - 同时把 waiting flag 也清掉，保证按钮态与提示态同步。
   */
  private clearAppClientConnectTimeout(): void {
    this.appClientWaitingForReadyFlag = false;
    if (!this.appClientConnectTimedOutFlag) {
      this.emit();
      return;
    }
    this.appClientConnectTimedOutFlag = false;
    this.emit();
  }

  /**
   * 处理 child `ready`（施工单 2026-06-30 003 硬切换）。
   *
   * 设计缘由：
   *   - 仅在 appView mode 下生效；connect mode 收到 ready 视为非法忽略。
   *   - 合法性：event.origin === appViewContext.appOrigin；若
   *     `currentAppClientSource` 已绑定则 event.source 必须等于它；
   *     若未绑定则把 event.source 绑定为当前合法 child app source。
   *   - `childReadyFlag` 翻转后**不**再回 false；同 Session Window 生命周期
   *     内 UI 切到 popup 阶段后不再回 show app 阶段。
   *   - 收到合法 ready 后清掉 waiting flag、停止软超时 timer、清除
   *     `appClientConnectTimedOut` 提示。
   *   - 重复 ready 到达：`childReadyFlag` 已经 true → 直接忽略，不重复 emit
   *     避免 UI 闪烁。
   *   - 注：`childReadyFlag` 也可在首条合法 request 路径由
   *     `markChildAliveFromBoundSource` 翻 true（见 handleMessage）。
   *     本函数仅处理显式 `ready` 路径；两路汇到同一份真值。
   */
  private tryAcceptChildReady(event: MessageEvent): void {
    if (this.bootModeValue !== "appView") return;
    const ctx = this.currentAppViewContext;
    if (!ctx) return;
    if (event.origin !== ctx.appOrigin) return;
    const source = event.source as Window | null;
    if (!source) return;
    // 已绑定 source：必须严格匹配，错误窗口的 ready 直接忽略。
    if (this.currentAppClientSource && this.currentAppClientSource !== source) return;
    if (!this.currentAppClientSource) {
      this.currentAppClientSource = source;
    }
    if (this.childReadyFlag) {
      // 已 ready：重复 ready 直接忽略；source 绑定已稳定，重复 ready
      // 不再触发 UI 切段、不再 emit。
      return;
    }
    this.childReadyFlag = true;
    this.stopAppClientConnectTimer();
    this.clearAppClientConnectTimeout();
    this.deps.logger?.info?.({
      scope: "protocol.sessionWindow",
      event: "appClient.ready"
    });
    this.emit();
  }

  /**
   * 标记 child 已"活着"：appView mode 下首条合法 child 协议消息到达
   * 即触发；后续不论来自显式 `ready` 还是首条 `connect.*`，UI 都应
   * 切到传统 popup（施工单 2026-06-30 003 硬切换）。
   *
   * 设计缘由：
   *   - 之前只有显式 `ready` 才能翻 childReady；child app 漏发 ready
   *     直接发 connect.launch 时 UI 仍会卡在 `show app` 分支——但请求
   *     已经被执行，状态错位。
   *   - 现在任何从 bound source 来的合法协议消息（无论是 ready /
   *     request / cancel）都把 childReady 翻 true；source 绑定已由
   *     `tryAcceptChildReady` / `isAllowedRequestSource` 在调用本方法
   *     之前完成。
   *   - 幂等：childReadyFlag 已 true 时直接返回，不重复 emit。
   */
  private markChildAliveFromBoundSource(): void {
    if (this.bootModeValue !== "appView") return;
    // 即便 childReadyFlag 已是 true，也顺手清掉等待态 / 软超时提示——
    // 例如迟到的 connect.* 在软超时之后到达，仍应清掉"连接较慢"提示。
    this.stopAppClientConnectTimer();
    this.clearAppClientConnectTimeout();
    if (this.childReadyFlag) return;
    this.childReadyFlag = true;
    this.deps.logger?.info?.({
      scope: "protocol.sessionWindow",
      event: "appClient.aliveFromRequest"
    });
    this.emit();
  }

  /**
   * 向指定 transport 对端发送 `ready`。
   *
   * 设计缘由：
   *   - connect mode：startSession 时给 opener 发 ready；
   *   - appView mode：手动 `Open App` 后必须给新开的 child app 再发一条
   *     ready，否则它会一直停在"等待 Session Window ready"阶段，永远不发
   *     `connect.launch`。
   *   - `ready` 是 transport-ready 信号，不承载授权语义；重复发送的
   *     语义是幂等的。
   */
  private postReadyToTarget(target: Window): void {
    if (this.deps.postReady) {
      this.deps.postReady(target, READY_MESSAGE);
      return;
    }
    try {
      target.postMessage(READY_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.transport",
        event: "ready.failed",
        data: { err: String(err) }
      });
    }
  }

  /**
   * 当前 Session Window 拥有的"可执行 owner runtime"真值
   * （施工单 2026-06-30 003 硬切换 4.5）。
   *
   * 设计缘由：
   *   - `lockStateValue` 公开语义从"本地 vault 是否已解锁"正式收口为
   *     "当前 Session Window 是否已经拥有可执行 owner runtime"。
   *   - 可执行 owner runtime 的两种来源：
   *       1. `bootstrap_owner`：launcher 一次性注入的 owner runtime
   *          材料，appView mode 下 `applyLauncherBootstrap` 注册到
   *          `ownerRuntimesBySessionId` 后即对当前窗口持续有效。
   *       2. `vault_unlock`：本窗口用户后续解锁 + keyspace 中 owner key
   *          可读时由 `resolveOwnerRuntime` 切换到 vault_unlock 来源。
   *   - 任一来源可用 → `unlocked`；两者皆不可用 → `locked`。
   *   - 这条真值收口让 appView popup 阶段不再"UI 看似 unlocked，但 accept
   *     阶段仍按 locked 推 waiting_unlock_*"——accept / UI 收口逻辑全部
   *     统一读这一份真值。
   */
  private hasExecutableOwnerRuntime(): boolean {
    // 优先 bootstrap_owner：哪怕 vault 后续被 relock，runtime 仍有效。
    if (this.ownerRuntimesBySessionId.size > 0) return true;
    // 否则靠 vault 解锁。
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
    parsed: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> }
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
    //     完成后再用 DB 历史重建当前 origin 视图。
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
      recordId,
      transportRequestId: parsed.id,
      source,
      origin,
      method,
      params: parsed.params,
      phase: "waiting_unlock_manual", // 临时占位，下方会立刻覆盖
      decision: "pending",
      status: "pending",
      enteredPhaseAt: now,
      autoApproved: false,
      // 关键（施工单 2026-06-28 002 硬切换）：`connectSessionId` +
      // `ownerPublicKeyHex` 在 record 创建时立即绑定一次。后续写卡
      // **不**再读 keyspace.active()——即使 popup 会话里用户切换 active
      // key，这条 record 的 owner / session 归属也不会被污染。
      // 业务方法在下方 method 分支里**先**做 session 预校验，再回填
      // 这两个字段；`connect.login` 在 bootstrapConnectLoginRecord
      // 之后回填。
      connectSessionId: "",
      ownerPublicKeyHex: "",
      createdAt: now,
      updatedAt: now,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    };
    this.requestsByRecordId.set(recordId, rec);

    // 决定初始 phase。`setRecordPhase` 会负责写 feed 卡 + 持久化（施工单
    // 2026-06-27 002 硬切换：feed 投影走 `buildFeedDisplay`，活卡按
    // createdAt asc 稳定排序，不再做"先占位后改 phase"的两次写）。
    //
    // connect.* 三方法（施工单 2026-06-28 001 硬切换）：
    //   - login：locked → waiting_unlock_manual；unlocked → confirming
    //     （UI 渲染"选 key + 确认"视图）。需要拉 keyspace.ready keys
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
        this.scheduleFailFastRequest(recordId, resumePre.code, resumePre.reason);
        return;
      }
      const pendingLogin = this.pickConnectRecord("connect.login", undefined, origin);
      if (pendingLogin && !pendingLogin.connectAuthSubmittedAt) {
        await this.finalizeRequestByCancel(pendingLogin.recordId, "superseded_by_resume");
      }
      // session 有效：locked → waiting_unlock_manual；unlocked → 直接
      // queued（**不**经过 confirming）。解锁后同样直接 queued。
      rec.connectSessionId = resumeParams.connectSessionId;
      rec.ownerPublicKeyHex = rec.connectResumeSnapshot?.ownerPublicKeyHex ?? "";
      rec.autoExecuteAfterUnlock = true;
      this.applyManualPhaseDecision(recordId, origin, /* skipConfirmWhenUnlocked */ true);
      return;
    } else if (method === "connect.launch") {
      // appView 首登：launchToken 是唯一真值；**不**要求 connectSessionId，
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
    } else {
      // 施工单 2026-06-28 002 硬切换：所有外部业务方法都属于某个
      // connectSessionId。统一预校验 session 真值，session 无效时
      // fail-fast（与 cipher.* 旧逻辑同语义）。
      //
      // 业务方法：identity.get / intent.sign / cipher.encrypt /
      // cipher.decrypt / p2pkh.transfer / feepool.prepare / feepool.commit。
      const sessionParams = parsed.params as { connectSessionId?: string };
      const sessionId = sessionParams?.connectSessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        // 校验层应当已经拒绝；这里是兜底——任何缺 connectSessionId 的
        // 业务 method 都不允许落 record；按 invalid_request 兜底处理。
        this.deps.logger?.warn?.({
          scope: "protocol.session",
          event: "missingConnectSessionId",
          recordId,
          method
        });
        this.scheduleFailFastRequest(recordId, "user_rejected", "internal_error");
        return;
      }
      const sessionFail = await this.preCheckConnectSession(sessionId, origin);
      if (sessionFail !== null) {
        this.scheduleFailFastRequest(recordId, sessionFail.code, sessionFail.reason);
        return;
      }
      // preCheck 已通过：session 真值有效 / DB 异常按降级放行（手动
      // confirm 继续走）。把 sessionId 落到 record 必填字段；
      // ownerPublicKeyHex 由 fetchSessionForBinding 二次校验后回填。
      let session: ConnectSessionRecord | null = null;
      let dbError = false;
      try {
        session = await this.fetchSessionForBinding(sessionId);
      } catch (err) {
        // DB 异常：accept 阶段无法读到 session 真值；走 manual
        // confirm 路径，execute 阶段 `requireConnectSession` 再校验。
        // ownerPublicKeyHex 留空——execute 阶段校验失败会写入
        // 本地 failureReason；caller 收到 user_rejected。
        this.deps.logger?.warn?.({
          scope: "protocol.session",
          event: "acceptRequest.fetchSession.dbError",
          recordId,
          sessionId,
          err: err instanceof Error ? err.message : String(err)
        });
        dbError = true;
      }
      if (dbError) {
        rec.connectSessionId = sessionId;
        // 不 return；让 request 继续走 manual confirm / execute 路径。
      } else if (session === null) {
        // 极端竞态：preCheck 通过 → session 突然被外部 logout / 删除。
        // 走 fail-fast（与 DB 异常区分）。
        this.scheduleFailFastRequest(recordId, "user_rejected", "internal_error");
        return;
      } else {
        rec.connectSessionId = sessionId;
        rec.ownerPublicKeyHex = session.ownerPublicKeyHex;
      }
      if (method === "cipher.encrypt" || method === "cipher.decrypt") {
        // cipher.* session 有效：locked → waiting_unlock_manual；
        // unlocked → confirming（与现有 manual confirm 路径一致）。
      }
    }

    const autoApproved = await this.tryAutoApprove(parsed, origin, rec);
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
   *   - `code` 是对外 result.error.code（user_rejected 或 invalid_origin）；
   *   - `reason` 是本地 ProtocolFailureReason（写进 record.failureReason）。
   *
   * 跨 origin 区分：accept 阶段读出 session 后立即做 origin 比对，
   * origin 不匹配 → `invalid_origin`（与 identity.get 同语义，
   * 让 caller 知道自己"用的 sessionId 不是该 origin 的"）。
   *
   * DB 异常 / DB 不可用处理（关键边界）：
   *   - fetchSessionForBinding 抛错时**不**走 fail-fast 路径，**返回
   *     null** 让 caller 走 manual confirm / execute 阶段再校验。
   *     这与旧"DB unavailable 降级"边界一致：p2pkh / cipher / 业务
   *     方法仍可继续走人工确认，execute 阶段 `requireConnectSession`
   *     会再做一次校验。
   */
  private async preCheckConnectSession(
    sessionId: string,
    origin: string
  ): Promise<{ code: ProtocolErrorCode; reason: ProtocolFailureReason } | null> {
    if (!sessionId) {
      return { code: "user_rejected", reason: "internal_error" };
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding(sessionId);
    } catch (err) {
      // 关键（施工单 2026-06-28 002 收口）：DB 异常**不**触发 fail-fast。
      // 与"DB unavailable 降级"边界一致：允许 manual confirm 继续走
      // manual confirm 路径，execute 阶段再校验 session 真值。
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "preCheckConnectSession.dbError",
        sessionId,
        err: err instanceof Error ? err.message : String(err)
      });
      return null;
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
    try {
      const key = await this.deps.keyspace.getKey(session.ownerPublicKeyHex);
      if (!key || !key.publicKeyHex || key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
        return { code: "user_rejected", reason: "internal_error" };
      }
    } catch {
      // owner key 查询失败 → 走 fail-fast。
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
   *   - DB 异常 / DB 不可用 → **抛错**。让 caller 区分"session 失效"
   *     与"DB 异常"两种 case：DB 异常**不**走 fail-fast 路径——与
   *     旧"DB unavailable 降级"边界一致：p2pkh / cipher / 业务
   *     方法仍走 manual confirm（execute 阶段再校验）。Fail-fast 只
   *     用于"session 真值确凿无效"，**不**用于"DB 查不到"。
   *   - 跨 origin 不在本函数判断；caller 拿到 session 后自己
   *     `session.origin !== event.origin` 决定走 `invalid_origin`。
   */
  private async fetchSessionForBinding(
    sessionId: string
  ): Promise<ConnectSessionRecord | null> {
    if (!this.deps.storageDb) {
      throw new Error("connect session storage unavailable");
    }
    const session = await this.deps.storageDb.getConnectSession(sessionId);
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    return session;
  }

  /**
   * 让一条已建 record "fail-fast"：直接 phase=failed 并回复错误 result。
   *
   * 设计缘由（施工单 2026-06-28 001 硬切换 5.1.2 / 5.2 + 反例反馈）：
   *   - session 真值无效（不存在 / 已 revoke / origin 不匹配 / owner key
   *     不 ready）时**必须直接失败**：不让用户走任何"解锁" / "确认" UI。
   *   - 无效 session 失败路径**不依赖** vault unlock：replyErrorToRec 只
   *     走 postMessage，不读 vault / keyspace 状态。
   *   - 因此 locked 与 unlocked 一视同仁——fail-fast 在两种状态下都直接
   *     收口为 phase=failed，对外回 result(ok=false)。**不**进入
   *     waiting_unlock_manual。
   *
   * 关键不变量：
   *   - fail-fast 的 record 不进 executionQueue / 不 drainExecutionQueue；
   *     executionQueue 的 drain 检查 `lockStateValue === "unlocked"`，
   *     走队列意味着 locked 时会被挂起，违反"直接失败"。
   *   - 不动 setVaultLockState / autoExecuteAfterUnlock——fail-fast record
   *     已经没有"unlock 后怎么办"的概念。
   */
  private scheduleFailFastRequest(
    recordId: string,
    code: ProtocolErrorCode,
    reason: ProtocolFailureReason
  ): void {
    const rec = this.requestsByRecordId.get(recordId);
    if (!rec) return;
    rec.phase = "failed";
    rec.decision = "failed";
    rec.status = "failed";
    rec.errorCode = code;
    rec.errorMessage = code === "invalid_origin" ? "invalid origin" : "User rejected";
    rec.failureReason = reason;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    // 写 feed 历史卡（终态）。
    this.writeFeedCommandFor(rec);
    this.emitFeed();
    // 直接向 opener 回 result。fire-and-forget：postMessage 失败不影响
    // 本地 record 终态；与现有 dispatch 收尾保持一致。
    void this.replyErrorToRec(rec, code, rec.errorMessage);
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
   * 准备 `connect.login` record：拉取 ready key 列表作为选 key 候选。
   * 任何 DB / keyspace 异常都**不**当场拒掉 request——service 仍按 manual
   * 路径推进；执行阶段会再次校验，失败时回 `user_rejected` + 本地 reason。
   */
  private async bootstrapConnectLoginRecord(rec: RequestRecord, _params: ConnectLoginParams): Promise<void> {
    try {
      const keys = await this.deps.keyspace.listKeys();
      const candidates = keys
        .filter((k) => k.publicKeyHex && k.identityStatus !== "failed" && k.identityStatus !== "uninitialized")
        .map((k) => ({ publicKeyHex: k.publicKeyHex as string, label: k.label }));
      rec.connectLoginCandidates = candidates;
    } catch (err) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "listKeys.failed",
        recordId: rec.recordId,
        err: err instanceof Error ? err.message : String(err)
      });
      rec.connectLoginCandidates = [];
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
   *     避免 execute 阶段再去 DB 多走一次（执行路径仍以 DB 当前值为
   *     准，但 snapshot 是热路径上的合理缓存）。
   *
   * 返回：`null` = 校验通过；`{code, reason}` = 校验失败（fail-fast）。
   */
  private async bootstrapConnectResumeRecord(
    rec: RequestRecord,
    params: ConnectResumeParams,
    origin: string
  ): Promise<{ code: ProtocolErrorCode; reason: ProtocolFailureReason } | null> {
    if (!this.deps.storageDb) {
      return { code: "user_rejected", reason: "internal_error" };
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.deps.storageDb.getConnectSession(params.connectSessionId);
    } catch (err) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "bootstrapConnectResume.getConnectSession.failed",
        recordId: rec.recordId,
        err: err instanceof Error ? err.message : String(err)
      });
      return { code: "user_rejected", reason: "internal_error" };
    }
    if (!session) return { code: "user_rejected", reason: "internal_error" };
    if (session.revokedAt !== null) return { code: "user_rejected", reason: "internal_error" };
    if (session.origin !== origin) return { code: "invalid_origin", reason: "internal_error" };
    try {
      const key = await this.deps.keyspace.getKey(session.ownerPublicKeyHex);
      if (!key || !key.publicKeyHex || key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
        return { code: "user_rejected", reason: "internal_error" };
      }
    } catch (err) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "bootstrapConnectResume.getKey.failed",
        recordId: rec.recordId,
        err: err instanceof Error ? err.message : String(err)
      });
      return { code: "user_rejected", reason: "internal_error" };
    }
    rec.connectResumeSnapshot = {
      sessionId: session.sessionId,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      ownerLabel: session.ownerLabel,
      claimsSnapshot: session.claimsSnapshot
    };
    return null;
  }

  /**
   * 判断新 request 是否命中 auto-approve / auto-sign。
   *
   * 命中条件（与旧实现一致，但**不**依赖当前 lockState）：
   *   - p2pkh.transfer：p2pkhAutoApproveEnabled + amount <= max；
   *   - feepool.prepare / feepool.commit：feePoolAutoSignMaxSatoshis > 0 + amount <= max；
   *   - identity.get / cipher.*：originCache 命中相应 auto-approve 配置；
   *     cache miss 时先 await getOriginSettingsCached 兜底一次（不翻案）。
   *
   * 注意：lockState **不**参与 auto-approve 判断。auto-approve 的命中只
   * 取决于 origin 配置；解锁后是否真的"跳过 confirming 直接执行"由
   * `acceptRequest` 根据 lockState + autoApproved 决定（见施工单
   * 2026-06-27 001 第五节）：
   *   - unlocked + auto-approved → queued；
   *   - locked + auto-approved   → waiting_unlock_auto（解锁后入队）。
   *
   * 旧实现的问题：`tryAutoApprove` 在 locked 时直接 return false，导致
   * 锁屏期间到达的 auto-approve 请求被错误地推到 `waiting_unlock_manual`，
   * 解锁后还要人工确认——这与施工单"auto-confirm 在锁屏期间不要绕过
   * 解锁直接执行，但解锁后应直接入队"的语义相反。
   */
  private async tryAutoApprove(
    parsed: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> },
    origin: string,
    _rec: RequestRecord
  ): Promise<boolean> {
    if (parsed.method === "p2pkh.transfer") {
      return this.isP2pkhAutoApprovedSync(parsed.params as P2pkhTransferParams, origin);
    }
    if (parsed.method === "feepool.prepare") {
      const amount = (parsed.params as FeepoolPrepareParams).amountSatoshis;
      return this.isFeepoolAutoSignedSync(amount, origin);
    }
    if (parsed.method === "feepool.commit") {
      const opId = (parsed.params as FeepoolCommitParams).operationId;
      const op = this.pendingOps.get(opId);
      const amount = op ? op.amountSatoshis : null;
      if (amount === null || amount <= 0) return false;
      return this.isFeepoolAutoSignedSync(amount, origin);
    }
    if (
      parsed.method === "identity.get" ||
      parsed.method === "cipher.encrypt" ||
      parsed.method === "cipher.decrypt"
    ) {
      // 同步 cache 检查；cache miss 时直接 await 一次 DB 再判定一次。
      let hit =
        parsed.method === "identity.get"
          ? this.isIdentityAutoApprovedSync(origin)
          : this.isCipherAutoApprovedSync(origin);
      if (!hit) {
        const settings = await this.getOriginSettingsCached(origin);
        if (settings) {
          hit =
            (parsed.method === "identity.get" && settings.identityAutoApproveEnabled) ||
            ((parsed.method === "cipher.encrypt" || parsed.method === "cipher.decrypt") &&
              settings.cipherAutoApproveEnabled);
        }
      }
      return hit;
    }
    // connect.* 走 manual 路径（施工单 2026-06-28 001）：
    //   - connect.login / resume：用户必须明确点确认（login 还要选 key）；
    //   - connect.logout：unlocked 时直接入队执行（不需要额外确认 UI），
    //     locked 时进入 waiting_unlock_manual，解锁后直接入队。
    // auto-approve 配置对 connect.* 不生效——caller 主动发 connect.* 已经是
    // "希望走 connect 流程"的信号，不应被 per-origin auto-approve 跳过。
    return false;
  }

  private isP2pkhAutoApprovedSync(params: P2pkhTransferParams, origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    if (!rec.p2pkhAutoApproveEnabled) return false;
    if (params.amountSatoshis <= 0) return false;
    return params.amountSatoshis <= rec.p2pkhAutoApproveMaxSatoshis;
  }

  private isIdentityAutoApprovedSync(origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    return rec.identityAutoApproveEnabled === true;
  }

  private isCipherAutoApprovedSync(origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    return rec.cipherAutoApproveEnabled === true;
  }

  private isFeepoolAutoSignedSync(amountSatoshis: number, origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    if (rec.feePoolAutoSignMaxSatoshis <= 0) return false;
    if (amountSatoshis <= 0) return false;
    return amountSatoshis <= rec.feePoolAutoSignMaxSatoshis;
  }

  private async getOriginSettingsCached(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
    const cached = this.originCache.get(origin);
    if (cached) return cached;
    if (!this.deps.storageDb) return null;
    try {
      const raw = await this.deps.storageDb.getOrigin(origin);
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
   * 设计缘由（施工单 2026-06-30 003 硬切换 4.5）：
   *   - `lockStateValue` 真值 = "当前 Session Window 是否拥有可执行
   *     owner runtime"。`setVaultLockState(locked)` 传的 `locked` 只是
   *     当前 vault 的状态；最终 `lockStateValue` 由 `computeLockState()`
   *     同时参考 vault 状态 + `ownerRuntimesBySessionId` 是否非空决定。
   *   - 因此即便 vault 被 relock，只要 `ownerRuntimesBySessionId` 里还
   *     有 bootstrap_owner runtime，`lockStateValue` 仍保持 unlocked——
   *     不再为了保留"本地 vault locked"细节把 UI / accept 阶段重新推
   *     进解锁流。
   *   - 同样被 `applyLauncherBootstrap` 在注册完 owner runtime 后调用
   *     一次，让 vault locked + bootstrap_owner 已就绪 的组合也能立刻
   *     把已存在的 `waiting_unlock_*` 记录推进到 confirming / queued。
   *
   * 收口语义：
   *   - 状态从 unlocked → locked：所有 `confirming` → `waiting_unlock_manual`
   *     + 清 timeout；`queued` 保持；`executing` 当前这条允许跑完。
   *   - 状态从 locked → unlocked：批量推进 `waiting_unlock_*`。
   *     `authUnlockInProgress` 期间跳过批量推进（auth 页自己处理）。
   */
  setVaultLockState(_vaultLocked: boolean): void {
    // 参数 `_vaultLocked` 仅保留兼容入口；最终态由 computeLockState 统一决定。
    const next = this.computeLockState();
    if (this.lockStateValue === next) return;
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
          // refresh 异步 clamp 到 DB 真值；per-origin timeout 配置必须生效。
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
   *   - cache miss 用缺省 30 兜底；DB 返回后**clamp down**（不 extend）。
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
   *     表示本次已拿到 cache 真值，后续不允许热更新（DB 真值晚到
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
   * 异步刷 origin 配置后，按 DB 真值重新评估当前 request 的
   * timeout deadline。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换 timeout 收口）：
   *   - **只**对 `startedFromFallback === true` 的 request 生效——已经
   *     走同步 cache 命中的 request **不**允许 DB 真值晚到后再热更新。
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
   *   - 同步 cache 命中 → 用 cache 真值启动 timer；后续 DB 真值晚到**不**
   *     热更新（`startedFromFallback = false`）。
   *   - 同步 cache miss → 用 `DEFAULT_CONFIRM_TIMEOUT_SECONDS`
   *     （30s）兜底；后续 DB 真值晚到**只**允许 clamp down
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
    rec.phase = "timed_out";
    rec.errorCode = "user_rejected";
    rec.errorMessage = "User rejected";
    rec.failureReason = "request_timeout";
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    this.writeFeedCommandFor(rec);
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
    if (rec.phase === "executing") return;
    // queued：从执行队列里移除。
    if (rec.phase === "queued") {
      this.executionQueue = this.executionQueue.filter((id) => id !== recordId);
    }
    this.clearConfirmTimeout(recordId);
    rec.phase = "rejected";
    rec.errorCode = "user_rejected";
    rec.errorMessage = "User rejected";
    rec.failureReason = failureReason;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    this.writeFeedCommandFor(rec);
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
        // 等 vault 解锁；保持队首，等待 `setVaultLockState(false)` 后
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
        rec.errorCode = "user_rejected";
        rec.errorMessage = "User rejected";
        rec.failureReason = "runtime_missing";
        rec.finishedAt = Date.now();
        rec.updatedAt = rec.finishedAt;
        this.writeFeedCommandFor(rec);
        await this.replyErrorToRec(rec, "user_rejected", "User rejected");
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
      } catch (err) {
        this.deps.logger?.error?.({
          scope: "protocol.exec",
          event: "runRequest.unexpected",
          recordId,
          err: err instanceof Error ? err.message : String(err)
        });
      } finally {
        this.executingRecordId = null;
      }
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
    | { kind: "fail" }
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
    // connect.launch 是唯一的非 connectSessionId 业务入口；session 真值
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
      sessionId = record.connectSessionId;
    } else {
      const params = rec.params as { connectSessionId?: string } | undefined;
      sessionId = params?.connectSessionId;
    }
    if (!sessionId) {
      return { kind: "fail" };
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding(sessionId);
    } catch {
      session = null;
    }
    if (!session || session.revokedAt !== null) {
      return { kind: "fail" };
    }
    // 1. bootstrap_owner 来源：刚启动 Session Window 时已有。
    if (this.ownerRuntimesBySessionId.has(session.sessionId)) {
      return { kind: "execute" };
    }
    // 2. vault_unlock 来源：本窗口 vault 已 unlock 且能拿到 owner key。
    if (this.lockStateValue === "unlocked") {
      try {
        const key = await this.deps.keyspace.getKey(session.ownerPublicKeyHex);
        if (
          key &&
          key.publicKeyHex &&
          key.keyId &&
          key.identityStatus !== "failed" &&
          key.identityStatus !== "uninitialized"
        ) {
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
    //     keyspace 元数据，**不**要求 vault 解锁：
    //       - keyspace 根本查不到该 owner key（用户已删 / 同步丢失）
    //         → 解锁了也拿不到 → 直接 fail-fast，让用户明确知道
    //         "session 绑定的 key 已经不在本地 vault 里"。
    //       - key 存在但 `identityStatus` 是 `failed` / `uninitialized`
    //         → 解锁后即便读到也用不了 → 同样 fail-fast。
    //       - key 存在且 ready → 等解锁；解锁后由 setVaultLockState
    //         重新触发 drainExecutionQueue → 走第 2 步拿到 execute。
    //   - 这把 "locked + 等下去也无解" 的请求挡在 unlocked 流程之前；
    //     避免无谓解锁。
    try {
      const keyMeta = await this.deps.keyspace.getKey(session.ownerPublicKeyHex);
      if (
        !keyMeta ||
        !keyMeta.publicKeyHex ||
        !keyMeta.keyId ||
        keyMeta.identityStatus === "failed" ||
        keyMeta.identityStatus === "uninitialized"
      ) {
        return { kind: "fail" };
      }
    } catch {
      // keyspace 异常：保守走 unlock 路径（解锁后由第 2 步再判定）。
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
    const result = await this.dispatch(rec);
    if (result) {
      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyResultToRec(rec, result);
    }
    this.emitFeed();
    this.emit();
  }

  private async dispatch(rec: RequestRecord): Promise<MethodResult | null> {
    try {
      switch (rec.method) {
        case "identity.get":
          return await this.executeIdentityGet(rec);
        case "intent.sign":
          return await this.executeIntentSign(rec);
        case "cipher.encrypt":
          return await this.executeCipherEncrypt(rec);
        case "cipher.decrypt":
          return await this.executeCipherDecrypt(rec);
        case "p2pkh.transfer":
          await this.executeP2pkhTransferAndFinalize(rec);
          return null;
        case "feepool.prepare":
          await this.executeFeepoolPrepareAndFinalize(rec);
          return null;
        case "feepool.commit":
          await this.executeFeepoolCommitAndFinalize(rec);
          return null;
        case "connect.login":
          return await this.executeConnectLogin(rec);
        case "connect.resume":
          return await this.executeConnectResume(rec);
        case "connect.logout":
          return await this.executeConnectLogout(rec);
        case "connect.launch":
          return await this.executeConnectLaunch(rec);
      }
    } catch (err) {
      // 业务错误：本地 record 写 failed + 对外回真实 errCode（p2pkh /
      // feepool 已经内部 catch 处理过）；这里只是兜底。
      let errCode: ProtocolErrorCode;
      let errMessage: string;
      let localReason: ProtocolFailureReason | undefined;
      if (err && typeof err === "object" && "localReason" in err) {
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
      rec.phase = "failed";
      rec.errorCode = errCode;
      rec.errorMessage = errMessage;
      rec.failureReason = localReason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, errCode, errMessage);
      return null;
    }
    return null;
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
    // runtime resolver（`bootstrap_owner` / `vault_unlock` 来源对外
    // 行为一致）；**不**直接读 keyId。
    const session = await this.requireConnectSession(rec, params.connectSessionId);
    const publicKeyBytes = await this.fetchPublicKeyBytesWithSession(session);
    const label = await this.withSessionOwnerPrivateKey(session, async () => {
      return session.ownerLabel;
    });

    const { resolvedClaims, projection } = buildClaimProjectionFromParams(params, {
      activeKeyLabel: label
    });

    const envelopeInput: CborValue[] = [
      PROTOCOL_VERSION,
      rec.transportRequestId,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      publicKeyBytes,
      projection.map(([name, val]) => [name, valToCbor(val)])
    ];
    const envelopeCbor = cborEncode(envelopeInput);
    const signature = await this.signWithSessionOwner(session, envelopeCbor);

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
    // resolver，两条来源（`bootstrap_owner` / `vault_unlock`）对外行为一致。
    const session = await this.requireConnectSession(rec, params.connectSessionId);
    const publicKeyBytes = await this.fetchPublicKeyBytesWithSession(session);
    const contentSha256 = sha256Bytes(new Uint8Array(params.content.bytes));
    const envelopeCbor = cborEncode([
      PROTOCOL_VERSION,
      rec.transportRequestId,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      params.contentType,
      contentSha256,
      publicKeyBytes
    ]);
    const signature = await this.signWithSessionOwner(session, envelopeCbor);
    return {
      signedEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature)
    };
  }

  private async executeCipherEncrypt(rec: RequestRecord): Promise<CipherEncryptResult> {
    const params = rec.params as CipherEncryptParams;
    const session = await this.requireConnectSession(rec, params.connectSessionId);
    const siteKey = await this.deriveSiteKeyWithSession(session, rec.origin);
    const inner = cborEncode([
      PROTOCOL_VERSION,
      params.contentType,
      new Uint8Array(params.content.bytes)
    ]);
    const { nonce, cipherbytes } = aesGcmEncrypt(siteKey, inner);
    void this.touchConnectSession(session);
    return {
      nonce: toBinaryField(nonce),
      cipherbytes: toBinaryField(cipherbytes)
    };
  }

  private async executeCipherDecrypt(rec: RequestRecord): Promise<CipherDecryptResult> {
    const params = rec.params as CipherDecryptParams;
    const session = await this.requireConnectSession(rec, params.connectSessionId);
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
    void this.touchConnectSession(session);
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
   *   - DB 不可用时也按 internal_error 拒掉——cipher / connect.* / 业务
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
    if (!this.deps.storageDb) {
      throw localFailure("internal_error", "connect session storage unavailable");
    }
    if (!sessionId) {
      throw localFailure("internal_error", "connect session id missing");
    }
    let session: ConnectSessionRecord | null = null;
    try {
      session = await this.fetchSessionForBinding(sessionId);
    } catch (err) {
      // DB 异常：与"DB unavailable 降级"边界一致——execute 阶段
      // 也走"未查到 session"路径，统一 user_rejected。
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "requireConnectSession.dbError",
        sessionId,
        err: err instanceof Error ? err.message : String(err)
      });
      throw localFailure("internal_error", "connect session storage unavailable");
    }
    if (!session) {
      // 重新做一次更精确的区分：可能是被删 / 被 revoke / 跨 origin。
      // 跨 origin 必须给 caller `invalid_origin` 让其能定位问题；
      // 其它统一 `user_rejected`。
      let raw: ConnectSessionRecord | null = null;
      try {
        raw = await this.deps.storageDb.getConnectSession(sessionId);
      } catch (err) {
        this.deps.logger?.warn?.({
          scope: "protocol.connect",
          event: "requireConnectSession.rawGet.dbError",
          sessionId,
          err: err instanceof Error ? err.message : String(err)
        });
        throw localFailure("internal_error", "connect session storage unavailable");
      }
      if (raw && raw.origin !== rec.origin) {
        throw protocolError("invalid_origin", "connect session origin mismatch");
      }
      throw localFailure("internal_error", "connect session not found / revoked");
    }
    // 施工单 2026-06-30 002 硬切换：session 真值上不再带 runtime 来源。
    // 业务路径一律走 `resolveOwnerRuntime(session)`；accept 阶段
    // 不再为 `runtimeBinding === "vault"` 这条已删除的旧路径预校验
    // owner key——执行阶段 `resolveOwnerRuntime` 走 `bootstrap_owner`
    // → `vault_unlock` 顺序按当前窗口状态决定能不能拿到 runtime。
    return session;
  }

  /**
   * 用 session 绑定的 owner public key 解析当前 vault 内部借用句柄（keyId）。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换）：`ownerKeyId` **不**允许
   * 落 session 持久化；执行时按 `ownerPublicKeyHex` → keyspace.getKey() →
   * `keyId` 解析。`keyId` 是 vault 内部细节，按需解析。
   *
   * 施工单 2026-06-30 002 硬切换：本方法仅在 `resolveOwnerRuntime`
   * 走 `vault_unlock` 来源时调用；`bootstrap_owner` 来源直接拿
   * `ownerRuntimeBootstrap.privateKeyHex`。
   */
  private async resolveOwnerKeyMaterial(
    ownerPublicKeyHex: string
  ): Promise<{ keyId: string; label: string } | null> {
    const key = await this.deps.keyspace.getKey(ownerPublicKeyHex);
    if (!key || !key.keyId || !key.publicKeyHex) {
      return null;
    }
    if (key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
      return null;
    }
    return { keyId: key.keyId, label: key.label };
  }

  /**
   * 统一 owner execution runtime resolver（施工单 2026-06-30 002 硬切换）。
   *
   * 设计缘由：
   *   - 业务方法（`identity.*` / `intent.sign` / `cipher.*` / `p2pkh.transfer` /
   *     `feepool.*`）**统一**走这一个入口解析 owner 执行
   *     材料；**不**再各自手写：
   *       - `keyspace.getKey(...)`
   *       - `vault.withPrivateKey(...)`
   *       - 直接读 `keyspace.active()` 的 active key
   *   - 解析顺序固定为：
   *       1. **`bootstrap_owner`**：当前 Session Window 内存里已
   *          bootstrap 注入的 owner runtime；命中后直接拿私钥 hex，
   *          **不**再读 keyspace / vault。这是 launcher 启动早期
   *          与`vault.locked`态下的主要来源。
   *       2. **`vault_unlock`**：当前窗口 vault 已 unlocked 且
   *          `ownerPublicKeyHex` 对应的 key 可读 → 现解析 vault
   *          `keyId` → 用 `vault.withPrivateKey(keyId, fn)` 借出。
   *       3. 解析失败：抛 `runtime_missing`（对外 `user_rejected`）。
   *   - 业务方法拿到的 `OwnerKeyResolution` 与签名 / 加解密链路
   *     共享同一份 owner 真值——cipher / intent.sign / p2pkh / feepool
   *     走同一条 owner 解析路径。
   */
  private async resolveOwnerRuntime(
    session: ConnectSessionRecord
  ): Promise<OwnerExecutionRuntime> {
    // 1) bootstrap_owner 来源：拿当前窗口已注入的 owner runtime。
    const bootEntry = this.ownerRuntimesBySessionId.get(session.sessionId);
    if (bootEntry) {
      const runtime = bootEntry.runtime;
      // 公钥比较统一 toLowerCase：launcher 端可能用大小写不一。
      if (runtime.ownerPublicKeyHex.toLowerCase() !== session.ownerPublicKeyHex.toLowerCase()) {
        throw localFailure(
          "internal_error",
          "owner runtime ownerPublicKeyHex mismatch"
        );
      }
      return {
        ownerPublicKeyHex: session.ownerPublicKeyHex,
        source: "bootstrap_owner",
        withPrivateKeyHex: async <T>(
          fn: (material: { hex: string }) => Promise<T> | T
        ): Promise<T> => {
          // runtime 私钥 hex 在闭包内短暂暴露；调用方负责"用完即丢"。
          return fn({ hex: runtime.privateKeyHex });
        }
      };
    }
    // 2) vault_unlock 来源：本窗口 vault 解锁后从本地 vault 重建。
    const material = await this.resolveOwnerKeyMaterial(session.ownerPublicKeyHex);
    if (!material) {
      throw localFailure(
        "runtime_missing",
        "owner runtime not available in current window: please reopen the app from Keymaster"
      );
    }
    const { keyId } = material;
    return {
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      source: "vault_unlock",
      withPrivateKeyHex: async <T>(
        fn: (material: { hex: string }) => Promise<T> | T
      ): Promise<T> => {
        return this.deps.vault.withPrivateKey(keyId, async (m) => fn(m));
      }
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
   * （`bootstrap_owner` / `vault_unlock`），对外行为完全一致。
   */
  private async deriveSiteKeyWithSession(
    session: ConnectSessionRecord,
    exactOrigin: string
  ): Promise<Uint8Array> {
    const resolution = await this.resolveOwnerRuntime(session);
    return resolution.withPrivateKeyHex(async (material) => {
      return deriveSiteKey(material.hex, exactOrigin);
    });
  }

  /**
   * 在 session 绑定的 owner 私钥闭包内执行回调（施工单 2026-06-30 002）。
   *
   * 取代 `vault.withPrivateKey(keyId, fn)` 的"按 session"版。业务方法
   * **统一**走这一个入口持有 owner 私钥 hex；**不**各自手写 keyId 解析。
   */
  private async withSessionOwnerPrivateKey<T>(
    session: ConnectSessionRecord,
    fn: (material: { hex: string }) => Promise<T> | T
  ): Promise<T> {
    const resolution = await this.resolveOwnerRuntime(session);
    return resolution.withPrivateKeyHex(fn);
  }

  /**
   * 从 `rec` 上拿 connect session 真值（施工单 2026-06-30 002）。
   *
   * 设计缘由：feepool / p2pkh 等业务方法先前直接用 `keyId` 调
   * `vault.withPrivateKey(keyId, fn)`；本单让所有业务方法统一走
   * `resolveOwnerRuntime` 后，session 真值通过 `rec.connectSessionId`
   * + `fetchSessionForBinding` 取出。
   */
  private async requireSessionFromRec(
    rec: RequestRecord
  ): Promise<ConnectSessionRecord> {
    if (!rec.connectSessionId) {
      throw localFailure("internal_error", "rec.connectSessionId missing");
    }
    const session = await this.fetchSessionForBinding(rec.connectSessionId);
    if (!session) {
      throw localFailure("internal_error", "connect session not found");
    }
    return session;
  }

  /**
   * 在 session 绑定的 owner 私钥上做 secp256k1 签名（compact 64 字节）。
   *
   * 取代 `signWithOwnerKey(keyId, bytes)` 的"按 session"版。
   */
  private async signWithSessionOwner(
    session: ConnectSessionRecord,
    bytes: Uint8Array
  ): Promise<Uint8Array> {
    return this.withSessionOwnerPrivateKey(session, async (material) => {
      return signCompactSecp256k1(material.hex, bytes);
    });
  }

  /**
   * 取 session 绑定的 owner 压缩公钥字节（envelope / subject 字段用）。
   *
   * 取代 `fetchPublicKeyBytes(publicKeyHex, keyId)` 的"按 session"版。
   */
  private async fetchPublicKeyBytesWithSession(
    session: ConnectSessionRecord
  ): Promise<Uint8Array> {
    return this.withSessionOwnerPrivateKey(session, async (material) => {
      return secp256k1.getPublicKey(hexToBytes(material.hex), true);
    });
  }

  /**
   * 取 session 绑定的 owner 私钥明文 hex（feepool 等场景需要交给 SDK 签名）。
   */
  private async getSessionOwnerPrivHex(session: ConnectSessionRecord): Promise<string> {
    return this.withSessionOwnerPrivateKey(session, async (m) => m.hex);
  }

  /**
   * 更新 session.lastUsedAt。fire-and-forget：cipher 解密 / 加密的
   * 主路径**不**等待 DB 写；写失败时 DB 侧记日志但不影响主流程。
   */
  private touchConnectSession(session: ConnectSessionRecord): void {
    if (!this.deps.storageDb) return;
    session.lastUsedAt = Date.now();
    const next: ConnectSessionRecord = { ...session, lastUsedAt: session.lastUsedAt };
    void this.deps.storageDb.putConnectSession(next).catch((err) => {
      this.deps.logger?.warn?.({
        scope: "protocol.connect",
        event: "touchConnectSession.putFailed",
        sessionId: session.sessionId,
        err: err instanceof Error ? err.message : String(err)
      });
    });
  }

  /**
   * 执行 connect.login。
   *
   * 关键不变量（施工单 2026-06-28 002 硬切换）：
   *   - ownerPublicKeyHex 必须是用户在 UI 上选定的那把 key 公钥 hex
   *     （来自 rec.connectLoginSelected；用户在 confirmConnectLogin 时写入）；
   *   - owner 唯一真值 = `ownerPublicKeyHex`；`ownerKeyId` **不**落
   *     session record；vault 内部 keyId 按需在执行时从 keyspace 解析。
   *   - owner key 必须在 keyspace 内可查，且 identityStatus === "ready"；
   *   - DB 不可用时直接拒掉（fail-closed）。
   */
  private async executeConnectLogin(rec: RequestRecord): Promise<ConnectLoginResult> {
    const params = rec.params as ConnectLoginParams;
    const ownerPublicKeyHex = rec.connectLoginSelected;
    if (!ownerPublicKeyHex) {
      throw localFailure("internal_error", "connect.login: no owner selected");
    }
    const key = await this.deps.keyspace.getKey(ownerPublicKeyHex);
    if (!key || !key.publicKeyHex) {
      throw localFailure("internal_error", "connect.login: owner key not found");
    }
    if (key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
      throw localFailure("internal_error", "connect.login: owner key not ready");
    }
    if (!this.deps.storageDb) {
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
    const now = Date.now();
    const sessionId = this.nextRecordId();
    const record: ConnectSessionRecord = {
      sessionId,
      origin: rec.origin,
      ownerPublicKeyHex: key.publicKeyHex,
      ownerLabel: key.label,
      claimsSnapshot: resolvedClaims,
      // 施工单 2026-06-30 002 硬切换：session 真值收口为三元组
      // （sessionId + origin + ownerPublicKeyHex），**不**写
      // `runtimeBinding`——执行路径走统一 owner runtime resolver，
      // 不再依赖 session 真值上的分叉。
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    };
    await this.deps.storageDb.putConnectSessionAndRevokeOriginPeers(record);
    return {
      connectSessionId: sessionId,
      ownerPublicKeyHex: key.publicKeyHex,
      resolvedClaims: resolvedClaims,
      resolvedAt: now
    };
  }

  /**
   * 执行 connect.resume。
   *
   * 关键不变量：
   *   - session 真值必须仍在 DB 内（rec.connectResumeSnapshot 由
   *     `bootstrapConnectResumeRecord` 在 acceptRequest 时预填，执行时
   *     仍以 DB 当前值为准；中间态变化以 DB 为真值）；
   *   - origin / revokedAt / owner ready 三道闸在执行时**重新**校验一次
   *     （即使 popup 当前文档 unlock runtime 仍在，session 也可能被外部
   *     logout / key 删除 / 别的 tab 改 DB）；
   *   - 失败语义与 cipher 路径一致。
   */
  private async executeConnectResume(rec: RequestRecord): Promise<ConnectResumeResult> {
    const params = rec.params as ConnectResumeParams;
    const session = await this.requireConnectSession(rec, params.connectSessionId);
    const key = await this.deps.keyspace.getKey(session.ownerPublicKeyHex);
    if (!key || !key.publicKeyHex) {
      throw localFailure("internal_error", "connect.resume: owner key not found");
    }
    if (key.identityStatus === "failed" || key.identityStatus === "uninitialized") {
      throw localFailure("internal_error", "connect.resume: owner key not ready");
    }
    const now = Date.now();
    const next: ConnectSessionRecord = { ...session, lastUsedAt: now };
    if (this.deps.storageDb) {
      try {
        await this.deps.storageDb.putConnectSession(next);
      } catch (err) {
        this.deps.logger?.warn?.({
          scope: "protocol.connect",
          event: "touchConnectSession.putFailed",
          sessionId: session.sessionId,
          err: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return {
      connectSessionId: session.sessionId,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      resolvedClaims: session.claimsSnapshot,
      resolvedAt: now
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
   *     调用 `setVaultLockState(true)`：
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
    if (!this.deps.storageDb) {
      throw localFailure("internal_error", "connect.logout: session storage unavailable");
    }
    const existing = await this.deps.storageDb.getConnectSession(params.connectSessionId);
    const now = Date.now();
    let result: ConnectLogoutResult;
    if (!existing) {
      // 幂等：session 不存在也直接回 ok=true。site 自己应当处理
      // "sessionId 本地丢失 → 不需要 logout"的情况，但即使重复 logout
      // 也不报错。
      result = {
        connectSessionId: params.connectSessionId,
        revokedAt: now
      };
    } else if (existing.origin !== rec.origin) {
      throw protocolError("invalid_origin", "connect.logout: session origin mismatch");
    } else if (existing.revokedAt !== null) {
      // 已 revoke 视为幂等成功。
      result = {
        connectSessionId: existing.sessionId,
        revokedAt: existing.revokedAt
      };
    } else {
      const next: ConnectSessionRecord = { ...existing, revokedAt: now };
      await this.deps.storageDb.putConnectSession(next);
      result = {
        connectSessionId: existing.sessionId,
        revokedAt: now
      };
    }
    // 清掉 popup 当前 unlock runtime。**同步** await：施工单 4.4 + 5.1.3
    // 要求 logout 同时"吊销 session + 清 popup unlock runtime"——
    // 任意一步失败即视为 logout 不完整；fire-and-forget 会让 caller 在
    // vault.lock 抛出（例如 keyspace.onVaultLocked 失败 / 业务订阅者抛
    // 错）时仍收到 ok=true，导致"session 已吊销但 unlock runtime 还在"
    // 的状态错位。
    //
    // 副作用：DB 里 session.revokedAt 已被本次写入；即使 vault.lock
    // 抛错、对外回 ok=false，session 真值层面 logout 已生效——下次
    // connect.resume / cipher.* 仍会按 fail-fast 路径失败（session
    // revoked）。这是 fail-closed 的安全语义，不是 bug。
    try {
      await this.deps.vault.lock();
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.connect",
        event: "logout.vaultLock.failed",
        sessionId: params.connectSessionId,
        err: err instanceof Error ? err.message : String(err)
      });
      throw localFailure("internal_error", "connect.logout: vault lock failed");
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
    if (!this.deps.storageDb) {
      throw localFailure(
        "internal_error",
        "connect.launch: session storage unavailable"
      );
    }
    // 校验 session 真值（与 connect.resume 同一路径）：session 不存在 /
    // 已 revoke / origin 不匹配 / owner 不 ready 都拒掉。
    const session = await this.deps.storageDb.getConnectSession(record.connectSessionId);
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
    // 消费 token：一次性，幂等。
    this.launchTokensByToken.set(params.launchToken, { ...record, consumed: true });
    const now = Date.now();
    const next: ConnectSessionRecord = { ...session, lastUsedAt: now };
    try {
      await this.deps.storageDb.putConnectSession(next);
    } catch (err) {
      this.deps.logger?.warn?.({
        scope: "protocol.connect.launch",
        event: "touchSession.failed",
        sessionId: session.sessionId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
    return {
      connectSessionId: session.sessionId,
      ownerPublicKeyHex: session.ownerPublicKeyHex,
      resolvedClaims: session.claimsSnapshot,
      resolvedAt: now
    };
  }

  /* ============== p2pkh.transfer ============== */

  private async executeP2pkhTransferAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as P2pkhTransferParams;
    if (!this.deps.p2pkhService) {
      rec.phase = "failed";
      rec.errorCode = "internal_error";
      rec.errorMessage = "p2pkh service not available";
      rec.failureReason = "internal_error";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "internal_error", "p2pkh service not available");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：p2pkh.transfer 走 session 绑定 owner，
      // 不再读全局 active key。execute 阶段先 requireConnectSession 校验
      // session 仍有效，再把 session 绑定的 owner public key 交给
      // p2pkhService（plugin-p2pkh 内部按 ownerPublicKeyHex 解析 keyId
      // 走选币 + 签名）。
      const session = await this.requireConnectSession(rec, params.connectSessionId);
      const ownerPublicKeyHex = session.ownerPublicKeyHex;
      const card = this.feedCommands.find((c) => c.id === rec.recordId);
      if (card) {
        card.recipientAddress = params.recipientAddress;
        card.amountSatoshis = params.amountSatoshis;
        card.autoApproved = rec.autoApproved;
        card.updatedAt = Date.now();
        this.persistRecord(card);
      }
      const preview = await this.deps.p2pkhService.prepareTransfer({
        assetId: "bsv",
        ownerPublicKeyHex,
        recipientAddress: params.recipientAddress,
        amountSatoshis: params.amountSatoshis,
        feeRateSatoshisPerKb: params.feeRateSatoshisPerKb ?? DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB
      });
      // preview 透传 ownerPublicKeyHex；submit 阶段 plugin-p2pkh
      // 会校验 resource / 签名 key 与 owner 一致，跨 owner 复用
      // preview 直接拒绝。
      const previewWithOwner = { ...preview, ownerPublicKeyHex };
      const submitted = await this.deps.p2pkhService.submitTransfer(previewWithOwner);
      const txid = submitted.txid ?? preview.txid;
      const result: P2pkhTransferResult = {
        txid,
        rawTxHex: submitted.rawTxHex,
        feeSatoshis: preview.estimatedFeeSatoshis
      };
      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyResultToRec(rec, result);
    } catch (err) {
      const reason = classifyP2pkhFailure(err);
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = reason;
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /* ============== feepool.prepare ============== */

  private async executeFeepoolPrepareAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as FeepoolPrepareParams;
    if (!this.deps.storageDb) {
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = "fee_pool_db_unavailable";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：feepool 走 session 绑定 owner；
      // poolKey 补 ownerPublicKeyHex 维度（不再仅按 origin + counterparty）。
      const session = await this.requireConnectSession(rec, params.connectSessionId);
      const ownerPublicKeyHex = session.ownerPublicKeyHex;
      const poolKey = `${rec.origin}::${ownerPublicKeyHex}::${params.counterpartyPublicKeyHex}`;
      const prior = await this.deps.storageDb.getFeePool(poolKey);
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
      // resolver；`bootstrap_owner` / `vault_unlock` 两条来源对外
      // 行为一致，都返回同一份 owner 私钥 hex。
      const clientPrivateKeyHex = await this.getSessionOwnerPrivHex(session);
      const operationId = this.nextRecordId();
      const preparedAt = Date.now();

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
          clientPrivateKeyHex,
          params.counterpartyPublicKeyHex,
          poolAmount,
          ownerPublicKeyHex
        );
        baseTxHex = baseResp.baseTxHex;
        baseTxOutputIndex = baseResp.baseTxOutputIndex;
        draftTotalAmount = baseResp.amount;
        const initialDraft = await sdkBuildInitialDraftSpendTx({
          prevTxId: baseResp.baseTxid,
          totalAmount: draftTotalAmount,
          serverAmount: params.amountSatoshis,
          endHeight: 0,
          clientPrivateKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          feeRate: 1
        });
        const clientSig = await sdkClientSignInitialSpendTx({
          txHex: initialDraft.txHex,
          totalAmount: draftTotalAmount,
          clientPrivateKeyHex,
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
          clientPublicKeyHex: ownerPublicKeyHex,
          targetAmount: prior.totalAmount
        });
        const clientSig = await sdkClientSignUpdatedSpendTx({
          txHex: loaded.txHex,
          clientPrivateKeyHex,
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
          clientPublicKeyHex: ownerPublicKeyHex,
          targetAmount: prior.totalAmount
        });
        const closeClientSig = await sdkClientSignUpdatedSpendTx({
          txHex: closeLoaded.txHex,
          clientPrivateKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        closeDraftTxHex = closeLoaded.txHex;
        closeClientSignBytes = closeClientSig;
        const baseResp = await this.buildAndMaybeBuildBaseTx(
          prior,
          clientPrivateKeyHex,
          params.counterpartyPublicKeyHex,
          newPoolAmount,
          ownerPublicKeyHex
        );
        baseTxHex = baseResp.baseTxHex;
        baseTxOutputIndex = baseResp.baseTxOutputIndex;
        draftTotalAmount = baseResp.amount;
        const newInitialDraft = await sdkBuildInitialDraftSpendTx({
          prevTxId: baseResp.baseTxid,
          totalAmount: draftTotalAmount,
          serverAmount: params.amountSatoshis,
          endHeight: 0,
          clientPrivateKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex,
          feeRate: 1
        });
        const newClientSig = await sdkClientSignInitialSpendTx({
          txHex: newInitialDraft.txHex,
          totalAmount: draftTotalAmount,
          clientPrivateKeyHex,
          serverPublicKeyHex: params.counterpartyPublicKeyHex
        });
        draftSpendTxHex = newInitialDraft.txHex;
        draftClientSignBytes = newClientSig;
      }

      // 关键（施工单 2026-06-28 002 硬切换）：pending op 必须绑定
      // connectSessionId + ownerPublicKeyHex。commit 阶段按 origin +
      // connectSessionId + ownerPublicKeyHex + counterpartyPublicKeyHex
      // 四元组校验 op，禁止跨 session / 跨 owner 复用 operationId。
      this.pendingOps.set(operationId, {
        operationId,
        origin: rec.origin,
        connectSessionId: rec.connectSessionId,
        ownerPublicKeyHex,
        counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
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
        card.updatedAt = Date.now();
        this.persistRecord(card);
      }

      const result: FeepoolPrepareResult = {
        operationId,
        action,
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
      this.writeFeedCommandFor(rec);
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
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /* ============== feepool base tx helper ============== */

  /**
   * 建 A-Tx（client P2PKH UTXO → 2-of-2 multisig output）；create /
   * close_and_recreate 复用。返回 `baseTxHex` / `baseTxOutputIndex` /
   * `baseTxid` / `amount`（multisig output 大小）。
   *
   * 设计缘由（施工单 2026-06-28 002 硬切换）：
   *   - UTXO 选币按 `ownerPublicKeyHex`（session 绑定 owner）走，**不**
   *     读全局 active key 的 namespace。`clientPrivateKeyHex` 由调用方
   *     从 session owner 解析出来的 keyId 借出，与 ownerPublicKeyHex
   *     在 plugin-p2pkh 内部必须同源。
   *   - 旧实现读 `listUtxos({ assetId: "bsv" })` 等于"取当前 active key
   *     namespace"——会与签名 key 错位。本实现强制传 owner 让 plugin-p2pkh
   *     内部按 owner 过滤 UTXO。
   */
  private async buildAndMaybeBuildBaseTx(
    prior: ProtocolFeePoolRecord | null,
    clientPrivateKeyHex: string,
    serverPublicKeyHex: string,
    poolAmount: number,
    ownerPublicKeyHex: string
  ): Promise<{
    baseTxHex: string;
    baseTxOutputIndex: number;
    baseTxid: string;
    amount: number;
  }> {
    if (!this.deps.p2pkhService) {
      throw localFailure("internal_error", "p2pkh service required for fee pool base tx");
    }
    // 关键（002 硬切换）：UTXO 选币按 owner 走，**不**读全局 active key。
    // plugin-p2pkh 内部 `listUtxos` filter 已支持 `ownerPublicKeyHex`。
    const utxos = await this.deps.p2pkhService.listUtxos({
      assetId: "bsv",
      ownerPublicKeyHex
    });
    if (utxos.length === 0) {
      throw localFailure(
        "internal_error",
        `No P2PKH UTXOs to fund fee pool for owner ${ownerPublicKeyHex}`
      );
    }
    const resp = await sdkBuildBaseTx({
      clientUtxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, satoshis: u.value })),
      clientPrivateKeyHex,
      serverPublicKeyHex,
      feepoolAmount: poolAmount,
      feeRate: 1
    });
    return {
      baseTxHex: resp.txHex,
      baseTxOutputIndex: resp.outputIndex,
      baseTxid: resp.txid,
      amount: resp.amount
    };
  }

  /* ============== feepool.commit ============== */

  private async executeFeepoolCommitAndFinalize(rec: RequestRecord): Promise<void> {
    const params = rec.params as FeepoolCommitParams;
    if (!this.deps.storageDb) {
      rec.phase = "failed";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = "fee_pool_db_unavailable";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
      return;
    }
    try {
      // 施工单 2026-06-28 002 硬切换：feepool.commit 必须按 origin +
      // connectSessionId + ownerPublicKeyHex + counterpartyPublicKeyHex
      // 四元组校验 pending op，禁止跨 session / 跨 owner 复用 operationId。
      const session = await this.requireConnectSession(rec, params.connectSessionId);
      const op = this.pendingOps.get(params.operationId);
      if (!op) {
        throw localFailure("unknown_operation", "operationId not found in current session");
      }
      if (op.origin !== rec.origin) {
        throw localFailure("cross_origin_operation", "operationId from a different origin");
      }
      if (op.connectSessionId !== session.sessionId) {
        throw localFailure("internal_error", "operationId from a different connect session");
      }
      if (op.ownerPublicKeyHex !== session.ownerPublicKeyHex) {
        throw localFailure("internal_error", "operationId bound to a different owner");
      }
      if (op.counterpartyPublicKeyHex !== params.counterpartyPublicKeyHex) {
        throw localFailure("internal_error", "counterpartyPublicKeyHex mismatch");
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
      const poolKey = `${rec.origin}::${session.ownerPublicKeyHex}::${params.counterpartyPublicKeyHex}`;
      let newRecord: ProtocolFeePoolRecord | null = null;
      const draftTxid = await computeTxidFromHex(op.draftSpendTxHex);
      const draftTxHex = op.draftSpendTxHex;
      let closeDraftTxid: string | undefined;

      if (op.action === "create" || op.action === "close_and_recreate") {
        const baseTxid = await computeTxidFromHex(op.baseTxHex ?? "");
        newRecord = {
          poolKey,
          origin: rec.origin,
          ownerPublicKeyHex: session.ownerPublicKeyHex,
          counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
          baseTxid,
          baseTxHex: op.baseTxHex ?? "",
          totalAmount: op.draftTotalAmount,
          serverAmount: op.nextServerAmount,
          draftSpendTxHex: op.draftSpendTxHex,
          draftClientSignBytes: bytesToBinaryField(op.draftClientSignBytes),
          lastOperationId: op.operationId,
          updatedAt: Date.now()
        };
        await this.deps.storageDb.putFeePool(newRecord);
      } else if (op.action === "spend" && op.priorPool) {
        const baseTxid = op.priorPool.baseTxid;
        const baseTxHex = op.priorPool.baseTxHex;
        newRecord = {
          poolKey: op.priorPool.poolKey,
          origin: rec.origin,
          ownerPublicKeyHex: session.ownerPublicKeyHex,
          counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
          baseTxid,
          baseTxHex,
          totalAmount: op.draftTotalAmount,
          serverAmount: op.nextServerAmount,
          draftSpendTxHex: op.draftSpendTxHex,
          draftClientSignBytes: bytesToBinaryField(op.draftClientSignBytes),
          lastOperationId: op.operationId,
          updatedAt: Date.now()
        };
        await this.deps.storageDb.putFeePool(newRecord);
      }
      if (op.action === "close_and_recreate" && op.closeDraftTxHex) {
        closeDraftTxid = await computeTxidFromHex(op.closeDraftTxHex);
      }
      this.pendingOps.delete(op.operationId);

      const card = this.feedCommands.find((c) => c.id === rec.recordId);
      if (card) {
        card.action = op.action;
        card.operationId = op.operationId;
        card.updatedAt = Date.now();
        this.persistRecord(card);
      }

      const result: FeepoolCommitResult = {
        operationId: op.operationId,
        action: op.action,
        draftTxid,
        draftTxHex,
        poolRecord: newRecord,
        closeDraftTxid
      };

      rec.phase = "approved";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.writeFeedCommandFor(rec);
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
      this.writeFeedCommandFor(rec);
      await this.replyErrorToRec(rec, "user_rejected", "User rejected");
    }
  }

  /* ============== vault / 私钥 helpers ============== */

  /**
   * 借出 private key 拿 hex 文本。feepool 等场景要拿私钥 hex 给 SDK 签名
   * 草稿；通过 `keyId` 借用，不走全局 active key。
   */
  private async getActiveKeyHex(keyId: string): Promise<string> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => material.hex);
  }

  /**
   * 用指定 key（由 `ownerPublicKeyHex` 解析出的 vault keyId）做 compact
   * secp256k1 签名。identity.get / intent.sign / 任何业务方法**都**走
   * 这条路径——不允许 fallback 到钱包全局 active key。
   */
  private async signWithOwnerKey(keyId: string, bytes: Uint8Array): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return signCompactSecp256k1(material.hex, bytes);
    });
  }

  /**
   * 取 owner 压缩公钥字节（用于 envelope / subject 字段）。走 vault 借用
   * 私钥 hex → noble secp256k1 推出 compressed pubkey。
   */
  private async fetchPublicKeyBytes(publicKeyHex: string, keyId: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      const pub = secp256k1.getPublicKey(hexToBytes(material.hex), true);
      return pub;
    });
  }

  /* ============== 发送 ============== */

  private async replyResultToRec(rec: RequestRecord, result: MethodResult): Promise<void> {
    const target = rec.source;
    if (!this.canPostToTarget(target)) return;
    const message: ProtocolResultMessage = {
      v: PROTOCOL_VERSION,
      type: "result",
      id: rec.transportRequestId,
      ok: true,
      result
    };
    this.postMessage(target, rec.origin, message);
  }

  private async replyErrorToRec(
    rec: RequestRecord,
    code: ProtocolErrorCode,
    errorMessage: string
  ): Promise<void> {
    const target = rec.source;
    if (!this.canPostToTarget(target)) return;
    const message: ProtocolResultMessage = {
      v: PROTOCOL_VERSION,
      type: "result",
      id: rec.transportRequestId,
      ok: false,
      error: { code, message: errorMessage }
    };
    this.postMessage(target, rec.origin, message);
  }

  private canPostToTarget(target: Window): boolean {
    try {
      const s = target as Window & { closed?: boolean };
      if (s.closed === true) return false;
    } catch {
      return false;
    }
    return true;
  }

  private postMessage(target: Window, origin: string, message: ProtocolResultMessage): void {
    if (this.deps.postResult) {
      this.deps.postResult(target, origin, message);
      return;
    }
    try {
      target.postMessage(message, origin);
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.transport",
        event: "postMessage.failed",
        data: { err: String(err) }
      });
    }
  }

  private sendClosingBestEffort(): void {
    if (this.closingSent) return;
    // 优先取当前任意一条活请求的 source；否则取 opener。
    let target: Window | null = null;
    let origin = "*";
    for (const [, rec] of this.requestsByRecordId) {
      target = rec.source;
      origin = rec.origin;
      break;
    }
    if (!target) {
      target = this.getOpener();
    }
    if (!target) {
      this.closingSent = true;
      return;
    }
    if (!this.canPostToTarget(target)) {
      this.closingSent = true;
      return;
    }
    this.closingSent = true;
    if (this.deps.postClosing) {
      try {
        this.deps.postClosing(target, CLOSING_MESSAGE);
      } catch (err) {
        this.deps.logger?.error?.({
          scope: "protocol.transport",
          event: "closing.failed",
          data: { err: String(err) }
        });
      }
      return;
    }
    try {
      target.postMessage(CLOSING_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.transport",
        event: "closing.failed",
        data: { err: String(err) }
      });
    }
    void origin;
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
  private isAllowedRequestSource(event: MessageEvent, _method: ProtocolMethod): boolean {
    const source = event.source as Window | null;
    if (!source) return false;
    if (this.bootModeValue !== "appView") {
      const opener = this.getOpener();
      return Boolean(opener && source === opener);
    }
    const ctx = this.currentAppViewContext;
    if (!ctx) return false;
    if (event.origin !== ctx.appOrigin) return false;
    if (this.currentAppClientSource) {
      return source === this.currentAppClientSource;
    }
    // 首条合法 child request 即绑 source。`handleMessage` 紧随其后调
    // `markChildAliveFromBoundSource`，把 childReady 翻 true。
    this.currentAppClientSource = source;
    return true;
  }

  /* ============== 命令流（feed）+ DB ============== */

  /**
   * 当前 record 的 phase 是否已经走到终态（不可再被 `confirmByUser` /
   * `rejectByUser` 影响，仍可作为历史展示）。
   *
   * 终态集合（与 `ProtocolCommandPhase` 同步）：
   *   approved / rejected / failed / timed_out
   *
   * 旧 `waiting_unlock` / `waiting_confirm` 是 DB 历史 schema 上的 alias，
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
   * 入参 `records` 一般来自 `feedCommands` 或"DB 历史 + 内存活记录"的
   * 合并结果；本函数只负责按 phase / 时间戳排序，**不**做 id 去重——
   * 调用方负责先按 id 合并（DB + 内存合并时内存覆盖 DB）。
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
   *   - `connectSessionId` + `ownerPublicKeyHex` 从 `rec` 字段读取——即 record
   *     创建时快照下来的值，**不**再读 `keyspace.active()` / 钱包全局
   *     active key。这样符合 contract `ProtocolCommandRecord.ownerPublicKeyHex`
   *     注释："record 在创建时快照的 owner public key hex"。
   *   - 后续即便用户在 popup 会话里切换 active key，旧卡片的元数据
   *     不会被污染。
   */
  private writeFeedCommandFor(rec: RequestRecord): void {
    const card = this.makeCommandRecord(rec);
    this.upsertFeedCommand(card);
    this.persistRecord(card);
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
      origin: rec.origin,
      requestId: rec.transportRequestId,
      method: rec.method,
      phase: rec.phase,
      decision,
      status,
      textSummary: this.summarizeText(rec.params),
      claimsSummary: this.summarizeClaims(rec.params),
      contentType: this.summarizeContentType(rec.params),
      payloadSize: this.summarizePayloadSize(rec.params),
      connectSessionId: rec.connectSessionId,
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

  private persistRecord(record: ProtocolCommandRecord): void {
    const db = this.deps.storageDb;
    if (!db) return;
    // 施工单 2026-06-27 001/002 明确：活请求只存在于当前 popup 会话内存，
    // popup 刷新 / 关闭后不做会话级活卡恢复。因此 IndexedDB 只持久化终态；
    // 中间态（waiting_unlock_* / confirming / queued / executing）即便误写，
    // 也只会制造"UI 看起来有活卡，但内存里已经没有 request"的脏状态。
    if (!this.isTerminalPhase(record.phase)) return;
    void db.putCommand(record).catch((err) => {
      console.error("[protocol.storageDb] persistRecord failed", {
        id: record.id,
        origin: record.origin,
        error: err instanceof Error ? err.message : String(err)
      });
      if (this.historyAvailableFlag) {
        this.historyAvailableFlag = false;
        this.emitFeed();
      }
    });
  }

  /**
   * 历史加载（施工单 2026-06-27 002 硬切换 + 反馈修复）。
   *
   * 行为：
   *   - 同 origin 内已有的 in-flight load 直接复用返回的 promise（避免
   *     对同 origin 重复 DB 读取）；**不同 origin 各自独立**——
   *     `historyLoadInFlightByOrigin: Map<origin, Promise>`，不能用
   *     全局 `currentOriginValue` 判断复用（否则切到 B 时复用 A 的 in-flight）。
   *   - 加载完成后，按 recordId 合并 DB 历史 + 内存活记录，**同 id 以
   *     内存活记录为准**；DB 旧字段不允许覆盖当前内存里的活卡。
   *   - DB 里若残留旧版本误写进去的中间态 record（confirming /
   *     waiting_unlock_* / queued / executing），本轮直接忽略：活请求
   *     只能来自当前 popup 会话内存，不能跨会话从 DB "复活"。
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
    const db = this.deps.storageDb;
    if (!db) {
      // DB 不可用：仅当当前 currentOrigin 仍等于本 origin 时把"不可用"
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
        const [list, originRec, pools] = await Promise.all([
          db.listCommandsByOrigin(origin),
          db.getOrigin(origin),
          db.listFeePoolsByOrigin(origin)
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
        // 按 recordId 合并：内存活记录优先覆盖 DB 旧记录。
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
          void pools;
          this.emitFeed();
        }
      } catch (err) {
        console.error("[protocol.storageDb] loadHistoryForOrigin failed", {
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
   * 取当前 origin 的内存活命令卡（不读 DB）。
   * 用于切 origin / DB 不可用时快速重建"当前 origin 视图"。
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
      rec.phase === "queued"
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
      return { code: e.code as ProtocolErrorCode, message: e.message };
    }
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : "Internal error" };
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

function looksLikeRequest(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === PROTOCOL_VERSION &&
    o.type === "request" &&
    typeof o.id === "string" &&
    typeof o.method === "string"
  );
}

function looksLikeCancel(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === PROTOCOL_VERSION &&
    o.type === "cancel" &&
    typeof o.id === "string"
  );
}

/**
 * 顶层 `ready` 报文形状判定（施工单 2026-06-30 003）。
 *
 * 设计缘由：
 *   - `ready` 是顶层协议消息（无 method / 无 id），与 request / cancel
 *     互斥。
 *   - 不带 `id`：与 cancel 区分；不带 `method`：与 request 区分。
 *   - 这里**只**做结构判定，合法性（origin + source）由 `handleMessage`
 *     调用 `tryAcceptChildReady` 时集中判定。
 */
function looksLikeReady(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.v === PROTOCOL_VERSION && o.type === "ready";
}

function toBinaryField(bytes: Uint8Array, mime?: string) {
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
