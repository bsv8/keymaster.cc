// packages/plugin-protocol/src/protocolService.ts
// 协议 service：transport + 校验 + 解锁/确认调度 + 全局串行执行 +
// 调用 vault / keyspace + 构造 envelope + 签名/加解密 + 命令流历史 +
// p2pkh.transfer / feepool.prepare / feepool.commit 执行。
//
// 设计缘由（施工单 2026-06-27 001 硬切换：popup 锁屏 + 多 request 并存 +
// 全局串行执行）：
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
//   - `cancel(id)` 按 `source + origin + transportRequestId` 命中具体
//     request；命中后转 rejected，对外回原 request 的 user_rejected。
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
// operationId，**全部**对外回 `user_rejected`；真实原因只写
// `ProtocolCommandRecord.failureReason`。
//
// DB 不可用差异化降级：p2pkh 仍可用（auto-approve 被禁用、manual
// confirm 仍可走通）；feepool 直接 fail-closed。
//
// 不依赖 React；可单测。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  PROTOCOL_VERSION,
  type BinaryField,
  type CipherDecryptParams,
  type CipherDecryptResult,
  type CipherEncryptParams,
  type CipherEncryptResult,
  type FeepoolCommitParams,
  type FeepoolCommitResult,
  type FeepoolPrepareParams,
  type FeepoolPrepareResult,
  type IdentityGetParams,
  type IdentityGetResult,
  type IntentSignParams,
  type IntentSignResult,
  type KeyspaceService,
  type MethodParams,
  type MethodResult,
  type P2pkhProtocolAdapter,
  type P2pkhTransferParams,
  type P2pkhTransferResult,
  type ProtocolClosingMessage,
  type ProtocolCommandFeedState,
  type ProtocolCommandRecord,
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
  sha256Bytes,
  signCompactSecp256k1
} from "./protocolCrypto.js";
import { cborDecode, cborEncode, type CborValue } from "./protocolCbor.js";
import { buildClaimProjectionFromParams } from "./protocolClaims.js";
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
   * 写记录时快照的 active public key hex（施工单 2026-06-27 002 反馈修复）。
   *
   * 严格遵守 contract `ProtocolCommandRecord.activePublicKeyHex` 的语义：
   * "执行该命令时 active public key hex；写记录时取一次"。后续写卡
   * **不**再读当前 active key——即使 popup 会话里用户切换 active key，
   * 旧卡片的 `activePublicKeyHex` 字段也保持 record 创建时的快照值，
   * 不被污染。
   */
  activePublicKeyHex: string;
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
  /** 本地真实失败原因（写本地）；隐私敏感场景与对外解耦。 */
  failureReason?: ProtocolFailureReason;
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

  constructor(private readonly deps: ProtocolServiceDeps) {
    this.historyAvailableFlag = Boolean(deps.storageDb);
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
    this.phase = "waiting";
    // 同时推 session 快照 + feed 快照：feed 订阅者拿到空 feed；
    // session 订阅者拿到 phase="waiting" + lockState 不变（vault 状态
    // 与 popup 生命周期解耦，由 setVaultLockState 单独管理）。
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
      await this.finalizeRequestByCancel(rec.recordId);
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

    // 校验 source 与 opener 一致（不接受"伪 source"伪造）。
    const opener = this.getOpener();
    if (!opener || event.source !== opener) return;

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
    void this.drainExecutionQueue();
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
    await this.finalizeRequestByCancel(rec.recordId);
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
      // manual → confirming（启动 timeout + 异步 clamp）；auto → queued（直接入队）。
      for (const rec of manualRecs) {
        this.setRecordPhase(rec.recordId, "confirming");
        rec.enteredPhaseAt = Date.now();
        this.startConfirmTimeout(rec.recordId, rec.origin);
        // 同步等待 refresh 落定：cache miss 时 timer 用 30s 兜底启动，
        // refresh 会 clamp 到 DB 真值；如果 clamp 触发了 finalize，由
        // await 链保证后续 setPhase/emit 不会跟 finalize 收尾冲突。
        await this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
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
      this.setRecordPhase(rec.recordId, "confirming");
      rec.enteredPhaseAt = Date.now();
      this.startConfirmTimeout(rec.recordId, rec.origin);
      await this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
      this.emit();
      this.emitFeed();
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
   */
  lockState(): ProtocolPopupLockState {
    return this.lockStateValue;
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

  /* ============== 内部 ============== */

  private snapshotInternal(): ProtocolSessionSnapshot {
    const rec = this.firstAliveRequest();
    return {
      phase: this.phase,
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
    if (this.deps.postReady) {
      this.deps.postReady(opener, READY_MESSAGE);
      return;
    }
    try {
      opener.postMessage(READY_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({
        scope: "protocol.transport",
        event: "ready.failed",
        data: { err: String(err) }
      });
    }
  }

  private readVaultLockState(): ProtocolPopupLockState {
    const s = this.deps.vault.status();
    return s === "unlocked" ? "unlocked" : "locked";
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
      // 关键（施工单 2026-06-27 002 反馈修复）：activePublicKeyHex 在
      // record 创建时快照一次。后续写卡（writeFeedCommandFor）从
      // rec.activePublicKeyHex 读取，**不**再读当前 active key——
      // 即使 popup 会话里用户切换 active key，这条 record 的元数据
      // 也不会被污染。
      activePublicKeyHex: this.deps.keyspace.active().activePublicKeyHex ?? "",
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

    // manual confirm 路径。
    if (this.lockStateValue === "locked") {
      this.setRecordPhase(recordId, "waiting_unlock_manual");
      rec.enteredPhaseAt = Date.now();
      this.emit();
      this.emitFeed();
    } else {
      this.setRecordPhase(recordId, "confirming");
      rec.enteredPhaseAt = Date.now();
      this.startConfirmTimeout(recordId, origin);
      this.emit();
      this.emitFeed();
      void this.refreshTimeoutFromOriginConfig(recordId, origin);
    }
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
   * - locked → unlocked：批量推进所有 waiting_unlock_*。
   * - unlocked → locked：confirming → waiting_unlock_manual + 清 timeout；
   *   queued 保持；executing 当前这一条允许跑完；执行器暂停取新任务。
   */
  setVaultLockState(locked: boolean): void {
    const next = locked ? "locked" : "unlocked";
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
      // unlock 批量推进。
      const manualRecs: RequestRecord[] = [];
      const autoRecs: RequestRecord[] = [];
      for (const [, rec] of this.requestsByRecordId) {
        if (rec.phase === "waiting_unlock_manual") manualRecs.push(rec);
        else if (rec.phase === "waiting_unlock_auto") autoRecs.push(rec);
      }
      for (const rec of manualRecs) {
        this.setRecordPhase(rec.recordId, "confirming");
        rec.enteredPhaseAt = Date.now();
        this.startConfirmTimeout(rec.recordId, rec.origin);
        // 与 resumeAfterUnlock 对齐：cache miss 时 timer 用 30s 兜底启动，
        // refresh 异步 clamp 到 DB 真值；per-origin timeout 配置必须生效。
        void this.refreshTimeoutFromOriginConfig(rec.recordId, rec.origin);
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
  private startConfirmTimeout(recordId: string, origin: string): void {
    this.clearConfirmTimeout(recordId);
    const cached = this.originCache.get(origin);
    const seconds =
      cached && cached.confirmTimeoutSeconds > 0
        ? cached.confirmTimeoutSeconds
        : DEFAULT_CONFIRM_TIMEOUT_SECONDS;
    const now = Date.now();
    const startedAtMs = now;
    const deadlineMs = now + seconds * 1000;
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
    this.timersByRecordId.set(recordId, { deadlineMs, tickHandle, startedAtMs });
    this.emit();
  }

  private async refreshTimeoutFromOriginConfig(recordId: string, origin: string): Promise<void> {
    const cached = await this.getOriginSettingsCached(origin);
    const t = this.timersByRecordId.get(recordId);
    if (!t) return;
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

  private async finalizeRequestByCancel(recordId: string): Promise<void> {
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
   * `executing`。relock 时执行器暂停取新任务。
   */
  private async drainExecutionQueue(): Promise<void> {
    if (this.executingRecordId !== null) return; // 已有正在执行的；当前条跑完后由 `runRequest` 内的 finally 触发下一次 drain。
    while (this.executionQueue.length > 0 && this.lockStateValue === "unlocked") {
      const recordId = this.executionQueue.shift()!;
      const rec = this.requestsByRecordId.get(recordId);
      if (!rec) continue;
      if (rec.phase !== "queued") continue;
      // 执行。
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
    const active = this.requireActiveKey();
    const { publicKeyHex, label, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);

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
    const signature = await this.signWithActive(keyId, envelopeCbor);

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
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);
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
    const signature = await this.signWithActive(keyId, envelopeCbor);
    return {
      signedEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature)
    };
  }

  private async executeCipherEncrypt(rec: RequestRecord): Promise<CipherEncryptResult> {
    const params = rec.params as CipherEncryptParams;
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const siteKey = await this.deriveSiteKeyWithActive(keyId, rec.origin);
    const inner = cborEncode([
      PROTOCOL_VERSION,
      params.contentType,
      new Uint8Array(params.content.bytes)
    ]);
    const { nonce, cipherbytes } = aesGcmEncrypt(siteKey, inner);
    return {
      nonce: toBinaryField(nonce),
      cipherbytes: toBinaryField(cipherbytes)
    };
  }

  private async executeCipherDecrypt(rec: RequestRecord): Promise<CipherDecryptResult> {
    const params = rec.params as CipherDecryptParams;
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    let siteKey: Uint8Array;
    try {
      siteKey = await this.deriveSiteKeyWithActive(keyId, rec.origin);
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
    return {
      contentType,
      content: toBinaryField(contentBytes)
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
      const active = this.requireActiveKey();
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
        recipientAddress: params.recipientAddress,
        amountSatoshis: params.amountSatoshis,
        feeRateSatoshisPerKb: params.feeRateSatoshisPerKb ?? DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB
      });
      const submitted = await this.deps.p2pkhService.submitTransfer(preview);
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
      const poolKey = `${rec.origin}::${params.counterpartyPublicKeyHex}`;
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

      const active = this.requireActiveKey();
      const clientPrivateKeyHex = await this.getActiveKeyHex(active.keyId);
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
          poolAmount
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
          clientPublicKeyHex: active.publicKeyHex,
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
          clientPublicKeyHex: active.publicKeyHex,
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
          newPoolAmount
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

      this.pendingOps.set(operationId, {
        operationId,
        origin: rec.origin,
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
   */
  private async buildAndMaybeBuildBaseTx(
    prior: ProtocolFeePoolRecord | null,
    clientPrivateKeyHex: string,
    serverPublicKeyHex: string,
    poolAmount: number
  ): Promise<{
    baseTxHex: string;
    baseTxOutputIndex: number;
    baseTxid: string;
    amount: number;
  }> {
    if (!this.deps.p2pkhService) {
      throw localFailure("internal_error", "p2pkh service required for fee pool base tx");
    }
    const utxos = await this.deps.p2pkhService.listUtxos({ assetId: "bsv" });
    if (utxos.length === 0) {
      throw localFailure("internal_error", "No P2PKH UTXOs to fund fee pool");
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
      const op = this.pendingOps.get(params.operationId);
      if (!op) {
        throw localFailure("unknown_operation", "operationId not found in current session");
      }
      if (op.origin !== rec.origin) {
        throw localFailure("cross_origin_operation", "operationId from a different origin");
      }
      if (op.counterpartyPublicKeyHex !== params.counterpartyPublicKeyHex) {
        throw localFailure("internal_error", "counterpartyPublicKeyHex mismatch");
      }
      if (params.counterpartySignatures.length === 0) {
        throw localFailure("internal_error", "counterpartySignatures must not be empty");
      }
      const active = this.requireActiveKey();
      const clientPublicKeyHex = active.publicKeyHex;
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

      const poolKey = `${rec.origin}::${params.counterpartyPublicKeyHex}`;
      let newRecord: ProtocolFeePoolRecord | null = null;
      const draftTxid = await computeTxidFromHex(op.draftSpendTxHex);
      const draftTxHex = op.draftSpendTxHex;
      let closeDraftTxid: string | undefined;

      if (op.action === "create" || op.action === "close_and_recreate") {
        const baseTxid = await computeTxidFromHex(op.baseTxHex ?? "");
        newRecord = {
          poolKey,
          origin: rec.origin,
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
      } else if (op.action === "spend") {
        if (op.priorPool) {
          const baseTxid = op.priorPool.baseTxid;
          const baseTxHex = op.priorPool.baseTxHex;
          newRecord = {
            poolKey: op.priorPool.poolKey,
            origin: rec.origin,
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

  private async getActiveKeyHex(keyId: string): Promise<string> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => material.hex);
  }

  private requireActiveKey() {
    const active = this.deps.keyspace.active();
    if (!active.activePublicKeyHex) {
      throw protocolError("active_key_unavailable", "No active key available");
    }
    const id = this.deps.keyspace.requireActiveKey();
    if (!id.publicKeyHex) {
      throw protocolError("active_key_unavailable", "No active key available");
    }
    return {
      publicKeyHex: id.publicKeyHex,
      label: id.label,
      keyId: id.keyId
    };
  }

  private async signWithActive(keyId: string, bytes: Uint8Array): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return signCompactSecp256k1(material.hex, bytes);
    });
  }

  private async deriveSiteKeyWithActive(keyId: string, exactOrigin: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return deriveSiteKey(material.hex, exactOrigin);
    });
  }

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
   * 关键（施工单 2026-06-27 002 反馈修复）：
   *   - `activePublicKeyHex` 从 `rec.activePublicKeyHex` 读取——即 record
   *     创建时快照下来的值，**不**再读 `keyspace.active()`。这样
   *     符合 contract `ProtocolCommandRecord.activePublicKeyHex` 注释：
   *     "执行该命令时 active public key hex；写记录时取一次"。
   *   - 后续即便用户在 popup 会话里切换 active key，旧卡片的元数据
   *     不会被污染。
   */
  private writeFeedCommandFor(rec: RequestRecord): void {
    const card = this.makeCommandRecord(rec, rec.activePublicKeyHex);
    this.upsertFeedCommand(card);
    this.persistRecord(card);
  }

  private makeCommandRecord(rec: RequestRecord, activePublicKeyHex: string): ProtocolCommandRecord {
    const isTerminal = this.isTerminalPhase(rec.phase);
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
      activePublicKeyHex,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      finishedAt: rec.finishedAt,
      errorCode: rec.errorCode,
      errorMessage: rec.errorMessage,
      ...(rec.failureReason !== undefined ? { failureReason: rec.failureReason } : {}),
      ...(rec.autoApproved ? { autoApproved: true } : {})
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
        if (originRec) {
          this.originCache.set(origin, normalizeOriginSettings(originRec, origin));
        }
        // 按 recordId 合并：内存活记录优先覆盖 DB 旧记录。
        const mergedById = new Map<string, ProtocolCommandRecord>();
        for (const c of list) mergedById.set(c.id, c);
        for (const rec of this.requestsByRecordId.values()) {
          if (rec.origin !== origin) continue;
          const card = this.makeCommandRecord(rec, rec.activePublicKeyHex);
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
      out.push(this.makeCommandRecord(rec, rec.activePublicKeyHex));
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