// packages/plugin-protocol/src/protocolService.ts
// 协议 service：transport + 校验 + source/origin 绑定 + 解锁/确认调度 +
// 调用 vault / keyspace + 构造 envelope + 签名/加解密 + 命令流历史 +
// p2pkh.transfer / feepool.prepare / feepool.commit 执行。
//
// 设计缘由（施工单 002 硬切换：connect 增加 p2pkh + feepool）：
//   - service 生命周期、命令卡、closing 语义、`pageUnloading` 收口、
//     DB 主键与 transport requestId 解耦等基础约定与 002 之前一致。
//   - 新增 `pendingOps: Map`：`feepool.commit` 消费由 `feepool.prepare`
//     产出的内存 op；`endSession()` 一次性清空。
//   - 新增 `p2pkh.transfer` 的 auto-approve 路径：在 `tryAcceptFirstRequest`
//     里**直接决定** auto-approve 是否命中；命中时内联 `executeP2pkhTransfer`
//     + 写历史 + reply result，**不**进 confirming phase。这样 popup 自然
//     不显示 ConfirmView（snapshot.phase === "executing" 时 popup 顶层
//     CurrentRequestPanel 渲染 ExecutingView，briefly 后回到 waiting）。
//     外部依赖 `currentRequestAutoApproved()` 来更精确地跳过 ConfirmView。
//   - 新增 feepool.prepare / feepool.commit 的完整执行路径：buildDualFee
//     池 + 内存 op + 服务端验签 + 写 feePools store。
//   - 新增站点配置 getter/setter：getOriginSettings / setOriginSettings。
//   - 新增系统级设置 setSystemSettings：把 feePoolDefaultFundSatoshis
//     写入 localStorage 并同步到 systemSettings bridge。
//   - 隐私边界：余额不足 / 费用池缺失 / DB 不可用 / 未知 op / 跨 origin
//     operationId，**全部**对外回 `user_rejected`；真实原因只写
//     `ProtocolCommandRecord.failureReason`。
//   - DB 不可用差异化降级：p2pkh 仍可用（auto-approve 被禁用、manual
//     confirm 仍可走通）；feepool 直接 fail-closed。
//   - 不依赖 React；可单测。

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
  type ProtocolMethod,
  type ProtocolOriginSettingsRecord,
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
 *     不视为"关闭"，而是回退到缺省 30。这是与现有 p2pkh 上限 / 费用
 *     池上限"非法 → 0 关闭"语义的对称收口。
 */
const DEFAULT_CONFIRM_TIMEOUT_SECONDS = 30;

/**
 * 把 DB 读到的 origin 记录补齐新字段默认值。**纯函数**；不改入参，不读 DB。
 *
 * 设计缘由（施工单 001 收口：per-origin 自动批准 + 施工单 003：per-origin 超时）：
 *   - 旧记录（写入时 schema 还没有 `identityAutoApproveEnabled` /
 *     `cipherAutoApproveEnabled` / `confirmTimeoutSeconds`）走归一化后
 *     字段都补默认值，不抛错。
 *   - 不做 host 归一化、不做数字字段 clamp；这里只补 boolean / 数字
 *     默认与 origin 字段来源校正。
 *   - `origin` 由 caller 显式传入（不读 `rec.origin`）——这样归一化后
 *     的 record 永远与 DB primary key 对齐；调用方传错也能保持一致。
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
  /** 用户确认页 / 解锁页推动 session 状态使用。 */
  notifyUnlockChanged?: () => void;
  /**
   * 自定义 ID 生成器。默认用 `crypto.randomUUID()`；测试可注入稳定 id。
   * 这一层**只**用作命令流 DB 主键（`ProtocolCommandRecord.id`），不参与
   * transport `requestId`。
   */
  generateId?: () => string;
}

interface RequestBinding {
  id: string;
  method: ProtocolMethod;
  params: MethodParams<ProtocolMethod>;
  source: Window;
  origin: string;
  /** 当前命令卡 id（service 内部生成，与 transport requestId 解耦）。 */
  recordId: string;
  /** p2pkh.auto-approve 命中时为 true；UI 据此跳过 ConfirmView。 */
  autoApproved?: boolean;
}

const READY_MESSAGE: ProtocolReadyMessage = { v: PROTOCOL_VERSION, type: "ready" };
const CLOSING_MESSAGE: ProtocolClosingMessage = { v: PROTOCOL_VERSION, type: "closing" };

export class ProtocolServiceImpl implements ProtocolService {
  private phase: ProtocolSessionPhase = "waiting";
  private binding: RequestBinding | null = null;
  private listeners = new Set<(snap: ProtocolSessionSnapshot) => void>();
  private feedListeners = new Set<(state: ProtocolCommandFeedState) => void>();
  private pendingRequestSnapshot:
    | { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> }
    | null = null;
  /**
   * 本会话是否已经向 opener 发过 `closing`。`closing` 与 `popup.closed` 是
   * 并联收敛的断开信号，因此本标志只用来防止重复发出 `closing` 本身。
   */
  private closingSent = false;

  /** 当前 origin（exact event.origin，**不**归一化）。 */
  private currentOriginValue: string | null = null;
  /** 当前 origin 下的命令流（最新在前；按 updatedAt desc）。 */
  private feedCommands: ProtocolCommandRecord[] = [];
  /** 命令流 DB 是否可用。false 时 UI 顶部显示"历史不可用"。 */
  private historyAvailableFlag: boolean;
  /** DB 加载 promise：避免重复打开 + 重复载入。 */
  private historyLoadInFlight: Promise<void> | null = null;
  /** 当前绑定的命令卡 id；用于状态推进时定位。 */
  private currentRecordId: string | null = null;
  /** feepool pending operations：仅本 popup 会话内存有效，endSession 清空。 */
  private pendingOps: FeepoolPendingOpsMap = new Map();
  /**
   * origin 配置内存 cache（同步 auto-approve 判断用）。
   *
   * 设计缘由：`isP2pkhAutoApprovedSync` 在 `tryAcceptFirstRequest` 里要走
   * 同步路径，而 IndexedDB 读写是 async。所以把 `setOriginSettings` 写入
   * 时同步刷 cache；新会话无 cache 时保守走 manual confirm。
   * `getOriginSettings` 公开接口仍走 storageDb（async + 拿到最新真值）。
   */
  private originCache: Map<string, ProtocolOriginSettingsRecord> = new Map();
  /**
   * 确认超时截止时间（epoch ms；null = 没在计时）。
   *
   * 设计缘由（施工单 003 硬切换）：
   *   - 一条 request 只维护一个定时器；进入 `unlocking` 或 `confirming`
   *     时启动；任何终态都清掉。
   *   - auto-approve / auto-sign 命中时**不**创建 timer。
   *   - UI 倒计时直接读 wall-clock 计算 remaining = deadline - now()；
   *     setInterval 只用来每 1s emitFeed 一次让 UI 重渲染。
   *   - 修改站点 timeout **不**热更新当前正在倒计时的 request；当前
   *     request 保留它开始计时时快照下来的 deadline。
   */
  private timeoutDeadlineMs: number | null = null;
  /**
   * 倒计时 setInterval handle；null 表示没有计时。
   *
   * setInterval **不**用作"超时触发器"——超时与否用 wall-clock 比较
   * deadline 判定。setInterval 仅用来 1s emitFeed() 一次让 UI 倒计时
   * 重渲染。这样即便 setInterval 抖动也不会把"实际超时时刻"拖后。
   */
  private timeoutTickHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * 倒计时的原始起点（epoch ms；null = 没在计时）。
   *
   * 用于在 cache miss 异步 clamp 时**不**重算起点：deadline 收紧到
   * `timerStartedAtMs + actualMs`，保证"从进入 unlocking / confirming
   * 算起"的总等待时长稳定 = DB 真值，不会因为 DB 慢返回而拉长。
   *
   * `timerStartedAtMs + timeoutDeadlineMs` 不变（即 deadline 缩短 = 总
   * 等待时长不变 = 不影响用户对"我已经等了多久"的判断）。
   */
  private timerStartedAtMs: number | null = null;
  /**
   * 当前正在计时的 request id（用于跨 await 安全判定"这条 timeout 仍属于
   * 当前 binding"）。一旦 binding 切换 / 收尾 / endSession 都清掉。
   */
  private timeoutRecordId: string | null = null;

  constructor(private readonly deps: ProtocolServiceDeps) {
    this.historyAvailableFlag = Boolean(deps.storageDb);
  }

  /**
   * 内部稳定 id 生成器。**不**允许与 transport `requestId` 共用——同一
   * requestId 重复发来时，必须落两条不同命令卡，而不是互相覆盖。
   */
  private nextRecordId(): string {
    if (this.deps.generateId) {
      return this.deps.generateId();
    }
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // 兜底：测试环境或非常规运行时。用时间戳 + 随机数即可。
    return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 启动会话。挂在 window.message 监听**之后**再调用，确保 ready 不丢。 */
  startSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.closingSent = false;
    // 注意：startSession **不**清空 currentOrigin / feedCommands / history。
    // 设计缘由：popup 刷新场景下我们仍要按"上次服务的 origin"载入历史；
    // 但施工单 002 收口显式不恢复未完成 request，未完成 request 由 binding
    // 状态自然丢失。
    this.emit();
    this.postReadyIfPossible();
  }

  /**
   * 关闭当前会话并清空内部状态。**不**主动发 `closing`——`closing` 由
   * `pageUnloading` 路径发出，避免 `endSession` 误把单条 request 收尾
   * 当成"会话结束"。
   */
  endSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    // popup 卸载 / 刷新 → 所有 pending feepool operation 立即失效。
    // 设计缘由：operationId 不持久化；popup 关闭后 commit 必然 invalid_request。
    this.pendingOps.clear();
    // 确认超时 timer 也一起清（不持久化、不恢复）。
    this.clearConfirmTimeout();
    this.emit();
  }

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
      historyAvailable: this.historyAvailableFlag
    };
  }

  /** 订阅命令流变化。立即把当前 feed 状态喂给 handler。 */
  subscribeFeed(handler: (state: ProtocolCommandFeedState) => void): () => void {
    this.feedListeners.add(handler);
    handler(this.feedSnapshot());
    return () => this.feedListeners.delete(handler);
  }

  /**
   * 读 origin 配置。DB 不可用或该 origin 尚未配置时返回 null。
   * 设置 modal 初始化时调它拿当前值；null 时 UI 给默认值。
   */
  async getOriginSettings(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
    if (!this.deps.storageDb) return null;
    try {
      const raw = await this.deps.storageDb.getOrigin(origin);
      // 旧记录缺字段：归一化补默认值，再刷 cache；保证下一次同步判断能命中。
      // null 时不刷 cache（避免污染；后续同步判断读不到旧值更安全）。
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
   * 写 origin 配置。DB 不可用时 throw（settings modal 应提示"无法保存"）。
   * 写入时同步刷内存 cache，确保下一次 auto-approve 判断能立即生效。
   *
   * 设计缘由（施工单 001）：写入前走归一化——若 UI 漏字段（甚至来自旧
   * 版本调用方），DB 落盘也是带默认 false 的完整 record，避免下次读
   * 出来又触发归一化 + 误导 UI。
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

  /**
   * 处理来自 `window` 的 message 事件。
   *
   * 返回 `Promise<void>`:identity / cipher cache miss 路径需要先
   * `await getOriginSettingsCached` 决定 setPhase;这样 phase 永远只在
   * 终态（executing 或 confirming）出现一次,不会先 setPhase("confirming")
   * 再被 fire-and-forget 翻案成 executing —— 后者会引入 race condition
   * （React batching 行为变化 / 用户在翻案前点 confirm 抢先消费）。
   *
   * 调用方可以 sync 调(不 await)也可以 await。listener 端常用 sync 调;
   * unit test 必须 await 以确保 setPhase 已落定。
   *
   * 顶层 cancel 报文（施工单 003 硬切换）：
   *   - cancel 是 transport 控制消息，不是业务 method。
   *   - 生效条件：当前已绑定 + event.source/origin 与绑定匹配 +
   *     cancel.id === binding.id + 当前 phase 不是 executing。
   *   - 任意一条不满足 → 静默忽略（不抛、不回 cancel result）。
   *   - 生效时复用现有 reject 路径收尾：对外回原 request 的
   *     `result(ok=false, user_rejected)`，cancel 自己**不**回一条
   *     新 result。
   */
  async handleMessage(event: MessageEvent): Promise<void> {
    // cancel 在 binding 之前也可能到来（比如 client 在 popup 还没收到
    // 第一条 request 时发 cancel）。validation 失败 → 静默忽略。
    if (looksLikeCancel(event.data)) {
      let parsed: { id: string };
      try {
        parsed = parseCancelMessage(event.data);
      } catch {
        return;
      }
      // 没绑定 / id 不匹配 → 忽略；这条边界是 cancel 与普通 request
      // 不一样的关键：cancel **不**是新业务请求，不允许"最接近匹配"。
      if (!this.binding) return;
      if (event.source !== this.binding.source) return;
      if (event.origin !== this.binding.origin) return;
      if (parsed.id !== this.binding.id) return;
      // 进入 executing 后 cancel 忽略（不可逆执行，V1 不支持补偿）。
      if (this.phase === "executing") return;
      // 命中：复用 reject 路径清 timer + 回 user_rejected + 收尾。
      await this.finalizeByExternalCancel();
      return;
    }
    if (!this.binding) {
      await this.tryAcceptFirstRequest(event);
      return;
    }
    // 已绑定：只接受同 source + 同 origin 的消息；其它一律忽略。
    if (event.source !== this.binding.source || event.origin !== this.binding.origin) {
      return;
    }
    // 当前 V1 不支持同会话并发多 request；忽略后续。
  }

  /** 用户在确认页点击"确认"。开始执行方法。 */
  async confirmByUser(): Promise<void> {
    if (!this.binding) {
      return;
    }
    if (this.phase !== "confirming") {
      return;
    }
    const binding = this.binding;
    // 用户点了"确认"→ 进入 executing → 不再计时；timeout 路径已经在
    // setInterval 里 wall-clock 比较，这里只需清 handle 即可。
    this.clearConfirmTimeout();
    this.setPhase("executing");
    this.updateRecordPhase(binding.recordId, "executing");
    let result: MethodResult | null = null;
    let errCode: ProtocolErrorCode | null = null;
    let errMessage: string | null = null;
    let localReason: ProtocolFailureReason | undefined;
    try {
      result = await this.dispatch(binding);
    } catch (err) {
      // 本地失败原因（p2pkh 余额不足 / feepool 未知 op / feepool 跨 origin /
      // DB 不可用 等）→ 外层统一 user_rejected，本地写 failureReason。
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
    }
    // p2pkh / feepool 的 execute 内部已经 reply + 清 binding 并回 waiting；
    // 这里跳过外层 reply。
    const internalHandled =
      binding.method === "p2pkh.transfer" ||
      binding.method === "feepool.prepare" ||
      binding.method === "feepool.commit";
    if (result && !internalHandled) {
      this.updateRecordFinal(binding.recordId, "approved", "approved");
      await this.replyResult(binding, result);
    } else if (errCode && errMessage && !internalHandled) {
      this.updateRecordFinal(binding.recordId, "failed", "failed", errCode, errMessage);
      await this.replyError(binding, errCode, errMessage);
    } else if (result === null && localReason && !internalHandled) {
      // 防御：localReason 但 internalHandled=false 的情况不应发生。
      this.updateRecordFinal(binding.recordId, "failed", "failed", "user_rejected", "User rejected");
      await this.replyError(binding, "user_rejected", "User rejected");
    }
    // 单条 request 收尾：清 binding、phase 回到 waiting。
    // 不发 closing（closing 由 pageUnloading 路径发），不调 endSession。
    // p2pkh / feepool 在 execute 里已经清过；幂等再做无副作用。
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
  }

  /** 用户点击"取消"。回 user_rejected，把命令卡标 rejected，phase 回到 waiting。 */
  async rejectByUser(): Promise<void> {
    if (!this.binding) {
      this.setPhase("waiting");
      this.emit();
      return;
    }
    const binding = this.binding;
    // 任何终态都统一清 timer：cancel / reject / confirmByUser / timeout
    // 全部走同一条 cleanup，避免泄漏与误触。
    this.clearConfirmTimeout();
    // **关键**：先快照 binding 再立即清 this.binding，使后续并发 cancel /
    // reject 看到 binding === null 直接早退，保证原 request 最多只回一条
    // result。
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
    this.updateRecordFinal(binding.recordId, "rejected", "rejected");
    await this.replyError(binding, "user_rejected", "User rejected");
  }

  /**
   * 当前正在计时的截止时间（epoch ms；null = 没在计时）。
   * UI 倒计时直接 `Math.max(0, ceil((deadline - Date.now()) / 1000))`。
   *
   * 注意：
   *   - popup 卸载 / endSession 时 timer 自然销毁；不做恢复。
   *   - 修改 `confirmTimeoutSeconds` **不**热更新当前正在倒计时的
   *     request，deadline 保留它开始计时时快照的值。
   */
  confirmDeadlineMs(): number | null {
    return this.timeoutDeadlineMs;
  }

  /**
   * 启动当前 request 的确认超时计时器。
   *
   * 时机：进入 `unlocking` 或 `confirming` 时。auto-approve / auto-sign
   * 命中时**不**调用本方法（不创建 timer）。
   *
   * 实现要点：
   *   - setInterval 只用来 1s emitFeed() 让 UI 倒计时刷新，**不**用作
   *     "触发器"。真正的 timeout 判定走 wall-clock 比较 deadline。
   *   - 修改站点 timeout 不影响当前正在倒计时的 request。
   */
  private startConfirmTimeout(recordId: string, origin: string): void {
    this.clearConfirmTimeout();
    const cached = this.originCache.get(origin);
    const seconds =
      cached && cached.confirmTimeoutSeconds > 0
        ? cached.confirmTimeoutSeconds
        : DEFAULT_CONFIRM_TIMEOUT_SECONDS;
    const now = Date.now();
    // 关键：记录**原始**起点，让后续 cache-miss clamp 用
    // `timerStartedAtMs + actualMs` 而不是 `Date.now() + actualMs`，
    // 避免 DB 慢返回时把总等待时长拉长超过 DB 真值。
    this.timerStartedAtMs = now;
    this.timeoutDeadlineMs = now + seconds * 1000;
    this.timeoutRecordId = recordId;
    this.timeoutTickHandle = setInterval(() => {
      // 已被其它路径清掉（confirm / reject / cancel / endSession）→ 退出。
      if (!this.timeoutDeadlineMs || !this.timeoutTickHandle) {
        this.clearConfirmTimeout();
        return;
      }
      // binding 已经切走（被 fire-and-forget 路径提前收尾）→ 不再干预。
      if (!this.binding || this.binding.recordId !== this.timeoutRecordId) {
        this.clearConfirmTimeout();
        return;
      }
      if (Date.now() >= this.timeoutDeadlineMs) {
        this.clearConfirmTimeout();
        void this.finalizeByTimeout();
        return;
      }
      // 还在倒计时：emitFeed 让 UI 刷新倒计时数字（用 wall-clock 计算）。
      this.emitFeed();
    }, 1000);
    // 关键：让 popup 立即看到 deadline 变化（之前 setPhase 已经 emit 过一次，
    // 但 confirmDeadlineMs 仍是 null；这里补 emit() 让 subscribe 重新读）。
    this.emit();
  }

  /**
   * 异步刷 origin cache：如果 cache miss 时 timer 用缺省 30 秒兜底启动，
   * DB 返回后这里把 deadline clamp 到 DB 真值（如果 DB 值比剩余时间更短）。
   *
   * 设计缘由：
   *   - 硬切换要求 timer 与 setPhase 同步开始，**不**能在 await getOriginSettingsCached
   *     后再 startConfirmTimeout（DB 慢会让用户无倒计时地等）。
   *   - cache miss 时 timer 用缺省 30 兜底，**立即**开始倒计时；DB 回来后
   *     如果真值比剩余时间更短就 clamp down，让"首条新 request 立即吃到
   *     站点配置"尽量成立。
   *   - **不** extend：如果 DB 真值比剩余时间更长，保持原 deadline 不变。
   *     这是施工单 003 收口的"不热更新"原则——timer 一旦开始就稳定。
   *   - 如果 binding 已切走（reject / confirm / 新 request）→ 静默退出。
   */
  private async refreshTimeoutFromOriginConfig(recordId: string, origin: string): Promise<void> {
    // 触发 cache 加载（cache hit 同步返回；cache miss 走 DB 一次）。
    const cached = await this.getOriginSettingsCached(origin);
    // 如果 timer 已被 confirm / reject / cancel / 其它路径清掉 → 退出。
    if (this.timeoutRecordId !== recordId) return;
    if (!this.timeoutDeadlineMs || this.timerStartedAtMs === null) return;
    if (!cached) return;
    const actualSeconds = cached.confirmTimeoutSeconds;
    if (!actualSeconds || actualSeconds <= 0) return;
    const actualMs = actualSeconds * 1000;
    const currentDeadline = this.timeoutDeadlineMs;
    // 关键：deadline 算式用 `timerStartedAtMs + actualMs`，**不**用
    // `Date.now() + actualMs`——后者会让"phase 切换到 DB 返回"的等待
    // 时长被叠加到 total 上，使总等待时长 > 配置值。
    const newDeadline = this.timerStartedAtMs + actualMs;
    // 比较的是"两个 deadline 哪个更早"，不是"actualMs 与 remainingMs"。
    // 例：默认先起了 30 秒，DB 在第 29 秒才返回 20 秒：
    //   newDeadline = start + 20s（已过去 9s）vs currentDeadline = start + 30s（剩 1s）
    //   newDeadline < currentDeadline → 应当 clamp 到 20s（按配置已超时 9s）。
    // 旧条件 `actualMs < remainingMs`（20000 < 1000 假）→ 不 clamp，
    // 会让请求继续活到默认 30s 才超时，违反"按配置计时"语义。
    if (newDeadline < currentDeadline) {
      this.timeoutDeadlineMs = newDeadline;
      this.emitFeed();
      this.emit();
      // 如果按真实配置早已超时（newDeadline <= now），立即收尾，不等
      // 下一个 1s tick——这样最大误差是 setInterval tick 间隔（≤1s），
      // 而不是"1s tick + clamp 延迟"。施工单 003 字面语义"从进入该状态
      // 开始按配置计时"要求这里立即 finalize。
      if (newDeadline <= Date.now()) {
        await this.finalizeByTimeout();
      }
    }
  }

  /** 清 timer / deadline / recordId / 起点；任何终态都走它，幂等。 */
  private clearConfirmTimeout(): void {
    if (this.timeoutTickHandle !== null) {
      clearInterval(this.timeoutTickHandle);
      this.timeoutTickHandle = null;
    }
    this.timeoutDeadlineMs = null;
    this.timeoutRecordId = null;
    this.timerStartedAtMs = null;
  }

  /**
   * 内部超时收尾：本地标 `status = "timed_out"` + `failureReason =
   * "request_timeout"`；对外**仍然**回 `user_rejected`（不暴露
   * `request_timeout`）。
   *
   * 走和 `rejectByUser` 同样的收尾路径，但**不**复用 `rejectByUser`
   * ——`rejectByUser` 把 record 写成 `decision = "rejected"`；
   * 这里要写成 `decision = "failed"` + `status = "timed_out"` + 真实
   * 本地 `failureReason = "request_timeout"`。
   */
  private async finalizeByTimeout(): Promise<void> {
    if (!this.binding) return;
    const binding = this.binding;
    this.clearConfirmTimeout();
    // record 终态：phase/decision 走 failed，status 单独标记 timed_out。
    const rec = this.feedCommands.find((c) => c.id === binding.recordId);
    if (rec) {
      rec.phase = "failed";
      rec.decision = "failed";
      rec.status = "timed_out";
      rec.errorCode = "user_rejected";
      rec.errorMessage = "User rejected";
      rec.failureReason = "request_timeout";
      rec.finishedAt = Date.now();
      rec.updatedAt = rec.finishedAt;
      this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
      this.emitFeed();
      this.persistRecord(rec);
    }
    // 对外依然回 user_rejected（不暴露 request_timeout）。
    await this.replyError(binding, "user_rejected", "User rejected");
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
  }

  /**
   * 外部 cancel 命中的收尾：与 `rejectByUser` 语义一致，但触发来源是
   * client 发来的 cancel 报文。本地 record 也标 `rejected`（与本地
   * 点取消语义一致）；对外回原 request 的 `user_rejected`。
   */
  private async finalizeByExternalCancel(): Promise<void> {
    if (!this.binding) return;
    const binding = this.binding;
    this.clearConfirmTimeout();
    // 先快照 + 立即清 binding，确保后续并发 reject 看到 null → 早退 → 单 result。
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
    this.updateRecordFinal(binding.recordId, "rejected", "rejected");
    await this.replyError(binding, "user_rejected", "User rejected");
  }

  /**
   * 解锁状态机推进：vault unlock 完成后由 UI 调本方法继续已绑定的 request。
   *
   * 设计缘由（施工单 001 收口）：
   *   - 锁定态下命中 auto-approve 时：解锁后**不**进 confirming，直接转
   *     `executing` 并内联执行。这样 popup 不会闪一下 ConfirmView。
   *   - **不**重新判断 `amountSatoshis` 这类业务量：tryAcceptFirstRequest
   *     已经判断过；这里只是补"vault 锁定下延后执行"。executeFeepoolPrepare
   *     / executeFeepoolCommit / executeIdentityGet 等内部仍会校验。
   *   - 锁定态 cache miss（popup 新开会话 + 首次请求即命中）也要兜底：
   *     同步 `isIdentityAutoApprovedSync` / `isCipherAutoApprovedSync`
   *     只读 cache；这里再加一次 async `getOriginSettingsCached` 让 DB
   *     真值能命中。否则用户体感"上次保存的 auto-approve 在 lock 后失效"。
   */
  async resumeAfterUnlock(): Promise<void> {
    if (!this.binding) return;
    if (this.phase !== "unlocking") return;
    const binding = this.binding;
    const method = binding.method;
    const origin = binding.origin;

    let isAutoApproved =
      (method === "identity.get" && this.isIdentityAutoApprovedSync(origin)) ||
      ((method === "cipher.encrypt" || method === "cipher.decrypt") &&
        this.isCipherAutoApprovedSync(origin));

    // 锁定态 cache miss 兜底：异步读 DB 一次，写 cache，再判断一次。
    // 不影响既有 sync 路径；只对 cache 没填的"popup 新开 + vault 锁定"场景生效。
    if (
      !isAutoApproved &&
      (method === "identity.get" || method === "cipher.encrypt" || method === "cipher.decrypt") &&
      this.binding?.recordId === binding.recordId
    ) {
      const cached = await this.getOriginSettingsCached(origin);
      if (cached) {
        isAutoApproved =
          (method === "identity.get" && cached.identityAutoApproveEnabled) ||
          ((method === "cipher.encrypt" || method === "cipher.decrypt") &&
            cached.cipherAutoApproveEnabled);
      }
    }

    if (!isAutoApproved) {
      this.setPhase("confirming");
      this.updateRecordPhase(binding.recordId, "waiting_confirm");
      return;
    }

    // 翻案：锁定态下命中 auto-approve → 解锁后直接 executing。
    binding.autoApproved = true;
    const recordId = binding.recordId;
    const card = this.feedCommands.find((c) => c.id === recordId);
    if (card) {
      card.autoApproved = true;
      card.updatedAt = Date.now();
      this.emitFeed();
      this.persistRecord(card);
    }
    this.updateRecordPhase(recordId, "executing");
    this.setPhase("executing");
    const parsedFrozen = {
      id: binding.id,
      method: binding.method,
      params: binding.params
    };
    void this.runIdentityCipherAutoApproved(parsedFrozen, origin, recordId).catch(
      (err: unknown) => {
        this.deps.logger?.error?.({
          scope: "protocol.exec",
          event: "resumeAutoApprove.identityCipher.err",
          err: err instanceof Error ? err.message : String(err)
        });
      }
    );
  }

  /**
   * 页面层 best-effort 触发：用户手工关闭窗口 / 刷新 / 卸载时由
   * ProtocolPopupPage 调用。本方法**只**负责"如果还没发过 closing
   * 就尝试发一次"，发送失败不重试、不阻塞。idempotent。
   */
  pageUnloading(): void {
    this.sendClosingBestEffort();
  }

  /** vault locked / uninitialized 时让 UI 进入解锁页。 */
  isWaitingForUnlock(): boolean {
    return this.phase === "unlocking" && this.binding !== null;
  }

  /** 给 UI 用的便利：当前已绑定的 request（如果已经进入 confirming / unlocking）。 */
  currentRequest(): { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null {
    if (!this.binding) return null;
    return {
      id: this.binding.id,
      method: this.binding.method,
      params: this.binding.params
    };
  }

  /* ============== 内部 ============== */

  private snapshotInternal(): ProtocolSessionSnapshot {
    return {
      phase: this.phase,
      boundSource: this.binding?.source ?? null,
      boundOrigin: this.binding?.origin ?? null,
      method: this.binding?.method ?? null,
      requestId: this.binding?.id ?? null
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
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "ready.failed", data: { err: String(err) } });
    }
  }

  private async tryAcceptFirstRequest(event: MessageEvent): Promise<void> {
    const opener = this.getOpener();
    if (!opener) return;
    if (event.source !== opener) return;
    const data = event.data;
    if (!looksLikeRequest(data)) return;
    let parsed;
    try {
      parsed = parseRequestMessage(data);
    } catch (err) {
      if (err instanceof ProtocolValidationError) {
        // 非法 request：按规则忽略。
        return;
      }
      this.deps.logger?.error?.({ scope: "protocol.validation", event: "unexpected", data: { err: String(err) } });
      return;
    }
    // origin 切换：如果与上次服务的 origin 不同，重新载入该 origin 的历史。
    // 注意：载入完成前先把当前命令卡 upsert 到 feed；loadHistoryForOrigin
    // 用 merge 模式不会覆盖当前卡。
    if (this.currentOriginValue !== event.origin) {
      this.currentOriginValue = event.origin;
      // 触发历史载入（fire & forget；UI 走 historyAvailable 兜底）。
      void this.loadHistoryForOrigin(event.origin);
    }
    // 创命令卡：内部稳定 id 与 transport requestId 解耦，避免调用方
    // 重复 requestId 时旧命令卡被覆盖。
    const recordId = this.nextRecordId();
    const now = Date.now();
    const activePub = this.deps.keyspace.active().activePublicKeyHex ?? "";
    const newRecord: ProtocolCommandRecord = {
      id: recordId,
      origin: event.origin,
      requestId: parsed.id,
      method: parsed.method,
      phase: "waiting_unlock",
      decision: "pending",
      status: "pending",
      textSummary: this.summarizeText(parsed.params),
      claimsSummary: this.summarizeClaims(parsed.params),
      contentType: this.summarizeContentType(parsed.params),
      payloadSize: this.summarizePayloadSize(parsed.params),
      activePublicKeyHex: activePub,
      createdAt: now,
      updatedAt: now,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    };
    this.upsertFeedCommand(newRecord);
    this.persistRecord(newRecord);

    this.binding = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params,
      source: event.source as Window,
      origin: event.origin,
      recordId
    };
    this.pendingRequestSnapshot = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params
    };
    this.currentRecordId = recordId;

    /* ============== auto-approve 分流（p2pkh.transfer） ============== */
    // 命中 auto-approve 时**不**进 confirming：内联执行 + reply result + 回 waiting。
    // popup 因此不会显示 ConfirmView（详见 ProtocolPopupPage 6.2）。
    if (
      parsed.method === "p2pkh.transfer" &&
      this.deps.vault.status() === "unlocked" &&
      this.isP2pkhAutoApprovedSync(parsed.params as P2pkhTransferParams, event.origin)
    ) {
      this.binding.autoApproved = true;
      newRecord.autoApproved = true;
      this.updateRecordPhase(recordId, "executing");
      this.setPhase("executing");
      // 异步执行；不阻塞 tryAcceptFirstRequest 返回。
      void this.runP2pkhTransferAndFinalize(parsed, event.origin, recordId, /*autoApproved*/ true).catch(
        (err: unknown) => {
          this.deps.logger?.error?.({
            scope: "protocol.exec",
            event: "autoTransfer.err",
            err: err instanceof Error ? err.message : String(err)
          });
        }
      );
      return;
    }

    /* ============== auto-sign 分流（feepool.prepare / feepool.commit） ============== */
    // 命中 auto-sign 时**不**进 confirming：内联执行 feepool 方法 + 回 waiting。
    // 关键修复（施工单 002 收尾反馈 V2）：`feepool.commit` 没有
    // `amountSatoshis` 字段；它的金额必须从 `pendingOps` 里 prepare 阶段
    // 已经决策好的 op.amountSatoshis 读取，**不能**从 request params 读。
    // 否则 commit 路径永远拿到 0、被 `isFeepoolAutoSignedSync` 的
    // `amountSatoshis <= 0` 检查拒掉、auto-sign 永远只在 prepare 命中。
    if (
      (parsed.method === "feepool.prepare" || parsed.method === "feepool.commit") &&
      this.deps.vault.status() === "unlocked"
    ) {
      let amountSatoshisForCheck: number | null = null;
      if (parsed.method === "feepool.prepare") {
        amountSatoshisForCheck = (parsed.params as FeepoolPrepareParams).amountSatoshis;
      } else {
        // feepool.commit：从 pending op 里读。
        const opId = (parsed.params as FeepoolCommitParams).operationId;
        const op = this.pendingOps.get(opId);
        amountSatoshisForCheck = op ? op.amountSatoshis : null;
      }
      if (
        amountSatoshisForCheck !== null &&
        amountSatoshisForCheck > 0 &&
        this.isFeepoolAutoSignedSync(amountSatoshisForCheck, event.origin)
      ) {
        this.binding.autoApproved = true;
        newRecord.autoApproved = true;
        this.updateRecordPhase(recordId, "executing");
        this.setPhase("executing");
        void this.runFeepoolAutoApproved(parsed, event.origin, recordId).catch(
          (err: unknown) => {
            this.deps.logger?.error?.({
              scope: "protocol.exec",
              event: "autoFeepool.err",
              err: err instanceof Error ? err.message : String(err)
            });
          }
        );
        return;
      }
    }

    const status = this.deps.vault.status();
    if (status === "unlocked") {
      /* ============== auto-approve 分流（identity.get / cipher.*） ==============
       *
       * 设计缘由（施工单 001 收口）：
       *   - 同步路径：originCache 命中 → 直接 executing + 内联执行。
       *     与 p2pkh / feepool 的现有同步分流对称。
       *   - 异步路径：cache miss（新会话 / 新 origin / DB 未命中） →
       *     fire-and-forget 异步查 DB；如果 DB 命中 → "翻案"转 executing。
       *     这是为了让"popup 新开会话第一条请求也能命中持久化配置"。
       *   - vault 锁定/未初始化：上一行已经把已存在的 p2pkh / feepool 同步
       *     分流拦在 unlocked 分支内；这里 identity / cipher 也只在 unlocked
       *     时走 auto-approve 路径，否则交由 `resumeAfterUnlock` 决策。
       */
      const isIdentityOrCipher =
        parsed.method === "identity.get" ||
        parsed.method === "cipher.encrypt" ||
        parsed.method === "cipher.decrypt";

      if (isIdentityOrCipher) {
        // 同步 cache 检查：命中就立即 executing 内联，**不**进 confirming。
        const cacheHit =
          parsed.method === "identity.get"
            ? this.isIdentityAutoApprovedSync(event.origin)
            : this.isCipherAutoApprovedSync(event.origin);

        if (cacheHit) {
          this.binding!.autoApproved = true;
          newRecord.autoApproved = true;
          this.updateRecordPhase(recordId, "executing");
          this.setPhase("executing");
          const parsedFrozen = parsed;
          const recordIdFrozen = recordId;
          const originFrozen = event.origin;
          void this.runIdentityCipherAutoApproved(parsedFrozen, originFrozen, recordIdFrozen).catch(
            (err: unknown) => {
              this.deps.logger?.error?.({
                scope: "protocol.exec",
                event: "autoIdentityCipher.err",
                err: err instanceof Error ? err.message : String(err)
              });
            }
          );
          return;
        }

        // cache miss（popup 新开会话 / 新 origin）：**先 await 一次 DB 查询**
        // 再决定 setPhase。这样 phase 永远只在终态（executing 或 confirming）
        // 出现一次，UI 不会先看到 confirming 浮层再被翻案。
        const settings = await this.getOriginSettingsCached(event.origin);
        // 二次确认：binding 仍指本 record（避免 await 期间被 reject / 新 request 替换）。
        if (this.binding?.recordId !== recordId) return;
        if (settings) {
          const hit =
            (parsed.method === "identity.get" && settings.identityAutoApproveEnabled) ||
            ((parsed.method === "cipher.encrypt" || parsed.method === "cipher.decrypt") &&
              settings.cipherAutoApproveEnabled);
          if (hit) {
            this.binding.autoApproved = true;
            newRecord.autoApproved = true;
            this.updateRecordPhase(recordId, "executing");
            this.setPhase("executing");
            const parsedFrozen = parsed;
            const originFrozen = event.origin;
            void this.runIdentityCipherAutoApproved(parsedFrozen, originFrozen, recordId).catch(
              (err: unknown) => {
                this.deps.logger?.error?.({
                  scope: "protocol.exec",
                  event: "autoIdentityCipher.dbHit.err",
                  err: err instanceof Error ? err.message : String(err)
                });
              }
            );
            return;
          }
        }
      }

      // manual confirm 路径：identity/cipher 都没命中，或非 identity/cipher method。
      this.setPhase("confirming");
      this.updateRecordPhase(recordId, "waiting_confirm");
      // 关键：**timer 与 setPhase 同步启动**，不允许先 await DB 再启动。
      // 之前先 await getOriginSettingsCached 再 startConfirmTimeout 的写法
      // 会让 DB 慢时用户已经进入确认/解锁态、但 timer 还没开始，实际等待
      // 时长被无上限拉长。改成：cache 命中直接用 cache；cache miss 用缺省
      // 30 兜底，立即启动 timer；之后再异步刷一次 cache，如果发现 DB 里
      // 的值**比当前剩余时间更短**就 clamp deadline（不 extend，符合
      // 施工单"不热更新"原则）。
      this.startConfirmTimeout(recordId, event.origin);
      void this.refreshTimeoutFromOriginConfig(recordId, event.origin);
    } else {
      this.setPhase("unlocking");
      // 进入 unlocking：同样 timer 同步启动（vault 锁定期间用户迟迟
      // 不解锁也要按 origin 配置 timeout；与 confirming 共享一个 timer，
      // 符合"同一条 request 只维护一个定时器"）。
      this.startConfirmTimeout(recordId, event.origin);
      void this.refreshTimeoutFromOriginConfig(recordId, event.origin);
    }
  }

  /**
   * p2pkh auto-approve 同步判断（fire & forget 路径用）。
   *
   * 命中条件（必须全部满足）：
   *   - `storageDb` 可用（无 DB → 强制 manual，避免"无配置时偷偷自动"）；
   *   - 当前 origin 有配置；
   *   - `p2pkhAutoApproveEnabled === true`；
   *   - `amountSatoshis <= p2pkhAutoApproveMaxSatoshis`。
   *
   * 不在这里做余额 / 地址校验——余额不够会在 `runP2pkhTransferAndFinalize`
   * 内部 throw `insufficient_balance` 并对外统一回 user_rejected。
   */
  private isP2pkhAutoApprovedSync(params: P2pkhTransferParams, origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    if (!rec.p2pkhAutoApproveEnabled) return false;
    if (params.amountSatoshis <= 0) return false;
    return params.amountSatoshis <= rec.p2pkhAutoApproveMaxSatoshis;
  }

  /**
   * identity.get 自动批准同步判断。
   *
   * 命中条件：
   *   - `storageDb` 可用（无 DB → false）；
   *   - 当前 origin 在 `originCache` 有配置；
   *   - `identityAutoApproveEnabled === true`。
   *
   * 不做 aud 校验：`executeIdentityGet` 内部仍会 throw `invalid_origin`，
   * auto-approve 路径不绕过业务校验。
   */
  private isIdentityAutoApprovedSync(origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    return rec.identityAutoApproveEnabled === true;
  }

  /**
   * cipher.encrypt / cipher.decrypt 自动批准同步判断。
   *
   * 同一字段同时控制 encrypt 与 decrypt。命中条件同 identity。
   * 不做内容 / nonce 长度校验：`executeCipher*` 内部仍会做全部业务校验。
   */
  private isCipherAutoApprovedSync(origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    return rec.cipherAutoApproveEnabled === true;
  }

  /**
   * feepool auto-sign 同步判断（fire & forget 路径用）。
   *
   * 命中条件：
   *   - `storageDb` 可用；
   *   - 当前 origin 有配置；
   *   - `feePoolAutoSignMaxSatoshis > 0`；
   *   - `amountSatoshis <= feePoolAutoSignMaxSatoshis`。
   *
   * 适用于 `feepool.prepare` 与 `feepool.commit` 两种 method。`commit` 命中
   * auto-sign 时，service 假定 pending op 在 prepare 阶段已经生成；不命中
   * 时走 manual confirm。
   */
  private isFeepoolAutoSignedSync(amountSatoshis: number, origin: string): boolean {
    if (!this.deps.storageDb) return false;
    const rec = this.originCache.get(origin) ?? null;
    if (!rec) return false;
    if (rec.feePoolAutoSignMaxSatoshis <= 0) return false;
    if (amountSatoshis <= 0) return false;
    return amountSatoshis <= rec.feePoolAutoSignMaxSatoshis;
  }

  /** 当前已绑定 request 是否走了 auto-approve / auto-sign。 */
  currentRequestAutoApproved(): boolean {
    return Boolean(this.binding?.autoApproved);
  }

  /**
   * feepool auto-sign 内联执行入口。
   *
   * V1 简化：
   *   - prepare：调 executeFeepoolPrepare；内部已 reply + 清 binding。
   *   - commit：调 executeFeepoolCommit；同样内部 reply + 清 binding。
   *   - 失败（localFailure / 业务错误）时 catch → 对外 user_rejected（executeFeepoolPrepare
   *     / executeFeepoolCommit 自己走 `runFeepoolAndFinalize` 已经处理）。
   */
  private async runFeepoolAutoApproved(
    parsed: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> },
    eventOrigin: string,
    recordId: string
  ): Promise<void> {
    try {
      if (parsed.method === "feepool.prepare") {
        await this.executeFeepoolPrepare(
          parsed.params as FeepoolPrepareParams,
          eventOrigin,
          recordId
        );
      } else if (parsed.method === "feepool.commit") {
        await this.executeFeepoolCommit(
          parsed.params as FeepoolCommitParams,
          eventOrigin,
          recordId
        );
      }
    } catch (err) {
      // executeFeepoolPrepare / executeFeepoolCommit 自己 runFeepoolAndFinalize
      // 已经 catch 了；但 runFeepoolAndFinalize 是在 dispatch 里调用的，
      // 这里直接调 executeFeepool* 不走 dispatch；所以 catch 兜底。
      this.deps.logger?.error?.({
        scope: "protocol.exec",
        event: "feepoolAutoSign.err",
        err: err instanceof Error ? err.message : String(err)
      });
      // 用 localFailure 语义映射 record 终态。
      let localReason: ProtocolFailureReason = "internal_error";
      if (err && typeof err === "object" && "localReason" in err) {
        localReason = (err as { localReason?: ProtocolFailureReason }).localReason ?? "internal_error";
      }
      const rec = this.feedCommands.find((c) => c.id === recordId);
      if (rec) {
        rec.failureReason = localReason;
      }
      this.updateRecordFinal(recordId, "failed", "failed", "user_rejected", "User rejected");
      const binding = this.binding;
      if (binding) {
        await this.replyError(binding, "user_rejected", "User rejected");
      }
      this.binding = null;
      this.pendingRequestSnapshot = null;
      this.currentRecordId = null;
      this.setPhase("waiting");
    }
  }

  /**
   * identity / cipher auto-approve 内联执行入口。
   *
   * 设计缘由（施工单 001 收口）：
   *   - **不**走 `dispatch`：dispatch 给 confirmByUser 用，内部还有 result
   *     包装 / internalHandled 判断。auto-approve 路径需要自己管 record
   *     终态 + reply result + 清 binding，这里直接调底层 execute* 更干净。
   *   - 错误语义（与 `confirmByUser` 路径对齐）：
   *       * 业务错误（`invalid_origin` / `decrypt_failed` /
   *         `active_key_unavailable` / `invalid_request` /
   *         `internal_error`）：对外回**真实** `errCode` + `errMessage`，
   *         不吞掉协议语义。这是施工单 001 收口反馈 v1 修复的行为。
   *       * 本地失败原因（含 `localReason` 字段，例如未来扩展的
   *         "余额不足"等敏感本地状态）：对外回 `user_rejected` +
   *         `User rejected`（隐私边界，与 p2pkh 一致），本地 record
   *         写 `failureReason`。
   *   - 走 `this.binding` 而非局部快照：runIdentityCipherAutoApproved 由
   *     `tryAcceptFirstRequest` / `resumeAfterUnlock` 串行调起，调用前
   *     已经 setPhase("executing")，binding 仍指向本 record。
   */
  private async runIdentityCipherAutoApproved(
    parsed: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> },
    eventOrigin: string,
    recordId: string
  ): Promise<void> {
    const binding = this.binding;
    try {
      let result: MethodResult;
      switch (parsed.method) {
        case "identity.get":
          result = await this.executeIdentityGet(
            parsed.params as IdentityGetParams,
            eventOrigin
          );
          break;
        case "cipher.encrypt":
          result = await this.executeCipherEncrypt(
            parsed.params as CipherEncryptParams,
            eventOrigin
          );
          break;
        case "cipher.decrypt":
          result = await this.executeCipherDecrypt(
            parsed.params as CipherDecryptParams,
            eventOrigin
          );
          break;
        default:
          // 不会到这里：call site 已经只对 identity / cipher 调起。
          return;
      }
      this.updateRecordFinal(recordId, "approved", "approved");
      if (binding) {
        await this.replyResult(binding, result);
      }
    } catch (err) {
      // 错误语义：与 `confirmByUser` 路径对齐
      //   - 业务错误（invalid_origin / decrypt_failed / active_key_unavailable /
      //     invalid_request / internal_error）：对外回**真实** errCode
      //     + message，**不**吞掉协议语义。
      //   - 本地失败原因（p2pkh 余额不足 / DB 不可用 / 等"含 localReason"）：
      //     对外统一 `user_rejected`（隐私边界），本地 record 写 `failureReason`。
      let localReason: ProtocolFailureReason | undefined;
      let errCode: ProtocolErrorCode;
      let errMessage: string;
      if (err && typeof err === "object" && "localReason" in err) {
        localReason = (err as { localReason?: ProtocolFailureReason }).localReason as
          | ProtocolFailureReason
          | undefined;
        errCode = "user_rejected";
        errMessage = "User rejected";
      } else {
        const protoErr = toProtocolError(err);
        errCode = protoErr.code;
        errMessage = protoErr.message;
      }
      this.deps.logger?.error?.({
        scope: "protocol.exec",
        event: "identityCipherAutoApprove.failed",
        recordId,
        origin: eventOrigin,
        method: parsed.method,
        errCode,
        reason: localReason,
        err: errMessage
      });
      this.updateRecordFinal(recordId, "failed", "failed", errCode, errMessage);
      if (localReason) {
        const rec = this.feedCommands.find((c) => c.id === recordId);
        if (rec) {
          rec.failureReason = localReason;
          rec.updatedAt = Date.now();
          this.emitFeed();
          this.persistRecord(rec);
        }
      }
      if (binding) {
        await this.replyError(binding, errCode, errMessage);
      }
    } finally {
      // 收尾：清 binding、phase 回到 waiting；与 manual confirm 路径一致。
      this.binding = null;
      this.pendingRequestSnapshot = null;
      this.currentRecordId = null;
      this.setPhase("waiting");
    }
  }

  /**
   * 历史保留注释（施工单 001 收口反馈 v3 → v4 演进）：
   * 旧版 `evaluateIdentityCipherAutoApproveAfterLookup` 用 fire-and-forget
   * 异步查 DB 翻案会引入 race condition（先 setPhase("confirming") 再
   * 翻案 → React batching 行为变化 / 用户在翻案前点 confirm 抢先消费）。
   * v4 改为 `tryAcceptFirstRequest` 内**同步 await** `getOriginSettingsCached`
   * 再决定 setPhase,phase 永远只在终态（executing 或 confirming）出现一次,
   * 不再有 fire-and-forget 翻案路径。**因此本方法已删除,不再有 caller。**
   */

  private async dispatch(binding: RequestBinding): Promise<MethodResult> {
    console.info("[protocol] dispatch", {
      requestId: binding.id,
      method: binding.method,
      origin: binding.origin,
      paramsKeys: Object.keys(binding.params as object)
    });
    switch (binding.method) {
      case "identity.get":
        return this.executeIdentityGet(binding.params as IdentityGetParams, binding.origin);
      case "intent.sign":
        return this.executeIntentSign(binding.params as IntentSignParams, binding.origin);
      case "cipher.encrypt":
        return this.executeCipherEncrypt(binding.params as CipherEncryptParams, binding.origin);
      case "cipher.decrypt":
        return this.executeCipherDecrypt(binding.params as CipherDecryptParams, binding.origin);
      case "p2pkh.transfer":
        return this.executeP2pkhTransfer(
          binding.params as P2pkhTransferParams,
          binding.origin
        );
      case "feepool.prepare":
        return this.runFeepoolAndFinalize(
          () =>
            this.executeFeepoolPrepare(
              binding.params as FeepoolPrepareParams,
              binding.origin,
              binding.recordId
            ),
          binding.recordId
        );
      case "feepool.commit":
        return this.runFeepoolAndFinalize(
          () =>
            this.executeFeepoolCommit(
              binding.params as FeepoolCommitParams,
              binding.origin,
              binding.recordId
            ),
          binding.recordId
        );
    }
  }

  /**
   * feepool 执行包装：catch localFailure / 业务错误 → 对外统一 user_rejected，
   * 命令卡本地写 failureReason + errorCode/errorMessage。
   */
  private async runFeepoolAndFinalize<T extends FeepoolPrepareResult | FeepoolCommitResult>(
    run: () => Promise<T>,
    recordId: string
  ): Promise<T> {
    const binding = this.binding;
    try {
      return await run();
    } catch (err) {
      let localReason: ProtocolFailureReason = "internal_error";
      if (err && typeof err === "object" && "localReason" in err) {
        localReason = (err as { localReason?: ProtocolFailureReason }).localReason ??
          "internal_error";
      }
      this.deps.logger?.error?.({
        scope: "protocol.exec",
        event: "feepool.failed",
        recordId,
        localReason,
        err: err instanceof Error ? err.message : String(err)
      });
      const rec = this.feedCommands.find((c) => c.id === recordId);
      if (rec) {
        rec.failureReason = localReason;
      }
      this.updateRecordFinal(recordId, "failed", "failed", "user_rejected", "User rejected");
      if (binding) {
        await this.replyError(binding, "user_rejected", "User rejected");
      }
      this.binding = null;
      this.pendingRequestSnapshot = null;
      this.currentRecordId = null;
      this.setPhase("waiting");
      // dispatch 上层仍要拿到 result（confirmByUser 检查 internalHandled 时
      // 直接跳过外层 reply / 写命令卡）。这里返回 null 占位；调用方 dispatch
      // 内部已经把 result reply 出去 / 把命令卡写好；这里只是为了让 TS 收口。
      return null as unknown as T;
    }
  }

  private async executeIdentityGet(
    params: IdentityGetParams,
    eventOrigin: string
  ): Promise<IdentityGetResult> {
    console.info("[protocol] identity.get begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      aud: params.aud,
      claimCount: params.claims?.length ?? 0
    });
    if (params.aud !== eventOrigin) {
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
      this.binding!.id,
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

  private async executeIntentSign(
    params: IntentSignParams,
    eventOrigin: string
  ): Promise<IntentSignResult> {
    console.info("[protocol] intent.sign begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      aud: params.aud,
      contentType: params.contentType,
      contentBytes: params.content.bytes.byteLength
    });
    if (params.aud !== eventOrigin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);
    const contentSha256 = sha256Bytes(new Uint8Array(params.content.bytes));
    const envelopeCbor = cborEncode([
      PROTOCOL_VERSION,
      this.binding!.id,
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

  private async executeCipherEncrypt(
    params: CipherEncryptParams,
    eventOrigin: string
  ): Promise<CipherEncryptResult> {
    console.info("[protocol] cipher.encrypt begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      contentType: params.contentType,
      contentBytes: params.content.bytes.byteLength
    });
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const siteKey = await this.deriveSiteKeyWithActive(keyId, eventOrigin);
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

  private async executeCipherDecrypt(
    params: CipherDecryptParams,
    eventOrigin: string
  ): Promise<CipherDecryptResult> {
    console.info("[protocol] cipher.decrypt begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      nonceBytes: params.nonce.bytes.byteLength,
      cipherbytesBytes: params.cipherbytes.bytes.byteLength
    });
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    let siteKey: Uint8Array;
    try {
      siteKey = await this.deriveSiteKeyWithActive(keyId, eventOrigin);
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
    if (v !== PROTOCOL_VERSION || typeof contentType !== "string" || !(contentBytes instanceof Uint8Array)) {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    return {
      contentType,
      content: toBinaryField(contentBytes)
    };
  }

  /* ============== p2pkh.transfer ============== */

  /**
   * 手动 confirm 路径上执行 p2pkh.transfer（`confirmByUser` 流程调用）。
   * auto-approve 路径走 `runP2pkhTransferAndFinalize`。
   */
  private async executeP2pkhTransfer(
    params: P2pkhTransferParams,
    eventOrigin: string
  ): Promise<P2pkhTransferResult> {
    if (!this.binding) throw protocolError("internal_error", "No binding");
    await this.runP2pkhTransferAndFinalize(
      { id: this.binding.id, method: this.binding.method, params },
      eventOrigin,
      this.binding.recordId,
      /*autoApproved*/ false
    );
    // 上面的 finalize 已经 reply result；这里返回 dummy 让 dispatch 类型收敛。
    return {
      txid: "",
      rawTxHex: "",
      feeSatoshis: 0
    };
  }

  /**
   * p2pkh 真实执行 + reply result + 写命令卡终态；被 auto-approve 路径与
   * manual 路径共用。
   *
   * 关键不变量：
   *   - 余额不足 / 任何 prepare 失败 / 任何 submit 失败，**对外**统一回
   *     `user_rejected` + `User rejected` message；真实原因写到 record 的
   *     `failureReason`（本地）。
   *   - 错误 message 绝不含真实余额数字（p2pkhTransferService.prepare
   *     默认会带 "Available inputs N sats"；这里把它转换成 `user_rejected`
   *     后 message 固定为 "User rejected"）。
   *   - 成功时 record 写 recipientAddress / amountSatoshis / autoApproved；
   *     reply result 含 txid / rawTxHex / feeSatoshis。
   */
  private async runP2pkhTransferAndFinalize(
    parsed: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> },
    eventOrigin: string,
    recordId: string,
    autoApproved: boolean
  ): Promise<void> {
    const params = parsed.params as P2pkhTransferParams;
    try {
      const active = this.requireActiveKey();
      const result = await this.runP2pkhTransferOnce(params, active, recordId, autoApproved);
      // 成功：写 record 终态 + reply result + 回 waiting。
      this.updateRecordFinal(recordId, "approved", "approved");
      const binding = this.binding;
      if (binding) {
        await this.replyResult(binding, result);
      }
    } catch (err) {
      const reason = classifyP2pkhFailure(err);
      this.deps.logger?.error?.({
        scope: "protocol.exec",
        event: "p2pkhTransfer.failed",
        recordId,
        origin: eventOrigin,
        reason,
        err: err instanceof Error ? err.message : String(err)
      });
      const binding = this.binding;
      // record 写：errorCode = user_rejected（对外口径），failureReason = 真实原因（本地）。
      this.updateRecordFinal(recordId, "failed", "failed", "user_rejected", "User rejected");
      const rec = this.feedCommands.find((c) => c.id === recordId);
      if (rec) {
        rec.failureReason = reason;
        rec.updatedAt = Date.now();
        this.emitFeed();
        this.persistRecord(rec);
      }
      if (binding) {
        await this.replyError(binding, "user_rejected", "User rejected");
      }
    } finally {
      // 收尾：清 binding、phase 回到 waiting；与 manual confirm 路径一致。
      this.binding = null;
      this.pendingRequestSnapshot = null;
      this.currentRecordId = null;
      this.setPhase("waiting");
    }
  }

  private async runP2pkhTransferOnce(
    params: P2pkhTransferParams,
    active: { publicKeyHex: string; keyId: string; label: string },
    recordId: string,
    autoApproved: boolean
  ): Promise<P2pkhTransferResult> {
    if (!this.deps.p2pkhService) {
      throw protocolError("internal_error", "p2pkh service not available");
    }
    this.updateRecordPhase(recordId, "executing");
    // 写入方法相关摘要字段，供历史显示。
    const rec = this.feedCommands.find((c) => c.id === recordId);
    if (rec) {
      rec.recipientAddress = params.recipientAddress;
      rec.amountSatoshis = params.amountSatoshis;
      rec.autoApproved = autoApproved;
      rec.updatedAt = Date.now();
      this.emitFeed();
      this.persistRecord(rec);
    }

    const preview = await this.deps.p2pkhService.prepareTransfer({
      assetId: "bsv",
      recipientAddress: params.recipientAddress,
      amountSatoshis: params.amountSatoshis,
      feeRateSatoshisPerKb: params.feeRateSatoshisPerKb ?? DEFAULT_P2PKH_FEE_RATE_SAT_PER_KB
    });
    const submitted = await this.deps.p2pkhService.submitTransfer(preview);
    const txid = submitted.txid ?? preview.txid;
    return {
      txid,
      rawTxHex: submitted.rawTxHex,
      feeSatoshis: preview.estimatedFeeSatoshis
    };
  }

  /* ============== feepool.prepare ============== */

  private async executeFeepoolPrepare(
    params: FeepoolPrepareParams,
    eventOrigin: string,
    recordId: string
  ): Promise<FeepoolPrepareResult> {
    if (!this.deps.storageDb) {
      throw localFailure("fee_pool_db_unavailable", "Protocol storage DB unavailable");
    }
    const poolKey = `${eventOrigin}::${params.counterpartyPublicKeyHex}`;
    const prior = await this.deps.storageDb.getFeePool(poolKey);
    const originSettings = await this.getOriginSettingsCached(eventOrigin);

    /**
     * action 决策（V4 收口，Keymaster 单边）：
     *   - 无 prior 池 → create
     *   - 有 prior，且 `prior.serverAmount + amountSatoshis <= prior.totalAmount` → spend
     *   - 其它 → close_and_recreate
     *
     * 关键：spend 决策**不**是 `prior.totalAmount >= amountSatoshis`——
     * 那样会忽略累计已分配金额；正确是看剩余额度（`prior.totalAmount -
     * prior.serverAmount`）是否够。
     */
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
      nextServerAmount = params.amountSatoshis; // 新池从 0 重新累计
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

    // 主 B-Tx 草稿字段（三种 action 都有）。
    let draftSpendTxHex = "";
    let draftClientSignBytes: Uint8Array = new Uint8Array(0);
    let draftTotalAmount = 0;
    // 仅 close_and_recreate 的 close 部分。
    let closeDraftTxHex: string | undefined;
    let closeClientSignBytes: Uint8Array | undefined;
    // 仅 create / close_and_recreate 的新池部分。
    let baseTxHex: string | undefined;
    let baseTxOutputIndex: number | undefined;

    if (action === "create") {
      // 池大小 = 该 origin 配置的 feePoolDefaultFundSatoshis。
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
      // 1) 建 A-Tx（client P2PKH → 2-of-2 multisig output，size = poolAmount）。
      const baseResp = await this.buildAndMaybeBuildBaseTx(
        prior,
        clientPrivateKeyHex,
        params.counterpartyPublicKeyHex,
        poolAmount
      );
      baseTxHex = baseResp.baseTxHex;
      baseTxOutputIndex = baseResp.baseTxOutputIndex;
      draftTotalAmount = baseResp.amount;
      // 2) 构造**初始** B-Tx 草稿（multisig output → server + change）；
      //    `serverAmount = amountSatoshis`。
      const initialDraft = await sdkBuildInitialDraftSpendTx({
        prevTxId: baseResp.baseTxid,
        totalAmount: draftTotalAmount,
        serverAmount: params.amountSatoshis,
        endHeight: 0,
        clientPrivateKeyHex,
        serverPublicKeyHex: params.counterpartyPublicKeyHex,
        feeRate: 1
      });
      // 3) client 在初始草稿上签名。
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
      // 用 SDK `loadTx` 在**旧草稿**上把 `serverAmount` 改成
      // `prior.serverAmount + amountSatoshis`；locktime 保持未来生效。
      // **关键**（施工单 002 收尾反馈 V5）：sequenceNumber **不能**传 0
      // ——SDK 在 update 签名 / 验签时用 `input.sequence || 1`，所以
      // sequence=0 会让 sighash preimage 用 1 算，但实际 sequence 是 0，
      // 导致"实际 sequence 0 / 签名 preimage 按 1 算"的不一致。V1 用一个
      // 固定的非零未来生效值（0xfffffffe，类似"近未来"）。
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
      // close_and_recreate：先把旧草稿切到 FINAL_LOCKTIME 最终版本；
      // 然后建新 A-Tx + 新初始 B-Tx 草稿。
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
      // 1) close 部分：把旧草稿切到 FINAL_LOCKTIME（`sequence = 0xFFFFFFFF`）。
      //    **关键**（施工单 002 收尾反馈 V5）：close 的 serverAmount 必须
      //    只是 `prior.serverAmount`（旧池已累计的金额）—— close 只能兑现
      //    旧池内的累计，**不能**把 site 的新请求 amountSatoshis 加进来。
      //    新请求的 amountSatoshis 由新池的初始 B-Tx 草稿承接（`buildInitialDraftSpendTx`）。
      //    SDK 的 `loadTx` 只更新 `outputs[0] = serverAmount`、`outputs[1] = total - serverAmount`，
      //    **没有**上限检查——如果 close.serverAmount 超出 prior.totalAmount，
      //    outputs[1] 会变成负数，签名会失败。
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
      // 2) 建新 A-Tx。
      const baseResp = await this.buildAndMaybeBuildBaseTx(
        prior,
        clientPrivateKeyHex,
        params.counterpartyPublicKeyHex,
        newPoolAmount
      );
      baseTxHex = baseResp.baseTxHex;
      baseTxOutputIndex = baseResp.baseTxOutputIndex;
      draftTotalAmount = baseResp.amount;
      // 3) 新池的初始 B-Tx 草稿。
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

    // 写 pending op 内存。
    this.pendingOps.set(operationId, {
      operationId,
      origin: eventOrigin,
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

    this.updateRecordSummary(recordId, {
      action,
      operationId,
      counterpartyPublicKeyHex: params.counterpartyPublicKeyHex,
      amountSatoshis: params.amountSatoshis
    });

    // 构造 prepare result。
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

    this.updateRecordFinal(recordId, "approved", "approved");
    const binding = this.binding;
    if (binding) {
      await this.replyResult(binding, result);
    }
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
    return result;
  }

  /**
   * 建 A-Tx（client P2PKH UTXO → 2-of-2 multisig output）；create / close_and_recreate 复用。
   * 返回 `baseTxHex` / `baseTxOutputIndex` / `baseTxid` / `amount`（multisig output 大小）。
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

  /**
   * 同步取 origin 配置（用于 `executeFeepoolPrepare` 内部读取 default fund）。
   * 内部缓存已通过 `loadHistoryForOrigin` / `setOriginSettings` 维护。
   * cache miss 时保守返回 undefined（service 仍可继续，只是 default fund = 0）。
   */
  private async getOriginSettingsCached(origin: string): Promise<ProtocolOriginSettingsRecord | null> {
    const cached = this.originCache.get(origin);
    if (cached) return cached;
    if (!this.deps.storageDb) return null;
    try {
      const raw = await this.deps.storageDb.getOrigin(origin);
      // 与 getOriginSettings 行为一致：DB 命中才归一化写 cache；null
      // 不污染 cache。
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

  /* ============== feepool.commit ============== */

  private async executeFeepoolCommit(
    params: FeepoolCommitParams,
    eventOrigin: string,
    recordId: string
  ): Promise<FeepoolCommitResult> {
    if (!this.deps.storageDb) {
      throw localFailure("fee_pool_db_unavailable", "Protocol storage DB unavailable");
    }
    const op = this.pendingOps.get(params.operationId);
    if (!op) {
      throw localFailure("unknown_operation", "operationId not found in current session");
    }
    if (op.origin !== eventOrigin) {
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

    /**
     * V4 验签矩阵（**B-Tx 是草稿**，不是最终已广播的 tx）：
     *
     * | action | 验什么 | sig 类型 |
     * | --- | --- | --- |
     * | create | 主 B-Tx 草稿 | initial spend sig |
     * | spend | 主 B-Tx 草稿（更新版）| update sig |
     * | close_and_recreate | close 草稿（旧池 final）+ 主 B-Tx 草稿（新池）| update sig + initial spend sig |
     *
     * V4 移除 `baseCounterpartySignatures`：base tx 仅由 client 用 P2PKH
     * UTXO funding 签；server 不参与 base tx 的签名（multisig output
     * 是被创建的，不是被花费的）。
     */
    if (op.action === "create") {
      if (!op.draftSpendTxHex || !op.draftClientSignBytes.length) {
        throw localFailure("internal_error", "create pending op missing draft / client sign");
      }
      // create：验**初始** spend sig（草稿是初始版）。
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
      // spend：验**更新** sig（草稿是更新版）。
      // SDK 的 `clientVerifyServerUpdateSig` 与 `clientVerifyServerSpendSig`
      // sighash 计算方式不同，不能混用。
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
      // close_and_recreate：验 close 草稿（update sig）+ 主 B-Tx 草稿（initial spend sig）。
      // eslint-disable-next-line no-console
      if (!op.closeDraftTxHex ||
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
      // 1) close 草稿：update sig。
      const closeValid = await sdkVerifyServerUpdateSig({
        txHex: op.closeDraftTxHex,
        serverPublicKeyHex: params.counterpartyPublicKeyHex,
        clientPublicKeyHex,
        serverSignBytes: closeServerSignBytes
      });
      // eslint-disable-next-line no-console
      if (!closeValid) {
        throw localFailure("internal_error", "close draft signature verification failed");
      }
      // 2) 新池主 B-Tx 草稿：initial spend sig。
      const draftValid = await sdkVerifyServerInitialSpendSig({
        txHex: op.draftSpendTxHex,
        totalAmount: op.draftTotalAmount,
        serverPublicKeyHex: params.counterpartyPublicKeyHex,
        clientPublicKeyHex,
        serverSignBytes: mainServerSignBytes
      });
      // eslint-disable-next-line no-console
      if (!draftValid) {
        throw localFailure("internal_error", "draft signature verification failed");
      }
    }

    // V4：commit 不真广播；只把 B-Tx 草稿落地到 store。
    // eslint-disable-next-line no-console
    const poolKey = `${eventOrigin}::${params.counterpartyPublicKeyHex}`;
    let newRecord: ProtocolFeePoolRecord | null = null;
    let draftTxid = "";
    let draftTxHex = "";
    draftTxid = await computeTxidFromHex(op.draftSpendTxHex);
    draftTxHex = op.draftSpendTxHex;
    // eslint-disable-next-line no-console
    let closeDraftTxid: string | undefined;

    if (op.action === "create" || op.action === "close_and_recreate") {
      // 新池 baseTxid = 新 base tx 的 txid（**不是** B-Tx draft 的 txid）。
      const baseTxid = await computeTxidFromHex(op.baseTxHex ?? "");
      // 关键不变量（V4）：totalAmount = 池大小 = draftTotalAmount；
      // serverAmount = 累计已分配额 = op.nextServerAmount。
      newRecord = {
        poolKey,
        origin: eventOrigin,
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
      // spend：**不**删池；只更新同一条 pool record（累计 serverAmount + 草稿）。
      if (op.priorPool) {
        const baseTxid = op.priorPool.baseTxid;
        const baseTxHex = op.priorPool.baseTxHex;
        newRecord = {
          poolKey: op.priorPool.poolKey,
          origin: eventOrigin,
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
      // close_and_recreate：**不**需要 deleteFeePool；上面 putFeePool(newRecord)
      // 已经用同 key（同一 origin + counterparty）覆盖了 prior。
      // 再 delete 反而会把新池也删掉。
      closeDraftTxid = await computeTxidFromHex(op.closeDraftTxHex);
    }
    this.pendingOps.delete(op.operationId);

    this.updateRecordSummary(recordId, {
      action: op.action,
      operationId: op.operationId
    });

    const result: FeepoolCommitResult = {
      operationId: op.operationId,
      action: op.action,
      draftTxid,
      draftTxHex,
      poolRecord: newRecord,
      closeDraftTxid
    };

    this.updateRecordFinal(recordId, "approved", "approved");
    const binding = this.binding;
    if (binding) {
      await this.replyResult(binding, result);
    }
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
    return result;
  }

  /** 通过 vault.withPrivateKey 拿到私钥 hex（feepoolSdk 需要）。 */
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

  /** sign helper：从 vault.withPrivateKey 借私钥。 */
  private async signWithActive(keyId: string, bytes: Uint8Array): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return signCompactSecp256k1(material.hex, bytes);
    });
  }

  /** cipher siteKey 派生：借私钥后 HMAC。 */
  private async deriveSiteKeyWithActive(keyId: string, exactOrigin: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return deriveSiteKey(material.hex, exactOrigin);
    });
  }

  /** publicKey 字节：用 vault.withPrivateKey 派生 33-byte compressed pubkey。 */
  private async fetchPublicKeyBytes(publicKeyHex: string, keyId: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      const pub = secp256k1.getPublicKey(hexToBytes(material.hex), true);
      return pub;
    });
  }

  /* ============== 发送 ============== */

  private async replyResult(binding: RequestBinding, result: MethodResult): Promise<void> {
    if (!this.canPostToOpener(binding)) {
      return;
    }
    const message: ProtocolResultMessage = {
      v: PROTOCOL_VERSION,
      type: "result",
      id: binding.id,
      ok: true,
      result
    };
    this.postMessage(binding, message);
    // 注意：单条 request 收尾**不**发 `closing`。closing 由
    // pageUnloading 路径在 popup 真正销毁时发。
  }

  private async replyError(
    binding: RequestBinding,
    code: ProtocolErrorCode,
    errorMessage: string
  ): Promise<void> {
    console.error("[protocol] replyError", {
      requestId: binding.id,
      method: binding.method,
      origin: binding.origin,
      code,
      errorMessage
    });
    if (this.canPostToOpener(binding)) {
      const message: ProtocolResultMessage = {
        v: PROTOCOL_VERSION,
        type: "result",
        id: binding.id,
        ok: false,
        error: { code, message: errorMessage }
      };
      this.postMessage(binding, message);
    }
  }

  private canPostToOpener(binding: RequestBinding): boolean {
    try {
      const s = binding.source as Window & { closed?: boolean };
      if (s.closed === true) return false;
    } catch {
      return false;
    }
    return true;
  }

  private postMessage(binding: RequestBinding, message: ProtocolResultMessage): void {
    if (this.deps.postResult) {
      this.deps.postResult(binding.source, binding.origin, message);
      return;
    }
    try {
      binding.source.postMessage(message, binding.origin);
    } catch (err) {
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "postMessage.failed", data: { err: String(err) } });
    }
  }

  /**
   * best-effort 发送 `closing`。idempotent：最多发一次。失败不重试、
   * 不抛、不阻塞，由 client 端 `popup.closed === true` 兜底。
   *
   * 优先级：绑定的 request source > window.opener。前者覆盖 service 启动后
   * opener 已被回收的情况；后者覆盖 popup 页面在 waiting 阶段就触发卸载
   * （还没绑定 request）的边缘情况。
   */
  private sendClosingBestEffort(): void {
    if (this.closingSent) return;
    const target = this.binding?.source ?? this.getOpener();
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
        this.deps.logger?.error?.({ scope: "protocol.transport", event: "closing.failed", data: { err: String(err) } });
      }
      return;
    }
    try {
      target.postMessage(CLOSING_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "closing.failed", data: { err: String(err) } });
    }
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

  private getOpener(): Window | null {
    if (this.deps.resolveOpener) {
      return this.deps.resolveOpener();
    }
    if (typeof window === "undefined") return null;
    return window.opener;
  }

  /* ============== 命令流（feed）+ DB ============== */

  /**
   * 推一条命令到当前 feed。`commands` 数组按 `updatedAt desc` 排序；
   * 同 `id` 已存在时覆盖并前移。
   */
  private upsertFeedCommand(record: ProtocolCommandRecord): void {
    const idx = this.feedCommands.findIndex((c) => c.id === record.id);
    if (idx >= 0) {
      this.feedCommands[idx] = record;
    } else {
      this.feedCommands.unshift(record);
    }
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
  }

  private updateRecordPhase(id: string, phase: ProtocolCommandRecord["phase"]): void {
    const rec = this.feedCommands.find((c) => c.id === id);
    if (!rec) return;
    rec.phase = phase;
    rec.status = phase;
    rec.updatedAt = Date.now();
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
    this.persistRecord(rec);
  }

  private updateRecordFinal(
    id: string,
    phase: ProtocolCommandRecord["phase"],
    decision: ProtocolCommandRecord["decision"],
    errorCode: string = "",
    errorMessage: string = ""
  ): void {
    const rec = this.feedCommands.find((c) => c.id === id);
    if (!rec) return;
    rec.phase = phase;
    rec.decision = decision;
    rec.status = phase;
    rec.errorCode = errorCode;
    rec.errorMessage = errorMessage;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
    this.persistRecord(rec);
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
      // 写失败 → 历史不可用；UI 顶部显示"历史不可用"提示。
      // 仍然在内存里保留命令卡，主协议流程不中断。
      // 注意：写成功**不**主动把 historyAvailable 翻回 true —— 历史可用
      // 是由"DB 能读 + DB 能写"共同决定的，单次写成功不足以证明 DB
      // 已经恢复。翻回 true 只能由 loadHistoryForOrigin 成功完成时做。
      if (this.historyAvailableFlag) {
        this.historyAvailableFlag = false;
        this.emitFeed();
      }
    });
  }

  /**
   * 把方法特定的摘要字段（recipientAddress / amountSatoshis / action /
   * operationId / counterpartyPublicKeyHex）写进 record；不影响 phase /
   * decision / status。
   */
  private updateRecordSummary(
    recordId: string,
    summary: {
      recipientAddress?: string;
      amountSatoshis?: number;
      action?: ProtocolFeePoolAction;
      operationId?: string;
      counterpartyPublicKeyHex?: string;
    }
  ): void {
    const rec = this.feedCommands.find((c) => c.id === recordId);
    if (!rec) return;
    if (summary.recipientAddress !== undefined) rec.recipientAddress = summary.recipientAddress;
    if (summary.amountSatoshis !== undefined) rec.amountSatoshis = summary.amountSatoshis;
    if (summary.action !== undefined) rec.action = summary.action;
    if (summary.operationId !== undefined) rec.operationId = summary.operationId;
    if (summary.counterpartyPublicKeyHex !== undefined) {
      rec.counterpartyPublicKeyHex = summary.counterpartyPublicKeyHex;
    }
    rec.updatedAt = Date.now();
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
    this.persistRecord(rec);
  }

  private async loadHistoryForOrigin(origin: string): Promise<void> {
    if (this.historyLoadInFlight) {
      return this.historyLoadInFlight;
    }
    const db = this.deps.storageDb;
    if (!db) {
      this.historyAvailableFlag = false;
      // 即使没 DB，也保留当前 in-flight 命令卡（如果有）。
      this.feedCommands = this.feedCommands.filter(
        (c) => c.origin === origin && c.id === this.currentRecordId
      );
      this.emitFeed();
      return;
    }
    const task = (async () => {
      try {
        // 三 store 并行拉：commands / origins / feePools。
        const [list, originRec, pools] = await Promise.all([
          db.listCommandsByOrigin(origin),
          db.getOrigin(origin),
          db.listFeePoolsByOrigin(origin)
        ]);
        // 把 origins 写进内存 cache（auto-approve 同步判断用）。
        // 旧记录经 normalizeOriginSettings 补默认值；null 时不刷 cache，
        // 避免把"该 origin 未配置"覆盖成"曾有旧配置"。
        if (originRec) {
          this.originCache.set(origin, normalizeOriginSettings(originRec, origin));
        }
        // merge：DB 列表是基线，但**当前 in-flight 命令卡**必须保留。
        const inflight = this.currentRecordId
          ? this.feedCommands.find((c) => c.id === this.currentRecordId)
          : undefined;
        const merged: ProtocolCommandRecord[] = list.slice();
        if (inflight && !merged.some((c) => c.id === inflight.id)) {
          merged.unshift(inflight);
        }
        merged.sort((a, b) => b.updatedAt - a.updatedAt);
        this.feedCommands = merged;
        this.historyAvailableFlag = true;
        // 注意：feePools 不进 commands 内存（不持久化到命令流），但写入
        // pendingOps 之外的 store 时仍走 storageDb。这里只确认"读得到"，
        // 不缓存（cache 不需要；feepool 路径按需重读）。
        void pools;
        this.emitFeed();
      } catch (err) {
        console.error("[protocol.storageDb] loadHistoryForOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        this.historyAvailableFlag = false;
        // 读失败时也保留当前 in-flight 命令卡。
        this.feedCommands = this.feedCommands.filter(
          (c) => c.id === this.currentRecordId
        );
        this.emitFeed();
      } finally {
        this.historyLoadInFlight = null;
      }
    })();
    this.historyLoadInFlight = task;
    return task;
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
    const p = params as { content?: { bytes?: { byteLength?: number } }; cipherbytes?: { bytes?: { byteLength?: number } } };
    if (p.content?.bytes && typeof p.content.bytes.byteLength === "number") {
      return p.content.bytes.byteLength;
    }
    if (p.cipherbytes?.bytes && typeof p.cipherbytes.bytes.byteLength === "number") {
      return p.cipherbytes.bytes.byteLength;
    }
    return 0;
  }
}

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

/* ============== 施工单 002 硬切换：本地失败原因辅助 ============== */

/**
 * 把"内部真实失败原因"打包成 Error；error.code = ProtocolErrorCode（用于
 * reply 给 opener 时 fallback 选 user_rejected），error.localReason =
 * ProtocolFailureReason（写到命令卡）。`runP2pkhTransferAndFinalize` /
 * `executeFeepool*` 用这个 throw 错误。
 */
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

/**
 * 把 p2pkh 业务异常分类成本地 `ProtocolFailureReason`。
 *
 * 触发源：plugin-p2pkh `prepareTransfer` 抛的 Error message 含特定关键字；
 * 我们不依赖 message 数字本身（避免泄漏），只做关键字分类。
 */
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

/** BinaryField[] → Uint8Array[]（feepool.commit 验签前转换）。 */
function binaryFieldsToBytes(fields: BinaryField[]): Uint8Array {
  if (fields.length !== 1) {
    // 当前 V1 一个 server pubkey 对应一个签名；多条签名合并语义留作 V2。
    return fields[0] ? new Uint8Array(fields[0].bytes) : new Uint8Array(0);
  }
  return new Uint8Array(fields[0]!.bytes);
}

/** Uint8Array → BinaryField。 */
function bytesToBinaryField(bytes: Uint8Array): BinaryField {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return { $type: "binary" as const, bytes: ab };
}

/**
 * V1 简化：用 @bsv/sdk Transaction.id("hex") 计算 txid。
 * 失败时退化为 sha256d(txBytes)（双 sha256 后按字节序小端）。
 */
async function computeTxidFromHex(txHex: string): Promise<string> {
  // 关键修复（施工单 002 收尾反馈）：fallback 路径必须是对**交易字节**
  // 做双 sha256，而不是对十六进制字符串文本做。原实现的 fallback 会
  // 产出完全错误的 txid。
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
  // BSV txid 是双 sha256 结果反序。
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

/** 顶层 cancel 报文的轻量形状嗅探（施工单 003 硬切换）。 */
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

/** 把 claim 投影值安全转成 CborValue。 */
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
