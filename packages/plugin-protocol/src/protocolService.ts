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
import { ProtocolValidationError, parseRequestMessage } from "./protocolValidation.js";
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
      const rec = await this.deps.storageDb.getOrigin(origin);
      if (rec) this.originCache.set(origin, rec);
      return rec;
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
   * 写入时同步刷内存 cache，确保下一次 p2pkh auto-approve 判断能立即生效。
   */
  async setOriginSettings(record: ProtocolOriginSettingsRecord): Promise<void> {
    if (!this.deps.storageDb) {
      throw new Error("Protocol storage DB is not available");
    }
    const next: ProtocolOriginSettingsRecord = { ...record, updatedAt: Date.now() };
    await this.deps.storageDb.putOrigin(next);
    this.originCache.set(record.origin, next);
  }

  /** 处理来自 `window` 的 message 事件。 */
  handleMessage(event: MessageEvent): void {
    if (!this.binding) {
      this.tryAcceptFirstRequest(event);
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
    this.updateRecordFinal(binding.recordId, "rejected", "rejected");
    await this.replyError(binding, "user_rejected", "User rejected");
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
  }

  /** 解锁状态机推进：vault unlock 完成后由 UI 调本方法继续已绑定的 request。 */
  resumeAfterUnlock(): void {
    if (!this.binding) return;
    if (this.phase !== "unlocking") return;
    this.setPhase("confirming");
    this.updateRecordPhase(this.binding.recordId, "waiting_confirm");
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

  private tryAcceptFirstRequest(event: MessageEvent): void {
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
      this.setPhase("confirming");
      this.updateRecordPhase(recordId, "waiting_confirm");
    } else {
      this.setPhase("unlocking");
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
      const rec = await this.deps.storageDb.getOrigin(origin);
      if (rec) this.originCache.set(origin, rec);
      return rec;
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
        if (originRec) this.originCache.set(origin, originRec);
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
