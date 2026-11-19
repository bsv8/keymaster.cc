import { selectMsFileSellerTransport } from "./sellerRuntime.js";
import { bitfsDownloadLockName } from "./buyerDownloadLock.js";
import { configureBitfsDebug, traceBitfs } from "./debug.js";
import { collectorForOwner } from "../collector/collectorHost.js";
import { requireWocNetwork } from "@keymaster/contracts";
import { readSchedulerTaskState, schedulerFailureSettled, schedulerSuccessSettled, schedulerSessionResponsibilitiesSettled, schedulerTaskFields } from "./schedulerHost/taskState.js";
import { view as schedulerView } from "keymaster-trade-scheduler";
import { deleteBitfsPurchaseData } from "./purchaseCleanup.js";
import { listBitfsFundingPools } from "./fundingPools.js";
import { bitfsContentLockKey, withBitfsContentLock, createBitfsRetainedContentStore, readBitfsDeletedHistory, readBitfsHiddenHistory } from "./purchaseRetention.js";
import { createBitfsPurchaseTasks, type BitfsPurchaseTask } from "./purchaseTasks.js";
import { createBitfsDemandMonitor } from "./demandMonitor.js";
import { inspectLocalMsFileSeed, listMsFileSeeds } from "../storage/msfileSeedStore.js";
import { arbitrationFeeForItems } from "./arbitrationFees.js";
import { prepareBitfsPoolRecoveryWithCurrentRevision } from "./funding.js";
import { BitfsArbitrationWorkflow } from "./arbitrationWorkflow.js";
import type { CoordinatorClientRequest, CoordinatorMsFileControl, CoordinatorResponse, MsFileErrorCode, ActiveKeyCrypto, BorrowedModuleFileStore, MsFileSellerSettings, SessionEpoch, ProtocolSpendService, P2pkhUtxoSnapshotResult, WocWorkerChainPort } from "@keymaster/contracts";
import { normalizeMsFileSatoshiAmount, isValidMsFileHashHex } from "@keymaster/contracts";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { BitfsSeedIndex, BitfsSellerRuntime, BitfsSellerSessionManager, createBitfsBuyerTask, createBitfsBuyerDownloadPlan, createBitfsLocalSellerContentResolver, BitfsTransactionBroadcaster, createBitfsJournal, createBitfsSessionJournal, createBitfsTransactionJournal, createBitfsVaultSigner, createBitfsWocChainPort, createMsFileLocalContentSource, readBitfsBuyerLocalPaymentState, assertBitfsBuyerCloseBinding, parseBitfsBuyerCloseBinding, createUnavailableBitfsSellerContentResolver, reconcileBitfsTransactions, reconcileBitfsSessionTransactions, readBitfsPoolSpendChain, prepareBitfsFunding, BitfsSellerProtocol, type BitfsSellerMatch, type BitfsBuyerTask, type BitfsSellerProtocolPort, type BitfsSellerStreamTransport, type BitfsFundingPrepareDeps, type BitfsTransactionJournal, type BitfsFundingLedger, type MsFileServiceImpl } from "../coordinator.js";
import type { WorkerFundingDependencies, createWorkerFundingRuntime } from "./workerFundingRuntime.js";
import { completeBuyerOpening, parse, parsePaymentState, verifyArbitratedPayment, verifyBuyerCompletedClose, transactionID } from "bitfs-protocol";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { newSessionID, parseMessageID, parseSessionID } from "bsv8-channel-protocol";
import { WEBRTC_SIGNAL_PROTOCOL, newOffer, newAnswer, newEndOfCandidates as newEndOfCandidatesSignal, newICECandidate as newIceSignal } from "bsv8-channel-protocol/webrtc-signal";
import type { WebRTCInterconnectEnvelope } from "bitcoin-libp2p/webrtc-interconnect";

interface BitfsChannelPort { ownerPublicKeyHex: string; signal: AbortSignal }
interface BitfsExecutorLease { leaseId: string; sessionEpoch: string; transportReady: boolean }
type P2pkhUtxoSnapshotResource = Awaited<ReturnType<WorkerFundingDependencies["ensureResources"]>>[number];
export interface BitfsWorkerDependencies {
  session(): { vaultStatus: string; activePublicKeyHex?: string; sessionEpoch: string; runGeneration: string };
  service(): MsFileServiceImpl | undefined;
  ensureService(): Promise<MsFileServiceImpl>;
  files(purpose: string): BorrowedModuleFileStore;
  woc(): WocWorkerChainPort | undefined;
  walletIdentity: WorkerFundingDependencies["walletIdentity"];
  effectiveFeeRate: WorkerFundingDependencies["effectiveFeeRate"];
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  blockHeight(network: "main" | "test"): Promise<number>;
  executor(operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown>;
  network(): "main" | "test";
  availability(unitId: string): { state: string };
  subscribeAvailability(listener: () => void): () => void;
  ensureResources: WorkerFundingDependencies["ensureResources"];
  ensureChannel(): Promise<BitfsChannelPort>;
  channel(): BitfsChannelPort | undefined;
  buyerSubscriptions(runtime: BitfsChannelPort): Promise<void>;
  sellerSubscriptions(runtime: BitfsChannelPort): Promise<void>;
  stopSellerSubscriptions(): void;
  demandNetworkStatus(): Promise<import("@keymaster/contracts").MsFileDemandMonitorSnapshot["network"]>;
  publishHashRequest(runtime: BitfsChannelPort, input: { hash: string; locator: "webrtc-sdp" }, signal: AbortSignal, prepared: (messageId: string) => void): Promise<{ messageId: string }>;
  unknownPublishFailure(error: unknown): boolean;
  executorLease(): BitfsExecutorLease | undefined;
  buyerExecutorLease(peerId: string): BitfsExecutorLease | undefined;
  isWindowLeaseActive(leaseId: string): boolean;
  buyerExecutor(leaseId: string, operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown>;
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
export function createBitfsWorkerRuntime(deps: BitfsWorkerDependencies) {
configureBitfsDebug(deps.diagnosticsEnabled());
traceBitfs("runtime.created", () => ({ ...deps.session(), network: deps.network() }));
const demandMonitor = createBitfsDemandMonitor();
function buyerContentStore(owner: string, seed: string, sessionId: string) {
  return createBitfsRetainedContentStore({ store: deps.files(""), journal: deps.files("bitfs-journal"), owner, seed, sessionId });
}

const demandMonitorScope = () => { const current = deps.session(); return JSON.stringify([current.activePublicKeyHex, current.sessionEpoch, current.runGeneration]); };

/** 当前 owner 的 BitFS 卖方派生索引；锁定、切 Key 或关闭卖方时立即丢弃。 */
let msfileSellerIndex: BitfsSeedIndex | undefined;
let arbitrationScope: { key: string; controller: AbortController; promise: Promise<BitfsArbitrationWorkflow>; flow?: BitfsArbitrationWorkflow } | undefined;
async function arbitrationReserve(service: MsFileServiceImpl, arbiterPublicKeys: readonly string[], display?: { base?: string; perItem?: string }): Promise<bigint> {
  const endpoints = (await service.getSettingsSnapshot()).arbitrationServices;
  const endpoint = endpoints.find(item => arbiterPublicKeys.includes(item.publicKeyHex));
  if (!endpoint) throw new Error("报价没有可查询收费的可信仲裁方");
  const info = await deps.executor({ type: "lane", laneId: "msfile", operation: { type: "bitfs-arbitration-info", endpoint } }) as import("./arbitrationClient.js").BitfsArbitrationInfo;
  // 价格只取所选服务的认证 info；不把 test 部署的 10/1 硬编码到应用。
  const amount = arbitrationFeeForItems(info, 1);
  // 只投影已取得的数据，不增加请求、不改变金额或购买准入。
  if (display) { display.base = String(info.baseSat); display.perItem = String(info.perItemSat); }
  return amount;
}

async function arbitrationWorkflow(service?: MsFileServiceImpl): Promise<BitfsArbitrationWorkflow> {
  const identity = deps.session();
  const owner = identity.activePublicKeyHex;
  if (!owner || identity.vaultStatus !== "unlocked") throw new Error("请先解锁钱包");
  const network = deps.network();
  const key = `${owner}:${identity.sessionEpoch}:${identity.runGeneration}:${network}`;
  if (arbitrationScope?.key === key) return arbitrationScope.promise;
  arbitrationScope?.controller.abort();
  const controller = new AbortController();
  const assertActive = () => {
    const current = deps.session();
    if (controller.signal.aborted || current.vaultStatus !== "unlocked" || current.activePublicKeyHex !== owner
      || current.sessionEpoch !== identity.sessionEpoch || current.runGeneration !== identity.runGeneration || deps.network() !== network) throw new Error("仲裁操作所属登录会话已结束");
  };
  const scope = { key, controller, promise: Promise.resolve(undefined as unknown as BitfsArbitrationWorkflow), flow: undefined as BitfsArbitrationWorkflow | undefined };
  arbitrationScope = scope;
  scope.promise = (async () => {
    const runtime = service ?? await deps.ensureService();
    const store = deps.files("bitfs-journal");
    const sessions = createBitfsSessionJournal(store);
    const cryptoPort = await deps.crypto(owner);
    assertActive();
    // 列表可先于链能力就绪；显式操作时读取当前句柄，避免冻结初始缺失状态。
    const requireWoc = () => { const current = deps.woc(); if (!current) throw new Error("链服务尚未就绪，请稍后手动重试"); return current; };

    const transactions = createBitfsTransactionJournal(store);
    const signer = createBitfsVaultSigner(cryptoPort);
    const flow = new BitfsArbitrationWorkflow({
      owner, sessions, store, content: deps.files(""), contentForSession: record => buyerContentStore(owner, record.seedHashHex, record.sessionId), signer,
      broadcaster: new BitfsTransactionBroadcaster({ journal: transactions, chain: { async broadcast(input) { return deps.funding.chain(requireWoc(), network, transactions).broadcast(input); }, async lookupTransaction(txid) { return deps.funding.chain(requireWoc(), network, transactions).lookupTransaction(txid); } }, nowMs: () => Date.now() }),
      services: async () => (await runtime.getSettingsSnapshot()).arbitrationServices,
      async settleBuyer(record, pool) {
        assertActive();
        const currentWoc = requireWoc();
        const fundingTxid = deps.bytesToHex(new Uint8Array(transactionID(pool.opening.fundingTransactionRaw)).reverse());
        const observed = await readBitfsPoolSpendChain({ woc: currentWoc, network, fundingTxid, signal: controller.signal });
        assertActive();
        if (observed.kind !== "spender") return false;
        const payment = await parsePaymentState(observed.rawTransaction, pool.opening);
        await verifyArbitratedPayment(payment, pool.opening);
        assertActive();
        const parsed = deps.parseTransaction(deps.bytesToHex(observed.rawTransaction), observed.txid);
        if (parsed.canonicalTxid !== observed.txid || parsed.inputs.length !== 1 || parsed.inputs[0]?.outpointKey !== `${fundingTxid}:0`) throw new Error("仲裁结算没有花费原费用池");
        const ownerScript = deps.addressScript(deps.deriveAddress(owner, network), network).toLowerCase();
        const outputs = parsed.outputs.filter(output => output.scriptHex.toLowerCase() === ownerScript && BigInt(output.value) > 0n)
          .map(output => ({ txid: observed.txid, vout: output.vout, valueSatoshis: String(output.value), scriptHex: output.scriptHex.toLowerCase() }));
        const ledger = currentMsfileBitfsFundingLedger();
        let account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: record.seedHashHex, network, nowMs: Date.now() });
        let poolRecord = account.pools.find(item => item.poolId === record.sessionId);
        if (!poolRecord) throw new Error("买方仲裁账本缺少费用池记录");
        if (poolRecord.state !== "closed") {
          await transactions.putTransaction(observed.txid, observed.rawTransaction, Date.now());
          if (poolRecord.state === "open") await prepareBitfsPoolRecoveryWithCurrentRevision(ledger, {
            ownerPublicKeyHex: owner, seedHashHex: record.seedHashHex, network, poolId: record.sessionId, purpose: "arbitration",
            txid: observed.txid, spendingOutpoint: parsed.inputs[0]!.outpointKey, outputs, nowMs: Date.now(),
          }, assertActive);
          await ledger.observePoolRecovery({ ownerPublicKeyHex: owner, seedHashHex: record.seedHashHex, network,
            poolId: record.sessionId, actualInputs: parsed.inputs.map(input => input.outpointKey), actualOutputs: outputs, nowMs: Date.now() });
        }
        account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: record.seedHashHex, network, nowMs: Date.now() });
        poolRecord = account.pools.find(item => item.poolId === record.sessionId);
        if (poolRecord?.state !== "closed" || poolRecord.recoveryTxid !== observed.txid) throw new Error("仲裁结算与买方账本不一致");
        await markMsfileBitfsDownloadPlanPoolClosed({ ownerPublicKeyHex: owner, seedHashHex: record.seedHashHex, sessionId: record.sessionId });
        assertActive(); return true;
      },
      transport: {
        info: async ({ endpoint, signal }) => await deps.executor({ type: "lane", laneId: "msfile", operation: { type: "bitfs-arbitration-info", endpoint } }, signal) as import("./arbitrationClient.js").BitfsArbitrationInfo,
        exchange: async ({ endpoint, request, signal }) => {
          assertActive(); const value = await deps.executor({ type: "lane", laneId: "msfile", operation: { type: "bitfs-arbitration-exchange", endpoint, request: request.slice() } }, signal);
          assertActive(); if (!(value instanceof Uint8Array)) throw new Error("仲裁响应不是字节"); return value;
        },
      }, assertActive, signal: controller.signal, now: () => Date.now(),
    });
    assertActive(); scope.flow = flow; return flow;
  })().catch(error => { if (arbitrationScope === scope) arbitrationScope = undefined; throw error; });
  return scope.promise;
}
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
  windowLeaseId: string;
  /** 已验证 Hash 请求的真实 message_id。 */
  requestMessageId: string;
  /** Inbox 对端公钥；答复必须来自此公钥。 */
  peerPublicKeyHex: string;
  /** 建立链接时的 owner session epoch。 */
  ownerSessionEpoch: SessionEpoch;
}>();
/** 等待卖方报价的 Hash 请求；只在当前 owner 和请求有效期内保留。 */
const msfileBitfsBuyerRequests = new Map<string, {
  /** 当前买方 Key。 */
  ownerPublicKeyHex: string;
  /** 本次请求的 Seed Hash。 */
  seedHashHex: string;
  /** 发送需求时的 owner 会话世代。 */
  ownerSessionEpoch: SessionEpoch;
  /** 请求有效截止毫秒。 */
  expiresAtMs: number;
  windowLeaseId: string;
}>();
/** 单个需求最多允许建立的卖家 WebRTC 会话数，防止报价洪泛。 */
const msfileBitfsBuyerOfferCounts = new Map<string, number>();
const MSFILE_BITFS_MAX_OFFERS_PER_DEMAND = 32;
const MSFILE_BITFS_MAX_ACTIVE_BUYER_LINKS = 128;
const msfileBitfsWebRtcBuyerLinks = new Map<string, {
  transportSessionId: string;
  windowLeaseId: string;
  requestMessageId: string;
  peerPublicKeyHex: string;
  ownerPublicKeyHex: string;
  seedHashHex: string;
  ownerSessionEpoch: SessionEpoch;
}>();

/** 测试注入的卖方 bridge；生产为 undefined，使用 Window lane + 未就绪端口。 */
let testMsfileSellerBridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined;



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
  if (phase === "arbitration-retrieval") return "completed";
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
  if (candidate.phase === "failed" && input.task) {
    try {
      await input.task.recoverFailedOpening(candidate.sessionId);
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  if (candidate.phase === "cancel-opening" && input.task) {
    try {
      await input.task.cancelUnfundedOpening(candidate.sessionId);
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message : "未开池资金占用恢复暂不可用";
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
      recoveryErrorMessage = error instanceof Error ? error.message : "开池交易对账暂不可用";
    }
  }
  let closeReconciled = false;
  if (input.task && await sessions.getEvidence(candidate.sessionId, "kind13-close-response")) {
    try {
      const result = await input.task.resumePoolRecovery(candidate.sessionId);
      closeReconciled = result?.closed === true;
    } catch (error) {
      recoveryErrorMessage = error instanceof Error ? error.message : "关池交易对账暂不可用";
    }
  }
  let refundReconciled = false;
  let refundUnknown = false;
  let refundRecoveryMessage: string | undefined;
  const openingWasPrepared = candidate.evidence.includes("kind3-opening-response")
    && candidate.evidence.includes("funding-transaction");
  // 尚有已签内容授权时，重新登录只展示状态。不能自动退款，与卖方仲裁竞争花费。
  if (input.task && !candidate.pendingAuthorizationId && openingWasPrepared && !(await sessions.getEvidence(candidate.sessionId, "kind13-close-response"))) {
    try {
      const result = await input.task.recoverMaturedRefund(candidate.sessionId);
      refundReconciled = result?.refunded === true;
      refundUnknown = result !== undefined && !result.refunded;
    } catch (error) {
      // 链查询暂不可用时不阻塞任务摘要；账本和池内 UTXO 仍保持保护。
      refundRecoveryMessage = error instanceof Error ? error.message : "链上退款对账暂不可用";
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
      recoveryErrorMessage = error instanceof Error ? error.message : "下载计划关池记录暂不可用";
    }
  }
  const latestCandidate = await sessions.get(candidate.sessionId);
  if (!latestCandidate) throw new Error("BitFS 买方恢复期间会话记录消失");
  if (latestCandidate.phase === "cancelled" && latestCandidate.evidence.includes("download-plan")) {
    // 取消已证明未派发，或先前已完成资金回收。重启也必须补做预算释放，
    // 不能让参数已固定但开池失败的记录永久占住卖家名额和全部 Block。
    await markMsfileBitfsDownloadPlanPoolClosed({ ...input, sessionId: candidate.sessionId });
  }
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
      const downloadPlan = await openMsfileBitfsBuyerDownloadPlan(input.ownerPublicKeyHex, input.seedHashHex, input.sessionId);
      const snapshot = await downloadPlan.snapshot();
      wholeFileCancellationPending = snapshot.stopRequested && snapshot.pools.some((pool) => !pool.closed);
    } catch {
      // 计划损坏时不覆盖原会话恢复摘要；后续买卖入口仍会因读取失败而拒绝继续付款。
    }
  }
  const message = wholeFileCancellationPending
    ? "整文件取消已保存；所有池已停止领取新内容，正在等待费用池逐一关闭或退款确认。"
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
      ? "已按原 txid 对账确认开池交易，并保存 Kind 4；下载记录已保留。"
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
      : "已读取本地购买记录，资金和签名证据仍保留。";
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
  const plan = await openMsfileBitfsBuyerDownloadPlan(input.ownerPublicKeyHex, input.seedHashHex, input.sessionId);
  await plan.closePool(input.sessionId);
  await finishPurchaseTask(input.ownerPublicKeyHex, input.seedHashHex, input.sessionId);
}

/** 历史记录只迁入一次；之后不再从协议阶段推断生命周期。 */
async function purchaseTasksFor(owner: string, seed: string) {
  const store = deps.files("bitfs-journal");
  const tasks = createBitfsPurchaseTasks(store, owner, seed);
  if (!await tasks.exists()) {
    const records = (await createBitfsSessionJournal(store).list()).filter(r => r.role === "buyer" && r.ownerPublicKeyHex === owner && r.seedHashHex === seed
      && (r.evidence.includes("purchase-manifest") || r.evidence.includes("kind2-opening-request") || r.evidence.includes("opening-configuration") || r.evidence.includes("funding-transaction") || r.evidence.includes("download-plan")));
    const ongoing = records.filter(r => !r.replacedBySessionId && !["completed","cancelled","refunded"].includes(r.phase)
      && (r.phase !== "failed" || r.evidence.includes("funding-transaction") || r.pendingTxid));
    const migrated: BitfsPurchaseTask[] = records.filter(r => !ongoing.includes(r)).map(r => ({
      taskId: r.sessionId, demandId: "legacy", state: "ended", endReason: r.replacedBySessionId ? "replaced" : r.phase === "completed" ? "completed" : r.phase === "failed" ? "failed" : "cancelled",
      createdAt: r.createdAt ?? r.updatedAt, endedAt: r.updatedAt, sessionIds: [r.sessionId], legacyPlan: true,
    }));
    if (ongoing.length) migrated.push({ taskId: ongoing[0]!.sessionId, demandId: "legacy", state: "active", createdAt: ongoing[0]!.createdAt ?? ongoing[0]!.updatedAt,
      sessionIds: ongoing.map(r => r.sessionId), legacyPlan: true });
    await tasks.initialize(migrated);
  }
  return tasks;
}
async function taskForSession(owner: string, seed: string, sessionId?: string) {
  const records = await (await purchaseTasksFor(owner, seed)).list();
  return sessionId ? records.find(t => t.sessionIds.includes(sessionId)) : records.find(t => t.state === "active");
}
/** 会话只操作自己任务的计划，旧资金恢复不会误关新池。 */
async function openMsfileBitfsBuyerDownloadPlan(owner: string, seed: string, sessionId?: string) {
  const store = deps.files("bitfs-journal");
  const task = await taskForSession(owner, seed, sessionId);
  const taskId = task && !task.legacyPlan ? task.taskId : undefined;
  const object = await store.get(taskId ? `download-plans/${seed}/${taskId}.json` : `download-plans/${seed}.json`);
  if (!object) throw new Error("采购任务的下载计划记录缺失");
  const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)) as Record<string, unknown>;
  if (typeof row.fileSizeBytes !== "string" || typeof row.recommendedFilename !== "string") throw new Error("下载计划缺少文件身份信息");
  return createBitfsBuyerDownloadPlan({ ownerPublicKeyHex: owner, seedHashHex: seed, fileSizeBytes: row.fileSizeBytes, recommendedFilename: row.recommendedFilename, taskId, store });
}
/** 协议动作完成后显式结束文件任务，资金状态独立留在账本。 */
async function finishPurchaseTask(owner: string, seed: string, sessionId: string) {
  const tasks = await purchaseTasksFor(owner, seed);
  // sessionId 通常是卖家会话编号；内核完成路径传入的是采购任务编号，两者都接受。
  const task = (await tasks.list()).find(t => t.taskId === sessionId || t.sessionIds.includes(sessionId));
  if (!task || task.state !== "active") return;
  const kernel = await readSchedulerTaskState({ store: deps.files("bitfs-journal"), ownerPublicKeyHex: owner, network: deps.network(), taskId: task.taskId });
  if (kernel?.failure) {
    if (schedulerFailureSettled(schedulerView(kernel))) await tasks.end(task.taskId, "failed", Date.now());
    return;
  }
  const journal = createBitfsSessionJournal(deps.files("bitfs-journal"));
  const records = await Promise.all(task.sessionIds.map(id => journal.get(id)));
  if (kernel) {
    const current = schedulerView(kernel);
    const unresolved = !schedulerSessionResponsibilitiesSettled(records);
    const settled = schedulerSuccessSettled(current) && !unresolved;
    traceBitfs("purchase.lifecycle.review", () => ({ taskId: task.taskId, seedHashHex: seed, current, unresolved, settled,
      sessions: records.map(record => record && ({ sessionId: record.sessionId, phase: record.phase, pendingTxid: record.pendingTxid, pendingAuthorizationId: record.pendingAuthorizationId })) }));
    if (settled) await tasks.end(task.taskId, "completed", Date.now());
    return;
  }
  if (records.length && records.every(r => r && ["quote-selected", "failed"].includes(r.phase) && !r.evidence.includes("funding-transaction") && !r.pendingTxid)) { await tasks.end(task.taskId, "failed", Date.now()); return; }
  if (records.length && records.every(r => r && ["completed","cancelled","refunded","failed"].includes(r.phase))) {
    const plan = await openMsfileBitfsBuyerDownloadPlan(owner, seed, sessionId).catch(() => undefined);
    const snapshot = await plan?.snapshot();
    const complete = snapshot?.totalBlockCount !== null && snapshot?.totalBlockCount !== undefined && snapshot.completedBlockCount === snapshot.totalBlockCount;
    if (records.some(r => r?.phase === "cancelled" || r?.phase === "refunded")) await tasks.end(task.taskId, "cancelled", Date.now());
    else if (complete && records.some(r => r?.phase === "completed")) await tasks.end(task.taskId, "completed", Date.now());
    else if (records.every(r => r?.phase === "failed")) await tasks.end(task.taskId, "failed", Date.now());
  }
}

/** 采购开始时重验实际字节。历史付款标记只能证明曾经买过，不能证明仍在本地。 */
/** 从持久 journal 与专款账本重建 `/msfile/storage` 的未完成购买任务列表。 */
async function listMsfileBitfsBuyerTaskSnapshots(): Promise<import("@keymaster/contracts").MsFileBitfsTaskSnapshot[]> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("Vault 已锁定，不能读取 BitFS 购买任务");
  const sessions = createBitfsSessionJournal(deps.files( "bitfs-journal"));
  const records = (await sessions.list()).filter((record) => record.role === "buyer"
    && record.ownerPublicKeyHex === owner
    && (record.evidence.includes("kind2-opening-request")
      || record.evidence.includes("opening-configuration")
      || record.evidence.includes("funding-transaction")
      || record.evidence.includes("purchase-manifest") || record.evidence.includes("download-plan")
      || record.phase === "cancel-opening" || record.phase === "quote-selected"));
  const ledger = currentMsfileBitfsFundingLedger();
  const contentStore = deps.files( "");
  const snapshots: import("@keymaster/contracts").MsFileBitfsTaskSnapshot[] = [];
  for (const record of records) {
    let session = await sessions.get(record.sessionId);
    if (!session) continue;
    const fileTask = await taskForSession(owner, session.seedHashHex, session.sessionId);
    if (session.phase === "quote-selected" && !fileTask) continue;
    const phase = msfileBitfsPurchasePhaseFromJournal(session.phase) ?? (fileTask ? "discovering" : undefined);
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
    const currentMaxFullBlockPriceSatoshis = evidencePriceLimit ?? null;

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
          verifiedBlockBytesKnown = false;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const fileTaskForCount = await taskForSession(owner, session.seedHashHex, session.sessionId);
    const historyPlanPath = fileTaskForCount && !fileTaskForCount.legacyPlan ? `download-plans/${session.seedHashHex}/${fileTaskForCount.taskId}.json` : `download-plans/${session.seedHashHex}.json`;
    const historyPlan = await deps.files("bitfs-journal").get(historyPlanPath);
    // 总块数以 Seed 清单为准（下载计划已登记时）；未知时为 null，不拿报价长度伪造。
    let planTotalBlockCount: number | null = null;
    if (historyPlan) {
      const history = JSON.parse(new TextDecoder().decode(historyPlan.bytes)) as { blocks?: Record<string, { state: string; sessionId: string }>; blockHashesHex?: unknown };
      verifiedBlockCount = Object.values(history.blocks ?? {}).filter(b => b.state === "completed").length;
      if (Array.isArray(history.blockHashesHex)) planTotalBlockCount = history.blockHashesHex.length;
    }
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
    if (fundingPlan?.state === "observed") {
      const inputValue = fundingPlan.inputOutpoints.reduce((sum, outpoint) => sum + BigInt(dedicatedByOutpoint.get(outpoint)?.valueSatoshis ?? "0"), 0n);
      const outputValue = fundingPlan.expectedOutputs.reduce((sum, output) => sum + BigInt(output.valueSatoshis), 0n);
      if (inputValue >= outputValue) fundingFeeSatoshis = inputValue - outputValue;
    }
    const totalBlockCount = planTotalBlockCount;
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
      taskId: fileTask?.taskId, taskState: fileTask?.state, taskEndReason: fileTask?.endReason,
      historyDeleted: (await readBitfsHiddenHistory(deps.files("bitfs-journal"), session.seedHashHex)).has(session.sessionId),
      sessionId: session.sessionId,
      createdAt: session.createdAt, updatedAt: session.updatedAt,
      fundingState: pool?.state === "closed" ? "closed" : fundingPlan?.state === "observed" ? "open"
        : fundingPlan && fundingPlan.state !== "failed" ? "unknown" : "not-opened",
      fundingTxid: fundingPlan?.txid ?? null, poolOutpoint: pool?.openingOutpoint ?? null,
      refundLockTime: configuration ? (JSON.parse(new TextDecoder().decode(configuration)) as { expiryLockTime?: number }).expiryLockTime ?? null : null,
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
      availableQuotes: [],
      message: [statusMessage, session.failureMessage].filter(Boolean).join(" "),
    });
  }

  let schedulerCursor: string | undefined;
  do {
    const page = await deps.files("bitfs-journal").list({ prefix: "scheduler/tasks/", limit: 200, ...(schedulerCursor ? { cursor: schedulerCursor } : {}) });
    traceBitfs("scheduler.history.scan", () => ({ paths: page.files.map(file => file.path), schedulerCursor }));
    for (const file of page.files) {
      const match = /^scheduler\/tasks\/([0-9a-z][0-9a-z._-]{0,127})\.json$/u.exec(file.path);
      if (!match) continue;
      const state = await readSchedulerTaskState({ store: deps.files("bitfs-journal"), ownerPublicKeyHex: owner, network: deps.network(), taskId: match[1]! });
      if (!state) continue;
      // 快照文件定位键即宿主购买执行编号；内核下载对象只看 seedHash。
      const hostTaskId = match[1]!;
      const task = (await (await purchaseTasksFor(owner, state.seedHash)).list()).find(item => item.taskId === hostTaskId);
      const members = snapshots.filter(item => item.taskId === hostTaskId || task?.sessionIds.includes(item.sessionId));
      const fields = schedulerTaskFields(state);
      traceBitfs("scheduler.history.project", () => ({ hostTaskId, seedHashHex: state.seedHash, members: members.map(item => item.sessionId), failure: state.failure }));
      for (const item of members) {
        item.taskId = hostTaskId;
        item.taskState = task?.state;
        item.taskEndReason = task?.endReason;
        item.createdAt ??= task?.createdAt;
        item.updatedAt ??= task?.endedAt;
        item.schedulerState = fields.schedulerState;
        if (state.failure) {
          item.message = fields.message;
          item.discoveryOnly = false;
          item.canCancel = false;
          if (!Object.values(state.pools).length) item.fundingState = "not-opened";
        }
      }
      if (members.length || !state.failure || Object.values(state.pools).some(pool => pool.funding !== "failed")) continue;
      const hidden = await readBitfsHiddenHistory(deps.files("bitfs-journal"), state.seedHash);
      const blocks = Object.values(state.content).filter(item => item.kind === "block");
      const completedBlocks = blocks.filter(item => state.completed[item.id]);
      // 已验收字节按暂存实际大小求和；读不到准确大小时为 null，不伪造。
      let failedVerifiedBytes: string | null = "0";
      if (completedBlocks.length > 0) {
        try {
          const staged = await deps.files("").list({ prefix: `bitfs-staging/by-seed/${state.seedHash}/blocks/`, limit: 10_000 });
          const sizes = new Map(staged.files.map(file => [file.path.split("/").pop()!.replace(/\.bin$/u, ""), file.size]));
          let sum = 0n;
          for (const item of completedBlocks) {
            const size = sizes.get(item.id);
            if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) { failedVerifiedBytes = null; break; }
            sum += BigInt(size);
          }
          if (failedVerifiedBytes !== null) failedVerifiedBytes = sum.toString(10);
        } catch { failedVerifiedBytes = null; }
      }
      snapshots.push({
        taskId: hostTaskId, taskState: task?.state, taskEndReason: task?.endReason,
        sessionId: task?.sessionIds[0] ?? hostTaskId, seedHashHex: state.seedHash,
        createdAt: task?.createdAt, updatedAt: task?.endedAt,
        historyDeleted: !!task?.sessionIds.length && task.sessionIds.every(id => hidden.has(id)),
        phase: "failed", fundingState: "not-opened", openingAmountSatoshis: null,
        verifiedBlockCount: completedBlocks.length,
        verifiedBytes: state.manifest !== null ? failedVerifiedBytes : null,
        totalBlockCount: state.manifest !== null ? blocks.length : null,
        sellerPublicKeyHex: state.failure.sellerId, recommendedFilename: null, fileSizeBytes: null, fullBlockPriceSatoshis: null,
        paidSatoshis: "0", minerFeeSatoshis: "0", lockedSatoshis: "0", pendingReturnSatoshis: "0",
        discoveryOnly: false, canCancel: false, ...fields,
      });
    }
    schedulerCursor = page.nextCursor;
  } while (schedulerCursor !== undefined);
  return snapshots.sort((left, right) => left.seedHashHex.localeCompare(right.seedHashHex));
}

/** 删除只停止内容调度并清理本地数据；资金动作仍由原管理入口显式发起。 */
async function deleteMsfilePurchaseData(seed: string, sessionId?: string): Promise<void> {
  const identity = deps.session();
  const owner = identity.activePublicKeyHex?.toLowerCase();
  if (!owner || identity.vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key");
  const assertActive = () => {
    const current = deps.session();
    if (current.vaultStatus !== "unlocked" || current.activePublicKeyHex?.toLowerCase() !== owner
      || current.sessionEpoch !== identity.sessionEpoch || current.runGeneration !== identity.runGeneration) throw new Error("删除所属钱包会话已变化");
  };
  assertActive();
  await deleteBitfsPurchaseData({
    journal: deps.files("bitfs-journal"), content: deps.files(""), ledger: currentMsfileBitfsFundingLedger(),
    owner, seed, sessionId, deleteContent: sessionId === undefined, assertActive,
  });
  if (!sessionId) msfileSellerIndex?.invalidate(seed);
}

/** 比较 exact BitFS 报文字节；不把视图对象或哈希摘要当作会话身份。 */
function equalMsfileBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function stopMsfileSellerRuntime(): void {
  deps.stopSellerSubscriptions();
  arbitrationScope?.controller.abort();
  arbitrationScope = undefined;
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
const createMsfileBitfsProtocolSpend = msfileFundingRuntime.protocolSpend;
const releaseMsfileBitfsPreparedSubmission = msfileFundingRuntime.releasePreparedSubmission;
const recoverMsfileBitfsFundingSplit = msfileFundingRuntime.recoverSplit;

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
  signal?: AbortSignal;
}): Promise<BitfsBuyerTask> {
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
    input.signal?.throwIfAborted();
    if (deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.session().runGeneration !== runGeneration
      || deps.session().sessionEpoch !== sessionEpoch) {
      throw new Error("BitFS 买方任务的 Key、存储或会话世代已变化");
    }
  };
  const store = deps.files( "bitfs-journal");
  const sessions = createBitfsSessionJournal(store);
  const transactions = createBitfsTransactionJournal(store);
  const ledger = currentMsfileBitfsFundingLedger();
  assertCurrentContext();

  const protocolSpend = createMsfileBitfsProtocolSpend();
  const fundingDeps: BitfsFundingPrepareDeps = {
    protocolSpend,
    planFunding: request => deps.funding.planFunding(request),
    releaseFundingPlan: request => deps.funding.releaseFundingPlan(request),
    async resolveOwnerAddress() {
      assertCurrentContext();
      const address = deps.deriveAddress(owner, input.network);
      return { address, scriptHex: deps.addressScript(address, input.network) };
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
    nowMs: () => Date.now(),
  };

  const woc = deps.woc();
  const chain = woc ? deps.funding.chain(woc, input.network, transactions) : {
    async broadcast(): Promise<never> { throw new Error("BitFS Worker 内 WoC 服务未就绪"); },
    async lookupTransaction(): Promise<"unknown"> { return "unknown"; },
  };
  const broadcaster = new BitfsTransactionBroadcaster({ journal: transactions, chain, nowMs: () => Date.now() });
  const cryptoPort = await deps.crypto(owner);
  assertCurrentContext();
  const signer = createBitfsVaultSigner(cryptoPort);

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
    async prepareFunding(fundingInput) {
      assertCurrentContext();
      const identity = deps.walletIdentity();
      if (input.network !== identity.bsvNetwork) throw new Error("FundingTx network does not match the active wallet identity");
      const resources = await deps.ensureResources(owner, identity.bsvNetwork);
      if (!resources.some(resource => resource.network === input.network)) throw new Error("BitFS FundingTx 的钱包资源尚未就绪");
      for (let attempt = 0; ; attempt += 1) {
        assertCurrentContext();
        try {
          return await prepareBitfsFunding({
            sessionId: fundingInput.sessionId,
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            network: input.network,
            generation,
            openingOutput: fundingInput.openingOutput,
            feeRateSatoshisPerKb: deps.effectiveFeeRate(),
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
      const lease = deps.executorLease();
      if (!lease?.transportReady || lease.sessionEpoch !== deps.session().sessionEpoch) {
        throw new Error("BitFS 卖方连接页面不可用");
      }
      const link = {
        windowLeaseId: lease.leaseId,
        sessionId: input.sessionId,
        requestMessageId: input.requestMessageId,
        peerPublicKeyHex: input.publicKeyHex.toLowerCase(),
        ownerSessionEpoch: deps.session().sessionEpoch,
      };
      msfileBitfsWebRtcSellerLinks.set(input.webrtcSessionId, link);
      try {
        await deps.buyerExecutor(link.windowLeaseId, operation, input.signal);
      } catch (error) {
        if (msfileBitfsWebRtcSellerLinks.get(input.webrtcSessionId) === link) {
          msfileBitfsWebRtcSellerLinks.delete(input.webrtcSessionId);
        }
        await deps.buyerExecutor(link.windowLeaseId, {
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
        await writeBitfsDiagnostic("seller-stream-send-error.json", {
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
    return "disabled";
  }
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
    const journalStore = deps.files( "bitfs-journal");
    const journal = createBitfsJournal(journalStore);
    const transactionJournal = createBitfsTransactionJournal(journalStore);
    const woc = deps.woc();
    const sessions = createBitfsSessionJournal(journalStore);
    const sellerNetwork=deps.network(),{sessionEpoch:sellerSessionEpoch,runGeneration:sellerRunGeneration}=deps.session();
    const assertSellerContext=()=>{
      const current=deps.session();
      if(controller.signal.aborted||msfileSellerIndexController!==controller||current.vaultStatus!=="unlocked"
        ||current.activePublicKeyHex!==ownerPublicKeyHex||current.sessionEpoch!==sellerSessionEpoch
        ||current.runGeneration!==sellerRunGeneration||deps.network()!==sellerNetwork||deps.service()!==service)
        throw new Error("BitFS seller identity is stale");
    };
    // Kind 2 uses its exact refund/opening proof. Later state signatures use
    // the actual funding retained after Kind 4, never a manufactured prevout.
    const signer=createBitfsVaultSigner(cryptoPort);
    // WoC 未装配时仍允许派生索引和 fail-closed 协议端口启动；
    // 任何真实交易广播/高度查询都会明确失败，不会伪造链上事实。
    const chain = woc ? deps.funding.chain(woc, deps.network(), transactionJournal) : {
      async broadcast(): Promise<never> { throw new Error("BitFS Worker 内 WoC 服务未就绪"); },
      async lookupTransaction(): Promise<"unknown"> { return "unknown"; },
    };
    const broadcaster = new BitfsTransactionBroadcaster({
      journal: transactionJournal,
      chain,
      nowMs: () => Date.now(),
    });
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
      findContent(seedHashHex) {
        const entry = index.get(seedHashHex);
        return Promise.resolve(entry?.availability === "available" ? entry : undefined);
      },
      selectTransport: request => selectMsFileSellerTransport(request, deps.allowLoopback()),
      journal,
      sessions,
      settings: () => service.describeState().sellerSettings,
      nowMs: Date.now,
    });
    const sellerContent = woc
      ? createBitfsLocalSellerContentResolver({
        content: createMsFileLocalContentSource(contentStore, { onReadFailure: (seedHashHex) => index.invalidate(seedHashHex) }),
        nowMs: () => Date.now(),
        blockHeight: () => deps.blockHeight(deps.network()),
      })
      : createUnavailableBitfsSellerContentResolver();
    const arbitration = testMsfileSellerBridge?.protocol || (await service.getSettingsSnapshot()).arbitrationServices.length === 0 ? undefined : await arbitrationWorkflow(service);
    const protocolPort = testMsfileSellerBridge?.protocol ?? new BitfsSellerProtocol({
      serialize: arbitration ? (id, run) => arbitration.exclusive(id, run) : undefined,
      onDelivered: arbitration ? id => arbitration.delivered(id, service.describeState().sellerSettings.paymentTimeoutSeconds) : undefined,
      onPaid: id => arbitration?.cancelWait(id),
      signer,
      async arbitrationFee(arbiterPublicKeyHex, itemCount) {
        const endpoint = (await service.getSettingsSnapshot()).arbitrationServices.find(item => item.publicKeyHex === arbiterPublicKeyHex);
        if (!endpoint) throw new Error("费用池仲裁方没有本网络可信收费服务");
        const info = await deps.executor({ type: "lane", laneId: "msfile", operation: { type: "bitfs-arbitration-info", endpoint } }) as import("./arbitrationClient.js").BitfsArbitrationInfo;
        return arbitrationFeeForItems(info, itemCount);
      },
      sessions,
      content: sellerContent,
      broadcaster,
       ownerPublicKeyHex,
       generation: () => msfileSellerSessionEpoch,
       runtimeInstanceId: () => runtimeInstanceId,
       nowMs: () => Date.now(),
      blockHeight: () => deps.blockHeight(deps.network()),
      minRefundDelayBlocks: () => service.describeState().sellerSettings.minRefundDelayBlocks,
      maxConcurrentSales: () => service.describeState().sellerSettings.maxConcurrentSales,
      onPaymentTransaction: async ({ txid, rawTxHex }) => {
        const wocConfig = deps.woc()?.getConfig();
        await writeBitfsDiagnostic("seller-payment-transaction.json", {
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
      // 报价连接保留独立的有界名额；实际开池在协议端检查销售并发。
      maxSessions: () => service.describeState().sellerSettings.maxConcurrentSales + 16,
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
        await writeBitfsDiagnostic("seller-protocol-frame-error.json", { sessionId, message, stack });
      },
      onSessionClosed: async ({ sessionId, reason, atMs }) => {
        await writeBitfsDiagnostic("seller-session-close.json", { sessionId, reason, atMs });
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
async function writeBitfsDiagnostic(path: string, value: unknown): Promise<void> {
  traceBitfs(path.replace(/\.json$/u, ""), () => value);
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
  if (deps.session().vaultStatus !== "unlocked" || !deps.session().activePublicKeyHex) return;
  const scope = demandMonitorScope();
  demandMonitor.record(scope, request, Date.now(), async () => {
    if (demandMonitorScope() !== scope || deps.session().vaultStatus !== "unlocked") return false;
    const descriptor = await inspectLocalMsFileSeed({ store: deps.files(""), seedHashHex: request.body.hash });
    return descriptor !== null;
  });
  const runtime = msfileSellerRuntime;
  const manager = msfileSellerSessionManager;
  const protocolPort = msfileSellerProtocolPort;
  const service = deps.service();
  if (service && !service.describeState().sellerSettings.sellerEnabled) return;
  await writeBitfsDiagnostic("seller-hash-request-entry.json", {
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
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "not-quoted", "卖方运行态或传输尚未就绪");
    if (request.expires_at_ms > Date.now()) {
      msfilePendingSellerHashRequests.set(`${request.from_public_key}:${request.message_id}`, request);
    }
    return;
  }
  if (!protocolPort.ready) {
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "not-quoted", "卖方协议端口尚未就绪");
    if (request.expires_at_ms > Date.now()) {
      msfilePendingSellerHashRequests.set(`${request.from_public_key}:${request.message_id}`, request);
    }
    return;
  }
  if (deps.session().vaultStatus !== "unlocked" || !deps.session().activePublicKeyHex) return;
  const ownerPublicKeyHex = deps.session().activePublicKeyHex;
  const epoch = msfileSellerSessionEpoch;
  if (manager.activeCount() >= service.describeState().sellerSettings.maxConcurrentSales + 16) {
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "failed", "卖方报价连接已达到并发上限");
    return;
  }
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
      demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "failed", error instanceof Error ? error.message : String(error));
      console.warn("[msfile] seller hash request index refresh failed", error instanceof Error ? error.message : String(error));
      return;
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
  await writeBitfsDiagnostic("seller-hash-request-index.json", {
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
  demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "preparing");
  try {
    match = await runtime.match(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "failed", error instanceof Error ? error.message : String(error));
    console.warn("[msfile] seller hash request match failed", error instanceof Error ? error.message : String(error));
    await writeBitfsDiagnostic("seller-hash-request-match.json", { hash: request.body.hash, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  await writeBitfsDiagnostic("seller-hash-request-match.json", { hash: request.body.hash, matched: match !== null });
  if (!match) {
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "unmatched", "未匹配到完整文件或有效连接方式，或需求已过期/重复");
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
    const started = await manager.start({
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
    if (!started) demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "failed", "报价连接未建立：连接容量已满或运行会话已变化");
    else if (match.transport === "multiaddr") demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "quoted");
    await writeBitfsDiagnostic("seller-session-start.json", { sessionId, webrtcSessionId, matched: true });
  } catch (error) {
    demandMonitor.updateQuote(scope, request.message_id, request.from_public_key, "failed", error instanceof Error ? error.message : String(error));
    await writeBitfsDiagnostic("seller-session-start.json", { matched: true, error: error instanceof Error ? error.message : String(error) });
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
  void writeBitfsDiagnostic("buyer-webrtc-offer.json", {
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
    windowLeaseId: request.windowLeaseId,
    requestMessageId: input.requestMessageId,
    peerPublicKeyHex: input.peerPublicKeyHex.toLowerCase(),
    ownerPublicKeyHex: request.ownerPublicKeyHex,
    seedHashHex: request.seedHashHex,
    ownerSessionEpoch: request.ownerSessionEpoch,
  };
  // 在创建 PeerConnection 和发布 answer 前登记，容纳 DataChannel 立即回传的 Kind 1。
  msfileBitfsWebRtcBuyerLinks.set(input.webrtcSessionId, link);
  // SSP 的 offer 回执不能等待 ICE/连接完成：网关收到回执后才会投递后续
  // candidate。连接建立在后台继续，原 owner/世代和失败清理仍绑定此 link。
  void (async () => {
  try {
    await deps.buyerExecutor(link.windowLeaseId, {
      type: "lane",
      laneId: "msfile",
      operation: {
        type: "bitfs-webrtc-buyer-offer",
        sessionId: transportSessionId,
        requestMessageId: input.requestMessageId,
        webrtcSessionId: input.webrtcSessionId,
        publicKeyHex: input.peerPublicKeyHex,
        seedHashHex: input.seedHashHex,
        offerSdp: input.offerSdp,
      },
    }, runtime.signal);
    if (link.ownerSessionEpoch !== deps.session().sessionEpoch
      || deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex !== request.ownerPublicKeyHex) {
      throw new Error("BitFS buyer owner changed while accepting an offer");
    }
    await writeBitfsDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: true });
  } catch (error) {
    await writeBitfsDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: false, error: error instanceof Error ? error.message : String(error) });
    if (msfileBitfsWebRtcBuyerLinks.get(input.webrtcSessionId) === link) {
      msfileBitfsWebRtcBuyerLinks.delete(input.webrtcSessionId);
    }
    msfileBitfsBuyerOfferCounts.set(input.requestMessageId, Math.max(0, (msfileBitfsBuyerOfferCounts.get(input.requestMessageId) ?? 1) - 1));
    await deps.buyerExecutor(link.windowLeaseId, {
      type: "lane",
      laneId: "msfile",
      operation: { type: "bitfs-seller-close", sessionId: transportSessionId, reason: "answer_failed" },
    }).catch(() => undefined);
    throw error;
  }
  })().catch(error => console.warn("[msfile] BitFS buyer offer setup failed", error instanceof Error ? error.message : String(error)));
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
      /** 帧完整到达时刻（本地毫秒）。 */
      receivedAt?: unknown;
      /** 流计量：累计到达字节。 */
      bytesIn?: unknown;
      /** 流计量：累计写出字节。 */
      bytesOut?: unknown;
      /** 流计量：最近活动时刻。 */
      lastActivityAt?: unknown;
   };
  const sellerTransport = deps.executorLease()?.leaseId === lease.leaseId;
  const manager = sellerTransport ? msfileSellerSessionManager : undefined;
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) return;
  // 旧 lease/旧 owner 的迟到事件不得进入新会话。
  if (event.ownerSessionEpoch !== lease.sessionEpoch || lease.sessionEpoch !== deps.session().sessionEpoch) return;
  void writeBitfsDiagnostic("webrtc-stream-event.json", {
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
    if (!link || (buyerLink && !sellerLink
      && (buyerLink.windowLeaseId !== lease.leaseId || buyerLink.transportSessionId !== event.sessionId))
      || (sellerLink && (sellerLink.windowLeaseId !== lease.leaseId || sellerLink.sessionId !== event.sessionId))
      || link.requestMessageId !== event.requestMessageId
      || link.peerPublicKeyHex !== event.publicKeyHex.toLowerCase()
      || link.ownerSessionEpoch !== deps.session().sessionEpoch) return;
    const executor = deps.buyerExecutor.bind(deps, link.windowLeaseId);
    const envelope = event.envelope as WebRTCInterconnectEnvelope;
    if (envelope.signal.type === "close") {
      if (sellerLink) msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId);
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId);
      void executor({
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
      if (sellerLink) demandMonitor.updateQuote(demandMonitorScope(), sellerLink.requestMessageId, sellerLink.peerPublicKeyHex, "failed", error instanceof Error ? error.message : String(error));
      if (sellerLink) msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId as string);
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId as string);
      await executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId: event.sessionId as string, reason: "signal_publish_failed" },
      }).catch(() => undefined);
      await writeBitfsDiagnostic("webrtc-signal-publish-error.json", {
        webrtcSessionId: event.webrtcSessionId,
        sessionId: event.sessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return;
  }
  if (event.type === "bitfs-webrtc-quote-sent") {
    if (!sellerTransport) return;
    const link = typeof event.webrtcSessionId === "string" ? msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId) : undefined;
    if (link && link.sessionId === event.sessionId && link.ownerSessionEpoch === deps.session().sessionEpoch)
      demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "quoted");
    return;
  }
  if (event.type === "bitfs-webrtc-runtime-error") {
    const link = typeof event.webrtcSessionId === "string" ? msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId) : undefined;
    if (sellerTransport && link) demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "failed", typeof event.message === "string" ? event.message : "WebRTC 报价连接失败");
    void writeBitfsDiagnostic("webrtc-runtime-error.json", {
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
    void writeBitfsDiagnostic("webrtc-session-close.json", {
      sessionId: event.sessionId,
      webrtcSessionId: event.webrtcSessionId,
      reason: event.reason,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      errorName: event.errorName,
      observedAtMs: Date.now(),
    });
    if (sellerTransport && typeof event.webrtcSessionId === "string") {
      const link = msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId);
      if (link) demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "failed",
        typeof event.errorMessage === "string" ? event.errorMessage : typeof event.reason === "string" ? event.reason : "报价连接已关闭");
      msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId);
    }
    if (typeof event.webrtcSessionId === "string") {
      const link = msfileBitfsWebRtcBuyerLinks.get(event.webrtcSessionId);
      if (link?.windowLeaseId === lease.leaseId && link.transportSessionId === event.sessionId) {
        msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId);
      }
    }
    void manager?.close(event.sessionId, typeof event.reason === "string" ? event.reason : "stream_error").catch(() => undefined);
    return;
  }
  if (event.type === "bitfs-webrtc-frame") {
    if (!(event.frame instanceof Uint8Array) || typeof event.webrtcSessionId !== "string") return;
    const sellerLink = msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId);
    if (sellerTransport && sellerLink && sellerLink.sessionId === event.sessionId
      && sellerLink.ownerSessionEpoch === deps.session().sessionEpoch) {
       void manager?.handleFrame({ sessionId: event.sessionId, frame: event.frame }).catch(async (error) => {
         const message = error instanceof Error ? error.message : String(error);
         await writeBitfsDiagnostic("seller-protocol-frame-error.json", {
           sessionId: event.sessionId,
           webrtcSessionId: event.webrtcSessionId,
           message,
           stack: error instanceof Error ? error.stack : undefined
         });
       });
       return;
    }
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
    await writeBitfsDiagnostic("seller-protocol-frame-error.json", {
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
  "settings.readConcurrency.update",
  "settings.readConcurrency.reset",
  "bitfs.demand.publish",
  "bitfs.demand.cancel",
  "bitfs.buyer.wallet",
  "bitfs.purchase.reconcile",
  "bucket.delete-file",
  "bitfs.purchase.history.delete",
  "bitfs.arbitration.operate",
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
  const execute = async () => {
    const startedAt = performance.now();
    traceBitfs("control.start", () => ({ requestId: request.requestId, type: request.control.type, sessionEpoch: request.expectedSessionEpoch }));
    try {
      const result = await executeMsfileControlNow(request, signal);
      traceBitfs("control.finish", () => ({ requestId: request.requestId, type: request.control.type, ack: result.ack, elapsedMs: performance.now() - startedAt }));
      return result;
    } catch (error) {
      traceBitfs("control.failed", () => ({ requestId: request.requestId, type: request.control.type, error, elapsedMs: performance.now() - startedAt }));
      throw error;
    }
  };
  if (!isMsfileMutationControl(request.control)) return execute();
  // mutation 进串行尾；前一个失败不阻塞后续。
  const run = msfileMutationTail.then(execute, execute);
  msfileMutationTail = run.then(() => undefined, () => undefined);
  return run;
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
    case "bitfs.demand.publish": {
      if (!isValidMsFileHashHex(control.seedHashHex)) throw new Error("BitFS Seed Hash 无效");
      const owner = deps.session().activePublicKeyHex;
      const lease = deps.buyerExecutorLease(request.clientId);
      if (!owner || !lease?.transportReady || lease.sessionEpoch !== requestEpoch) throw new Error("下载页面连接未就绪");
      const channel = await deps.ensureChannel();
      await deps.buyerSubscriptions(channel);
      let requestId: string | undefined;
      const expiresAtMs = Date.now() + 10 * 60_000;
      try {
        await deps.publishHashRequest(channel, { hash: control.seedHashHex, locator: "webrtc-sdp" },
          signal ?? channel.signal, id => {
            signal?.throwIfAborted();
            if (!deps.isWindowLeaseActive(lease.leaseId)) throw new Error("下载页面已关闭");
            requestId = id;
            msfileBitfsBuyerRequests.set(id, {
              ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex, ownerSessionEpoch: requestEpoch,
              windowLeaseId: lease.leaseId, expiresAtMs,
            });
          });
      } catch (error) {
        if (!requestId || !deps.unknownPublishFailure(error) || signal?.aborted) {
          if (requestId) msfileBitfsBuyerRequests.delete(requestId);
          throw error;
        }
      }
      value = { seedHashHex: control.seedHashHex, requestMessageId: requestId, expiresAtMs, quotes: [], currentMaxFullBlockPriceSatoshis: null };
      break;
    }
    case "bitfs.demand.snapshot": {
      const route = [...msfileBitfsBuyerRequests].find(([, row]) => row.seedHashHex === control.seedHashHex);
      value = { seedHashHex: control.seedHashHex, requestMessageId: route?.[0] ?? null,
        expiresAtMs: route?.[1].expiresAtMs ?? null, quotes: [], currentMaxFullBlockPriceSatoshis: null };
      break;
    }
    case "bitfs.buyer.wallet": {
      const owner = deps.session().activePublicKeyHex;
      const lease = deps.buyerExecutorLease(request.clientId);
      if (!owner || !lease?.transportReady || lease.sessionEpoch !== requestEpoch || !isValidMsFileHashHex(control.seedHashHex)) {
        throw new Error("下载页面连接未就绪");
      }
      const operation = control.operation;
      const activeRoute = [...msfileBitfsBuyerRequests.values()].some(route =>
        route.windowLeaseId === lease.leaseId && route.seedHashHex === control.seedHashHex);
      if (!activeRoute) throw new Error("下载页面没有此文件的活动请求");
      if (operation.type === "sign") {
        const crypto = await deps.crypto(owner);
        const signature = await createBitfsVaultSigner(crypto).sign({
          purpose: operation.document ? "wire_message" : "transaction",
          wireKind: operation.kind as import("bitfs-protocol").WireKind,
          digest: new Uint8Array(operation.digest),
          ...(operation.document ? { documentCBOR: new Uint8Array(operation.document) } : {}),
        }, signal);
        value = Uint8Array.from(signature).buffer;
        break;
      }
      const task = await createMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex,
        network: deps.network(), signal });
      signal?.throwIfAborted();
      switch (operation.type) {
        case "prepare-opening":
          value = Uint8Array.from(await task.prepareOpening({ ...operation,
            minerFeeRateSatoshisPerKilobyte: BigInt(operation.minerFeeRateSatoshisPerKilobyte) })).buffer;
          break;
        case "accept-opening":
          await task.acceptOpeningResponse({ sessionId: operation.sessionId, rawKind3: new Uint8Array(operation.response) });
          value = null;
          break;
        case "fund-opening": {
          const result = await task.submitOrReconcileFunding(operation.sessionId);
          value = { outcome: result.outcome, ...(result.kind4 ? { kind4: Uint8Array.from(result.kind4).buffer } : {}) };
          break;
        }
        case "settle-close":
          value = await task.submitOrReconcilePoolRecovery(operation.sessionId);
          break;
        case "cancel-opening":
          await task.cancelUnfundedOpening(operation.sessionId);
          value = null;
          break;
      }
      break;
    }
    case "bitfs.arbitration.list": {
      value = await (await arbitrationWorkflow(service)).list(); break;
    }
    case "bitfs.arbitration.operate": {
      const workflow = await arbitrationWorkflow(service);
      if (control.action === "retrieve") await workflow.retrieve(control.sessionId);
      else await workflow.submit(control.sessionId, undefined, control.action === "check");
      value = null; break;
    }
    case "bitfs.purchase.reconcile": {
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      const saved = await createBitfsSessionJournal(deps.files("bitfs-journal")).get(control.sessionId);
      if (!owner || !saved || saved.role !== "buyer" || saved.ownerPublicKeyHex !== owner || saved.seedHashHex !== control.seedHashHex) throw new Error("购买记录不属于当前 Key");
      const task = await createMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex, network: deps.network(), signal });
      await navigator.locks.request(bitfsDownloadLockName(owner, control.seedHashHex), { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("此文件正在下载");
        await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex, sessionId: control.sessionId, task });
      });
      value = null; break;
    }
    case "bitfs.demands.monitor": {
      const scope = demandMonitorScope();
      const network = await deps.demandNetworkStatus();
      if (demandMonitorScope() !== scope || deps.session().vaultStatus !== "unlocked") throw new Error("文件需求观察所属会话已结束");
      value = { ...demandMonitor.snapshot(scope), sellerEnabled: service.describeState().sellerSettings.sellerEnabled, network };
      break;
    }
    case "bitfs.funding.pools.list": {
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key");
      value = await listBitfsFundingPools({ journal: deps.files("bitfs-journal"), ledger: currentMsfileBitfsFundingLedger(), owner, network: deps.network() });
      break;
    }
    case "bucket.delete-file":
    case "bitfs.purchase.history.delete": {
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      if (!owner || !isValidMsFileHashHex(control.seedHashHex)) throw new Error("文件身份无效");
      await navigator.locks.request(bitfsDownloadLockName(owner, control.seedHashHex), { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("此文件正在下载");
        await deleteMsfilePurchaseData(control.seedHashHex, control.type === "bitfs.purchase.history.delete" ? control.sessionId : undefined);
      });
      value = null;
      break;
    }
    case "bitfs.purchase.tasks.list": {
      const owner = deps.session().activePublicKeyHex?.toLowerCase();
      const held = await navigator.locks?.query();
      value = (await listMsfileBitfsBuyerTaskSnapshots()).map(row => {
        const downloadReadOnly = held?.held?.some(lock => lock.name === bitfsDownloadLockName(owner ?? "", row.seedHashHex)) ?? false;
        return !downloadReadOnly && row.taskState === "active" && !row.schedulerState?.failure
          ? { ...row, downloadReadOnly, phase: "connection-closed", message: "下载已中断，原记录已保留。" }
          : { ...row, downloadReadOnly };
      });
      break;
    }
    case "bitfs.demand.cancel": {
      const lease = deps.buyerExecutorLease(request.clientId);
      if (lease) stopBuyerRouting(lease.leaseId, control.seedHashHex, control.requestMessageId);
      value = null;
      break;
    }
    case "bitfs.file.stored": {
      if (!isValidMsFileHashHex(control.seedHashHex)) throw new Error("BitFS Seed Hash 无效");
      const index = msfileSellerIndex;
      if (index) {
        index.invalidate(control.seedHashHex);
        void index.refresh(deps.files(""), control.seedHashHex, index.currentGeneration())
          .catch(error => traceBitfs("seller.index.refresh.failed", () => ({ seedHashHex: control.seedHashHex, error })));
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
    case "collector.notify-stored":
    case "collector.config.get":
    case "collector.config.update":
    case "collector.status":
    case "collector.description.set": {
      value = await executeMsfileCollectorControl(control);
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

/**
 * 采集上报控制面：队列、配置、状态、介绍。签名经 Vault 受限能力，
 * 调度随会话世代自停；顶层门禁已保证 unlocked，定时器触发前再复核。
 */
async function executeMsfileCollectorControl(
  control: Extract<CoordinatorMsFileControl, { type: `collector.${string}` }>,
): Promise<unknown> {
  const session = deps.session();
  const owner = session.activePublicKeyHex?.trim().toLowerCase();
  if (!owner) throw new Error("请先解锁当前 Key 再使用采集上报");
  const epoch = session.sessionEpoch;
  const service = collectorForOwner(owner, epoch, {
    files: deps.files(""),
    crypto: () => deps.crypto(owner),
    isAlive: () => {
      const current = deps.session();
      return current.vaultStatus === "unlocked" && current.activePublicKeyHex?.trim().toLowerCase() === owner
        && current.sessionEpoch === epoch;
    },
    diagnostics: deps.diagnosticsEnabled(),
  });
  switch (control.type) {
    case "collector.notify-stored": {
      assertCollectorHash(control.seedHashHex);
      assertCollectorFileName(control.fileName);
      assertCollectorSize(control.fileSizeBytes);
      if (typeof control.mediaType !== "string" || control.mediaType.length < 1) {
        throw new Error("采集上报的媒体类型不能为空");
      }
      await service.notifyStored({
        seedHashHex: control.seedHashHex,
        fileName: control.fileName,
        mediaType: control.mediaType,
        fileSizeBytes: control.fileSizeBytes,
      });
      return null;
    }
    case "collector.config.get":
      return service.getConfig();
    case "collector.config.update": {
      const input = control.input ?? {};
      if (input.endpoint !== undefined && typeof input.endpoint !== "string") throw new Error("采集地址必须为字符串");
      const config = await service.updateConfig(input);
      if (config.enabled && config.endpoint !== "") await collectorBackfill(service);
      return null;
    }
    case "collector.status":
      return service.getStatus();
    case "collector.description.set": {
      assertCollectorHash(control.seedHashHex);
      if (typeof control.description !== "string" || new TextEncoder().encode(control.description).byteLength > 2048) {
        throw new Error("介绍必须为 0..2048 UTF-8 字节");
      }
      await service.setDescription(control.seedHashHex, control.description);
      return null;
    }
  }
}

function assertCollectorHash(seedHashHex: string): void {
  if (!isValidMsFileHashHex(seedHashHex)) throw new Error("Seed Hash 必须是 64 位小写十六进制字符");
}

function assertCollectorFileName(fileName: string): void {
  if (typeof fileName !== "string") throw new Error("文件名必须为字符串");
  const bytes = new TextEncoder().encode(fileName).byteLength;
  if (bytes < 1 || bytes > 255 || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("文件名必须为 1..255 字节的 basename");
  }
}

function assertCollectorSize(fileSizeBytes: string): void {
  if (typeof fileSizeBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(fileSizeBytes)) {
    throw new Error("文件长度必须为十进制规范字符串");
  }
}

/**
 * 首次启用时补齐：已有且完整（种子与块齐备）的文件入队。
 * 启用前已存在的购买/下载文件无法区分来源，会一并入队一次；
 * 存储分离后该歧义消除。失败不抛错，交由每小时调度补齐。
 */
async function collectorBackfill(service: { notifyStored(input: { seedHashHex: string; fileName: string; mediaType: string; fileSizeBytes: string }): Promise<void> }): Promise<void> {
  try {
    const store = deps.files("");
    const entries = await listMsFileSeeds({ store });
    for (const entry of entries) {
      if (!entry.meta) continue;
      const descriptor = await inspectLocalMsFileSeed({ store, seedHashHex: entry.seedHashHex });
      if (!descriptor) continue;
      await service.notifyStored({
        seedHashHex: entry.seedHashHex,
        fileName: descriptor.meta.fileName,
        mediaType: descriptor.meta.mediaType,
        fileSizeBytes: descriptor.meta.fileSizeBytes,
      });
    }
  } catch {
    // 后台补齐失败不阻塞配置更新。
  }
}

function stopBuyerRouting(leaseId?: string, seedHashHex?: string, requestId?: string): void {
  for (const [id, request] of msfileBitfsBuyerRequests) {
    if ((leaseId !== undefined && request.windowLeaseId !== leaseId)
      || (seedHashHex !== undefined && request.seedHashHex !== seedHashHex)
      || (requestId !== undefined && id !== requestId)) continue;
    msfileBitfsBuyerRequests.delete(id);
    msfileBitfsBuyerOfferCounts.delete(id);
  }
  for (const [id, link] of msfileBitfsWebRtcBuyerLinks) {
    if ((leaseId === undefined || link.windowLeaseId === leaseId)
      && (seedHashHex === undefined || link.seedHashHex === seedHashHex)
      && (requestId === undefined || link.requestMessageId === requestId)) msfileBitfsWebRtcBuyerLinks.delete(id);
  }
}

function disconnectWindowTransport(leaseId: string): void {
  stopBuyerRouting(leaseId);
  for (const [id, link] of msfileBitfsWebRtcSellerLinks) {
    if (link.windowLeaseId === leaseId) msfileBitfsWebRtcSellerLinks.delete(id);
  }
}

function clearBuyerState(): void {
  stopBuyerRouting();
  msfileBitfsWebRtcSellerLinks.clear();
}

async function handleInboxWebRtc(webrtcBody: import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body, opened: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage, seedHashHex?: string): Promise<void> {
  void writeBitfsDiagnostic(`webrtc-inbound-${webrtcBody.signal.type}.json`, {
    sessionId: webrtcBody.session_id, requestMessageId: webrtcBody.request_message_id,
    hasBuyerLink: msfileBitfsWebRtcBuyerLinks.has(webrtcBody.session_id),
    hasSellerLink: msfileBitfsWebRtcSellerLinks.has(webrtcBody.session_id),
  });
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
              ? sellerLink
              : buyerLink
                ? { sessionId: buyerLink.transportSessionId, requestMessageId: buyerLink.requestMessageId, peerPublicKeyHex: buyerLink.peerPublicKeyHex, ownerSessionEpoch: buyerLink.ownerSessionEpoch, windowLeaseId: buyerLink.windowLeaseId }
                : undefined;
            if (link) {
              const executor = deps.buyerExecutor.bind(deps, link.windowLeaseId);
              if (link.ownerSessionEpoch !== deps.session().sessionEpoch
                || link.requestMessageId !== webrtcBody.request_message_id
                || link.peerPublicKeyHex !== opened.from_public_key.toLowerCase()) {
                throw new Error("BitFS WebRTC signal owner or peer relation mismatch");
              }
              try {
                await executor({
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
                if (sellerLink) {
                  if (msfileBitfsWebRtcSellerLinks.get(webrtcBody.session_id) !== sellerLink) return;
                  msfileBitfsWebRtcSellerLinks.delete(webrtcBody.session_id);
                } else {
                  if (msfileBitfsWebRtcBuyerLinks.get(webrtcBody.session_id) !== buyerLink) return;
                  msfileBitfsWebRtcBuyerLinks.delete(webrtcBody.session_id);
                }
                if (sellerLink) await msfileSellerSessionManager?.close(link.sessionId, "transport_error").catch(() => undefined);
                else await executor({
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
    disconnectWindowTransport,
    handleInboxWebRtc,
    isMsfileMutationControl,
    revoke: () => { traceBitfs("runtime.revoked", () => deps.session()); demandMonitor.clear(); arbitrationScope?.controller.abort(); arbitrationScope = undefined; stopMsfileSellerRuntime(); clearBuyerState(); msfileFundingRuntime.clear(); },
    clearBuyerState,
    resetControlQueue: () => { msfileMutationTail = Promise.resolve(); },
    createMsfileBitfsBuyerTask,
    msfileBitfsBuyerRequests,
    msfileBitfsBuyerOfferCounts,
    configureMsfileSellerRuntime,
    msfileBitfsWebRtcBuyerLinks,
    msfileBitfsWebRtcSellerLinks,
    stopMsfileSellerRuntime,
    msfileFundingRuntime,
    acceptMsfileBitfsWebRtcOffer,
    get msfileSellerSessionManager() { return msfileSellerSessionManager; },
    handleMsfileSellerHashRequest,
    get msfileSellerProtocolPort() { return msfileSellerProtocolPort; },
    drainMsfilePendingSellerHashRequests,
    handleBitfsSellerStreamEvent,
    msfileBitfsBuyerTaskKey,
    listMsfileBitfsBuyerTaskSnapshots,
    currentMsfileBitfsFundingLedger,
    get msfileSellerRuntime() { return msfileSellerRuntime; },
    get testMsfileSellerBridge() { return testMsfileSellerBridge; },
    set testMsfileSellerBridge(value: typeof testMsfileSellerBridge) { testMsfileSellerBridge = value; },
    get msfileSellerDependencyResume() { return msfileSellerDependencyResume; },
    set msfileSellerDependencyResume(value: typeof msfileSellerDependencyResume) { msfileSellerDependencyResume = value; },
    get msfileSellerIndex() { return msfileSellerIndex; },
  };
}
