import type { CoordinatorClientRequest, CoordinatorMsFileControl, CoordinatorResponse, MsFileErrorCode, ActiveKeyCrypto, BorrowedModuleFileStore, MsFileSellerSettings, SessionEpoch, ProtocolSpendService, P2pkhUtxoSnapshotResult, WocServiceHandle } from "@keymaster/contracts";
import { normalizeMsFileSatoshiAmount, isValidMsFileHashHex, MSFILE_BITFS_BUYER_SETTINGS_DEFAULT } from "@keymaster/contracts";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { BitfsSeedIndex, BitfsSellerRuntime, BitfsSellerSessionManager, createBitfsBuyerTask, createBitfsBuyerDownloadPlan, BitfsBuyerProtocol, createBitfsLocalSellerContentResolver, BitfsTransactionBroadcaster, createBitfsJournal, createBitfsSessionJournal, createBitfsTransactionJournal, createBitfsVaultSigner, createBitfsWocChainPort, createMsFileLocalContentSource, recoverBitfsBuyerContentCommit, readBitfsBuyerLocalPaymentState, assertBitfsBuyerCloseBinding, parseBitfsBuyerCloseBinding, createUnavailableBitfsSellerContentResolver, reconcileBitfsTransactions, reconcileBitfsSessionTransactions, readBitfsPoolSpendChain, prepareBitfsFunding, recoverBitfsFundingSplits, BitfsSellerProtocol, type BitfsSellerMatch, type BitfsBuyerQuoteView, type BitfsBuyerTask, type BitfsSellerProtocolPort, type BitfsSellerStreamTransport, type BitfsFundingPrepareDeps, type BitfsTransactionJournal, type BitfsFundingLedger, type MsFileServiceImpl } from "../coordinator.js";
import type { WorkerFundingDependencies, createWorkerFundingRuntime } from "./workerFundingRuntime.js";
import { completeBuyerOpening, parsePaymentState, verifyBuyerCompletedClose } from "go-bitfs";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { newSessionID, parseMessageID, parseSessionID } from "bsv8-channel-protocol";
import { WEBRTC_SIGNAL_PROTOCOL, newOffer, newAnswer, newEndOfCandidates as newEndOfCandidatesSignal, newICECandidate as newIceSignal } from "bsv8-channel-protocol/webrtc-signal";
import type { WebRTCInterconnectEnvelope } from "bitcoin-libp2p/webrtc-interconnect";

interface BitfsChannelPort { ownerPublicKeyHex: string; signal: AbortSignal }
interface BitfsExecutorLease { sessionEpoch: string; transportReady: boolean }
type P2pkhUtxoSnapshotResource = Awaited<ReturnType<WorkerFundingDependencies["ensureResources"]>>[number];
export interface BitfsWorkerDependencies {
  session(): { vaultStatus: string; activePublicKeyHex?: string; sessionEpoch: string; runGeneration: string };
  service(): MsFileServiceImpl | undefined;
  ensureService(): Promise<MsFileServiceImpl>;
  files(purpose: string): BorrowedModuleFileStore;
  woc(): WocServiceHandle | undefined;
  p2pkhSettings(): ReturnType<WorkerFundingDependencies["readP2pkhSettings"]>;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  blockHeight(network: "main" | "test"): Promise<number>;
  executor(operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown>;
  network(): "main" | "test";
  availability(unitId: string): { state: string };
  subscribeAvailability(listener: () => void): () => void;
  ensureResources: WorkerFundingDependencies["ensureResources"];
  snapshots(): (NonNullable<ReturnType<WorkerFundingDependencies["snapshots"]>> & { get(resource: P2pkhUtxoSnapshotResource): P2pkhUtxoSnapshotResult }) | undefined;
  ensureChannel(): Promise<BitfsChannelPort>;
  channel(): BitfsChannelPort | undefined;
  buyerSubscriptions(runtime: BitfsChannelPort): Promise<void>;
  sellerSubscriptions(runtime: BitfsChannelPort): Promise<void>;
  publishHashRequest(runtime: BitfsChannelPort, input: { hash: string; locator: "webrtc-sdp" }, signal: AbortSignal, prepared: (messageId: string) => void): Promise<{ messageId: string }>;
  unknownPublishFailure(error: unknown): boolean;
  executorLease(): BitfsExecutorLease | undefined;
  resetAutoLock(): void;
  pauseAutoLock(): void;
  allowLoopback(): boolean;
  isUnavailable(error: unknown): boolean;
  publishPrivate(input: { runtime: BitfsChannelPort; recipientPublicKeyHex: string; protocol: typeof WEBRTC_SIGNAL_PROTOCOL; body: ReturnType<typeof newOffer>; signal?: AbortSignal }): Promise<{ messageId: string }>;
  funding: ReturnType<typeof createWorkerFundingRuntime>;
  parseTransaction: WorkerFundingDependencies["parseTransaction"];
  deriveAddress: WorkerFundingDependencies["deriveAddress"];
  addressScript: WorkerFundingDependencies["addressScript"];
  maxFeeSatoshis: WorkerFundingDependencies["maxFeeSatoshis"];
  diagnosticsEnabled(): boolean;
  bytesToHex(bytes: Uint8Array): string;
  hexToBytes(value: string): Uint8Array;
}

/** Owns the shared BitFS seller, buyer recovery, demand and WebRTC session state. */
interface MsFileBitfsBuyerRecoveryScope {
  /** 当前已解锁 Key 的公钥。 */
  ownerPublicKeyHex: string;
  /** 当前 Worker 会话世代。 */
  sessionEpoch: SessionEpoch;
  /** 当前 Worker 运行世代。 */
  runGeneration: string;
}
interface MsFileBitfsRecentSellerSpeed {
  /** 样本写入时的 UTC Unix 毫秒。 */
  recordedAtMs: number;
  /** 最近一次已付款 Block 的整数字节/秒。 */
  bytesPerSecond: string;
}
interface MsFileBitfsSellerSpeedSample {
  /** 已验收的文件 Block 总字节数，不包含 Seed。 */
  effectiveBlockBytes: number;
  /** 从发送 Kind 5 到验收 Kind 6 的耗时毫秒数。 */
  elapsedMs: number;
  /** 样本写入时的 UTC Unix 毫秒。 */
  recordedAtMs: number;
}
export function createBitfsWorkerRuntime(deps: BitfsWorkerDependencies) {
/** 当前 owner 的 BitFS 卖方派生索引；锁定、切 Key 或关闭卖方时立即丢弃。 */
let msfileSellerIndex: BitfsSeedIndex | undefined;
/** 索引重建取消句柄，防止旧 owner 的迟到结果重新发布。 */
let msfileSellerIndexController: AbortController | undefined;
/** 当前 owner 唯一的卖方匹配运行单元。 */
let msfileSellerRuntime: BitfsSellerRuntime | undefined;
/** 当前 owner 唯一的卖方协议端口；未就绪时不得对外报价。 */
let msfileSellerProtocolPort: BitfsSellerProtocolPort | undefined;
/** 当前 owner 唯一的卖方会话管理器；多 Tab 只共享这一份。 */
let msfileSellerSessionManager: BitfsSellerSessionManager | undefined;
const msfilePendingSellerHashRequests = new Map<string, import("bsv8-channel-protocol/hash-request").VerifiedHashRequest>();
let msfilePendingSellerHashRequestDrain: Promise<void> | undefined;
/** 当前 owner 的 BitFS 交易 outbox；与普通 P2PKH 业务记录隔离。 */
let msfileBitfsTransactionJournal: BitfsTransactionJournal | undefined;
/** 当前 owner 的 BitFS 专款账本；普通 P2PKH 读取和广播都用它检查受保护输出。 */
/** 只通过 Worker 内 WoC 句柄广播/对账的 BitFS 交易器。 */
let msfileBitfsBroadcaster: BitfsTransactionBroadcaster | undefined;
/** 卖方会话 generation；锁定、切 Key、关闭卖方或重建 runtime 时推进。 */
let msfileSellerSessionEpoch = 0;
/** ChannelProtocol WebRTC session_id 到 Worker 卖方会话的短期映射。 */
const msfileBitfsWebRtcSellerLinks = new Map<string, {
  /** Worker 内 BitFS 卖方会话编号。 */
  sessionId: string;
  /** 已验证 Hash 请求的真实 message_id。 */
  requestMessageId: string;
  /** Inbox 对端公钥；答复必须来自此公钥。 */
  peerPublicKeyHex: string;
  /** 建立链接时的 owner session epoch。 */
  ownerSessionEpoch: SessionEpoch;
}>();
/** 等待卖方报价的 Hash 请求；只在当前 owner 和请求有效期内保留。 */
const msfileBitfsBuyerRequests = new Map<string, {
  /** 买方 Worker 编排任务。 */
  task: BitfsBuyerTask;
  /** 当前买方 Key。 */
  ownerPublicKeyHex: string;
  /** 本次请求的 Seed Hash。 */
  seedHashHex: string;
  /** 发送需求时的 owner 会话世代。 */
  ownerSessionEpoch: SessionEpoch;
  /** 请求有效截止毫秒。 */
  expiresAtMs: number;
}>();
/** 当前 Owner + Seed 的买方任务；多个页面复用同一任务和需求编号。 */
const msfileBitfsBuyerTasks = new Map<string, {
  /** 当前买方 Key。 */
  ownerPublicKeyHex: string;
  /** 任务对应的 Seed Hash。 */
  seedHashHex: string;
  /** 创建任务时的 owner 会话世代。 */
  ownerSessionEpoch: SessionEpoch;
  /** 买方任务创建过程；并发页面共享同一个初始化过程。 */
  taskPromise: Promise<BitfsBuyerTask>;
  /** 当前有效 Hash 需求编号。 */
  requestMessageId?: string;
  /** 当前需求过期时间，Unix 毫秒。 */
  expiresAtMs: number;
  /** 买方当前购买的安全进度摘要。 */
  purchase?: import("@keymaster/contracts").MsFileBitfsPurchaseSnapshot;
  /** 是否已从当前 Owner 的买方 journal 读取过上次购买摘要。 */
  purchaseHydrated: boolean;
}>();
/** 每个 Seed 的购买准入串行尾，避免两个同时到达的合格报价重复开池。 */
const msfileBitfsBuyerPurchaseTails = new Map<string, Promise<void>>();
/** 买方恢复任务所绑定的当前 Key 和 Worker 世代。 */

/** 最近速度样本对应卖家的速度视图。 */

/** 解锁期间正在执行的全量买方恢复；新购买必须等扫描完成。 */
let msfileBitfsBuyerRecoveryInFlight: {
  /** 当前已解锁 Key 的公钥。 */
  ownerPublicKeyHex: string;
  /** 当前 Worker 会话世代。 */
  sessionEpoch: SessionEpoch;
  /** 当前 Worker 运行世代。 */
  runGeneration: string;
  /** 当前 Key 买方会话的全量恢复任务。 */
  promise: Promise<void>;
} | undefined;
/** 最近一次完成全量恢复的 owner 与会话世代。 */
let msfileBitfsBuyerRecoveryReady: MsFileBitfsBuyerRecoveryScope | undefined;
/** 单个需求最多允许建立的卖家 WebRTC 会话数，防止报价洪泛。 */
const msfileBitfsBuyerOfferCounts = new Map<string, number>();
const MSFILE_BITFS_MAX_OFFERS_PER_DEMAND = 32;
const MSFILE_BITFS_MAX_ACTIVE_BUYER_LINKS = 128;

/** 已付款且通过 Kind 5/6 验证的速度记录；速度不作为付款或资金状态依据。 */

/** 收到 offer 后的买方 WebRTC DataChannel；报价需要继续逐条验签。 */
const msfileBitfsWebRtcBuyerLinks = new Map<string, {
  /** Window lane 内的 WebRTC 会话编号。 */
  transportSessionId: string;
  /** 已验证 Hash 请求的 message_id。 */
  requestMessageId: string;
  /** 已验签 offer 发送者公钥。 */
  peerPublicKeyHex: string;
  /** 当前买方 Key。 */
  ownerPublicKeyHex: string;
  /** 当前已验签 Hash 请求对应的 Seed Hash。 */
  seedHashHex: string;
  /** 买方会话编排任务。 */
  task: BitfsBuyerTask;
  /** 建立链接时的 owner 会话世代。 */
  ownerSessionEpoch: SessionEpoch;
  /** 首条 Kind 1 已持久化后的买方会话编号；重复报价不创建第二份记录。 */
  quoteSessionId?: string;
  /** 首条 Kind 1 的持久化与验签过程；后续 Artifact 必须等待它完成。 */
  quoteAccepted?: Promise<void>;
  /** 用户选择报价后绑定此 WebRTC stream 的买方协议端口。 */
  protocol?: BitfsBuyerProtocol;
  /** 新连接复用了这条已经开池的买方日志会话时设置。 */
  resumedPurchaseSessionId?: string;
}>();
/** 测试注入的卖方 bridge；生产为 undefined，使用 Window lane + 未就绪端口。 */
let testMsfileSellerBridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined;

function sellerKeepsVaultUnlocked(): boolean {
  return deps.session().vaultStatus === "unlocked"
    && deps.service()?.describeState().sellerSettings.sellerEnabled === true;
}

function msfileBitfsBuyerTaskKey(ownerPublicKeyHex: string, seedHashHex: string): string {
  return `${ownerPublicKeyHex.toLowerCase()}|${seedHashHex.toLowerCase()}`;
}

function msfileBitfsPurchasePhaseFromJournal(phase: string): import("@keymaster/contracts").MsFileBitfsPurchasePhase | undefined {
  if (phase === "quote-selected") return "opening";
  if (phase === "cancel-opening") return "cancelling-opening";
  if (phase === "opening-presign") return "opening";
  if (phase === "funding-prepared") return "funding";
  if (phase === "funding-unknown") return "funding-unknown";
  if (phase === "funded") return "requesting-seed";
  if (phase === "request-prepared" || phase === "delivery-verified") return "requesting-blocks";
  if (phase === "payment-unknown") return "payment-unknown";
  if (phase === "content-committing") return "content-committing";
  if (phase === "close-required") return "closing-pool";
  if (phase === "close-requested") return "closing-pool";
  if (phase === "close-unknown") return "close-unknown";
  if (phase === "cancel-closing-pool") return "cancelling-pool";
  if (phase === "cancel-close-unknown") return "cancel-unknown";
  if (phase === "cancelled") return "cancelled";
  if (phase === "refund-ready") return "refund-ready";
  if (phase === "refund-unknown") return "refund-unknown";
  if (phase === "refunded") return "refunded";
  if (phase === "completed" || phase === "failed") return phase;
  return undefined;
}

/**
 * Worker 重建买方任务时按旧 txid 对账、恢复付款后的幂等入库并读取摘要；
 * 只有双方完整 Kind 13 已持久化的关池交易会按原字节继续提交，不重新签名或恢复 DataChannel。
 */
async function restoreMsfileBitfsBuyerPurchaseSummary(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  /** 指定只恢复此会话；省略时取该 Seed 最近更新的一条资金会话。 */
  sessionId?: string;
  task?: BitfsBuyerTask;
}): Promise<import("@keymaster/contracts").MsFileBitfsPurchaseSnapshot | undefined> {
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const records = await sessions.list();
  const candidate = records
    .filter((record) => record.role === "buyer"
      && record.ownerPublicKeyHex === input.ownerPublicKeyHex
      && record.seedHashHex === input.seedHashHex
      && (input.sessionId === undefined || record.sessionId === input.sessionId)
      && (record.evidence.includes("kind2-opening-request")
        || record.evidence.includes("opening-configuration")
        || record.evidence.includes("funding-transaction")
        || record.phase === "cancel-opening"))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  if (!candidate) return undefined;
  let recoveryErrorMessage: string | undefined;
  if (candidate.phase === "cancel-opening" && input.task) {
    try {
      await input.task.cancelUnfundedOpening(candidate.sessionId);
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message.slice(0, 180) : "未开池资金占用恢复暂不可用";
    }
  }
  let fundingReconciled = false;
  let fundingReconcileFailed = false;
  if (candidate.phase === "funding-unknown" && input.task) {
    try {
      const result = await input.task.reconcileFunding(candidate.sessionId);
      fundingReconciled = result?.outcome.status === "confirmed";
      fundingReconcileFailed = result?.outcome.status === "failed";
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message.slice(0, 180) : "开池交易对账暂不可用";
    }
  }
  let closeReconciled = false;
  if (input.task && await sessions.getEvidence(candidate.sessionId, "kind13-close-response")) {
    try {
      const result = await input.task.resumePoolRecovery(candidate.sessionId);
      closeReconciled = result?.closed === true;
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message.slice(0, 180) : "关池交易对账暂不可用";
    }
  }
  let refundReconciled = false;
  let refundUnknown = false;
  let refundRecoveryMessage: string | undefined;
  const openingWasPrepared = candidate.evidence.includes("kind3-opening-response")
    && candidate.evidence.includes("funding-transaction");
  if (input.task && openingWasPrepared && !(await sessions.getEvidence(candidate.sessionId, "kind13-close-response"))) {
    try {
      const result = await input.task.recoverMaturedRefund(candidate.sessionId);
      refundReconciled = result?.refunded === true;
      refundUnknown = result !== undefined && !result.refunded;
    } catch (error) {
      // 链查询暂不可用时不阻塞任务摘要；账本和池内 UTXO 仍保持保护。
      refundRecoveryMessage = error instanceof Error ? error.message.slice(0, 180) : "链上退款对账暂不可用";
    }
  }
  if ((closeReconciled || refundReconciled) && candidate.evidence.includes("download-plan")) {
    try {
      await markMsfileBitfsDownloadPlanPoolClosed({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        seedHashHex: input.seedHashHex,
        sessionId: candidate.sessionId,
      });
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message.slice(0, 180) : "下载计划关池记录暂不可用";
    }
  }
  let restoredContentCommit = false;
  if (candidate.phase === "content-committing") {
    const contentStore = deps.files( "");
    try {
      restoredContentCommit = await recoverBitfsBuyerContentCommit({
        sessions,
        contentStore,
        sessionId: candidate.sessionId,
        nowMs: Date.now(),
        async onContentCommitted(seedHashHex) {
          if (deps.session().vaultStatus !== "unlocked"
            || deps.session().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex) {
            throw new Error("BitFS 入库恢复期间当前 Key 已变化");
          }
          const index = msfileSellerIndex;
          if (!index) return;
          const indexGeneration = index.currentGeneration();
          index.invalidate(seedHashHex);
          await index.refresh(contentStore, seedHashHex, indexGeneration);
        },
      });
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message.slice(0, 180) : "付款后的本地文件恢复暂不可用";
    }
  }
  const latestCandidate = await sessions.get(candidate.sessionId);
  if (!latestCandidate) throw new Error("BitFS 买方恢复期间会话记录消失");
  const phase = msfileBitfsPurchasePhaseFromJournal(latestCandidate.phase);
  if (!phase) return undefined;

  const maxBlockPriceBytes = await sessions.getEvidence(latestCandidate.sessionId, "file-price-limit");
  let currentMaxFullBlockPriceSatoshis: string | null = null;
  if (maxBlockPriceBytes) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(maxBlockPriceBytes);
    const normalized = normalizeMsFileSatoshiAmount(decoded);
    if (normalized === undefined) throw new Error("BitFS 买方本文件最高价证据损坏");
    currentMaxFullBlockPriceSatoshis = normalized;
  }

  let openingAmountSatoshis: string | null = null;
  const openingConfiguration = await sessions.getEvidence(latestCandidate.sessionId, "opening-configuration");
  if (openingConfiguration) {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(openingConfiguration)) as { openingAmountSatoshis?: unknown };
      if (typeof parsed.openingAmountSatoshis === "string" && /^(0|[1-9][0-9]*)$/u.test(parsed.openingAmountSatoshis)) {
        openingAmountSatoshis = parsed.openingAmountSatoshis;
      }
    } catch {
      throw new Error("BitFS 买方开池摘要损坏；为安全起见停止恢复购买页面");
    }
  }

  let verifiedBlockCount = 0;
  const prefix = `bitfs-staging/${latestCandidate.sessionId}/blocks/`;
  const contentStore = deps.files( "");
  let cursor: string | undefined;
  do {
    const page = await contentStore.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    verifiedBlockCount += page.files.filter((file) => /^bitfs-staging\/[0-9a-z][0-9a-z._-]{0,127}\/blocks\/[0-9a-f]{64}\.bin$/u.test(file.path)).length;
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  let wholeFileCancellationPending = false;
  if (latestCandidate.evidence.includes("download-plan")) {
    try {
      const downloadPlan = await openMsfileBitfsBuyerDownloadPlan(input.ownerPublicKeyHex, input.seedHashHex);
      const snapshot = await downloadPlan.snapshot();
      wholeFileCancellationPending = snapshot.stopRequested && snapshot.pools.some((pool) => !pool.closed);
    } catch {
      // 计划损坏时不覆盖原会话恢复摘要；后续买卖入口仍会因读取失败而拒绝继续付款。
    }
  }
  const message = wholeFileCancellationPending
    ? "整文件取消已保存；所有池已停止领取新内容，正在等待费用池逐一关闭或退款确认。"
    : restoredContentCommit
    ? "已从本地会话日志恢复付款后的入库步骤，文件已重新校验并完成保存。"
    : closeReconciled
      ? "已按原关池交易完成链上对账，费用池余款已回到当前 Key 的专款余额。"
    : refundReconciled
      ? "退款锁已到期；买方预签退款已被节点观察，余款已回到当前 Key 的专款余额。"
    : refundUnknown
      ? "退款锁已到期；原退款交易结果尚未确定，费用池资金继续受保护。"
    : refundRecoveryMessage
      ? `到期退款对账暂未完成，专款继续受保护：${refundRecoveryMessage}`
    : recoveryErrorMessage
      ? `本轮恢复暂未完成；专款仍受保护：${recoveryErrorMessage}`
    : fundingReconciled
      ? "已按原 txid 对账确认开池交易，并保存 Kind 4；卖家重新连接前不会自动恢复内容传输。"
    : fundingReconcileFailed
      ? "开池交易对账信息不完整；原资金占用仍保留，未创建新交易。"
    : phase === "completed"
      ? "已从本地会话日志读取到已完成的购买记录。"
    : phase === "cancelled"
      ? latestCandidate.evidence.includes("kind3-opening-response")
        ? "购买已取消；链上已确认关池，费用池余款已回收到当前 Key。"
        : "购买已取消；卖方尚未完成开池预签，未广播资金交易，资金占用已释放。"
    : phase === "content-committing"
      ? "链上付款已核对，但这条旧会话缺少入库恢复清单；本地暂存已保留，尚未标记文件完成。"
    : latestCandidate.phase === "close-required"
      ? "文件已保存，关池请求尚未准备完成；费用池继续受专款账本保护。"
    : latestCandidate.phase === "close-requested"
      ? "文件已保存，已发送 Kind 12；等待卖方返回 Kind 13 后广播关池交易。"
    : phase === "close-unknown"
      ? "关池交易结果尚未确定；费用池和预期找回输出仍受专款账本保护。"
    : phase === "cancel-unknown"
      ? "取消关池结果尚未确定；原交易和费用池资金仍受专款账本保护。"
    : phase === "cancelling-pool"
      ? "已保存取消意图；正在通过卖方连接协商关池并回收余款。"
    : phase === "failed"
      ? "已从本地会话日志读取到失败记录；相关资金状态仍需按 journal/outbox 核对。"
      : "已从本地会话日志恢复购买摘要；资金和签名证据仍保留，可在购买任务页重新连接卖家续接。";
  return {
    sessionId: latestCandidate.sessionId,
    phase: wholeFileCancellationPending ? "cancelling-pool" : phase,
    openingAmountSatoshis,
    currentMaxFullBlockPriceSatoshis,
    verifiedBlockCount,
    totalBlockCount: null,
    message,
  };
}

/** 费用池关池或退款已链上确认后，释放同 Seed 计划中的 Block 认领和并发名额。 */
async function markMsfileBitfsDownloadPlanPoolClosed(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  sessionId: string;
}): Promise<void> {
  const plan = await openMsfileBitfsBuyerDownloadPlan(input.ownerPublicKeyHex, input.seedHashHex);
  await plan.closePool(input.sessionId);
}

/** 从买方专用日志恢复同 Seed 的共享下载计划。 */
async function openMsfileBitfsBuyerDownloadPlan(ownerPublicKeyHex: string, seedHashHex: string) {
  const store = deps.files( "bitfs-journal");
  const object = await store.get(`download-plans/${seedHashHex.toLowerCase()}.json`);
  if (!object) throw new Error("已确认关池，但同 Seed 的下载计划记录缺失");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
  catch { throw new Error("BitFS 同 Seed 下载计划记录损坏"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("同 Seed 下载计划格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.fileSizeBytes !== "string" || typeof row.recommendedFilename !== "string") {
    throw new Error("同 Seed 下载计划缺少文件身份信息");
  }
  return createBitfsBuyerDownloadPlan({
    ownerPublicKeyHex,
    seedHashHex,
    fileSizeBytes: row.fileSizeBytes,
    recommendedFilename: row.recommendedFilename,
    store,
  });
}

/** 解锁后扫描当前 Key 的全部买方会话，先对账已保存交易，再允许新购买。 */
async function recoverAllMsfileBitfsBuyerSessions(ownerPublicKeyHex: string): Promise<void> {
  const owner = ownerPublicKeyHex.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex?.toLowerCase() !== owner) return;
  const sessionEpoch = deps.session().sessionEpoch;
  const runGeneration = deps.session().runGeneration;
  const assertCurrentOwner = (): void => {
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.session().sessionEpoch !== sessionEpoch
      || deps.session().runGeneration !== runGeneration) {
      throw new Error("BitFS 全量恢复期间当前 Key 或存储世代已变化");
    }
  };
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const records = (await sessions.list())
    .filter((record) => record.role === "buyer"
      && record.ownerPublicKeyHex === owner
      && (record.evidence.includes("kind2-opening-request")
        || record.evidence.includes("opening-configuration")
        || record.evidence.includes("funding-transaction")
        || record.phase === "cancel-opening")
      && !["completed", "cancelled", "refunded"].includes(record.phase))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const tasksBySeed = new Map<string, BitfsBuyerTask>();
  const failures: string[] = [];
  for (const record of records) {
    try {
      assertCurrentOwner();
      let task = tasksBySeed.get(record.seedHashHex);
      if (!task) {
        task = await createMsfileBitfsBuyerTask({
          ownerPublicKeyHex: owner,
          seedHashHex: record.seedHashHex,
          network: deps.network(),
        });
        tasksBySeed.set(record.seedHashHex, task);
      }
      // 指定精确 session ID，确保同一 Seed 下较旧但仍有资金责任的会话也会恢复。
      const summary = await restoreMsfileBitfsBuyerPurchaseSummary({
        ownerPublicKeyHex: owner,
        seedHashHex: record.seedHashHex,
        sessionId: record.sessionId,
        task,
      });
      if (summary?.message?.startsWith("本轮恢复暂未完成；")
        || summary?.message?.startsWith("到期退款对账暂未完成，")) {
        failures.push(record.sessionId);
      }
    } catch (error) {
      // 单条记录恢复失败时保留原账本和 exact bytes，继续处理其它池；后续任务页仍可重试。
      if (!failures.includes(record.sessionId)) failures.push(record.sessionId);
      console.warn("[msfile] BitFS buyer session recovery deferred", {
        sessionId: record.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(`有 ${failures.length} 条买方会话未完成链上或本地恢复；会话仍保留资金保护`);
  }
}

/** 等待当前 owner 的解锁恢复完成；恢复失败会阻止创建新的买方资金会话。 */
async function ensureMsfileBitfsBuyerRecovery(ownerPublicKeyHex: string): Promise<void> {
  const owner = ownerPublicKeyHex.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex?.toLowerCase() !== owner) {
    throw new Error("BitFS 全量恢复需要当前已解锁 Key");
  }
  const sessionEpoch = deps.session().sessionEpoch;
  const runGeneration = deps.session().runGeneration;
  const tokenMatches = (token: MsFileBitfsBuyerRecoveryScope | undefined): boolean =>
    token?.ownerPublicKeyHex === owner && token.sessionEpoch === sessionEpoch && token.runGeneration === runGeneration;
  if (tokenMatches(msfileBitfsBuyerRecoveryReady)) return;
  let recovery = msfileBitfsBuyerRecoveryInFlight;
  if (!tokenMatches(recovery)) {
    const promise = recoverAllMsfileBitfsBuyerSessions(owner);
    recovery = { ownerPublicKeyHex: owner, sessionEpoch, runGeneration, promise };
    msfileBitfsBuyerRecoveryInFlight = recovery;
  }
  if (!recovery) throw new Error("BitFS 全量恢复任务没有成功启动");
  try {
    await recovery.promise;
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.session().sessionEpoch !== sessionEpoch
      || deps.session().runGeneration !== runGeneration) {
      throw new Error("BitFS 全量恢复期间当前 Key 或存储世代已变化");
    }
    msfileBitfsBuyerRecoveryReady = { ownerPublicKeyHex: owner, sessionEpoch, runGeneration };
  } catch (error) {
    throw new Error(`BitFS 买方会话恢复未完成，已阻止新购买：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (msfileBitfsBuyerRecoveryInFlight === recovery) msfileBitfsBuyerRecoveryInFlight = undefined;
  }
}

/** 从本地会话日志读取有效速度样本；损坏样本按“未知速度”处理。 */
function parseMsFileBitfsSellerSpeedSample(bytes: Uint8Array): MsFileBitfsSellerSpeedSample | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.effectiveBlockBytes !== "number" || !Number.isSafeInteger(row.effectiveBlockBytes) || row.effectiveBlockBytes <= 0
    || typeof row.elapsedMs !== "number" || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs <= 0
    || typeof row.recordedAtMs !== "number" || !Number.isSafeInteger(row.recordedAtMs) || row.recordedAtMs < 0) return undefined;
  return {
    effectiveBlockBytes: row.effectiveBlockBytes as number,
    elapsedMs: row.elapsedMs as number,
    recordedAtMs: row.recordedAtMs as number,
  };
}

/** 保存与已验收交付和已观察付款绑定的卖家速度样本。 */
async function persistMsfileBitfsSellerSpeedSample(input: {
  /** 当前买方会话编号。 */
  sessionId: string;
  /** 已验收 Kind 5 对应的付款授权编号。 */
  authorizationIdHex: string;
  /** 本次已验收文件 Block 的有效字节数，不含 Seed。 */
  effectiveBlockBytes: number;
  /** 从发出 Kind 5 到验收 Kind 6 的耗时毫秒数。 */
  elapsedMs: number;
}): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(input.authorizationIdHex)
    || !Number.isSafeInteger(input.effectiveBlockBytes) || input.effectiveBlockBytes <= 0
    || !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs <= 0) return;
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const session = await sessions.get(input.sessionId);
  const requestName = `kind5-content-request-${input.authorizationIdHex}`;
  const deliveryName = `kind6-content-delivery-${input.authorizationIdHex}`;
  const paymentName = `kind7-payment-update-${input.authorizationIdHex}`;
  if (!session || session.role !== "buyer"
    || !session.evidence.includes(requestName as import("@keymaster/plugin-msfile/coordinator").BitfsEvidenceName)
    || !session.evidence.includes(deliveryName as import("@keymaster/plugin-msfile/coordinator").BitfsEvidenceName)
    || !session.evidence.includes(paymentName as import("@keymaster/plugin-msfile/coordinator").BitfsEvidenceName)) {
    throw new Error("BitFS 速度样本缺少已验收交付或买方付款证据");
  }
  const evidenceName = `seller-speed-sample-${input.authorizationIdHex}` as const;
  if (await sessions.getEvidence(session.sessionId, evidenceName)) return;
  const sample: MsFileBitfsSellerSpeedSample = {
    effectiveBlockBytes: input.effectiveBlockBytes,
    elapsedMs: input.elapsedMs,
    recordedAtMs: Date.now(),
  };
  await sessions.putEvidence(session.sessionId, session.revision, evidenceName, new TextEncoder().encode(JSON.stringify(sample)), Date.now());
}

/** 给有效报价附上同一 Key + Seed + 卖家的最近一次已付款传输速度。 */
async function addMsfileBitfsRecentSellerSpeeds(
  ownerPublicKeyHex: string,
  seedHashHex: string,
  quotes: readonly BitfsBuyerQuoteView[],
): Promise<import("@keymaster/contracts").MsFileBitfsQuoteView[]> {
  if (quotes.length === 0) return [];
  const owner = ownerPublicKeyHex.toLowerCase();
  const seed = seedHashHex.toLowerCase();
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const records = await sessions.list();
  const latestBySeller = new Map<string, MsFileBitfsRecentSellerSpeed>();
  for (const record of records) {
    if (record.role !== "buyer" || record.ownerPublicKeyHex !== owner || record.seedHashHex !== seed) continue;
    for (const name of record.evidence.filter((item) => item.startsWith("seller-speed-sample-"))) {
      const bytes = await sessions.getEvidence(record.sessionId, name);
      if (!bytes) continue;
      const sample = parseMsFileBitfsSellerSpeedSample(bytes);
      if (!sample) continue;
      const prior = latestBySeller.get(record.counterpartyPublicKeyHex);
      if (prior && prior.recordedAtMs >= sample.recordedAtMs) continue;
      latestBySeller.set(record.counterpartyPublicKeyHex, {
        recordedAtMs: sample.recordedAtMs,
        bytesPerSecond: (BigInt(sample.effectiveBlockBytes) * 1_000n / BigInt(sample.elapsedMs)).toString(10),
      });
    }
  }
  return quotes.map((quote) => ({
    ...quote,
    recentBytesPerSecond: latestBySeller.get(quote.sellerPublicKeyHex)?.bytesPerSecond ?? null,
  }));
}

/** 从持久 journal 与专款账本重建 `/msfile/storage` 的未完成购买任务列表。 */
async function listMsfileBitfsBuyerTaskSnapshots(): Promise<import("@keymaster/contracts").MsFileBitfsTaskSnapshot[]> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("Vault 已锁定，不能读取 BitFS 购买任务");
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const runtime = await deps.ensureService();
  const buyerSettings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  const records = (await sessions.list()).filter((record) => record.role === "buyer"
    && record.ownerPublicKeyHex === owner
    && (record.evidence.includes("kind2-opening-request")
      || record.evidence.includes("opening-configuration")
      || record.evidence.includes("funding-transaction")
      || record.phase === "cancel-opening")
    && record.phase !== "completed" && record.phase !== "cancelled" && record.phase !== "refunded");
  const ledger = currentMsfileBitfsFundingLedger();
  const contentStore = deps.files( "");
  const snapshots: import("@keymaster/contracts").MsFileBitfsTaskSnapshot[] = [];
  for (const record of records) {
    let session = await sessions.get(record.sessionId);
    if (!session) continue;
    if (session.phase === "cancel-opening") {
      const { task } = await ensureMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: session.seedHashHex });
      await task.cancelUnfundedOpening(session.sessionId);
      session = await sessions.get(session.sessionId);
      if (!session) continue;
    }
    const phase = msfileBitfsPurchasePhaseFromJournal(session.phase);
    if (!phase) continue;
    let quote: {
      recommendedFilename: string | null;
      fileSizeBytes: string | null;
      fullBlockPriceSatoshis: string | null;
    } = { recommendedFilename: null, fileSizeBytes: null, fullBlockPriceSatoshis: null };
    const quoteBytes = await sessions.getEvidence(session.sessionId, "quote-summary");
    if (quoteBytes) {
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(quoteBytes)) as Record<string, unknown>;
        if (typeof parsed.recommendedFilename === "string"
          && typeof parsed.fileSizeBytes === "string" && /^(0|[1-9][0-9]*)$/u.test(parsed.fileSizeBytes)
          && typeof parsed.fullBlockPriceSatoshis === "string" && /^(0|[1-9][0-9]*)$/u.test(parsed.fullBlockPriceSatoshis)) {
          quote = {
            recommendedFilename: parsed.recommendedFilename.slice(0, 512),
            fileSizeBytes: parsed.fileSizeBytes,
            fullBlockPriceSatoshis: parsed.fullBlockPriceSatoshis,
          };
        }
      } catch {
        throw new Error("BitFS 任务报价摘要损坏；为安全起见停止展示其价格");
      }
    }
    let openingAmountSatoshis: string | null = null;
    const configuration = await sessions.getEvidence(session.sessionId, "opening-configuration");
    if (configuration) {
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configuration)) as { openingAmountSatoshis?: unknown };
        if (typeof parsed.openingAmountSatoshis === "string" && /^(0|[1-9][0-9]*)$/u.test(parsed.openingAmountSatoshis)) {
          openingAmountSatoshis = parsed.openingAmountSatoshis;
        }
      } catch {
        throw new Error("BitFS 任务开池金额摘要损坏");
      }
    }
    const maxBlockPriceBytes = await sessions.getEvidence(session.sessionId, "file-price-limit");
    const evidencePriceLimit = maxBlockPriceBytes
      ? normalizeMsFileSatoshiAmount(new TextDecoder("utf-8", { fatal: true }).decode(maxBlockPriceBytes))
      : null;
    if (maxBlockPriceBytes && evidencePriceLimit === undefined) {
      throw new Error("BitFS 任务本文件最高价证据损坏");
    }
    const currentMaxFullBlockPriceSatoshis = evidencePriceLimit ?? buyerSettings.filePriceLimitsBySeedHash?.[session.seedHashHex] ?? null;

    let verifiedBlockCount = 0;
    let verifiedBlockBytes = 0n;
    let verifiedBlockBytesKnown = true;
    const stagingPrefix = `bitfs-staging/${session.sessionId}/blocks/`;
    let cursor: string | undefined;
    do {
      const page = await contentStore.list({ prefix: stagingPrefix, limit: 1_000, ...(cursor === undefined ? {} : { cursor }) });
      for (const file of page.files) {
        if (!/^bitfs-staging\/[0-9a-z][0-9a-z._-]{0,127}\/blocks\/[0-9a-f]{64}\.bin$/u.test(file.path)) continue;
        verifiedBlockCount += 1;
        if (Number.isSafeInteger(file.size) && (file.size ?? -1) >= 0) {
          verifiedBlockBytes += BigInt(file.size!);
        } else {
          const object = await contentStore.get(file.path);
          if (object) verifiedBlockBytes += BigInt(object.bytes.byteLength);
          else verifiedBlockBytesKnown = false;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: session.seedHashHex, network: deps.network(), nowMs: Date.now() });
    const pool = account.pools.find((item) => item.poolId === session.sessionId);
    const dedicatedByOutpoint = new Map(account.utxos.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]));
    let lockedSatoshis = 0n;
    let pendingReturnSatoshis = 0n;
    if (pool && pool.state !== "closed") {
      const opening = dedicatedByOutpoint.get(pool.openingOutpoint);
      if (opening && (opening.state === "pool-occupied" || opening.state === "recovery-pending")) {
        lockedSatoshis = BigInt(opening.valueSatoshis);
      }
    }
    if (pool?.state === "recovery-pending" && pool.recoveryTxid) {
      pendingReturnSatoshis = account.utxos
        .filter((utxo) => utxo.poolId === session.sessionId && utxo.spendingTxid === pool.recoveryTxid
          && utxo.state === "recovery-pending" && `${utxo.txid}:${utxo.vout}` !== pool.openingOutpoint)
        .reduce((sum, utxo) => sum + BigInt(utxo.valueSatoshis), 0n);
    }

    let paidSatoshis = 0n;
    let poolStateFeeSatoshis = 0n;
    const openingRawKind2 = await sessions.getEvidence(session.sessionId, "kind2-opening-request");
    const openingRawKind3 = await sessions.getEvidence(session.sessionId, "kind3-opening-response");
    const fundingRaw = await sessions.getEvidence(session.sessionId, "funding-transaction");
    if (openingRawKind2 && openingRawKind3 && fundingRaw) {
      const completedOpening = await completeBuyerOpening({ rawKind2: openingRawKind2, rawKind3: new Uint8Array(), fundingTransactionRaw: fundingRaw }, openingRawKind3);
      const localState = await readBitfsBuyerLocalPaymentState({
        sessions,
        session,
        completedOpening: completedOpening.pool,
        includeLegacyPaymentEvidence: true,
      });
      const closeRaw = await sessions.getEvidence(session.sessionId, "close-transaction");
      const bindingRaw = await sessions.getEvidence(session.sessionId, "kind12-close-binding");
      if (bindingRaw) {
        const binding = parseBitfsBuyerCloseBinding(bindingRaw);
        if (binding.paymentSequence !== localState.paymentSequence
          || binding.sellerAmountSatoshis !== localState.sellerAmountSatoshis.toString(10)
          || binding.authorizationIdHex !== (localState.authorizationIdHex ?? null)) {
          throw new Error("BitFS 任务关池绑定与当前付款状态不一致");
        }
      }
      if (closeRaw) {
        await verifyBuyerCompletedClose({ pool: localState.pool, closeRaw });
        if (bindingRaw) {
          const binding = parseBitfsBuyerCloseBinding(bindingRaw);
          await assertBitfsBuyerCloseBinding({
            pool: localState.pool,
            closeTransactionRaw: closeRaw,
            paymentSequence: binding.paymentSequence,
            sellerAmountSatoshis: BigInt(binding.sellerAmountSatoshis),
          });
        }
        const state = await parsePaymentState(closeRaw, completedOpening.pool.opening);
        paidSatoshis = state.sellerAmountSatoshis;
        const distributed = state.buyerAmountSatoshis + state.sellerAmountSatoshis + state.arbiterAmountSatoshis;
        poolStateFeeSatoshis = state.poolOutputSatoshis > distributed ? state.poolOutputSatoshis - distributed : 0n;
      } else if (localState.source !== "initial") {
        paidSatoshis = localState.sellerAmountSatoshis;
      }
    }

    let fundingFeeSatoshis = 0n;
    const fundingPlan = account.transactions.find((item) => item.purpose === "opening" && item.poolId === session.sessionId);
    if (fundingPlan) {
      const inputValue = fundingPlan.inputOutpoints.reduce((sum, outpoint) => sum + BigInt(dedicatedByOutpoint.get(outpoint)?.valueSatoshis ?? "0"), 0n);
      const outputValue = fundingPlan.expectedOutputs.reduce((sum, output) => sum + BigInt(output.valueSatoshis), 0n);
      if (inputValue >= outputValue) fundingFeeSatoshis = inputValue - outputValue;
    }
    const totalBlockCount = quote.fileSizeBytes === null
      ? null
      : Number((BigInt(quote.fileSizeBytes) + 262_143n) / 262_144n);
    const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, session.seedHashHex));
    let availableQuotes: import("@keymaster/contracts").MsFileBitfsQuoteView[] = [];
    if (taskEntry?.ownerSessionEpoch === deps.session().sessionEpoch && taskEntry.requestMessageId
      && taskEntry.expiresAtMs > Date.now()) {
      availableQuotes = await addMsfileBitfsRecentSellerSpeeds(
        owner,
        session.seedHashHex,
        await (await taskEntry.taskPromise).listDiscoveredQuotes(),
      );
    }
    const activeLink = [...msfileBitfsWebRtcBuyerLinks.values()].some((link) =>
      link.ownerPublicKeyHex.toLowerCase() === owner
        && link.ownerSessionEpoch === deps.session().sessionEpoch
        && (link.quoteSessionId === session.sessionId
          || link.resumedPurchaseSessionId === session.sessionId
          || (link.seedHashHex === session.seedHashHex
            && link.peerPublicKeyHex === session.counterpartyPublicKeyHex
            && link.requestMessageId === taskEntry?.requestMessageId)));
    const canReconnect = session.evidence.includes("kind2-opening-request")
      && !activeLink
      && ["opening-presign", "funding-prepared", "funding-unknown", "funded", "request-prepared", "delivery-verified",
        "payment-unknown", "content-committing", "close-required", "close-requested", "close-unknown",
        "cancel-closing-pool", "cancel-close-unknown"].includes(session.phase);
    const pendingPaymentSignature = session.pendingAuthorizationId
      ? Boolean(await sessions.getEvidence(session.sessionId, `kind7-payment-signature-${session.pendingAuthorizationId}`)
        || await sessions.getEvidence(session.sessionId, `kind7-payment-sign-digest-${session.pendingAuthorizationId}`))
      : false;
    const cancelBeforePool = (session.phase === "quote-selected" || session.phase === "opening-presign" || session.phase === "funding-prepared" || session.phase === "cancel-opening")
      && !session.evidence.includes("kind3-opening-response")
      && !session.evidence.includes("kind4-funding-delivery");
    const cancelPool = (session.phase === "funded" || session.phase === "request-prepared"
      || session.phase === "cancel-closing-pool" || session.phase === "cancel-close-unknown")
      && activeLink && !pendingPaymentSignature;
    const statusMessage = session.phase === "refund-ready" || session.phase === "refund-unknown"
      ? "退款锁已到期，买方资金仍在按原交易对账。"
      : session.phase === "cancel-closing-pool" || session.phase === "cancel-close-unknown"
        ? "正在通过已保存的关池证据回收费用池余款。"
        : session.phase.startsWith("close-")
          ? "文件已入库；关池交易尚未确认，池内资金仍受保护。"
          : session.phase === "failed"
            ? "购买流程已失败；资金仍按专款账本保护。"
            : "购买任务已从本地日志恢复；刷新或关闭页面不会删除资金恢复记录。";
    snapshots.push({
      sessionId: session.sessionId,
      seedHashHex: session.seedHashHex,
      phase,
      sellerPublicKeyHex: session.counterpartyPublicKeyHex,
      recommendedFilename: quote.recommendedFilename,
      fileSizeBytes: quote.fileSizeBytes,
      fullBlockPriceSatoshis: quote.fullBlockPriceSatoshis,
      openingAmountSatoshis,
      currentMaxFullBlockPriceSatoshis,
      verifiedBlockCount,
      verifiedBytes: verifiedBlockBytesKnown ? verifiedBlockBytes.toString(10) : null,
      totalBlockCount,
      paidSatoshis: paidSatoshis.toString(10),
      minerFeeSatoshis: (fundingFeeSatoshis + poolStateFeeSatoshis).toString(10),
      lockedSatoshis: lockedSatoshis.toString(10),
      pendingReturnSatoshis: pendingReturnSatoshis.toString(10),
      discoveryOnly: false,
      availableQuotes,
      canCancel: cancelBeforePool || cancelPool,
      canReconnect,
      message: canReconnect
        ? "卖家连接已断开；原费用池仍受保护，可重新发布需求续接该会话。"
        : statusMessage,
    });
  }

  const purchaseSeeds = new Set(snapshots.map((item) => item.seedHashHex));
  for (const [taskKey, entry] of msfileBitfsBuyerTasks) {
    if (entry.ownerPublicKeyHex !== owner || entry.ownerSessionEpoch !== deps.session().sessionEpoch
      || !entry.requestMessageId || entry.expiresAtMs <= Date.now() || purchaseSeeds.has(entry.seedHashHex)) continue;
    const task = await entry.taskPromise;
    const availableQuotes = await addMsfileBitfsRecentSellerSpeeds(
      owner,
      entry.seedHashHex,
      await task.listDiscoveredQuotes(),
    );
    const purchase = entry.purchase;
    const selectedQuote = purchase
      ? availableQuotes.find((item) => item.sessionId === purchase.sessionId)
      : undefined;
    const quote = selectedQuote ?? availableQuotes[0];
    const taskId = purchase?.sessionId ?? quote?.sessionId ?? `demand-${entry.seedHashHex}`;
    const activePurchase = purchase && !["completed", "cancelled", "refunded", "failed", "connection-closed"].includes(purchase.phase);
    const purchaseSession = activePurchase && purchase ? await sessions.get(purchase.sessionId) : undefined;
    const purchaseLinkActive = activePurchase && purchase
      ? [...msfileBitfsWebRtcBuyerLinks.values()].some((link) => link.quoteSessionId === purchase.sessionId
        && link.ownerPublicKeyHex.toLowerCase() === owner
        && link.ownerSessionEpoch === deps.session().sessionEpoch)
      : false;
    const cancellableBeforeFunding = Boolean(purchaseSession
      && ["quote-selected", "opening-presign", "funding-prepared", "cancel-opening"].includes(purchaseSession.phase)
      && !purchaseSession.evidence.includes("kind3-opening-response")
      && !purchaseSession.evidence.includes("kind4-funding-delivery"));
    snapshots.push({
      sessionId: taskId,
      seedHashHex: entry.seedHashHex,
      phase: activePurchase && purchase ? purchase.phase : "discovering",
      openingAmountSatoshis: activePurchase && purchase ? purchase.openingAmountSatoshis : null,
      currentMaxFullBlockPriceSatoshis: activePurchase && purchase
        ? purchase.currentMaxFullBlockPriceSatoshis ?? buyerSettings.filePriceLimitsBySeedHash?.[entry.seedHashHex] ?? null
        : buyerSettings.filePriceLimitsBySeedHash?.[entry.seedHashHex] ?? null,
      verifiedBlockCount: activePurchase && purchase ? purchase.verifiedBlockCount : 0,
      verifiedBytes: activePurchase && purchase ? purchase.verifiedBytes ?? "0" : "0",
      totalBlockCount: activePurchase && purchase ? purchase.totalBlockCount : null,
      sellerPublicKeyHex: quote?.sellerPublicKeyHex ?? null,
      recommendedFilename: quote?.recommendedFilename ?? null,
      fileSizeBytes: quote?.fileSizeBytes ?? null,
      fullBlockPriceSatoshis: quote?.fullBlockPriceSatoshis ?? null,
      paidSatoshis: "0",
      minerFeeSatoshis: "0",
      lockedSatoshis: "0",
      pendingReturnSatoshis: "0",
      discoveryOnly: !activePurchase,
      availableQuotes,
      canCancel: activePurchase ? cancellableBeforeFunding : true,
      message: activePurchase && purchase
        ? purchase.message
        : availableQuotes.length === 0
          ? "正在等待卖家报价；发布需求不会拆分或广播资金。"
          : "已收到已验签报价；设置本文件最高单块价后可选择卖家开始下载。",
    });
    purchaseSeeds.add(entry.seedHashHex);
  }
  return snapshots.sort((left, right) => left.seedHashHex.localeCompare(right.seedHashHex));
}

/** 获取或创建当前 Owner + Seed 唯一买方任务。 */
async function ensureMsfileBitfsBuyerTask(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
}): Promise<{
  task: BitfsBuyerTask;
  entry: NonNullable<ReturnType<typeof msfileBitfsBuyerTasks.get>>;
}> {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const seed = input.seedHashHex.toLowerCase();
  const key = msfileBitfsBuyerTaskKey(owner, seed);
  const sessionEpoch = deps.session().sessionEpoch;
  const runGeneration = deps.session().runGeneration;
  const existing = msfileBitfsBuyerTasks.get(key);
  if (existing && existing.ownerSessionEpoch === sessionEpoch) {
    try {
      const task = await existing.taskPromise;
      if (!existing.purchaseHydrated) {
        const restored = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: seed, task });
        existing.purchase = restored ?? existing.purchase;
        existing.purchaseHydrated = true;
      }
      if (deps.session().sessionEpoch !== sessionEpoch || deps.session().runGeneration !== runGeneration
        || deps.session().activePublicKeyHex?.toLowerCase() !== owner || deps.session().vaultStatus !== "unlocked") {
        throw new Error("BitFS 买方恢复摘要期间 Key 或会话世代已变化");
      }
      return { task, entry: existing };
    } catch (error) {
      if (msfileBitfsBuyerTasks.get(key) === existing) msfileBitfsBuyerTasks.delete(key);
      throw error;
    }
  }
  const entry: NonNullable<ReturnType<typeof msfileBitfsBuyerTasks.get>> = {
    ownerPublicKeyHex: owner,
    seedHashHex: seed,
    ownerSessionEpoch: sessionEpoch,
    taskPromise: Promise.resolve(undefined as unknown as BitfsBuyerTask),
    expiresAtMs: 0,
    purchaseHydrated: false,
  };
  entry.taskPromise = createMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: seed, network: deps.network() });
  msfileBitfsBuyerTasks.set(key, entry);
  while (msfileBitfsBuyerTasks.size > 256) {
    const oldestKey = msfileBitfsBuyerTasks.keys().next().value as string | undefined;
    if (oldestKey === undefined || oldestKey === key) break;
    msfileBitfsBuyerTasks.delete(oldestKey);
  }
  try {
    const task = await entry.taskPromise;
    if (deps.session().sessionEpoch !== sessionEpoch || deps.session().runGeneration !== runGeneration
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner || deps.session().vaultStatus !== "unlocked") {
      throw new Error("BitFS 需求任务的 Key 或会话世代已变化");
    }
    entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: seed, task }) ?? entry.purchase;
    entry.purchaseHydrated = true;
    if (deps.session().sessionEpoch !== sessionEpoch || deps.session().runGeneration !== runGeneration
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner || deps.session().vaultStatus !== "unlocked") {
      throw new Error("BitFS 买方恢复摘要期间 Key 或会话世代已变化");
    }
    return { task, entry };
  } catch (error) {
    if (msfileBitfsBuyerTasks.get(key) === entry) msfileBitfsBuyerTasks.delete(key);
    throw error;
  }
}

/** 返回不会暴露 wire、私钥或交易证据的需求与报价视图。 */
async function msfileBitfsBuyerDemandSnapshot(
  seedHashHex: string,
  entry?: NonNullable<ReturnType<typeof msfileBitfsBuyerTasks.get>>,
  task?: BitfsBuyerTask,
): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const normalizedSeed = seedHashHex.toLowerCase();
  const runtime = await deps.ensureService();
  const buyerSettings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  const savedPriceLimit = buyerSettings.filePriceLimitsBySeedHash?.[normalizedSeed] ?? null;
  if (!entry || !task) {
    return { seedHashHex: normalizedSeed, requestMessageId: null, expiresAtMs: null, quotes: [], currentMaxFullBlockPriceSatoshis: savedPriceLimit };
  }
  return {
    seedHashHex: normalizedSeed,
    requestMessageId: entry.requestMessageId ?? null,
    expiresAtMs: entry.expiresAtMs > 0 ? entry.expiresAtMs : null,
    quotes: await addMsfileBitfsRecentSellerSpeeds(
      entry.ownerPublicKeyHex,
      normalizedSeed,
      await task.listDiscoveredQuotes(),
    ),
    purchase: entry.purchase ?? null,
    currentMaxFullBlockPriceSatoshis: savedPriceLimit,
  };
}

/** 为已经验签报价的 DataChannel 装配买方 SDK 协议端口。 */
async function ensureMsfileBitfsBuyerProtocol(
  webrtcSessionId: string,
  link: NonNullable<ReturnType<typeof msfileBitfsWebRtcBuyerLinks.get>>,
): Promise<BitfsBuyerProtocol> {
  if (link.protocol) return link.protocol;
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked" || link.ownerSessionEpoch !== deps.session().sessionEpoch) {
    throw new Error("BitFS 买方 Key 已锁定或会话已切换");
  }
  const woc = deps.woc();
  if (!woc) throw new Error("BitFS 买方需要可用的 WoC 链上事实服务");
  const sessionEpoch = deps.session().sessionEpoch;
  const runGeneration = deps.session().runGeneration;
  const assertCurrentContext = (): void => {
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.session().sessionEpoch !== sessionEpoch
      || deps.session().runGeneration !== runGeneration
      || msfileBitfsWebRtcBuyerLinks.get(webrtcSessionId) !== link) {
      throw new Error("BitFS 买方购买期间 Key、存储或 DataChannel 已变化");
    }
  };
  const settings = await deps.p2pkhSettings();
  const feeRate = settings.feeRateSatoshisPerKb.medium;
  if (!Number.isSafeInteger(feeRate) || feeRate < 1) throw new Error("BitFS 池内手续费率配置无效");
  const cryptoPort = await deps.crypto(owner);
  assertCurrentContext();
  const journalStore = deps.files( "bitfs-journal");
  const contentStore = deps.files( "");
  const quoteSessionId = link.quoteSessionId;
  if (!quoteSessionId) throw new Error("BitFS 下载计划需要先持久化已验签报价");
  const quoteViews = (await link.task.listDiscoveredQuotes()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const quoteView = quoteViews.find((item) => item.sessionId === quoteSessionId);
  const canonicalQuote = quoteViews[0];
  if (!quoteView || !canonicalQuote || quoteViews.some((item) => item.fileSizeBytes !== canonicalQuote.fileSizeBytes)) {
    throw new Error("BitFS 同 Seed 报价缺少统一文件大小，不能创建共享下载计划");
  }
  const runtime = await deps.ensureService();
  const buyerSettings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  const downloadPlan = createBitfsBuyerDownloadPlan({
    ownerPublicKeyHex: owner,
    seedHashHex: link.seedHashHex,
    fileSizeBytes: canonicalQuote.fileSizeBytes,
    recommendedFilename: canonicalQuote.recommendedFilename,
    store: journalStore,
  });
  const vaultSigner = createBitfsVaultSigner(cryptoPort);
  const signer = {
    publicKey: () => vaultSigner.publicKey(),
    async sign(request: Parameters<typeof vaultSigner.sign>[0], signal?: AbortSignal): Promise<Uint8Array> {
      try {
        return await vaultSigner.sign(request, signal);
      } catch (error) {
        await writeBitfsE2eDiagnostic("buyer-signer-error.json", {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
  };
  const protocol = new BitfsBuyerProtocol({
    task: link.task,
    sessions: createBitfsSessionJournal(journalStore),
    signer,
    contentStore,
    downloadPlan,
    selectionPriority: buyerSettings.sellerSelectionPriority,
    blocksPerBatch: buyerSettings.blocksPerBatch,
    onDownloadPlanChanged() {
      setTimeout(() => {
        for (const [candidateSessionId, candidateLink] of msfileBitfsWebRtcBuyerLinks) {
          if (candidateLink.ownerPublicKeyHex.toLowerCase() !== owner
            || candidateLink.seedHashHex.toLowerCase() !== link.seedHashHex.toLowerCase()
            || candidateLink.ownerSessionEpoch !== sessionEpoch
            || !candidateLink.protocol || !candidateLink.quoteSessionId) continue;
          void candidateLink.protocol.continueSharedDownload({
            sessionId: candidateLink.quoteSessionId,
            stream: createMsfileBitfsBuyerStream(candidateSessionId, candidateLink),
          }).catch(() => undefined);
        }
        void maybeStartMsfileBitfsNextSeller({ ownerPublicKeyHex: owner, seedHashHex: link.seedHashHex, task: link.task }).catch(() => undefined);
      }, 0);
    },
    blockHeight: () => deps.blockHeight(deps.network()),
    nowMs: () => Date.now(),
     minerFeeRateSatoshisPerKilobyte: BigInt(feeRate),
     assertCurrentContext,
     onSignerError: (error) => writeBitfsE2eDiagnostic("buyer-signer-error.json", {
       message: error instanceof Error ? error.message : String(error),
       name: error instanceof Error ? error.name : typeof error,
       stack: error instanceof Error ? error.stack : undefined,
     }),
    async onContentCommitted(seedHashHex) {
      const index = msfileSellerIndex;
      if (!index) return;
      const indexGeneration = index.currentGeneration();
      index.invalidate(seedHashHex);
      await index.refresh(contentStore, seedHashHex, indexGeneration);
    },
    onVerifiedDelivery: persistMsfileBitfsSellerSpeedSample,
    onProgress(progress) {
      void writeBitfsE2eDiagnostic("buyer-purchase-progress.json", progress);
      const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, link.seedHashHex));
      if (!taskEntry || taskEntry.ownerSessionEpoch !== sessionEpoch) return;
      taskEntry.purchase = {
        sessionId: progress.sessionId,
        phase: progress.phase,
        openingAmountSatoshis: progress.openingAmountSatoshis,
        ...(taskEntry.purchase?.sessionId === progress.sessionId && taskEntry.purchase.currentMaxFullBlockPriceSatoshis !== undefined
          ? { currentMaxFullBlockPriceSatoshis: taskEntry.purchase.currentMaxFullBlockPriceSatoshis }
          : {}),
        verifiedBlockCount: progress.verifiedBlockCount,
        totalBlockCount: progress.totalBlockCount,
        message: progress.message,
      };
    },
  });
  link.protocol = protocol;
  return protocol;
}

/** 同一 Seed 的手动/自动购买共用准入锁；双击或同时到达报价只会进入一次开池。 */
async function startMsfileBitfsBuyerPurchase(input: {
  seedHashHex: string;
  sessionId: string;
  maxFullBlockPriceSatoshis?: string;
  /** 只由用户手动购买入口设置；自动补池不得解除整文件取消标记。 */
  resumeCancelledPlan?: boolean;
}): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key 再购买 BitFS 文件");
  const lockKey = msfileBitfsBuyerTaskKey(owner, input.seedHashHex);
  const previous = msfileBitfsBuyerPurchaseTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  msfileBitfsBuyerPurchaseTails.set(lockKey, current);
  await previous;
  try {
    const result = await startMsfileBitfsBuyerPurchaseNow(input);
    await writeBitfsE2eDiagnostic("buyer-purchase-return.json", {
      seedHashHex: input.seedHashHex,
      sessionId: input.sessionId,
      purchase: result.purchase
    });
    return result;
  } catch (error) {
    const owner = deps.session().activePublicKeyHex?.toLowerCase();
    const sessions = owner
      ? await createBitfsSessionJournal(deps.files( "bitfs-journal")).list().catch(() => [])
      : [];
    await writeBitfsE2eDiagnostic("buyer-purchase-error.json", {
       seedHashHex: input.seedHashHex,
       sessionId: input.sessionId,
       message: error instanceof Error ? error.message : String(error),
       stack: error instanceof Error ? error.stack : undefined,
       sessions: sessions.filter((session) => session.ownerPublicKeyHex === owner)
        .map((session) => ({ sessionId: session.sessionId, phase: session.phase, evidence: session.evidence, pendingTxid: session.pendingTxid, pendingAuthorizationId: session.pendingAuthorizationId }))
    });
    throw error;
  } finally {
    release();
    if (msfileBitfsBuyerPurchaseTails.get(lockKey) === current) msfileBitfsBuyerPurchaseTails.delete(lockKey);
  }
}

/** 用户选择报价或自动规则命中后，为有界批次内的卖家按 Block 数分配独立费用池。 */
async function startMsfileBitfsBuyerPurchaseNow(input: {
  seedHashHex: string;
  sessionId: string;
  maxFullBlockPriceSatoshis?: string;
  /** 仅显式手动重启时允许在全部旧池关闭后清除停止标记。 */
  resumeCancelledPlan?: boolean;
}): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key 再购买 BitFS 文件");
  await ensureMsfileBitfsBuyerRecovery(owner);
  if (!isValidMsFileHashHex(input.seedHashHex)) throw new TypeError("BitFS Seed Hash 必须是 64 位小写十六进制字符");
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(input.sessionId)) throw new TypeError("BitFS 报价会话编号无效");
  const { task, entry } = await ensureMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex });
  const quotes = await addMsfileBitfsRecentSellerSpeeds(owner, input.seedHashHex, await task.listDiscoveredQuotes());
  const selectedQuote = quotes.find((item) => item.sessionId === input.sessionId);
  if (!selectedQuote) throw new Error("所选报价不属于当前 Seed 的已验签报价列表");
  const maximumBlockPrice = normalizeMsFileSatoshiAmount(input.maxFullBlockPriceSatoshis ?? selectedQuote.fullBlockPriceSatoshis);
  if (maximumBlockPrice === undefined || BigInt(selectedQuote.fullBlockPriceSatoshis) > BigInt(maximumBlockPrice)) {
    throw new Error("所选报价的完整 Block 单价高于本文件已选择的最高价");
  }
  const runtime = await deps.ensureService();
  const settings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const allSessions = await sessions.list();
  const sameSeedSessions = allSessions.filter((record) => record.role === "buyer"
    && record.ownerPublicKeyHex === owner && record.seedHashHex === input.seedHashHex.toLowerCase());
  const hasPlan = (record: (typeof sameSeedSessions)[number]): boolean => record.evidence.includes("download-plan");
  const hasFunding = (record: (typeof sameSeedSessions)[number]): boolean => record.evidence.includes("kind2-opening-request")
    || record.evidence.includes("opening-configuration") || record.evidence.includes("funding-transaction")
    || record.pendingTxid !== undefined;
  const terminal = new Set(["completed", "cancelled", "refunded"]);
  const otherActiveSeeds = new Set(allSessions.filter((record) => record.role === "buyer"
    && record.ownerPublicKeyHex === owner
    && (record.evidence.includes("kind2-opening-request") || record.evidence.includes("opening-configuration")
      || record.evidence.includes("funding-transaction"))
    && !terminal.has(record.phase) && record.seedHashHex !== input.seedHashHex.toLowerCase())
    .map((record) => record.seedHashHex));
  if (otherActiveSeeds.size >= settings.maxConcurrentDownloads) {
    throw new Error(`当前有 ${otherActiveSeeds.size} 个 BitFS 文件任务仍在购买或恢复；并发上限为 ${settings.maxConcurrentDownloads}`);
  }
  if (sameSeedSessions.some((record) => !hasPlan(record) && !terminal.has(record.phase) && hasFunding(record))) {
    throw new Error("当前 Seed 有尚未完成的旧版单卖家费用池；请先恢复或回收后再建立共享下载计划");
  }
  if (entry.purchase?.phase === "completed") throw new Error("当前 Seed 已完成购买，无需再次付款");

  const canonicalQuote = quotes.slice().sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
  if (!canonicalQuote || quotes.some((item) => item.fileSizeBytes !== canonicalQuote.fileSizeBytes)) {
    throw new Error("同 Seed 报价的签名文件大小不一致，不能安全建立共享下载计划");
  }
  const totalBlocksBig = (BigInt(canonicalQuote.fileSizeBytes) + 262_143n) / 262_144n;
  if (totalBlocksBig <= 0n || totalBlocksBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("BitFS 文件 Block 数量超出当前安全范围");
  const totalBlocks = Number(totalBlocksBig);
  const downloadPlan = createBitfsBuyerDownloadPlan({
    ownerPublicKeyHex: owner,
    seedHashHex: input.seedHashHex,
    fileSizeBytes: canonicalQuote.fileSizeBytes,
    recommendedFilename: canonicalQuote.recommendedFilename,
    store: deps.files( "bitfs-journal"),
  });
  let plan = await downloadPlan.snapshot();
  // 尚未准备 FundingTx 的失败池没有资金责任，可释放其预留 Block；其他失败仍保留占用。
  for (const pool of plan.pools) {
    const record = sameSeedSessions.find((item) => item.sessionId === pool.sessionId);
    if (!pool.closed && record?.phase === "failed" && !hasFunding(record)) await downloadPlan.closePool(pool.sessionId);
  }
  plan = await downloadPlan.snapshot();
  if (plan.stopRequested) {
    if (!input.resumeCancelledPlan) throw new Error("整文件已取消；请先完成费用池回收，再由用户重新开始下载");
    if (plan.pools.some((pool) => !pool.closed)) {
      throw new Error("整文件取消仍在等待费用池关闭；确认所有池关闭后才能重新开始下载");
    }
    await downloadPlan.resumeAfterCancellation();
    plan = await downloadPlan.snapshot();
  }
  if (plan.totalBlockCount !== null && plan.completedBlockCount === plan.totalBlockCount) {
    throw new Error("当前 Seed 的所有唯一 Block 已付款；正在执行文件提交或关池恢复");
  }
  const existingPools = plan.pools.filter((pool) => !pool.closed);
  const sellerSlots = Math.max(0, settings.maxConcurrentSellerSessions - existingPools.length);
  const inFlight = existingPools.filter((pool) => pool.inFlightBlockHashHex !== undefined).length;
  const blockCount = plan.totalBlockCount ?? totalBlocks;
  const unassignedByPlan = Math.max(0, blockCount - plan.completedBlockCount - inFlight);
  const alreadyBudgeted = existingPools.reduce((sum, pool) => {
    const balance = BigInt(pool.blockBudgetSatoshis) - BigInt(pool.blockCommittedSatoshis);
    const capacity = balance > 0n ? balance / BigInt(pool.fullBlockPriceSatoshis) : 0n;
    const bounded = Number(capacity > BigInt(blockCount) ? BigInt(blockCount) : capacity);
    return Math.min(blockCount, sum + bounded - (pool.inFlightBlockHashHex ? 1 : 0));
  }, 0);
  const newBlockSlots = Math.max(0, unassignedByPlan - Math.max(0, alreadyBudgeted));

  const links = new Map<string, { webrtcSessionId: string; link: NonNullable<ReturnType<typeof msfileBitfsWebRtcBuyerLinks.get>> }>();
  for (const [webrtcSessionId, link] of msfileBitfsWebRtcBuyerLinks) {
    if (link.quoteSessionId && link.ownerPublicKeyHex.toLowerCase() === owner
      && link.seedHashHex.toLowerCase() === input.seedHashHex.toLowerCase()
      && link.ownerSessionEpoch === deps.session().sessionEpoch) {
      links.set(link.quoteSessionId, { webrtcSessionId, link });
    }
  }
  const selectedLink = links.get(input.sessionId);
  if (!selectedLink) throw new Error("所选卖家 DataChannel 已关闭；请重新发布需求并连接新的报价");
  const selectedRecord = sameSeedSessions.find((record) => record.sessionId === input.sessionId);
  const selectedAlreadyStarted = selectedRecord?.evidence.includes("download-plan") === true;
  if (selectedAlreadyStarted && (sellerSlots === 0 || newBlockSlots === 0)) {
    return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
  }
  const availableQuotes = quotes.filter((item) => BigInt(item.fullBlockPriceSatoshis) <= BigInt(maximumBlockPrice)
    && links.has(item.sessionId))
    .sort((left, right) => compareMsfileBitfsBuyerQuotes(left, right, settings.sellerSelectionPriority))
    .filter((item) => {
      const saved = sameSeedSessions.find((record) => record.sessionId === item.sessionId);
      return !saved?.evidence.includes("download-plan") && !saved?.evidence.includes("kind2-opening-request");
    });
  // 手动选中的报价必须纳入本批；其他名额沿用持久化计划的卖家优先规则。
  const orderedQuotes = [
    ...availableQuotes.filter((item) => item.sessionId === input.sessionId),
    ...availableQuotes.filter((item) => item.sessionId !== input.sessionId),
  ];
  const batchCount = Math.min(sellerSlots, newBlockSlots, orderedQuotes.length);
  if (batchCount <= 0) {
    if (selectedRecord?.evidence.includes("download-plan")) return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
    throw new Error("可用卖家池已达到并发上限，或文件 Block 预算已全部分配");
  }
  const batch = orderedQuotes.slice(0, batchCount);
  if (!selectedAlreadyStarted && !batch.some((item) => item.sessionId === input.sessionId)) {
    throw new Error("当前并发名额已被其他报价占用；请重新选择可用报价");
  }
  const appSettings = await deps.p2pkhSettings();
  const feeRate = BigInt(appSettings.feeRateSatoshisPerKb.medium);
  if (feeRate <= 0n) throw new Error("BitFS 池内手续费率配置无效");
  const feeReserve = feeRate * 2n;
  let started = 0;
  let blockSlotsRemaining = newBlockSlots;
  let candidatesRemaining = batch.length;
  const failures: string[] = [];
  for (let index = 0; index < batch.length; index += 1) {
    const candidate = batch[index]!;
    const assignedCount = Math.floor(blockSlotsRemaining / candidatesRemaining)
      + (blockSlotsRemaining % candidatesRemaining > 0 ? 1 : 0);
    candidatesRemaining -= 1;
    const target = links.get(candidate.sessionId);
    if (!target) continue;
    const saved = sameSeedSessions.find((record) => record.sessionId === candidate.sessionId);
    if (saved?.evidence.includes("download-plan") || saved?.evidence.includes("kind2-opening-request")) continue;
    if (assignedCount <= 0) continue;
    const assignedBlockCount = BigInt(assignedCount);
    const blockBudget = assignedBlockCount * BigInt(candidate.fullBlockPriceSatoshis);
    // 允许每个候选池作为唯一 Seed 买家接替失败卖家；Seed 只会由计划认领一次。
    const seedBudget = plan.seedCompleted ? 0n : BigInt(candidate.seedPriceSatoshis);
    const contentBudget = blockBudget + seedBudget;
    const openingAmount = contentBudget + feeReserve;
    if (openingAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      failures.push(`${candidate.sessionId}: 开池金额超过安全上限`);
      continue;
    }
    await target.link.quoteAccepted;
    const protocol = await ensureMsfileBitfsBuyerProtocol(target.webrtcSessionId, target.link);
    const savedSession = await sessions.get(candidate.sessionId);
    if (!savedSession || savedSession.role !== "buyer" || savedSession.ownerPublicKeyHex !== owner
      || savedSession.seedHashHex !== input.seedHashHex.toLowerCase()) {
      failures.push(`${candidate.sessionId}: 买方报价会话身份不匹配`);
      continue;
    }
    const limitEvidence = new TextEncoder().encode(maximumBlockPrice);
    const priorLimit = await sessions.getEvidence(candidate.sessionId, "file-price-limit");
    if (priorLimit && deps.bytesToHex(priorLimit) !== deps.bytesToHex(limitEvidence)) {
      failures.push(`${candidate.sessionId}: 已固定不同的本文件最高价`);
      continue;
    }
    if (!priorLimit) await sessions.putEvidence(candidate.sessionId, savedSession.revision, "file-price-limit", limitEvidence, Date.now());
    try {
      const progress = await protocol.startPurchase({
        sessionId: candidate.sessionId,
        stream: createMsfileBitfsBuyerStream(target.webrtcSessionId, target.link),
        openingAmountSatoshis: openingAmount.toString(10),
        contentBudgetSatoshis: contentBudget.toString(10),
        seedBudgetSatoshis: seedBudget.toString(10),
        seedBudgetReserved: !plan.seedCompleted,
        blockBudgetSatoshis: blockBudget.toString(10),
        recentBytesPerSecond: candidate.recentBytesPerSecond ?? null,
      });
      started += 1;
      blockSlotsRemaining -= assignedCount;
      if (candidate.sessionId === input.sessionId || !entry.purchase) {
        entry.purchase = {
          sessionId: progress.sessionId,
          phase: progress.phase,
          openingAmountSatoshis: progress.openingAmountSatoshis,
          currentMaxFullBlockPriceSatoshis: maximumBlockPrice,
          verifiedBlockCount: progress.verifiedBlockCount,
          totalBlockCount: progress.totalBlockCount,
          message: progress.message,
        };
      }
     } catch (cause) {
       const message = cause instanceof Error ? cause.message : "BitFS 卖家池开池准备失败";
       await writeBitfsE2eDiagnostic("buyer-purchase-candidate-error.json", {
         seedHashHex: input.seedHashHex,
         sessionId: candidate.sessionId,
         message,
         stack: cause instanceof Error ? cause.stack : undefined
       });
       failures.push(`${candidate.sessionId}: ${message.slice(0, 160)}`);
      const latest = await sessions.get(candidate.sessionId);
      if (latest && !hasFunding(latest)) {
        await downloadPlan.closePool(candidate.sessionId).catch(() => undefined);
        const afterClose = await downloadPlan.snapshot();
        const pool = afterClose.pools.find((item) => item.sessionId === candidate.sessionId);
        if (pool && !pool.closed) blockSlotsRemaining -= assignedCount;
      } else if (latest) {
        blockSlotsRemaining -= assignedCount;
      }
      if (candidate.sessionId === input.sessionId && !entry.purchase) {
        entry.purchase = {
          sessionId: candidate.sessionId,
          phase: "failed",
          openingAmountSatoshis: openingAmount.toString(10),
          currentMaxFullBlockPriceSatoshis: maximumBlockPrice,
          verifiedBlockCount: 0,
          totalBlockCount: totalBlocks,
          message: message.slice(0, 240),
        };
      }
    }
  }
  if (started === 0) throw new Error(failures[0] ?? "没有卖家费用池可以启动");
  return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
}

/** 按持久化下载计划采用相同的价格/速度优先规则排列已验签报价。 */
function compareMsfileBitfsBuyerQuotes(
  left: import("@keymaster/contracts").MsFileBitfsQuoteView,
  right: import("@keymaster/contracts").MsFileBitfsQuoteView,
  priority: "price" | "recent-speed",
): number {
  const leftSpeed = left.recentBytesPerSecond == null ? undefined : BigInt(left.recentBytesPerSecond);
  const rightSpeed = right.recentBytesPerSecond == null ? undefined : BigInt(right.recentBytesPerSecond);
  if (priority === "recent-speed") {
    if (leftSpeed !== undefined && rightSpeed === undefined) return -1;
    if (leftSpeed === undefined && rightSpeed !== undefined) return 1;
    if (leftSpeed !== undefined && rightSpeed !== undefined && leftSpeed !== rightSpeed) return leftSpeed > rightSpeed ? -1 : 1;
  }
  const leftPrice = BigInt(left.fullBlockPriceSatoshis);
  const rightPrice = BigInt(right.fullBlockPriceSatoshis);
  if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
  if (leftSpeed !== undefined && rightSpeed !== undefined && leftSpeed !== rightSpeed) return leftSpeed > rightSpeed ? -1 : 1;
  return left.sessionId.localeCompare(right.sessionId);
}

/** 已付款池关闭并释放并发名额后，继续加入符合本文件价格上限的已连接卖家。 */
async function maybeStartMsfileBitfsNextSeller(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  task: BitfsBuyerTask;
}): Promise<void> {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const seed = input.seedHashHex.toLowerCase();
  const entry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, seed));
  const maximum = entry?.purchase?.currentMaxFullBlockPriceSatoshis;
  if (!entry || entry.ownerSessionEpoch !== deps.session().sessionEpoch || !maximum || entry.purchase?.phase === "completed") return;
  const plan = await openMsfileBitfsBuyerDownloadPlan(owner, seed).catch(() => undefined);
  if (plan && (await plan.snapshot()).stopRequested) return;
  const runtime = await deps.ensureService();
  const settings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  const quotes = await addMsfileBitfsRecentSellerSpeeds(owner, seed, await input.task.listDiscoveredQuotes());
  const sessions = await createBitfsSessionJournal(deps.files( "bitfs-journal")).list();
  const linkedSessionIds = new Set([...msfileBitfsWebRtcBuyerLinks.values()]
    .filter((candidate) => candidate.ownerPublicKeyHex.toLowerCase() === owner
      && candidate.seedHashHex.toLowerCase() === seed
      && candidate.ownerSessionEpoch === deps.session().sessionEpoch
      && candidate.quoteSessionId)
    .map((candidate) => candidate.quoteSessionId!));
  const next = quotes.filter((quote) => BigInt(quote.fullBlockPriceSatoshis) <= BigInt(maximum)
    && linkedSessionIds.has(quote.sessionId)
    && !sessions.some((record) => record.role === "buyer" && record.sessionId === quote.sessionId
      && (record.evidence.includes("download-plan") || record.evidence.includes("kind2-opening-request"))))
    .sort((left, right) => compareMsfileBitfsBuyerQuotes(left, right, settings.sellerSelectionPriority))[0];
  if (!next) return;
  await startMsfileBitfsBuyerPurchase({ seedHashHex: seed, sessionId: next.sessionId, maxFullBlockPriceSatoshis: maximum })
    .catch(() => undefined);
}

/** 有效报价短暂收敛后，启动当前可用且符合价格上限的卖家批次。 */
async function maybeAutoStartMsfileBitfsBuyerPurchase(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  task: BitfsBuyerTask;
}): Promise<void> {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const seed = input.seedHashHex.toLowerCase();
  const runtime = await deps.ensureService();
  const settings = runtime.getBitfsBuyerSettings
    ? await runtime.getBitfsBuyerSettings()
    : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  if (!settings.buyerAutoPurchaseEnabled) return;

  // 让同一轮已验签报价短暂收敛，再按上限和并发设置启动一个批次。
  await new Promise<void>((resolve) => setTimeout(resolve, 750));
  if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex?.toLowerCase() !== owner) return;
  const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, seed));
  if (!taskEntry || taskEntry.ownerSessionEpoch !== deps.session().sessionEpoch) return;
  if (taskEntry.purchase?.phase === "completed") return;
  const planObject = await deps.files( "bitfs-journal").get(`download-plans/${seed}.json`);
  if (planObject) {
    const downloadPlan = await openMsfileBitfsBuyerDownloadPlan(owner, seed);
    if ((await downloadPlan.snapshot()).stopRequested) return;
  }

  const priceLimit = BigInt(settings.maxFullBlockPriceSatoshis);
  const candidates = (await addMsfileBitfsRecentSellerSpeeds(owner, seed, await input.task.listDiscoveredQuotes()))
    .filter((quote) => BigInt(quote.fullBlockPriceSatoshis) <= priceLimit)
    .sort((left, right) => {
      const leftBlock = BigInt(left.fullBlockPriceSatoshis);
      const rightBlock = BigInt(right.fullBlockPriceSatoshis);
      if (settings.sellerSelectionPriority === "recent-speed") {
        const leftSpeed = left.recentBytesPerSecond === null || left.recentBytesPerSecond === undefined
          ? undefined
          : BigInt(left.recentBytesPerSecond);
        const rightSpeed = right.recentBytesPerSecond === null || right.recentBytesPerSecond === undefined
          ? undefined
          : BigInt(right.recentBytesPerSecond);
        if (leftSpeed !== undefined && rightSpeed === undefined) return -1;
        if (leftSpeed === undefined && rightSpeed !== undefined) return 1;
        if (leftSpeed !== undefined && rightSpeed !== undefined && leftSpeed !== rightSpeed) return leftSpeed > rightSpeed ? -1 : 1;
      }
      if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
      const leftSeed = BigInt(left.seedPriceSatoshis);
      const rightSeed = BigInt(right.seedPriceSatoshis);
      return leftSeed === rightSeed ? left.sessionId.localeCompare(right.sessionId) : leftSeed < rightSeed ? -1 : 1;
    });
  const selected = candidates[0];
  if (!selected) return;
  try {
    await startMsfileBitfsBuyerPurchase({ seedHashHex: seed, sessionId: selected.sessionId, maxFullBlockPriceSatoshis: settings.maxFullBlockPriceSatoshis });
  } catch (error) {
    console.warn("[msfile] BitFS automatic purchase was not started", error instanceof Error ? error.message : String(error));
  }
}

/** 整文件取消先立持久停止栅栏，再逐池复用原连接协商 Kind 12/13 回收。 */
async function cancelMsfileBitfsBuyerPurchase(input: { seedHashHex: string; sessionId: string }): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key 再取消 BitFS 购买");
  if (!isValidMsFileHashHex(input.seedHashHex)) throw new TypeError("BitFS Seed Hash 必须是 64 位小写十六进制字符");
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(input.sessionId)) throw new TypeError("BitFS 报价会话编号无效");
  const { task, entry } = await ensureMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex });
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const selected = await sessions.get(input.sessionId);
  if (!selected || selected.role !== "buyer" || selected.ownerPublicKeyHex !== owner
    || selected.seedHashHex !== input.seedHashHex.toLowerCase()) {
    throw new Error("找不到当前 Key 和 Seed 对应的买方购买会话");
  }
  if (!selected.evidence.includes("download-plan")) {
    return cancelOneMsfileBitfsBuyerPurchase({ ...input, ownerPublicKeyHex: owner, task, entry });
  }

  const plan = await openMsfileBitfsBuyerDownloadPlan(owner, input.seedHashHex);
  await plan.requestStop();
  const before = await plan.snapshot();
  const failures: string[] = [];
  for (const pool of before.pools.filter((item) => !item.closed)) {
    try {
      await cancelOneMsfileBitfsBuyerPurchase({
        seedHashHex: input.seedHashHex,
        sessionId: pool.sessionId,
        ownerPublicKeyHex: owner,
        task,
        entry,
      });
    } catch (error) {
      failures.push(`${pool.sessionId}: ${error instanceof Error ? error.message : "费用池取消失败"}`);
    }
  }
  const after = await plan.snapshot();
  const pending = after.pools.filter((item) => !item.closed);
  if (pending.length > 0) {
    entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, task }) ?? entry.purchase;
    if (entry.purchase) {
      const detail = failures[0] ? ` 首个未完成原因：${failures[0].slice(0, 140)}` : "";
      entry.purchase = {
        ...entry.purchase,
        message: `整文件已暂停新内容请求；${pending.length} 个费用池仍待卖家响应或链上确认。${detail}`,
      };
    }
  }
  return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
}

/** 单个费用池取消：没有连接时只释放未广播的开池预留；已开池必须恢复连接回收。 */
async function cancelOneMsfileBitfsBuyerPurchase(input: {
  seedHashHex: string;
  sessionId: string;
  ownerPublicKeyHex: string;
  task: BitfsBuyerTask;
  entry: NonNullable<ReturnType<typeof msfileBitfsBuyerTasks.get>>;
}): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key 再取消 BitFS 购买");
  if (owner !== input.ownerPublicKeyHex) throw new Error("BitFS 当前 Key 已切换，不能继续取消原下载计划");
  if (!isValidMsFileHashHex(input.seedHashHex)) throw new TypeError("BitFS Seed Hash 必须是 64 位小写十六进制字符");
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(input.sessionId)) throw new TypeError("BitFS 报价会话编号无效");
  const { task, entry } = input;
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const saved = await sessions.get(input.sessionId);
  if (!saved || saved.role !== "buyer" || saved.ownerPublicKeyHex !== owner || saved.seedHashHex !== input.seedHashHex.toLowerCase()) {
    throw new Error("找不到当前 Key 和 Seed 对应的买方购买会话");
  }
  if (saved.evidence.includes("kind13-close-response")) {
    await task.resumePoolRecovery(input.sessionId);
    entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, task });
    return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
  }
  const canCancelBeforeFunding = ["quote-selected", "opening-presign", "funding-prepared", "cancel-opening"].includes(saved.phase)
    && !saved.evidence.includes("kind3-opening-response")
    && !saved.evidence.includes("kind4-funding-delivery");
  const linkEntry = [...msfileBitfsWebRtcBuyerLinks.entries()].find(([, link]) =>
    link.quoteSessionId === input.sessionId
      && link.ownerSessionEpoch === deps.session().sessionEpoch
      && link.ownerPublicKeyHex.toLowerCase() === owner
      && link.seedHashHex === input.seedHashHex.toLowerCase());
  if (!linkEntry) {
    if (canCancelBeforeFunding) {
      const openingMayHaveReservedFunding = saved.evidence.includes("opening-configuration")
        || saved.evidence.includes("funding-transaction");
      if (saved.phase === "quote-selected" && !openingMayHaveReservedFunding) {
        await sessions.update(saved.sessionId, saved.revision, { phase: "cancelled" }, Date.now());
      } else {
        if (saved.phase !== "cancel-opening") await sessions.update(saved.sessionId, saved.revision, { phase: "cancel-opening" }, Date.now());
        await task.cancelUnfundedOpening(saved.sessionId);
      }
      if (saved.evidence.includes("download-plan")) {
        await markMsfileBitfsDownloadPlanPoolClosed({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, sessionId: saved.sessionId });
        void maybeStartMsfileBitfsNextSeller({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, task }).catch(() => undefined);
      }
      entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, task }) ?? {
        sessionId: saved.sessionId,
        phase: "cancelled",
        openingAmountSatoshis: null,
        verifiedBlockCount: 0,
        totalBlockCount: null,
        message: "购买已取消；开池资金未广播。",
      };
      return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
    }
    entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: input.seedHashHex, task }) ?? entry.purchase;
    throw new Error("卖方 DataChannel 已关闭；费用池仍受保护，需恢复卖方连接后继续关池回收");
  }
  const [webrtcSessionId, link] = linkEntry;
  await link.quoteAccepted;
  const protocol = await ensureMsfileBitfsBuyerProtocol(webrtcSessionId, link);
  await protocol.cancelPurchase({ sessionId: input.sessionId, stream: createMsfileBitfsBuyerStream(webrtcSessionId, link) });
  return await msfileBitfsBuyerDemandSnapshot(input.seedHashHex, entry, task);
}

function createMsfileBitfsBuyerStream(
  webrtcSessionId: string,
  link: NonNullable<ReturnType<typeof msfileBitfsWebRtcBuyerLinks.get>>,
) {
  return {
    async send(frame: Uint8Array) {
      if (msfileBitfsWebRtcBuyerLinks.get(webrtcSessionId) !== link) throw new Error("BitFS 买方 DataChannel 已关闭");
      try {
        await deps.executor({
          type: "lane",
          laneId: "msfile",
          operation: { type: "bitfs-seller-send", sessionId: link.transportSessionId, frame },
        });
      } catch (error) {
        await writeBitfsE2eDiagnostic("buyer-stream-send-error.json", {
          webrtcSessionId,
          transportSessionId: link.transportSessionId,
          frameBytes: frame.byteLength,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
  };
}

/** 买方传输或协议失败后关闭该会话并保留可见恢复状态。 */
function msfileBitfsBuyerWebRtcFailure(link: NonNullable<ReturnType<typeof msfileBitfsWebRtcBuyerLinks.get>>, webrtcSessionId: string, transportSessionId: string, reason: string): void {
  void writeBitfsE2eDiagnostic("buyer-webrtc-failure.json", {
    requestMessageId: link.requestMessageId,
    webrtcSessionId,
    transportSessionId,
    reason
  });
  if (msfileBitfsWebRtcBuyerLinks.get(webrtcSessionId) !== link) return;
  msfileBitfsWebRtcBuyerLinks.delete(webrtcSessionId);
  msfileBitfsBuyerOfferCounts.set(link.requestMessageId, Math.max(0, (msfileBitfsBuyerOfferCounts.get(link.requestMessageId) ?? 1) - 1));
  const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(link.ownerPublicKeyHex, link.seedHashHex));
  if (taskEntry?.purchase && taskEntry.purchase.phase !== "completed" && taskEntry.purchase.phase !== "cancelled") {
    const cancelling = taskEntry.purchase.phase === "cancelling-pool" || taskEntry.purchase.phase === "cancel-unknown";
    taskEntry.purchase = {
      ...taskEntry.purchase,
      phase: cancelling ? "cancel-unknown" : reason === "buyer_protocol_error" ? "failed" : "connection-closed",
      message: cancelling
        ? "卖方 DataChannel 已关闭；取消关池结果待核对，费用池仍受保护。"
        : reason === "buyer_protocol_error"
        ? "BitFS 买方协议处理失败；本地会话证据已保留。"
        : "BitFS DataChannel 已关闭；本地会话证据已保留，可在购买任务页重新连接卖家续接。",
    };
    taskEntry.purchaseHydrated = false;
  }
  void deps.executor({
    type: "lane",
    laneId: "msfile",
    operation: { type: "bitfs-seller-close", sessionId: transportSessionId, reason },
  }).catch(() => undefined);
}

/** 比较 exact BitFS 报文字节；不把视图对象或哈希摘要当作会话身份。 */
function equalMsfileBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function stopMsfileSellerRuntime(): void {
  msfileSellerSessionEpoch += 1;
  msfileSellerIndexController?.abort();
  msfileSellerIndexController = undefined;
  msfileSellerRuntime?.clear();
  msfileSellerRuntime = undefined;
  const manager = msfileSellerSessionManager;
  msfileSellerSessionManager = undefined;
  msfileSellerProtocolPort = undefined;
  msfileBitfsTransactionJournal = undefined;
  msfileBitfsBroadcaster = undefined;
  manager?.clear();
  msfileBitfsWebRtcSellerLinks.clear();
  msfilePendingSellerHashRequests.clear();
  msfileSellerIndex?.clear();
  msfileSellerIndex = undefined;
  offMsfileSellerDependencyWatch();
}

/**
 * 卖方「等待依赖」的进程内订阅。
 *
 * 依赖就绪与否只由唯一判定实现回答，变化靠进程内订阅推过来：没有轮询、没有
 * 等待休眠、没有超时猜测。双向都处理——依赖掉线如实报不可用，依赖回来自动
 * 重跑装配，用户不需要手动再切一次开关。重判是幂等的：只有依赖可用性真的翻转
 * 才动作，其它单元的抖动只做一次同态重判。
 */
let msfileSellerDependencyUnsubscribe: (() => void) | undefined;
/** 上一次观察到的依赖可用性；`undefined` 表示当前没有在观察。 */
let msfileSellerDependencyReady: boolean | undefined;
/** 「依赖就绪后自动重跑」的在途装配；只用于测试 await 与诊断，不参与判定。 */
let msfileSellerDependencyResume: Promise<void> | undefined;

function offMsfileSellerDependencyWatch(): void {
  const off = msfileSellerDependencyUnsubscribe;
  msfileSellerDependencyUnsubscribe = undefined;
  msfileSellerDependencyReady = undefined;
  off?.();
}

/** 卖方等待依赖时订阅的依赖单元；与目录声明保持一致，不在调用点另写副本。 */
const MSFILE_SELLER_DEPENDENCY_UNIT_ID = "sat-subscription.coordinator-worker";

/**
 * 订阅依赖可用性。
 *
 * - 依赖不可用：如实报「等待依赖」，**不拆解**已建好的部分、**不要求用户重切**。
 * - 依赖可用：重跑一次装配（幂等），把状态推进到就绪。
 */
function watchMsfileSellerDependency(
  service: MsFileServiceImpl,
  ownerPublicKeyHex: string,
): void {
  offMsfileSellerDependencyWatch();
  const serviceRef = service;
  msfileSellerDependencyReady = deps.availability(MSFILE_SELLER_DEPENDENCY_UNIT_ID).state === "ready";
  msfileSellerDependencyUnsubscribe = deps.subscribeAvailability(() => {
    // 订阅已被同一次变化里的清理动作取消（开关关闭 / 锁定）时直接退出。
    if (msfileSellerDependencyUnsubscribe === undefined) return;
    if (deps.service() !== serviceRef) return;
    if (deps.session().activePublicKeyHex !== ownerPublicKeyHex) return;
    const settings = serviceRef.describeState().sellerSettings;
    if (!settings.sellerEnabled) return;
    const ready = deps.availability(MSFILE_SELLER_DEPENDENCY_UNIT_ID).state === "ready";
    if (ready === msfileSellerDependencyReady) return;
    msfileSellerDependencyReady = ready;
    if (!ready) {
      serviceRef.setSellerRuntimeStatus("waiting-dependency");
      return;
    }
    offMsfileSellerDependencyWatch();
    msfileSellerDependencyResume = configureMsfileSellerRuntime(serviceRef, ownerPublicKeyHex, settings)
      .then((status) => { serviceRef.setSellerRuntimeStatus(status); })
      .catch((error) => console.warn("[msfile] seller runtime resume failed", error instanceof Error ? error.message : String(error)));
  });
}

const msfileFundingRuntime = deps.funding;
const currentMsfileBitfsFundingLedger = msfileFundingRuntime.currentLedger;
const filterP2pkhSnapshotByBitfsFunds = msfileFundingRuntime.filterSnapshot;
const reconcileMsfileBitfsFundingInputs = msfileFundingRuntime.reconcileInputs;
const createMsfileBitfsProtocolSpend = msfileFundingRuntime.protocolSpend;
const releaseMsfileBitfsPreparedSubmission = msfileFundingRuntime.releasePreparedSubmission;
const waitForMsfileFundingSnapshot = msfileFundingRuntime.waitForSnapshot;
const prepareMsfileBitfsFundingSplit = msfileFundingRuntime.prepareSplit;
const recoverMsfileBitfsFundingSplit = msfileFundingRuntime.recoverSplit;
const settleMsfileBitfsFundingSplit = msfileFundingRuntime.settleSplit;

/** 为固定报价创建当前 Worker 内的买方开池任务；页面不接触账本或签名端口。 */
/** 单调递增的买方任务协议世代；只在 Worker 运行期有效，重启后重新开始。 */
let msfileBuyerTaskGeneration = 0;
function nextMsfileBuyerTaskGeneration(): number {
  msfileBuyerTaskGeneration += 1;
  return msfileBuyerTaskGeneration;
}

async function createMsfileBitfsBuyerTask(input: {
  /** 当前已解锁 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 本次采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 资金所属公链网络。 */
  network: "main" | "test";
}): Promise<BitfsBuyerTask> {
  const snapshots = deps.snapshots();
  const owner = input.ownerPublicKeyHex.trim().toLowerCase();
  const seed = input.seedHashHex.trim().toLowerCase();
  if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex?.toLowerCase() !== owner) {
    throw new Error("BitFS 买方任务只允许当前已解锁 Key");
  }
  const runGeneration = deps.session().runGeneration;
  const sessionEpoch = deps.session().sessionEpoch;
  // BitFS 买方任务的协议端口仍使用一个**数字** generation 做迟到结果撤销。
  // 单 Key 模型下不再有随切 Key 自增的 旧身份计数器，这里改用已存在的
  // `msfileSellerSessionEpoch` 同族计数：每次创建新任务都会取当前计数 + 1，
  // 因此同一 Worker 内后创建的任务一定大于先创建的任务，重启后计数重新
  // 开始即可（旧任务句柄本来就随 Worker 重启消失）。
  const generation = nextMsfileBuyerTaskGeneration();
  const assertCurrentContext = (): void => {
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.session().runGeneration !== runGeneration
      || deps.session().sessionEpoch !== sessionEpoch
      || deps.snapshots() !== snapshots) {
      throw new Error("BitFS 买方任务的 Key、存储或会话世代已变化");
    }
  };
  const store = deps.files( "bitfs-journal");
  const sessions = createBitfsSessionJournal(store);
  const transactions = createBitfsTransactionJournal(store);
  const ledger = currentMsfileBitfsFundingLedger();
  await recoverBitfsFundingSplits({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network }, {
    ledger,
    transactions,
    releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
    parseTransaction(rawTransactionHex, expectedTxid) {
      const parsed = deps.parseTransaction(rawTransactionHex, expectedTxid);
      return {
        canonicalTxid: parsed.canonicalTxid,
        inputs: parsed.inputs.map((item) => item.outpointKey),
        outputs: parsed.outputs.map((item) => ({ vout: item.vout, valueSatoshis: item.value, scriptHex: item.scriptHex })),
      };
    },
    nowMs: () => Date.now(),
  });
  let fundingAccount = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, nowMs: Date.now() });
  for (const plan of fundingAccount.transactions.filter((item) => item.purpose === "opening" && item.state === "prepared")) {
    if (!plan.poolId) throw new Error("BitFS FundingTx 恢复计划缺少会话编号，专款输入继续受保护");
    const evidence = await sessions.getEvidence(plan.poolId, "funding-transaction");
    const outboxRecord = await transactions.getTransactionRecord(plan.txid);
    // FundingTx 只有在 Kind 3 验证后才会广播；没有会话 evidence 且 outbox
    // 仍未派发时，可以安全释放崩溃前的孤立预签占用。
    if (evidence || (outboxRecord !== undefined && outboxRecord.state !== "prepared" && outboxRecord.state !== "failed")) continue;
    if (!plan.p2pkhSubmissionId) throw new Error("孤立 FundingTx 缺少 P2PKH 提交编号，输入继续受保护");
    await releaseMsfileBitfsPreparedSubmission({
      ownerPublicKeyHex: owner,
      network: input.network,
      txid: plan.txid,
      submissionId: plan.p2pkhSubmissionId,
    });
    fundingAccount = await ledger.releaseDefinitelyUndispatchedTransaction({
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      network: input.network,
      expectedRevision: fundingAccount.revision,
      txid: plan.txid,
      nowMs: Date.now(),
    });
    // exact raw may remain in the outbox, but no request path may dispatch it
    // without the missing Kind 2/3 session evidence.
  }
  assertCurrentContext();

  const protocolSpend = createMsfileBitfsProtocolSpend();
  let fundingSnapshotResource: P2pkhUtxoSnapshotResource | undefined;
  const fundingDeps: BitfsFundingPrepareDeps = {
    protocolSpend,
    async resolveOwnerAddress() {
      assertCurrentContext();
      const address = deps.deriveAddress(owner, input.network);
      return { address, scriptHex: deps.addressScript(address, input.network) };
    },
    reserveP2pkhInputs({ preview, inputOutpoints }) {
      assertCurrentContext();
      const resource = fundingSnapshotResource;
      const binding = preview.utxoBinding;
      if (!resource || !snapshots || !binding) {
        throw new Error("BitFS FundingTx 缺少可消费的 P2PKH 快照绑定");
      }
      const snapshot = snapshots.get(resource);
      const inputKeys = new Set(inputOutpoints);
      if (!snapshot.available || snapshot.state !== "fresh" || snapshot.seq !== binding.seq
        || preview.inputs.length !== inputKeys.size
        || preview.inputs.some((item) => {
          const key = `${item.txid}:${item.vout}`;
          const current = snapshot.items.find((utxo) => `${utxo.txid}:${utxo.vout}` === key);
          return !inputKeys.has(key) || !current || current.isSpentInMempoolTx || current.value !== item.value;
        })) {
        throw new Error("BitFS FundingTx 有输入未出现在当前新鲜快照中或已被花费");
      }
      const consumed = snapshots.consume(resource, {
        binding,
        inputOutpointKeys: inputOutpoints,
        txid: preview.txid,
      });
      if (consumed.status !== "consumed") {
        throw new Error(`BitFS FundingTx 输入占用被拒绝：${consumed.status === "rejected" ? consumed.reason : "snapshot-missing"}`);
      }
      return { rollback: () => { snapshots?.rollbackConsume(resource, binding); } };
    },
    parseTransaction(rawTransactionHex, expectedTxid) {
      const parsed = deps.parseTransaction(rawTransactionHex, expectedTxid);
      return {
        canonicalTxid: parsed.canonicalTxid,
        inputs: parsed.inputs.map((item) => item.outpointKey),
        outputs: parsed.outputs.map((item) => ({ vout: item.vout, valueSatoshis: item.value, scriptHex: item.scriptHex })),
      };
    },
    transactions,
    sessions,
    ledger,
    assertCurrentContext(context) {
      assertCurrentContext();
      if (context.ownerPublicKeyHex.toLowerCase() !== owner
        || context.network !== input.network
        || context.generation !== generation) {
        throw new Error("BitFS FundingTx 的身份、网络或 generation 不匹配");
      }
    },
    async releasePrepared(preview) {
      await protocolSpend.releasePrepared?.(preview);
    },
    nowMs: () => Date.now(),
  };

  const woc = deps.woc();
  const chain = woc ? createBitfsWocChainPort(woc, input.network) : {
    async broadcast(): Promise<never> { throw new Error("BitFS Worker 内 WoC 服务未就绪"); },
    async lookupTransaction(): Promise<"unknown"> { return "unknown"; },
  };
  const broadcaster = new BitfsTransactionBroadcaster({ journal: transactions, chain, nowMs: () => Date.now() });
  const cryptoPort = await deps.crypto(owner);
  assertCurrentContext();
  const signer = createBitfsVaultSigner(cryptoPort);

  const ensureDedicatedFunding = async (openingAmountSatoshis: string): Promise<void> => {
    let account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, nowMs: Date.now() });
    const pendingSplits = account.transactions.filter((item) => item.purpose === "split" && item.state !== "observed" && item.state !== "failed");
    for (const split of pendingSplits) {
      const outcome = await settleMsfileBitfsFundingSplit({
        ownerPublicKeyHex: owner,
        seedHashHex: seed,
        network: input.network,
        txid: split.txid,
        ledger,
        transactions,
        broadcaster,
        releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
        assertCurrentContext,
      });
      if (outcome.status !== "confirmed") throw new Error("BitFS 专款拆分尚未被节点观察；请按原 txid 对账后继续");
    }
    account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, nowMs: Date.now() });
    const availableSatoshis = account.utxos
      .filter((utxo) => utxo.state === "available")
      .reduce((total, utxo) => total + BigInt(utxo.valueSatoshis), 0n);
    const minimumFundingSatoshis = BigInt(openingAmountSatoshis) + BigInt(deps.maxFeeSatoshis());
    if (availableSatoshis >= minimumFundingSatoshis) return;

    const split = await prepareMsfileBitfsFundingSplit({
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      network: input.network,
      generation,
      requiredSatoshis: minimumFundingSatoshis.toString(10),
    });
    const outcome = await settleMsfileBitfsFundingSplit({
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      network: input.network,
      txid: split.txid,
      ledger,
      transactions,
      broadcaster,
      releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
      assertCurrentContext,
    });
    if (outcome.status !== "confirmed") throw new Error("BitFS 专款拆分尚未被节点观察；资金输入保持保护");
    account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, nowMs: Date.now() });
    const refreshedAvailable = account.utxos
      .filter((utxo) => utxo.state === "available")
      .reduce((total, utxo) => total + BigInt(utxo.valueSatoshis), 0n);
    if (refreshedAvailable < minimumFundingSatoshis) throw new Error("BitFS 专款拆分已观察，但可用输出仍不足以开池");
  };

  let buyerTask: BitfsBuyerTask;
  buyerTask = createBitfsBuyerTask({
    sessions,
    ledger,
    transactions,
    broadcaster,
    signer,
    ownerPublicKeyHex: owner,
    ownerP2pkhScriptHex: deps.addressScript(deps.deriveAddress(owner, input.network), input.network).toLowerCase(),
    seedHashHex: seed,
    network: input.network,
    generation,
    parseTransaction(rawTransactionHex, expectedTxid) {
      const parsed = deps.parseTransaction(rawTransactionHex, expectedTxid);
      return {
        canonicalTxid: parsed.canonicalTxid,
        inputs: parsed.inputs.map((item) => item.outpointKey),
        outputs: parsed.outputs.map((item) => ({ vout: item.vout, valueSatoshis: item.value, scriptHex: item.scriptHex })),
      };
    },
    assertCurrentContext,
    releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
    nowMs: () => Date.now(),
    blockHeight: () => deps.blockHeight(input.network),
    readPoolSpendChain: (fundingTxid) => {
      if (!woc) throw new Error("BitFS 到期退款需要可用的 WoC 池状态查询服务");
      return readBitfsPoolSpendChain({ woc, network: input.network, fundingTxid });
    },
    async publishHashRequest(onPrepared, onDefinitelyFailed) {
      assertCurrentContext();
      const runtime = await deps.ensureChannel();
      assertCurrentContext();
      await deps.buyerSubscriptions(runtime);
      assertCurrentContext();
      let preparedMessageId = "";
      try {
        return await deps.publishHashRequest(runtime, { hash: seed, locator: "webrtc-sdp" }, runtime.signal, (messageId) => {
          preparedMessageId = messageId;
          onPrepared(messageId);
          const now = Date.now();
          const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, seed));
          if (taskEntry && taskEntry.ownerSessionEpoch === sessionEpoch) {
            taskEntry.requestMessageId = messageId;
            taskEntry.expiresAtMs = now + 10 * 60 * 1_000;
          }
          for (const [requestId, entry] of msfileBitfsBuyerRequests) {
            if (entry.expiresAtMs <= now || entry.ownerSessionEpoch !== deps.session().sessionEpoch) {
              msfileBitfsBuyerRequests.delete(requestId);
              msfileBitfsBuyerOfferCounts.delete(requestId);
            }
          }
          msfileBitfsBuyerRequests.set(messageId, {
            task: buyerTask,
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            ownerSessionEpoch: sessionEpoch,
            expiresAtMs: now + 10 * 60 * 1_000,
          });
          while (msfileBitfsBuyerRequests.size > 256) {
            const first = msfileBitfsBuyerRequests.keys().next().value as string | undefined;
            if (first === undefined) break;
            msfileBitfsBuyerRequests.delete(first);
          }
        });
      } catch (error) {
        if (!deps.unknownPublishFailure(error) && preparedMessageId) {
          onDefinitelyFailed(preparedMessageId);
          msfileBitfsBuyerRequests.delete(preparedMessageId);
          const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, seed));
          if (taskEntry?.ownerSessionEpoch === sessionEpoch && taskEntry.requestMessageId === preparedMessageId) {
            taskEntry.requestMessageId = undefined;
            taskEntry.expiresAtMs = 0;
          }
        }
        throw error;
      }
    },
    async prepareFunding(fundingInput) {
      assertCurrentContext();
      await ensureDedicatedFunding(fundingInput.openingOutput.valueSatoshis);
      assertCurrentContext();
      const settings = await deps.p2pkhSettings();
      if (input.network === "test" && !settings.includeTestnet) {
        throw new Error("请先在 P2PKH 设置中启用测试网余额");
      }
      const resources = await deps.ensureResources(owner, settings.includeTestnet);
      fundingSnapshotResource = resources.find((resource) => resource.network === input.network);
      if (!fundingSnapshotResource || !snapshots) throw new Error("BitFS FundingTx 的 P2PKH 余额快照尚未就绪");
      for (let attempt = 0; ; attempt += 1) {
        await waitForMsfileFundingSnapshot({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, ledger });
        assertCurrentContext();
        try {
          return await prepareBitfsFunding({
            sessionId: fundingInput.sessionId,
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            network: input.network,
            generation,
            openingOutput: fundingInput.openingOutput,
            feeRateSatoshisPerKb: settings.feeRateSatoshisPerKb.medium,
            maxFeeSatoshis: deps.maxFeeSatoshis(),
          }, fundingDeps);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 2 || !/新鲜快照|输入占用被拒绝：snapshot-(stale|consumed)/u.test(message)) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
      }
    },
  });
  return buyerTask;
}

/**
 * Worker → Window lane 的 BitFS stream 端口。
 *
 * 中文说明：帧字节由协议端口负责先落盘再交给这里；本适配器只做受限
 * lane operation 转发，Window 侧仍会再次严格解析并做身份 pin。
 */
function createMsfileSellerStreamTransport(): BitfsSellerStreamTransport {
  return {
    async open(input) {
      const operation = {
        type: "lane",
        laneId: "msfile",
        operation: {
          type: "bitfs-seller-open",
          sessionId: input.sessionId,
          transport: input.transport,
          addresses: input.addresses,
          requestMessageId: input.requestMessageId,
          webrtcSessionId: input.webrtcSessionId,
          publicKeyHex: input.publicKeyHex,
          expectedPeerId: input.expectedPeerId,
          firstFrame: input.firstFrame,
        },
      } satisfies WindowP2pExecutorOperation;
      if (input.transport === "multiaddr") {
        await deps.executor(operation, input.signal);
        return;
      }
      const runtime = deps.channel();
      if (!runtime || runtime.ownerPublicKeyHex !== deps.session().activePublicKeyHex) {
        throw new Error("Channel runtime is not ready to start the BitFS WebRTC transport");
      }
      const link = {
        sessionId: input.sessionId,
        requestMessageId: input.requestMessageId,
        peerPublicKeyHex: input.publicKeyHex.toLowerCase(),
        ownerSessionEpoch: deps.session().sessionEpoch,
      };
      msfileBitfsWebRtcSellerLinks.set(input.webrtcSessionId, link);
      try {
        await deps.executor(operation, input.signal);
      } catch (error) {
        if (msfileBitfsWebRtcSellerLinks.get(input.webrtcSessionId) === link) {
          msfileBitfsWebRtcSellerLinks.delete(input.webrtcSessionId);
        }
        await deps.executor({
          type: "lane",
          laneId: "msfile",
          operation: { type: "bitfs-seller-close", sessionId: input.sessionId, reason: "offer_publish_failed" },
        }).catch(() => undefined);
        throw error;
      }
    },
    async send(sessionId, frame) {
      try {
        await deps.executor({
          type: "lane",
          laneId: "msfile",
          operation: { type: "bitfs-seller-send", sessionId, frame },
        });
      } catch (error) {
        await writeBitfsE2eDiagnostic("seller-stream-send-error.json", {
          sessionId,
          frameBytes: frame.byteLength,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
    async close(sessionId, reason) {
      await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId, reason },
      }).catch(() => undefined);
    },
  };
}

/** 当前是否存在可用的 BitFS 卖方 stream 通道。 */
function msfileSellerTransportAvailable(): boolean {
  if (testMsfileSellerBridge) return true;
  const lease = deps.executorLease();
  return lease?.transportReady === true && lease.sessionEpoch === deps.session().sessionEpoch;
}

async function configureMsfileSellerRuntime(
  service: MsFileServiceImpl,
  ownerPublicKeyHex: string,
  settings: import("@keymaster/contracts").MsFileSellerSettings,
): Promise<import("@keymaster/contracts").MsFileSellerRuntimeStatus> {
  stopMsfileSellerRuntime();
  // 用户开关与实际可接单状态是两个正交维度：开关关 → 短路，不评估可用性，
  // 不残留索引与运行时。
  if (!settings.sellerEnabled) {
    // 关闭后从当前时刻重新计算自动锁定，而不是沿用暂停前的旧 deadline。
    deps.resetAutoLock();
    return "disabled";
  }
  // 卖方需要持续接单；启用期间只暂停自动锁，手动锁定仍走全局释放路径。
  deps.pauseAutoLock();
  if (settings.supportedArbiterPublicKeys.length === 0) return "configuration-error";
  // 依赖先判、且只判一次；同时订阅双向变化——依赖掉线如实报不可用，依赖回来
  // 自动重跑。收款运行时还在预热时这不是永久配置错误：不拆索引、不要求用户
  // 再切一次开关。
  watchMsfileSellerDependency(service, ownerPublicKeyHex);
  if (msfileSellerDependencyReady !== true) return "waiting-dependency";
  service.setSellerRuntimeStatus("indexing");
  const controller = new AbortController();
  msfileSellerIndexController = controller;
  const index = new BitfsSeedIndex();
  msfileSellerIndex = index;
  try {
    const contentStore = deps.files( "");
    await index.build(contentStore, controller.signal);
    if (controller.signal.aborted || deps.session().activePublicKeyHex !== ownerPublicKeyHex || deps.service() !== service) {
      return "waiting-unlock";
    }
    const cryptoPort = await deps.crypto(ownerPublicKeyHex);
    const signer = createBitfsVaultSigner(cryptoPort);
    const journalStore = deps.files( "bitfs-journal");
    const journal = createBitfsJournal(journalStore);
    const transactionJournal = createBitfsTransactionJournal(journalStore);
    const woc = deps.woc();
    // WoC 未装配时仍允许派生索引和 fail-closed 协议端口启动；
    // 任何真实交易广播/高度查询都会明确失败，不会伪造链上事实。
    const chain = woc ? createBitfsWocChainPort(woc, deps.network()) : {
      async broadcast(): Promise<never> { throw new Error("BitFS Worker 内 WoC 服务未就绪"); },
      async lookupTransaction(): Promise<"unknown"> { return "unknown"; },
    };
    const broadcaster = new BitfsTransactionBroadcaster({
      journal: transactionJournal,
      chain,
      nowMs: () => Date.now(),
    });
    const sessions = createBitfsSessionJournal(journalStore);
    const persistedSellerGenerations = (await sessions.list())
      .filter((record) => record.role === "seller" && record.ownerPublicKeyHex === ownerPublicKeyHex)
      .map((record) => record.generation);
    msfileSellerSessionEpoch = Math.max(msfileSellerSessionEpoch, ...persistedSellerGenerations.map((value) => value + 1), 1);
    const runtimeInstanceId = crypto.randomUUID();
    // 恢复阶段只查询已持久化的 txid，不自动重播不可逆交易。
    const outcomes = await reconcileBitfsTransactions({ journal: transactionJournal, broadcaster, signal: controller.signal });
    await reconcileBitfsSessionTransactions({ sessions, outcomes, nowMs: Date.now() });
    if (controller.signal.aborted || msfileSellerIndexController !== controller
      || deps.session().activePublicKeyHex !== ownerPublicKeyHex || deps.service() !== service) return "waiting-unlock";
    msfileBitfsTransactionJournal = transactionJournal;
    msfileBitfsBroadcaster = broadcaster;
    msfileSellerRuntime = new BitfsSellerRuntime({
      signer,
      index,
      journal,
      sessions,
      settings: () => service.describeState().sellerSettings,
      nowMs: () => Date.now(),
      allowLoopbackWs: deps.allowLoopback(),
    });
    const sellerContent = woc
      ? createBitfsLocalSellerContentResolver({
        content: createMsFileLocalContentSource(contentStore, { onReadFailure: (seedHashHex) => index.invalidate(seedHashHex) }),
        nowMs: () => Date.now(),
        blockHeight: () => deps.blockHeight(deps.network()),
      })
      : createUnavailableBitfsSellerContentResolver();
    const protocolPort = testMsfileSellerBridge?.protocol ?? new BitfsSellerProtocol({
      signer,
      sessions,
      content: sellerContent,
      broadcaster,
       ownerPublicKeyHex,
       generation: () => msfileSellerSessionEpoch,
       runtimeInstanceId: () => runtimeInstanceId,
       nowMs: () => Date.now(),
      blockHeight: () => deps.blockHeight(deps.network()),
      onPaymentTransaction: async ({ txid, rawTxHex }) => {
        const wocConfig = deps.woc()?.getConfig();
        await writeBitfsE2eDiagnostic("seller-payment-transaction.json", {
          txid,
          rawTxHex,
          network: deps.network(),
          wocBaseUrl: wocConfig?.baseUrl,
        });
      },
    });
    const transport = testMsfileSellerBridge?.transport ?? createMsfileSellerStreamTransport();
    const manager: BitfsSellerSessionManager = new BitfsSellerSessionManager({
      transport,
      protocol: protocolPort,
      nowMs: () => Date.now(),
      // 报价期限是最短会话空闲时间；给对端留出付款与交付窗口。
      idleTimeoutMs: () => Math.max(30_000, service.describeState().sellerSettings.quoteLifetimeSeconds * 1_000),
      maxSessions: () => service.describeState().sellerSettings.maxConcurrentSales,
      onActiveSessionsChanged: (activeCount) => {
        if (msfileSellerSessionManager !== manager) return;
        if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex !== ownerPublicKeyHex) return;
        service.setSellerRuntimeStatus(activeCount > 0
          ? "selling"
          : (protocolPort.ready && msfileSellerTransportAvailable() ? "ready" : "degraded"));
      },
      isCurrent: () => msfileSellerSessionManager === manager
        && !controller.signal.aborted
        && deps.session().activePublicKeyHex === ownerPublicKeyHex
        && deps.service() === service,
      onProtocolError: async ({ sessionId, message, stack }) => {
        await writeBitfsE2eDiagnostic("seller-protocol-frame-error.json", { sessionId, message, stack });
      },
      onSessionClosed: async ({ sessionId, reason, atMs }) => {
        await writeBitfsE2eDiagnostic("seller-session-close.json", { sessionId, reason, atMs });
      },
    });
    const sat = await deps.ensureChannel();
    if (sat.ownerPublicKeyHex !== ownerPublicKeyHex) return "waiting-unlock";
    if (controller.signal.aborted || msfileSellerIndexController !== controller
      || deps.session().activePublicKeyHex !== ownerPublicKeyHex || deps.service() !== service) return "waiting-unlock";
    await deps.sellerSubscriptions(sat);
    if (controller.signal.aborted || msfileSellerIndexController !== controller
      || deps.session().activePublicKeyHex !== ownerPublicKeyHex || deps.service() !== service) return "waiting-unlock";
    msfileSellerProtocolPort = protocolPort;
    msfileSellerSessionManager = manager;
    void drainMsfilePendingSellerHashRequests();
    // 协议端口未就绪时只能保持 degraded：不报价、不暴露库存。
    return protocolPort.ready ? "ready" : "degraded";
  } catch (error) {
    if (controller.signal.aborted) return "waiting-unlock";
    // 依赖在装配途中变得不可用：这仍然是「还没好」，不是配置坏了。不拆解、
    // 不报永久错误；订阅就绪后自动重跑，用户不需要手动再切一次开关。
    if (deps.isUnavailable(error)) {
      controller.abort();
      watchMsfileSellerDependency(service, ownerPublicKeyHex);
      return "waiting-dependency";
    }
    console.warn("[msfile] seller runtime configuration failed", error instanceof Error ? error.message : String(error));
    stopMsfileSellerRuntime();
    return "configuration-error";
  }
}

/**
 * 消费一条已验证 Hash 请求：命中完整 Seed 且 locator 兼容时建立销售会话。
 *
 * 中文说明：只处理 ChannelProtocol 已验签的 VerifiedHashRequest；未命中保持
 * 静默。报价只在协议端口就绪时产生，且报价字节由 journal 先落盘。
 */
async function writeBitfsE2eDiagnostic(path: string, value: unknown): Promise<void> {
  if (!deps.diagnosticsEnabled()) return;
  try {
    const store = deps.files( "");
    await store.put(`bitfs-e2e-diagnostics/${path}`, new TextEncoder().encode(JSON.stringify(value)));
  } catch (error) {
    console.warn("[msfile] BitFS E2E diagnostic write failed", error instanceof Error ? error.message : String(error));
  }
}

async function drainMsfilePendingSellerHashRequests(): Promise<void> {
  if (msfilePendingSellerHashRequestDrain) return;
  msfilePendingSellerHashRequestDrain = (async () => {
    while (msfileSellerRuntime && msfileSellerSessionManager && msfileSellerProtocolPort && deps.service() && msfileSellerTransportAvailable()) {
      const next = msfilePendingSellerHashRequests.entries().next().value as [string, import("bsv8-channel-protocol/hash-request").VerifiedHashRequest] | undefined;
      if (!next) return;
      const [key, request] = next;
      msfilePendingSellerHashRequests.delete(key);
      if (request.expires_at_ms <= Date.now()) continue;
      await handleMsfileSellerHashRequest(request);
    }
  })().finally(() => {
    msfilePendingSellerHashRequestDrain = undefined;
  });
  await msfilePendingSellerHashRequestDrain;
}

async function handleMsfileSellerHashRequest(
  request: import("bsv8-channel-protocol/hash-request").VerifiedHashRequest,
): Promise<void> {
  const runtime = msfileSellerRuntime;
  const manager = msfileSellerSessionManager;
  const protocolPort = msfileSellerProtocolPort;
  const service = deps.service();
  await writeBitfsE2eDiagnostic("seller-hash-request-entry.json", {
    hash: request.body.hash,
    from: request.from_public_key,
    expiresAtMs: request.expires_at_ms,
    hasRuntime: runtime !== undefined,
    hasManager: manager !== undefined,
    hasProtocol: protocolPort !== undefined,
    protocolReady: protocolPort?.ready === true,
    hasService: service !== undefined,
    activeCount: manager?.activeCount(),
    maxSales: service?.describeState().sellerSettings.maxConcurrentSales,
    quoteLifetimeSeconds: service?.describeState().sellerSettings.quoteLifetimeSeconds,
    observedAtMs: Date.now(),
    owner: deps.session().activePublicKeyHex,
    sessionEpoch: deps.session().sessionEpoch
  });
  if (!runtime || !manager || !protocolPort || !service || !msfileSellerTransportAvailable()) {
    if (request.expires_at_ms > Date.now()) {
      msfilePendingSellerHashRequests.set(`${request.from_public_key}:${request.message_id}`, request);
    }
    return;
  }
  if (!protocolPort.ready) {
    if (request.expires_at_ms > Date.now()) {
      msfilePendingSellerHashRequests.set(`${request.from_public_key}:${request.message_id}`, request);
    }
    return;
  }
  if (deps.session().vaultStatus !== "unlocked" || !deps.session().activePublicKeyHex) return;
  const ownerPublicKeyHex = deps.session().activePublicKeyHex;
  const epoch = msfileSellerSessionEpoch;
  if (manager.activeCount() >= service.describeState().sellerSettings.maxConcurrentSales) return;
  const index = msfileSellerIndex;
  let indexedSeed = index?.get(request.body.hash);
  if (index && (!indexedSeed || indexedSeed.availability !== "available")) {
    try {
      const contentStore = deps.files( "");
      const indexGeneration = index.currentGeneration();
      index.invalidate(request.body.hash);
      await index.refresh(contentStore, request.body.hash, indexGeneration);
      indexedSeed = index.get(request.body.hash);
    } catch (error) {
      console.warn("[msfile] seller hash request index refresh failed", error instanceof Error ? error.message : String(error));
    }
  }
  console.warn("[msfile] seller hash request", request.body.hash, indexedSeed?.availability ?? "missing");
  const indexDiagnosticStore = deps.files( "");
  const indexMeta = await indexDiagnosticStore.get(`meta/${request.body.hash}.json`).catch(() => undefined);
  const indexSeed = await indexDiagnosticStore.get(`seeds/${request.body.hash}.ms`).catch(() => undefined);
  let indexBlocks: Awaited<ReturnType<typeof indexDiagnosticStore.list>> | undefined;
  let indexListError: string | undefined;
  try {
    indexBlocks = await indexDiagnosticStore.list({ prefix: `storage/${request.body.hash}/`, limit: 200 });
  } catch (error) {
    indexListError = error instanceof Error ? error.message : String(error);
  }
  await writeBitfsE2eDiagnostic("seller-hash-request-index.json", {
    hash: request.body.hash,
    availability: indexedSeed?.availability ?? "missing",
    fileName: indexedSeed?.fileName,
    fileSizeBytes: indexedSeed?.fileSizeBytes,
    blockCount: indexedSeed?.blockCount,
    metaBytes: indexMeta?.bytes.byteLength ?? null,
    seedBytes: indexSeed?.bytes.byteLength ?? null,
    listedBlocks: indexBlocks?.files.length ?? null,
    nextCursor: indexBlocks?.nextCursor ?? null,
    listError: indexListError ?? null
  });
  let match: BitfsSellerMatch | null;
  try {
    match = await runtime.match(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.warn("[msfile] seller hash request match failed", error instanceof Error ? error.message : String(error));
    await writeBitfsE2eDiagnostic("seller-hash-request-match.json", { hash: request.body.hash, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  await writeBitfsE2eDiagnostic("seller-hash-request-match.json", { hash: request.body.hash, matched: match !== null });
  if (!match) {
    console.warn("[msfile] seller hash request did not match", request.body.hash);
    return;
  }
  // match 期间可能发生锁定、切 Key、关闭卖方或 runtime 重建；迟到结果不得建会话。
  if (epoch !== msfileSellerSessionEpoch
    || msfileSellerRuntime !== runtime
    || msfileSellerSessionManager !== manager
    || deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex !== ownerPublicKeyHex) return;
  try {
    const publicKeyHex = request.from_public_key;
    const sessionId = match.resumeSessionId ?? crypto.randomUUID();
    const webrtcSessionId = newSessionID();
    await manager.start({
      sessionId,
      transport: match.transport,
      requestMessageId: match.requestMessageId,
      addresses: match.addresses,
      webrtcSessionId,
      publicKeyHex,
      // 只从已验证公钥派生 PeerId；不使用请求者自报的 locator PeerId。
      expectedPeerId: peerIdFromPublicKeyBytes(deps.hexToBytes(publicKeyHex)).toString(),
      quoteBytes: match.quoteBytes,
      seedHashHex: match.seedHashHex,
    });
    await writeBitfsE2eDiagnostic("seller-session-start.json", { sessionId, webrtcSessionId, matched: true });
  } catch (error) {
    await writeBitfsE2eDiagnostic("seller-session-start.json", { matched: true, error: error instanceof Error ? error.message : String(error) });
    console.warn("[msfile] seller session start failed", error instanceof Error ? error.message : String(error));
  }
}

/** 买方只接受引用自己有效 Hash 请求的已验签 offer，并用 ChannelProtocol answer 回答。 */
async function acceptMsfileBitfsWebRtcOffer(input: {
  requestMessageId: string;
  webrtcSessionId: string;
  peerPublicKeyHex: string;
  seedHashHex: string;
  offerSdp: string;
}): Promise<void> {
  const request = msfileBitfsBuyerRequests.get(input.requestMessageId);
  await writeBitfsE2eDiagnostic("buyer-webrtc-offer.json", {
    requestMessageId: input.requestMessageId,
    webrtcSessionId: input.webrtcSessionId,
    peerPublicKeyHex: input.peerPublicKeyHex,
    seedHashHex: input.seedHashHex,
    hasRequest: request !== undefined,
    requestMatches: request?.ownerPublicKeyHex === deps.session().activePublicKeyHex
      && request?.ownerSessionEpoch === deps.session().sessionEpoch
      && request?.seedHashHex === input.seedHashHex,
    requestExpired: request !== undefined && request.expiresAtMs <= Date.now(),
    hasRuntime: deps.channel() !== undefined,
    existingLink: msfileBitfsWebRtcBuyerLinks.has(input.webrtcSessionId)
  });
  if (!request || request.expiresAtMs <= Date.now()
    || request.ownerPublicKeyHex !== deps.session().activePublicKeyHex
    || request.ownerSessionEpoch !== deps.session().sessionEpoch
    || request.seedHashHex !== input.seedHashHex) return;
  if (msfileBitfsWebRtcBuyerLinks.has(input.webrtcSessionId)) return;
  const runtime = deps.channel();
  if (!runtime || runtime.ownerPublicKeyHex !== request.ownerPublicKeyHex) return;
  const existingPeerLink = [...msfileBitfsWebRtcBuyerLinks.values()].some((link) =>
    link.requestMessageId === input.requestMessageId
      && link.peerPublicKeyHex === input.peerPublicKeyHex.toLowerCase()
      && link.ownerSessionEpoch === request.ownerSessionEpoch);
  if (existingPeerLink || msfileBitfsWebRtcBuyerLinks.size >= MSFILE_BITFS_MAX_ACTIVE_BUYER_LINKS) return;
  const offerCount = msfileBitfsBuyerOfferCounts.get(input.requestMessageId) ?? 0;
  if (offerCount >= MSFILE_BITFS_MAX_OFFERS_PER_DEMAND) return;
  msfileBitfsBuyerOfferCounts.set(input.requestMessageId, offerCount + 1);
  const transportSessionId = crypto.randomUUID();
  const link = {
    transportSessionId,
    requestMessageId: input.requestMessageId,
    peerPublicKeyHex: input.peerPublicKeyHex.toLowerCase(),
    ownerPublicKeyHex: request.ownerPublicKeyHex,
    seedHashHex: request.seedHashHex,
    task: request.task,
    ownerSessionEpoch: request.ownerSessionEpoch,
  };
  // 在创建 PeerConnection 和发布 answer 前登记，容纳 DataChannel 立即回传的 Kind 1。
  msfileBitfsWebRtcBuyerLinks.set(input.webrtcSessionId, link);
  try {
    await deps.executor({
      type: "lane",
      laneId: "msfile",
      operation: {
        type: "bitfs-webrtc-buyer-offer",
        sessionId: transportSessionId,
        requestMessageId: input.requestMessageId,
        webrtcSessionId: input.webrtcSessionId,
        publicKeyHex: input.peerPublicKeyHex,
        offerSdp: input.offerSdp,
      },
    }, runtime.signal);
    if (link.ownerSessionEpoch !== deps.session().sessionEpoch
      || deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex !== request.ownerPublicKeyHex) {
      throw new Error("BitFS buyer owner changed while accepting an offer");
    }
    await writeBitfsE2eDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: true });
  } catch (error) {
    await writeBitfsE2eDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: false, error: error instanceof Error ? error.message : String(error) });
    if (msfileBitfsWebRtcBuyerLinks.get(input.webrtcSessionId) === link) {
      msfileBitfsWebRtcBuyerLinks.delete(input.webrtcSessionId);
    }
    msfileBitfsBuyerOfferCounts.set(input.requestMessageId, Math.max(0, (msfileBitfsBuyerOfferCounts.get(input.requestMessageId) ?? 1) - 1));
    await deps.executor({
      type: "lane",
      laneId: "msfile",
      operation: { type: "bitfs-seller-close", sessionId: transportSessionId, reason: "answer_failed" },
    }).catch(() => undefined);
    throw error;
  }
}

function bitfsWebRtcEnvelopeBody(requestMessageId: string, webrtcSessionId: string, envelope: WebRTCInterconnectEnvelope): ReturnType<typeof newOffer> | undefined {
  const requestId = parseMessageID(requestMessageId);
  const sessionId = parseSessionID(webrtcSessionId);
  if (envelope.signal.type === "offer") return newOffer(requestId, sessionId, envelope.signal.sdp);
  if (envelope.signal.type === "answer") return newAnswer(requestId, sessionId, envelope.signal.sdp);
  if (envelope.signal.type === "end-of-candidates") return newEndOfCandidatesSignal(requestId, sessionId);
  if (envelope.signal.type === "ice-candidate") {
    if (envelope.signal.candidate == null) return newEndOfCandidatesSignal(requestId, sessionId);
    return newIceSignal(requestId, sessionId, {
      candidate: envelope.signal.candidate.candidate,
      sdp_mid: envelope.signal.candidate.sdpMid ?? null,
      sdp_m_line_index: envelope.signal.candidate.sdpMLineIndex ?? null
    });
  }
  return undefined;
}

/** Window lane 的 BitFS 事件只允许路由到当前唯一卖方会话管理器。 */
function handleBitfsSellerStreamEvent(rawEvent: unknown, lease: BitfsExecutorLease): void {
  if (!rawEvent || typeof rawEvent !== "object") return;
  const event = rawEvent as {
    /** Window lane 事件类型。 */
    type?: unknown;
    /** Worker 侧 BitFS 会话编号。 */
    sessionId?: unknown;
    /** 创建连接时的 owner 会话世代。 */
    ownerSessionEpoch?: unknown;
    /** ChannelProtocol WebRTC 会话编号。 */
    webrtcSessionId?: unknown;
    /** 已通过接收侧校验的原始 Artifact。 */
    frame?: unknown;
     /** 稳定关闭原因。 */
       reason?: unknown;
       errorCode?: unknown;
       errorMessage?: unknown;
       errorName?: unknown;
       /** WebRTC runtime 错误方向。 */
     direction?: unknown;
     /** WebRTC runtime 错误消息。 */
     message?: unknown;
      /** WebRTC runtime 错误名称。 */
      name?: unknown;
      requestMessageId?: unknown;
      publicKeyHex?: unknown;
      envelope?: unknown;
   };
  const manager = msfileSellerSessionManager;
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) return;
  // 旧 lease/旧 owner 的迟到事件不得进入新会话。
  if (event.ownerSessionEpoch !== lease.sessionEpoch) return;
  void writeBitfsE2eDiagnostic("webrtc-stream-event.json", {
    type: event.type,
    sessionId: event.sessionId,
    webrtcSessionId: event.webrtcSessionId,
    reason: event.reason,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    errorName: event.errorName,
    frameBytes: event.frame instanceof Uint8Array ? event.frame.byteLength : null,
    observedAtMs: Date.now(),
    leaseSessionEpoch: lease.sessionEpoch
  });
  if (event.type === "bitfs-webrtc-signal-outbound") {
    if (typeof event.webrtcSessionId !== "string" || typeof event.requestMessageId !== "string"
      || typeof event.publicKeyHex !== "string" || event.envelope == null || typeof event.envelope !== "object") return;
    const sellerLink = msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId);
    const buyerLink = msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId);
    const link = sellerLink ?? buyerLink;
    if (!link || link.requestMessageId !== event.requestMessageId
      || link.peerPublicKeyHex !== event.publicKeyHex.toLowerCase()
      || link.ownerSessionEpoch !== deps.session().sessionEpoch) return;
    const envelope = event.envelope as WebRTCInterconnectEnvelope;
    if (envelope.signal.type === "close") {
      if (sellerLink) msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId);
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId);
      void deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId: event.sessionId, reason: "transport_closed" },
      }).catch(() => undefined);
      return;
    }
    let body;
    try {
      body = bitfsWebRtcEnvelopeBody(event.requestMessageId, event.webrtcSessionId, envelope);
    } catch {
      return;
    }
    if (body == null) return;
    const runtime = deps.channel();
    if (!runtime || runtime.ownerPublicKeyHex !== deps.session().activePublicKeyHex) return;
    void deps.publishPrivate({
      runtime,
      recipientPublicKeyHex: event.publicKeyHex,
      protocol: WEBRTC_SIGNAL_PROTOCOL,
      body,
      signal: runtime.signal
    }).catch(async error => {
      if (sellerLink) msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId as string);
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId as string);
      await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId: event.sessionId as string, reason: "signal_publish_failed" },
      }).catch(() => undefined);
      await writeBitfsE2eDiagnostic("webrtc-signal-publish-error.json", {
        webrtcSessionId: event.webrtcSessionId,
        sessionId: event.sessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return;
  }
  if (event.type === "bitfs-webrtc-runtime-error") {
    void writeBitfsE2eDiagnostic("webrtc-runtime-error.json", {
      sessionId: event.sessionId,
      webrtcSessionId: event.webrtcSessionId,
      direction: event.direction,
      message: event.message,
      name: event.name,
      leaseSessionEpoch: lease.sessionEpoch,
    });
    return;
  }
  if (event.type === "bitfs-webrtc-session-closed") {
    void writeBitfsE2eDiagnostic("webrtc-session-close.json", {
      sessionId: event.sessionId,
      webrtcSessionId: event.webrtcSessionId,
      reason: event.reason,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      errorName: event.errorName,
      observedAtMs: Date.now(),
    });
    if (typeof event.webrtcSessionId === "string") msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId);
    if (typeof event.webrtcSessionId === "string") {
      const buyerLink = msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId);
      if (buyerLink) msfileBitfsBuyerWebRtcFailure(
        buyerLink,
        event.webrtcSessionId,
        event.sessionId,
        typeof event.reason === "string" ? event.reason : "stream_error",
      );
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId);
    }
    void manager?.close(event.sessionId, typeof event.reason === "string" ? event.reason : "stream_error").catch(() => undefined);
    return;
  }
  if (event.type === "bitfs-webrtc-frame") {
    if (!(event.frame instanceof Uint8Array) || typeof event.webrtcSessionId !== "string") return;
    const sellerLink = msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId);
    if (sellerLink && sellerLink.sessionId === event.sessionId
      && sellerLink.ownerSessionEpoch === deps.session().sessionEpoch) {
       void manager?.handleFrame({ sessionId: event.sessionId, frame: event.frame }).catch(async (error) => {
         const message = error instanceof Error ? error.message : String(error);
         await writeBitfsE2eDiagnostic("seller-protocol-frame-error.json", {
           sessionId: event.sessionId,
           webrtcSessionId: event.webrtcSessionId,
           message,
           stack: error instanceof Error ? error.stack : undefined
         });
       });
       return;
    }
    const buyerLink = msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId);
    if (!buyerLink || buyerLink.transportSessionId !== event.sessionId
      || buyerLink.ownerSessionEpoch !== deps.session().sessionEpoch) return;
    if (buyerLink.quoteSessionId) {
      // 公开需求只负责发现卖家。报价已验签后，后续开池、交付和付款在同一条
      // 已关联的 DataChannel 上继续，即使公开 Hash 请求到期也不切断购买会话。
      void (async () => {
        await buyerLink.quoteAccepted;
        const protocol = await ensureMsfileBitfsBuyerProtocol(event.webrtcSessionId as string, buyerLink);
        await protocol.onFrame({
          sessionId: buyerLink.quoteSessionId!,
          rawArtifact: (event.frame as Uint8Array).slice(),
          stream: {
            send: async (frame) => {
              if (msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId as string) !== buyerLink) throw new Error("BitFS 买方 DataChannel 已关闭");
              await deps.executor({
                type: "lane",
                laneId: "msfile",
                operation: { type: "bitfs-seller-send", sessionId: buyerLink.transportSessionId, frame },
              });
            },
          },
        });
       })().catch(async (error) => {
         const message = error instanceof Error ? error.message : String(error);
         console.warn("[msfile] BitFS buyer protocol frame failed", message);
         await writeBitfsE2eDiagnostic("buyer-protocol-frame-error.json", {
           webrtcSessionId: event.webrtcSessionId,
           sessionId: event.sessionId,
           message,
           stack: error instanceof Error ? error.stack : undefined
         });
         await writeBitfsE2eDiagnostic(`buyer-protocol-${Date.now()}-error.json`, {
           webrtcSessionId: event.webrtcSessionId,
           sessionId: event.sessionId,
           message,
           stack: error instanceof Error ? error.stack : undefined
         });
         msfileBitfsBuyerWebRtcFailure(buyerLink, event.webrtcSessionId as string, event.sessionId as string, "buyer_protocol_error");
       });
      return;
    }
    const activeRequest = msfileBitfsBuyerRequests.get(buyerLink.requestMessageId);
    if (!activeRequest || activeRequest.expiresAtMs <= Date.now()) {
      msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId);
      msfileBitfsBuyerOfferCounts.set(buyerLink.requestMessageId, Math.max(0, (msfileBitfsBuyerOfferCounts.get(buyerLink.requestMessageId) ?? 1) - 1));
      void deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId: event.sessionId, reason: "demand_expired" },
      }).catch(() => undefined);
      return;
    }
    const freshQuoteSessionId = `quote-${crypto.randomUUID()}`;
    buyerLink.quoteSessionId = freshQuoteSessionId;
    buyerLink.quoteAccepted = (async () => {
      const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
      const resumablePhases = new Set([
        "opening-presign", "funding-prepared", "funding-unknown", "funded", "request-prepared",
        "delivery-verified", "payment-unknown", "content-committing", "close-required", "close-requested",
        "close-unknown", "cancel-closing-pool", "cancel-close-unknown",
      ]);
      const matches: string[] = [];
      for (const saved of await sessions.list()) {
        if (saved.role !== "buyer" || saved.ownerPublicKeyHex !== buyerLink.ownerPublicKeyHex.toLowerCase()
          || saved.counterpartyPublicKeyHex !== buyerLink.peerPublicKeyHex.toLowerCase()
          || saved.seedHashHex !== buyerLink.seedHashHex.toLowerCase()
          || !resumablePhases.has(saved.phase)
          || !saved.evidence.includes("kind2-opening-request")) continue;
        const savedQuote = await sessions.getEvidence(saved.sessionId, "kind1-quote");
        if (savedQuote && equalMsfileBytes(savedQuote, event.frame as Uint8Array)) matches.push(saved.sessionId);
      }
      if (matches.length === 1) {
        const resumedSessionId = matches[0]!;
        buyerLink.quoteSessionId = resumedSessionId;
        buyerLink.resumedPurchaseSessionId = resumedSessionId;
        await buyerLink.task.acceptQuote({
          sessionId: resumedSessionId,
          counterpartyPublicKeyHex: buyerLink.peerPublicKeyHex,
          rawKind1: event.frame as Uint8Array,
        });
      } else {
        await buyerLink.task.acceptDiscoveredQuote({
          sessionId: freshQuoteSessionId,
          requestMessageId: buyerLink.requestMessageId,
          counterpartyPublicKeyHex: buyerLink.peerPublicKeyHex,
          rawKind1: event.frame as Uint8Array,
        });
      }
     })().then(() => undefined).catch(async (error) => {
       void writeBitfsE2eDiagnostic("buyer-webrtc-quote-error.json", {
         requestMessageId: buyerLink.requestMessageId,
         webrtcSessionId: event.webrtcSessionId,
         message: error instanceof Error ? error.message : String(error)
       });
       if (msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId as string) === buyerLink) {
        msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId as string);
      }
      msfileBitfsBuyerOfferCounts.set(buyerLink.requestMessageId, Math.max(0, (msfileBitfsBuyerOfferCounts.get(buyerLink.requestMessageId) ?? 1) - 1));
      await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId: event.sessionId as string, reason: "invalid_quote" },
      }).catch(() => undefined);
      throw error;
    });
    void buyerLink.quoteAccepted.then(async () => {
      if (buyerLink.resumedPurchaseSessionId) {
        const protocol = await ensureMsfileBitfsBuyerProtocol(event.webrtcSessionId as string, buyerLink);
        await protocol.resumePurchase({
          sessionId: buyerLink.resumedPurchaseSessionId,
          stream: createMsfileBitfsBuyerStream(event.webrtcSessionId as string, buyerLink),
        });
        return;
      }
      await maybeAutoStartMsfileBitfsBuyerPurchase({
        ownerPublicKeyHex: buyerLink.ownerPublicKeyHex,
        seedHashHex: buyerLink.seedHashHex,
        task: buyerLink.task,
      });
     }).catch(async (error) => {
       const message = error instanceof Error ? error.message : String(error);
       console.warn("[msfile] BitFS automatic purchase check failed", message);
        await writeBitfsE2eDiagnostic("buyer-protocol-auto-error.json", {
          webrtcSessionId: event.webrtcSessionId,
          sessionId: event.sessionId,
          message,
          stack: error instanceof Error ? error.stack : undefined
        });
       msfileBitfsBuyerWebRtcFailure(buyerLink, event.webrtcSessionId as string, event.sessionId as string, "buyer_protocol_error");
     });
    return;
  }
  if (!manager) return;
  if (event.type === "bitfs-seller-session-closed") {
    void manager.close(event.sessionId, typeof event.reason === "string" ? event.reason : "stream_error").catch(() => undefined);
    return;
  }
  if (event.type !== "bitfs-seller-frame" || !(event.frame instanceof Uint8Array)) return;
  void manager.handleFrame({ sessionId: event.sessionId, frame: event.frame }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await writeBitfsE2eDiagnostic("seller-protocol-frame-error.json", {
      sessionId: event.sessionId,
      webrtcSessionId: event.webrtcSessionId,
      message,
      stack: error instanceof Error ? error.stack : undefined
    });
  });
}


let msfileMutationTail: Promise<void> = Promise.resolve();
function msfileError(code: MsFileErrorCode, message: string): Error & { code: MsFileErrorCode } {
  return Object.assign(new Error(message), { code });
}
const MSFILE_MUTATION_CONTROLS = new Set<CoordinatorMsFileControl["type"]>([
  "settings.global.update",
  "settings.seller.update",
  "settings.bitfsBuyer.update",
  "bitfs.buyerPriceLimit.update",
  "settings.readConcurrency.update",
  "settings.readConcurrency.reset",
  "settings.mediaBlockReadConcurrency.update",
  "bitfs.demand.publish",
  "bitfs.demand.cancel",
  "bitfs.purchase.start",
  "bitfs.purchase.cancel",
  "supplier.upsert",
  "supplier.delete",
  "app-policy.update",
  "app-policy.clear",
  "approval.resolve"
]);

function isMsfileMutationControl(control: CoordinatorMsFileControl): boolean {
  return MSFILE_MUTATION_CONTROLS.has(control.type);
}

async function executeMsfileControl(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>,
  signal?: AbortSignal,
): Promise<CoordinatorResponse> {
  if (!isMsfileMutationControl(request.control)) {
    return executeMsfileControlNow(request, signal);
  }
  // mutation 进串行尾；前一个失败不阻塞后续。
  const run = msfileMutationTail.then(() => executeMsfileControlNow(request, signal), () => executeMsfileControlNow(request, signal));
  msfileMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 桶内文件块写入的 Worker 侧并发上限。
 *
 * 页面 storage 数据面每个端口只允许 3 个并发请求；批量上传如果逐块走
 * 那条通道，远端一次 PUT 的延迟就是瓶颈。桶块由 Coordinator 直接写
 * OwnerFileStore，这里给出一个有界并发，既提高吞吐又不放大内存。
 */
const MSFILE_BUCKET_BLOCK_WRITE_MAX_CONCURRENCY = 16;
let msfileBucketBlockWritesActive = 0;
const msfileBucketBlockWriteWaiters: Array<() => void> = [];

async function withMsfileBucketBlockWriteSlot<T>(run: () => Promise<T>): Promise<T> {
  while (msfileBucketBlockWritesActive >= MSFILE_BUCKET_BLOCK_WRITE_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => { msfileBucketBlockWriteWaiters.push(resolve); });
  }
  msfileBucketBlockWritesActive += 1;
  try {
    return await run();
  } finally {
    msfileBucketBlockWritesActive = Math.max(0, msfileBucketBlockWritesActive - 1);
    msfileBucketBlockWriteWaiters.shift()?.();
  }
}

async function executeMsfileControlNow(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>,
  signal?: AbortSignal,
): Promise<CoordinatorResponse> {
  // 审查修复：排队中的请求必须携带其入队时的 epoch；任务开始时与当前 epoch
  // 比较——入队后发生 lock/unlock/key switch 都会推进 epoch，从而在此被拒。
  const requestEpoch = request.expectedSessionEpoch;
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  if (deps.session().vaultStatus !== "unlocked") {
    return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "locked" } };
  }
  if (requestEpoch !== deps.session().sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "stale-epoch" } };
  }
  const service = await deps.ensureService();
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  const runtimeAtStart = service;
  const control: CoordinatorMsFileControl = request.control;
  // 同世代检查在串行任务内部执行，天然免受并发窗口影响。
  const supplierGenerationNow = (): number => deps.service() === runtimeAtStart ? service.describeState().supplierGeneration : -1;
  let value: unknown;
  switch (control.type) {
    case "settings.get": value = await service.getSettingsSnapshot(); break;
    case "settings.readConcurrency.get": value = await service.getReadConcurrencySettings(); break;
    case "settings.readConcurrency.update": await service.updateReadConcurrencySettings(control.input); value = null; break;
    case "settings.readConcurrency.reset": await service.resetReadConcurrencySettings(); value = null; break;
    case "settings.mediaBlockReadConcurrency.get": value = await service.getMediaBlockReadConcurrency(); break;
    case "settings.mediaBlockReadConcurrency.update": await service.updateMediaBlockReadConcurrency(control.mediaBlockReadConcurrency); value = null; break;
    case "settings.global.update": await service.updateGlobalPriceSettings(control.input); value = null; break;
    case "settings.seller.update": await service.updateSellerSettings(control.input); value = null; break;
    case "settings.bitfsBuyer.get": {
      if (!service.getBitfsBuyerSettings) throw new Error("当前 MSFile 运行单元不支持 BitFS 买方设置");
      value = await service.getBitfsBuyerSettings();
      break;
    }
    case "settings.bitfsBuyer.update": {
      if (!service.updateBitfsBuyerSettings) throw new Error("当前 MSFile 运行单元不支持 BitFS 买方设置");
      await service.updateBitfsBuyerSettings(control.input);
      value = null;
      break;
    }
    case "bitfs.buyerPriceLimit.update": {
      if (!service.getBitfsBuyerSettings || !service.updateBitfsBuyerSettings) {
        throw new Error("当前 MSFile 运行单元不支持 BitFS 单文件价格上限");
      }
      const settings = await service.getBitfsBuyerSettings();
      const filePriceLimitsBySeedHash = { ...(settings.filePriceLimitsBySeedHash ?? {}) };
      filePriceLimitsBySeedHash[control.seedHashHex] = control.maxFullBlockPriceSatoshis;
      await service.updateBitfsBuyerSettings({ ...settings, filePriceLimitsBySeedHash });
      value = null;
      break;
    }
    case "bitfs.demand.publish": {
      if (!isValidMsFileHashHex(control.seedHashHex)) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "BitFS Seed Hash 必须是 64 位小写十六进制字符" } };
      }
      const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
      if (!owner) throw new Error("请先解锁当前 Key 再发布 BitFS 需求");
      await ensureMsfileBitfsBuyerRecovery(owner);
      const { task, entry } = await ensureMsfileBitfsBuyerTask({
        ownerPublicKeyHex: owner,
        seedHashHex: control.seedHashHex,
      });
      const sessionJournal = createBitfsSessionJournal(deps.files("bitfs-journal"));
      const resumable = (await sessionJournal.list()).filter((saved) => saved.role === "buyer"
        && saved.ownerPublicKeyHex === owner
        && saved.seedHashHex === control.seedHashHex.toLowerCase()
        && saved.evidence.includes("kind2-opening-request")
        && !["completed", "cancelled", "refunded", "failed"].includes(saved.phase));
      const resumeTarget = entry.purchase?.sessionId
        ? resumable.find((saved) => saved.sessionId === entry.purchase?.sessionId)
        : resumable.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const resumeLinkAlive = resumeTarget && [...msfileBitfsWebRtcBuyerLinks.values()].some((link) =>
        link.ownerSessionEpoch === deps.session().sessionEpoch
        && link.ownerPublicKeyHex.toLowerCase() === owner
        && (link.quoteSessionId === resumeTarget.sessionId
          || link.resumedPurchaseSessionId === resumeTarget.sessionId
          || (link.seedHashHex === resumeTarget.seedHashHex
            && link.peerPublicKeyHex === resumeTarget.counterpartyPublicKeyHex
            && link.requestMessageId === entry.requestMessageId)));
      if (entry.purchase?.phase === "connection-closed" || (resumeTarget && !resumeLinkAlive)) {
        // 旧公开 Hash 请求仍可能收到迟到 offer，但已断开的 DataChannel
        // 无法续用。为恢复同一卖方日志会话发布新的 Hash 请求编号。
        const oldRequestIds = new Set<string>();
        for (const [messageId, buyerRequest] of msfileBitfsBuyerRequests) {
          if (buyerRequest.ownerSessionEpoch === deps.session().sessionEpoch
            && buyerRequest.ownerPublicKeyHex.toLowerCase() === owner
            && buyerRequest.seedHashHex === control.seedHashHex.toLowerCase()) {
            oldRequestIds.add(messageId);
            msfileBitfsBuyerRequests.delete(messageId);
            msfileBitfsBuyerOfferCounts.delete(messageId);
          }
        }
        for (const [webrtcSessionId, buyerLink] of msfileBitfsWebRtcBuyerLinks) {
          if (buyerLink.ownerSessionEpoch !== deps.session().sessionEpoch
            || buyerLink.ownerPublicKeyHex.toLowerCase() !== owner
            || buyerLink.seedHashHex !== control.seedHashHex.toLowerCase()
            || !oldRequestIds.has(buyerLink.requestMessageId)) continue;
          msfileBitfsWebRtcBuyerLinks.delete(webrtcSessionId);
          await deps.executor({
            type: "lane",
            laneId: "msfile",
            operation: { type: "bitfs-seller-close", sessionId: buyerLink.transportSessionId, reason: "buyer_reconnect" },
          }).catch(() => undefined);
        }
        await task.cancelDemand();
        entry.requestMessageId = undefined;
        entry.expiresAtMs = 0;
      }
      const requestMessageId = await task.publishDemand();
      entry.requestMessageId = requestMessageId;
      if (entry.expiresAtMs <= Date.now()) entry.expiresAtMs = Date.now() + 10 * 60 * 1_000;
      value = await msfileBitfsBuyerDemandSnapshot(control.seedHashHex, entry, task);
      break;
    }
    case "bitfs.demand.snapshot": {
      if (!isValidMsFileHashHex(control.seedHashHex)) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "BitFS Seed Hash 必须是 64 位小写十六进制字符" } };
      }
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      const entry = owner ? msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, control.seedHashHex)) : undefined;
      const task = entry?.ownerSessionEpoch === deps.session().sessionEpoch ? await entry.taskPromise : undefined;
      value = await msfileBitfsBuyerDemandSnapshot(control.seedHashHex, entry, task);
      break;
    }
    case "bitfs.purchase.start": {
      value = await startMsfileBitfsBuyerPurchase({
        seedHashHex: control.seedHashHex,
        sessionId: control.sessionId,
        resumeCancelledPlan: true,
        ...(control.maxFullBlockPriceSatoshis === undefined ? {} : { maxFullBlockPriceSatoshis: control.maxFullBlockPriceSatoshis }),
      });
      break;
    }
    case "bitfs.purchase.cancel": {
      value = await cancelMsfileBitfsBuyerPurchase({ seedHashHex: control.seedHashHex, sessionId: control.sessionId });
      break;
    }
    case "bitfs.purchase.tasks.list": {
      value = await listMsfileBitfsBuyerTaskSnapshots();
      break;
    }
    case "bitfs.demand.cancel": {
      if (!isValidMsFileHashHex(control.seedHashHex)) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "BitFS Seed Hash 必须是 64 位小写十六进制字符" } };
      }
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      const taskEntry = owner ? msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, control.seedHashHex)) : undefined;
      if (taskEntry?.ownerSessionEpoch === deps.session().sessionEpoch) {
        const activeRequestId = taskEntry.requestMessageId;
        const task = await taskEntry.taskPromise;
        await task.cancelDemand();
        taskEntry.requestMessageId = undefined;
        taskEntry.expiresAtMs = 0;
        const cancelledRequestIds = new Set<string>();
        if (activeRequestId) cancelledRequestIds.add(activeRequestId);
        for (const [messageId, buyerRequest] of msfileBitfsBuyerRequests) {
          if (buyerRequest.ownerSessionEpoch === deps.session().sessionEpoch
            && buyerRequest.ownerPublicKeyHex.toLowerCase() === owner
            && buyerRequest.seedHashHex === control.seedHashHex.toLowerCase()) {
            cancelledRequestIds.add(messageId);
            msfileBitfsBuyerRequests.delete(messageId);
            msfileBitfsBuyerOfferCounts.delete(messageId);
          }
        }
        for (const [webrtcSessionId, buyerLink] of msfileBitfsWebRtcBuyerLinks) {
          if (buyerLink.ownerSessionEpoch !== deps.session().sessionEpoch
            || !cancelledRequestIds.has(buyerLink.requestMessageId)) continue;
          // 停止需求只应关闭闲置报价连接；仍在买卖中的通道需要继续接收交付、Kind 13 或取消关池响应。
          const activePurchase = taskEntry.purchase
            && taskEntry.purchase.sessionId === buyerLink.quoteSessionId
            && taskEntry.purchase.phase !== "completed"
            && taskEntry.purchase.phase !== "cancelled"
            && taskEntry.purchase.phase !== "failed"
            && taskEntry.purchase.phase !== "connection-closed";
          if (activePurchase) continue;
          msfileBitfsWebRtcBuyerLinks.delete(webrtcSessionId);
          await deps.executor({
            type: "lane",
            laneId: "msfile",
            operation: { type: "bitfs-seller-close", sessionId: buyerLink.transportSessionId, reason: "buyer_cancelled" },
          }).catch(() => undefined);
        }
      }
      value = null;
      break;
    }
    case "supplier.upsert":
      if (control.expectedGeneration !== null && control.expectedGeneration !== supplierGenerationNow()) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "MSFile supplier generation changed" } };
      }
      await service.upsertSupplier(control.supplier); value = null; break;
    case "supplier.delete":
      if (control.expectedGeneration !== null && control.expectedGeneration !== supplierGenerationNow()) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "MSFile supplier generation changed" } };
      }
      await service.deleteSupplier(control.supplierPublicKeyHex); value = null; break;
    case "supplier.probe": value = await service.probeSupplier(control.supplierPublicKeyHex); break;
    case "app-policy.update": await service.updateAppPriceOverride(control.input); value = null; break;
    case "app-policy.clear": await service.clearAppPriceOverride(control.key); value = null; break;
    case "app-authorizations.list": value = await service.listAppAuthorizations(); break;
    case "approvals.pending": value = service.listPendingApprovals(); break;
    case "approval.resolve": await service.resolveApproval(control.approvalId, control.decision); value = null; break;
    case "bucket.put-block": {
      // 直接写 owner 文件根，不经过页面 storage 数据面的每端口并发上限；
      // 路径由 Worker 拼接，页面只给 hash 和字节。
      const files = deps.files("");
      await withMsfileBucketBlockWriteSlot(() => files.put(
        `storage/${control.seedHashHex}/${control.blockHashHex}`,
        new Uint8Array(control.bytes),
      ));
      value = null;
      break;
    }
    case "bucket.get-block": {
      const files = deps.files("");
      const object = await files.get(`storage/${control.seedHashHex}/${control.blockHashHex}`);
      if (!object) throw msfileError("msfile_content_not_found", "MSFile bucket block is missing");
      // 响应同样走 ArrayBuffer，避免 TypedArray 的逐元素 DTO 校验开销。
      value = object.bytes.slice().buffer;
      break;
    }
    default: return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "Unknown MSFile control" } };
  }
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  // K-V commit 后复核：请求 epoch、Vault、runtime 身份任一变化都报告为
  // stale-epoch（写入已提交、不可撤销，与 Storage 数据面语义一致）。
  if (
    requestEpoch !== deps.session().sessionEpoch ||
    deps.session().vaultStatus !== "unlocked" ||
    deps.service() !== runtimeAtStart
  ) {
    return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "stale-epoch" } };
  }
  return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

function clearBuyerState(): void {
  msfileBitfsBuyerRequests.clear();
  msfileBitfsBuyerTasks.clear();
  msfileBitfsBuyerPurchaseTails.clear();
  msfileBitfsBuyerRecoveryInFlight = undefined;
  msfileBitfsBuyerRecoveryReady = undefined;
  msfileBitfsBuyerOfferCounts.clear();
  msfileBitfsWebRtcBuyerLinks.clear();
  msfileBitfsWebRtcSellerLinks.clear();
}

async function handleInboxWebRtc(webrtcBody: import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body, opened: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage, seedHashHex?: string): Promise<void> {
  if (webrtcBody.signal.type === "offer") {
            if (msfileBitfsBuyerRequests.has(webrtcBody.request_message_id)) {
              if (!seedHashHex) throw new Error("BitFS offer is missing verified Hash request evidence");
              await acceptMsfileBitfsWebRtcOffer({
                requestMessageId: webrtcBody.request_message_id,
                webrtcSessionId: webrtcBody.session_id,
                peerPublicKeyHex: opened.from_public_key,
                seedHashHex,
                offerSdp: webrtcBody.signal.sdp,
              });
            }
          } else {
            // 仅把同一 request/session 和预期信令身份的 answer/ICE 送回 DataChannel。
            const sellerLink = msfileBitfsWebRtcSellerLinks.get(webrtcBody.session_id);
            const buyerLink = msfileBitfsWebRtcBuyerLinks.get(webrtcBody.session_id);
            const link = sellerLink
              ? { sessionId: sellerLink.sessionId, requestMessageId: sellerLink.requestMessageId, peerPublicKeyHex: sellerLink.peerPublicKeyHex, ownerSessionEpoch: sellerLink.ownerSessionEpoch }
              : buyerLink
                ? { sessionId: buyerLink.transportSessionId, requestMessageId: buyerLink.requestMessageId, peerPublicKeyHex: buyerLink.peerPublicKeyHex, ownerSessionEpoch: buyerLink.ownerSessionEpoch }
                : undefined;
            if (link) {
              if (link.ownerSessionEpoch !== deps.session().sessionEpoch
                || link.requestMessageId !== webrtcBody.request_message_id
                || link.peerPublicKeyHex !== opened.from_public_key.toLowerCase()) {
                throw new Error("BitFS WebRTC signal owner or peer relation mismatch");
              }
              try {
                await deps.executor({
                  type: "lane",
                  laneId: "msfile",
                  operation: {
                    type: "bitfs-webrtc-signal",
                    sessionId: link.sessionId,
                    requestMessageId: link.requestMessageId,
                    webrtcSessionId: webrtcBody.session_id,
                    publicKeyHex: link.peerPublicKeyHex,
                    signal: webrtcBody.signal as unknown as Record<string, unknown>,
                  },
                });
              } catch (error) {
                msfileBitfsWebRtcSellerLinks.delete(webrtcBody.session_id);
                msfileBitfsWebRtcBuyerLinks.delete(webrtcBody.session_id);
                if (sellerLink) await msfileSellerSessionManager?.close(link.sessionId, "transport_error").catch(() => undefined);
                else await deps.executor({
                  type: "lane",
                  laneId: "msfile",
                  operation: { type: "bitfs-seller-close", sessionId: link.sessionId, reason: "transport_error" },
                }).catch(() => undefined);
                throw error;
              }
            }
          }
}

  return {
    executeMsfileControl,
    handleInboxWebRtc,
    isMsfileMutationControl,
    revoke: () => { stopMsfileSellerRuntime(); clearBuyerState(); msfileFundingRuntime.clear(); },
    clearBuyerState,
    resetControlQueue: () => { msfileMutationTail = Promise.resolve(); },
    createMsfileBitfsBuyerTask,
    msfileBitfsBuyerRequests,
    msfileBitfsBuyerOfferCounts,
    configureMsfileSellerRuntime,
    msfileBitfsBuyerTasks,
    msfileBitfsBuyerPurchaseTails,
    get msfileBitfsBuyerRecoveryInFlight() { return msfileBitfsBuyerRecoveryInFlight; },
    get msfileBitfsBuyerRecoveryReady() { return msfileBitfsBuyerRecoveryReady; },
    msfileBitfsWebRtcBuyerLinks,
    msfileBitfsWebRtcSellerLinks,
    stopMsfileSellerRuntime,
    msfileFundingRuntime,
    filterP2pkhSnapshotByBitfsFunds,
    reconcileMsfileBitfsFundingInputs,
    acceptMsfileBitfsWebRtcOffer,
    get msfileSellerSessionManager() { return msfileSellerSessionManager; },
    handleMsfileSellerHashRequest,
    get msfileSellerProtocolPort() { return msfileSellerProtocolPort; },
    drainMsfilePendingSellerHashRequests,
    handleBitfsSellerStreamEvent,
    ensureMsfileBitfsBuyerRecovery,
    ensureMsfileBitfsBuyerTask,
    msfileBitfsBuyerDemandSnapshot,
    msfileBitfsBuyerTaskKey,
    startMsfileBitfsBuyerPurchase,
    cancelMsfileBitfsBuyerPurchase,
    listMsfileBitfsBuyerTaskSnapshots,
    currentMsfileBitfsFundingLedger,
    sellerKeepsVaultUnlocked,
    get msfileSellerRuntime() { return msfileSellerRuntime; },
    get testMsfileSellerBridge() { return testMsfileSellerBridge; },
    set testMsfileSellerBridge(value: typeof testMsfileSellerBridge) { testMsfileSellerBridge = value; },
    get msfileSellerDependencyResume() { return msfileSellerDependencyResume; },
    set msfileSellerDependencyResume(value: typeof msfileSellerDependencyResume) { msfileSellerDependencyResume = value; },
    get msfileSellerIndex() { return msfileSellerIndex; },
  };
}
