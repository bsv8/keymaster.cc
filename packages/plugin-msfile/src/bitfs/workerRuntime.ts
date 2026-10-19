import { bitfsPoolSettlementFee } from "./poolBudget.js";
import { deleteBitfsPurchaseData } from "./purchaseCleanup.js";
import { listBitfsFundingPools } from "./fundingPools.js";
import { createBitfsRetainedContentStore, readBitfsDeletedHistory, readBitfsHiddenHistory } from "./purchaseRetention.js";
import { createBitfsPurchaseTasks, type BitfsPurchaseTask } from "./purchaseTasks.js";
import { selectBitfsMediaType } from "./mediaTypeVote.js";
import { parseBitfsBuyerPurchaseManifest } from "./buyerProtocol.js";
import { createBitfsDemandMonitor } from "./demandMonitor.js";
import { inspectPurchasedMsFileSeed, commitPurchasedMsFileContent, inspectLocalMsFileSeed } from "../storage/msfileSeedStore.js";
import { encodeBitfsBuyerPurchaseManifest } from "./buyerProtocol.js";
import { arbitrationFeeForItems } from "./arbitrationFees.js";
import {
  MonotonicClock, SchedulerAdapter, SchedulerCommandExecutor, createSchedulerSnapshotStore,
  type SchedulerCommandPorts,
} from "./schedulerHost/index.js";
import type {
  Command as SchedulerCommand, Fees as SchedulerFees, Payload as SchedulerPayload, Quote as SchedulerQuote,
} from "keymaster.cc-download-scheduler";
import { prepareBitfsPoolRecoveryWithCurrentRevision } from "./funding.js";
import { BitfsArbitrationWorkflow } from "./arbitrationWorkflow.js";
import {createBitfsBuyerPaymentSigner,createBitfsPaymentSigner} from '@keymaster/vaultlink-integration';
import type { CoordinatorClientRequest, CoordinatorMsFileControl, CoordinatorResponse, MsFileErrorCode, ActiveKeyCrypto, BorrowedModuleFileStore, MsFileSellerSettings, SessionEpoch, ProtocolSpendService, P2pkhUtxoSnapshotResult, WocServiceHandle } from "@keymaster/contracts";
import { normalizeMsFileSatoshiAmount, isValidMsFileHashHex, MSFILE_BITFS_BUYER_SETTINGS_DEFAULT } from "@keymaster/contracts";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { BitfsSeedIndex, BitfsSellerRuntime, BitfsSellerSessionManager, createBitfsBuyerTask, createBitfsBuyerDownloadPlan, BitfsBuyerProtocol, createBitfsLocalSellerContentResolver, BitfsTransactionBroadcaster, createBitfsJournal, createBitfsSessionJournal, createBitfsTransactionJournal, createBitfsVaultSigner, createBitfsWocChainPort, createMsFileLocalContentSource, recoverBitfsBuyerContentCommit, readBitfsBuyerLocalPaymentState, assertBitfsBuyerCloseBinding, parseBitfsBuyerCloseBinding, createUnavailableBitfsSellerContentResolver, reconcileBitfsTransactions, reconcileBitfsSessionTransactions, readBitfsPoolSpendChain, prepareBitfsFunding, recoverBitfsFundingSplits, BitfsSellerProtocol, type BitfsSellerMatch, type BitfsBuyerQuoteView, type BitfsBuyerTask, type BitfsSellerProtocolPort, type BitfsSellerStreamTransport, type BitfsFundingPrepareDeps, type BitfsTransactionJournal, type BitfsFundingLedger, type MsFileServiceImpl } from "../coordinator.js";
import type { WorkerFundingDependencies, createWorkerFundingRuntime } from "./workerFundingRuntime.js";
import { completeBuyerOpening, parse, parsePaymentState, verifyArbitratedPayment, verifyBuyerCompletedClose, transactionID } from "go-bitfs";
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
  requestPayment(command: import("@keymaster/contracts").CoordinatorWalletPaymentCommand): Promise<unknown>;
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
  stopSellerSubscriptions(): void;
  demandNetworkStatus(): Promise<import("@keymaster/contracts").MsFileDemandMonitorSnapshot["network"]>;
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
    const signer = createBitfsPaymentSigner(createBitfsVaultSigner(cryptoPort), {
      network, role: "seller", assertActive, requestPayment: deps.requestPayment,
      async previousTransaction(txid) {
        const retained = await transactions.getTransaction(txid);
        if (retained) return retained;
        for (const record of await sessions.list()) {
          const raw = await sessions.getEvidence(record.sessionId, "funding-transaction");
          if (raw && deps.bytesToHex(new Uint8Array(transactionID(raw)).reverse()) === txid) return raw;
        }
        const currentWoc = requireWoc();
        if (!currentWoc.getRawTransaction) throw new Error("缺少费用池资金交易证据");
        const raw = deps.hexToBytes(await currentWoc.getRawTransaction(network, txid)); assertActive(); return raw;
      },
    });
    const flow = new BitfsArbitrationWorkflow({
      owner, sessions, store, content: deps.files(""), contentForSession: record => buyerContentStore(owner, record.seedHashHex, record.sessionId), signer,
      broadcaster: new BitfsTransactionBroadcaster({ journal: transactions, chain: { async broadcast(input) { return createBitfsWocChainPort(requireWoc(), network).broadcast(input); }, async lookupTransaction(txid) { return createBitfsWocChainPort(requireWoc(), network).lookupTransaction(txid); } }, nowMs: () => Date.now() }),
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
  resumeSessionId?: string;
  /** 仅本轮需求明确启动的购买可回显到下载页。 */
  currentDemandPurchases?: Set<string>;
  /** 当前需求已经计算出的金额，只用于页面展示。 */
  feeBreakdowns?: Map<string, NonNullable<import("@keymaster/contracts").MsFileBitfsPurchaseSnapshot["feeBreakdown"]>>;
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
  /** 内核驱动模式下协议使用的共享下载计划；与协议同时创建。 */
  downloadPlan?: ReturnType<typeof createBitfsBuyerDownloadPlan>;
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
  let restoredContentCommit = false;
  if (candidate.phase === "content-committing") {
    const contentStore = buyerContentStore(input.ownerPublicKeyHex, candidate.seedHashHex, candidate.sessionId);
    try {
      restoredContentCommit = await recoverBitfsBuyerContentCommit({
        sessions,
        contentStore,
        sessionId: candidate.sessionId,
        nowMs: Date.now(),
        async onContentCommitted(seedHashHex) {
          if ((await readBitfsDeletedHistory(deps.files("bitfs-journal"), seedHashHex)).has(candidate.sessionId)) return;
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
      recoveryErrorMessage = error instanceof Error ? error.message : "付款后的本地文件恢复暂不可用";
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
  const task = (await tasks.list()).find(t => t.sessionIds.includes(sessionId));
  if (!task || task.state !== "active") return;
  const journal = createBitfsSessionJournal(deps.files("bitfs-journal"));
  const records = await Promise.all(task.sessionIds.map(id => journal.get(id)));
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
async function adoptExistingPurchaseContent(owner: string, seed: string, size: string, plan: ReturnType<typeof createBitfsBuyerDownloadPlan>) {
  const content = deps.files("");
  const staging = `bitfs-staging/by-seed/${seed}`;
  const canonical = await content.get(`seeds/${seed}.ms`);
  const unresolved = new Set<string>();
  let pendingSignedSeed = false;
  const priorPlans: { seedCompleted?: boolean; blocks?: Record<string, { state?: string }> }[] = [];
  const deleted = await readBitfsDeletedHistory(deps.files("bitfs-journal"), seed);
  for (const task of await (await purchaseTasksFor(owner, seed)).list()) {
    if (task.sessionIds.every(id => deleted.has(id))) continue;
    const path = task.legacyPlan ? `download-plans/${seed}.json` : `download-plans/${seed}/${task.taskId}.json`;
    const value = await deps.files("bitfs-journal").get(path);
    if (value) {
      const prior = JSON.parse(new TextDecoder().decode(value.bytes));
      priorPlans.push(prior);
      if (task.state === "ended" && task.endReason === "replaced" && !prior.seedCompleted && prior.seedOwnerSessionId) {
        const seller = await createBitfsSessionJournal(deps.files("bitfs-journal")).get(prior.seedOwnerSessionId);
        const id = seller?.pendingAuthorizationId;
        pendingSignedSeed ||= Boolean(id && seller?.evidence.some(name => name === `kind7-payment-sign-digest-${id}` || name === `kind7-payment-signature-${id}` || name === `kind7-payment-update-${id}`));
      }
      if (task.state === "ended" && task.endReason === "replaced") for (const [hash, claim] of Object.entries(prior.blocks ?? {}) as [string, { state: string }][]) if (claim.state === "claimed") unresolved.add(hash);
    }
  }
  await plan.reserveUnsettledContent([...unresolved]);
  const seedBytes = canonical?.bytes ?? ((pendingSignedSeed || priorPlans.some(p => p.seedCompleted)) ? (await content.get(`${staging}/seed.bin`))?.bytes : undefined);
  if (!seedBytes) return;
  let inspected: Awaited<ReturnType<typeof inspectPurchasedMsFileSeed>>;
  try { inspected = await inspectPurchasedMsFileSeed({ seedHashHex: seed, seedBytes, fileSizeBytes: size }); } catch { return; }
  await content.put(`${staging}/seed.bin`, seedBytes);
  const available: string[] = [];
  for (const [index, hash] of inspected.blockHashesHex.entries()) {
    const canonicalBlock = await content.get(`storage/${seed}/${hash}`);
    const paid = priorPlans.some(p => p.blocks?.[hash]?.state === "completed");
    const bytes = canonicalBlock?.bytes ?? ((paid || unresolved.has(hash)) ? (await content.get(`${staging}/blocks/${hash}.bin`))?.bytes : undefined);
    const expected = index === inspected.blockHashesHex.length-1 ? Number(BigInt(size) - BigInt(index)*262144n) : 262144;
    if (!bytes || bytes.byteLength !== expected || deps.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))) !== hash) continue;
    await content.put(`${staging}/blocks/${hash}.bin`, bytes);
    available.push(hash);
  }
  await plan.reserveUnsettledContent([...unresolved].filter(hash => !available.includes(hash)));
  await plan.adoptVerifiedContent(inspected.blockHashesHex, available);
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
      && !["completed", "cancelled", "refunded", "arbitration-retrieval"].includes(record.phase))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const tasksBySeed = new Map<string, BitfsBuyerTask>();
  const failures = new Map<string, string>();
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
        failures.set(record.sessionId, summary.message);
      }
    } catch (error) {
      // 单条记录恢复失败时保留原账本和 exact bytes，继续处理其它池；后续任务页仍可重试。
      failures.set(record.sessionId, error instanceof Error ? error.message : String(error));
      console.warn("[msfile] BitFS buyer session recovery deferred", {
        sessionId: record.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const record of await sessions.list()) {
    if (record.role === "buyer" && record.ownerPublicKeyHex === owner && ["completed", "cancelled", "refunded", "failed"].includes(record.phase)) {
      assertCurrentOwner();
      await finishPurchaseTask(owner, record.seedHashHex, record.sessionId);
    }
  }
  await recoverMsfileBitfsKernelRuntimes(owner);
  if (failures.size > 0) {
    const details = [...failures].map(([sessionId, message]) => `${sessionId}: ${message}`).join("\n");
    console.warn(`[msfile] ${failures.size} 条历史资金恢复未完成，继续保留专款保护，不占用新采购资格。\n${details}`);
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
      || record.evidence.includes("purchase-manifest") || record.evidence.includes("download-plan")
      || record.phase === "cancel-opening"));
  const ledger = currentMsfileBitfsFundingLedger();
  const contentStore = deps.files( "");
  const snapshots: import("@keymaster/contracts").MsFileBitfsTaskSnapshot[] = [];
  for (const record of records) {
    let session = await sessions.get(record.sessionId);
    if (!session) continue;
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
          const object = await contentStore.get(file.path);
          if (object) verifiedBlockBytes += BigInt(object.bytes.byteLength);
          else verifiedBlockBytesKnown = false;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const fileTaskForCount = await taskForSession(owner, session.seedHashHex, session.sessionId);
    const historyPlanPath = fileTaskForCount && !fileTaskForCount.legacyPlan ? `download-plans/${session.seedHashHex}/${fileTaskForCount.taskId}.json` : `download-plans/${session.seedHashHex}.json`;
    const historyPlan = await deps.files("bitfs-journal").get(historyPlanPath);
    if (historyPlan) {
      const history = JSON.parse(new TextDecoder().decode(historyPlan.bytes)) as { blocks?: Record<string, { state: string; sessionId: string }> };
      verifiedBlockCount = Object.values(history.blocks ?? {}).filter(b => b.state === "completed").length;
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
    const fileTask = await taskForSession(owner, session.seedHashHex, session.sessionId);
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
      availableQuotes,
      canCancel: cancelBeforePool || cancelPool,
      canReconnect,
      message: [canReconnect ? "卖家连接已断开；可在此重新连接原购买会话。" : statusMessage, session.failureMessage].filter(Boolean).join(" "),
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
      currentMaxFullBlockPriceSatoshis: activePurchase && purchase ? purchase.currentMaxFullBlockPriceSatoshis ?? null : null,
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
    // 当前需求不恢复历史购买；历史恢复由详情页明确发起。
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
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  const activeTask = owner ? await taskForSession(owner, normalizedSeed) : undefined;
  if (!entry || !task) {
    return { existingPurchaseSessionId: activeTask?.taskId ?? null, seedHashHex: normalizedSeed, requestMessageId: null, expiresAtMs: null, quotes: [], currentMaxFullBlockPriceSatoshis: null };
  }
  const currentPurchase = entry.purchase && entry.currentDemandPurchases?.has(entry.purchase.sessionId) ? entry.purchase : undefined;
  return {
    seedHashHex: normalizedSeed,
    requestMessageId: entry.requestMessageId ?? null,
    expiresAtMs: entry.expiresAtMs > 0 ? entry.expiresAtMs : null,
    quotes: activeTask ? [] : await addMsfileBitfsRecentSellerSpeeds(
      entry.ownerPublicKeyHex,
      normalizedSeed,
      await task.listDiscoveredQuotes(),
    ),
    purchase: currentPurchase ? { ...currentPurchase, feeBreakdown: entry.feeBreakdowns?.get(currentPurchase.sessionId) } : null,
    existingPurchaseSessionId: activeTask?.taskId ?? null,
    currentMaxFullBlockPriceSatoshis: null,
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
  const feeRate = settings.feeRateSatoshisPerKb;
  if (!Number.isSafeInteger(feeRate) || feeRate < 1) throw new Error("BitFS 池内手续费率配置无效");
  const cryptoPort = await deps.crypto(owner);
  assertCurrentContext();
  const journalStore = deps.files( "bitfs-journal");
  const quoteSessionId = link.quoteSessionId;
  if (!quoteSessionId) throw new Error("BitFS 下载计划需要先持久化已验签报价");
  const contentStore = buyerContentStore(owner, link.seedHashHex, quoteSessionId);
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
  const purchaseTask = await taskForSession(owner, link.seedHashHex, quoteSessionId);
  const downloadPlan = createBitfsBuyerDownloadPlan({
    taskId: purchaseTask && !purchaseTask.legacyPlan ? purchaseTask.taskId : undefined,
    ownerPublicKeyHex: owner,
    seedHashHex: link.seedHashHex,
    fileSizeBytes: canonicalQuote.fileSizeBytes,
    recommendedFilename: canonicalQuote.recommendedFilename,
    store: journalStore,
  });
  // 已结束任务的重连仅用于旧资金处理，不重新取得内容调度资格。
  if (purchaseTask?.state === "ended") await downloadPlan.requestStop();
  const paymentNetwork=deps.network();
  const vaultSigner = createBitfsBuyerPaymentSigner(createBitfsVaultSigner(cryptoPort),{
    network: paymentNetwork,assertActive(){assertCurrentContext();if(deps.network()!==paymentNetwork)throw new Error("BitFS payment network changed");},requestPayment:deps.requestPayment,
    async previousTransaction(txid){
      const saved=await createBitfsTransactionJournal(journalStore).getTransaction(txid);
      if(saved)return saved;
      if(!woc.getRawTransaction)throw new Error('BitFS previous transaction evidence unavailable');
      return deps.hexToBytes(await woc.getRawTransaction(paymentNetwork,txid));
    },
  });
  const signer = {
    publicKey: () => vaultSigner.publicKey(),
    async sign(request: Parameters<typeof vaultSigner.sign>[0], signal?: AbortSignal): Promise<Uint8Array> {
      try {
        return await vaultSigner.sign(request, signal);
      } catch (error) {
        await writeBitfsDiagnostic("buyer-signer-error.json", {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
  };
  const reserve = await arbitrationReserve(runtime, quoteView.supportedArbiterPublicKeys);
  const buyerArbitration = (await runtime.getSettingsSnapshot()).arbitrationServices.length > 0 ? await arbitrationWorkflow(runtime) : undefined;
  const kernelRuntime = msfileBitfsKernelRuntimeFor(owner, link.seedHashHex);
  const protocol = new BitfsBuyerProtocol({
    serialize: buyerArbitration ? (id, run) => buyerArbitration.exclusive(id, run) : undefined,
    arbitrationServices: async () => (await runtime.getSettingsSnapshot()).arbitrationServices,
    arbitrationReserveSatoshis: reserve,
    task: link.task,
    sessions: createBitfsSessionJournal(journalStore),
    signer,
    contentStore,
    downloadPlan,
    selectionPriority: "recent-speed",
    refundDelayBlocks: buyerSettings.refundDelayBlocks,
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
        // 内核路径的补卖家由适配器在席位空缺时下发 open 命令，不再由计划回调自行找卖家。
      }, 0);
    },
    blockHeight: () => deps.blockHeight(deps.network()),
    nowMs: () => Date.now(),
     minerFeeRateSatoshisPerKilobyte: BigInt(feeRate),
     assertCurrentContext,
     onSignerError: (error) => writeBitfsDiagnostic("buyer-signer-error.json", {
       message: error instanceof Error ? error.message : String(error),
       name: error instanceof Error ? error.name : typeof error,
       stack: error instanceof Error ? error.stack : undefined,
     }),
    async onContentCommitted(seedHashHex) {
      if ((await readBitfsDeletedHistory(journalStore, seedHashHex)).has(quoteSessionId)) return;
      const index = msfileSellerIndex;
      if (!index) return;
      const indexGeneration = index.currentGeneration();
      index.invalidate(seedHashHex);
      await index.refresh(contentStore, seedHashHex, indexGeneration);
    },
    onVerifiedDelivery: persistMsfileBitfsSellerSpeedSample,
    ...(kernelRuntime ? {
      dispatchMode: true,
      // 协议回调运行在会话串行锁内；内核命令会回调协议（continue/close），
      // 必须排程到锁释放后执行，否则非重入锁自锁。
      onPoolUsable: ({ sessionId }: { sessionId: string }) => {
        setTimeout(() => {
          void (async () => {
            const state = kernelRuntime.adapter.snapshot();
            const pool = Object.values(state.pools).find((item) => item.sessionId === sessionId && item.funding === "opening");
            if (!pool) return;
            await msfileBitfsKernelFeed(kernelRuntime, {
              eventId: `opened-${pool.id}`, payload: { type: "opened", poolId: pool.id, commandId: pool.openCommandId },
            });
            await kernelRuntime.adapter.settle(pool.openCommandId);
            kernelRuntime.executor.forget(pool.openCommandId);
          })().catch(() => undefined);
        }, 0);
      },
      onPoolClosed: ({ sessionId }: { sessionId: string }) => {
        setTimeout(() => { void msfileBitfsKernelFeedCloseSettled(kernelRuntime, sessionId).catch(() => undefined); }, 0);
      },
      onDispatchedDelivery: ({ sessionId, accepted, paidSatoshis, startedAt, endedAt }: {
        sessionId: string; contentIds: string[]; accepted: string[]; paidSatoshis: string; startedAt: number; endedAt: number;
      }) => {
        setTimeout(() => {
          void (async () => {
            const state = kernelRuntime.adapter.snapshot();
            const pool = Object.values(state.pools).find((item) => item.sessionId === sessionId && item.requestId !== null);
            const requestId = pool?.requestId ?? null;
            if (!requestId) return;
            const request = state.requests[requestId];
            // 交付墙钟取最内侧帧时刻：Kind 5 写出完成 → Kind 6 完整到达（校验之前）。
            const sentAt = msfileBitfsKernelLastSentAt.get(sessionId);
            const receivedAt = msfileBitfsKernelLastReceivedAt.get(sessionId);
            const wallStartedAt = sentAt !== undefined ? sentAt : startedAt;
            const wallEndedAt = receivedAt !== undefined && receivedAt > wallStartedAt ? receivedAt : Math.max(wallStartedAt + 1, endedAt);
            await msfileBitfsKernelFeed(kernelRuntime, {
              eventId: `delivery-${requestId}`,
              payload: { type: "delivery", requestId, accepted, paid: paidSatoshis, startedAt: wallStartedAt, endedAt: wallEndedAt },
            });
            msfileBitfsKernelProgress.delete(sessionId);
            msfileBitfsKernelLastSentAt.delete(sessionId);
            msfileBitfsKernelLastReceivedAt.delete(sessionId);
            if (request) { await kernelRuntime.adapter.settle(request.commandId); kernelRuntime.executor.forget(request.commandId); }
            await msfileBitfsKernelEnsureManifest(kernelRuntime, sessionId);
          })().catch(() => undefined);
        }, 0);
      },
    } : {}),
    onProgress(progress) {
      if (["completed", "cancelled", "refunded", "failed"].includes(progress.phase)) void finishPurchaseTask(owner, link.seedHashHex, progress.sessionId).catch(error => console.error("[msfile] 采购生命周期写入失败", error));
      void writeBitfsDiagnostic("buyer-purchase-progress.json", progress);
      const taskEntry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, link.seedHashHex));
      if (!taskEntry || taskEntry.ownerSessionEpoch !== sessionEpoch || !taskEntry.currentDemandPurchases?.has(progress.sessionId)) return;
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
  await protocol.configureOpeningBudget({ sessionId: quoteSessionId });
  link.downloadPlan = downloadPlan;
  link.protocol = protocol;
  return protocol;
}

// ===== 下载策略器购买路径（schedulerMode=on）：内核决策，宿主只执行 =====

/** 内核任务运行态；快照持久化在 bitfs-journal，进程内只缓存适配器与执行器。 */
interface MsfileBitfsKernelRuntime {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  hostTaskId: string;
  fileSizeBytes: string;
  mediaType: string;
  entry?: NonNullable<ReturnType<typeof msfileBitfsBuyerTasks.get>>;
  adapter: SchedulerAdapter;
  executor: SchedulerCommandExecutor;
}

const msfileBitfsKernelRuntimes = new Map<string, MsfileBitfsKernelRuntime>();
const msfileBitfsKernelWakes = new Map<string, ReturnType<typeof setTimeout>>();
const msfileBitfsKernelClock = new MonotonicClock();
/** 流级进度基线：meter 的累计字节 → 本次内核请求已传字节。 */
const msfileBitfsKernelProgress = new Map<string, { base: number; fed: number }>();
/** 正在为某卖家刷新报价（旧协议会话已用完）的集合，避免重复取消/重发。 */
const msfileBitfsKernelQuoteRefreshes = new Set<string>();
/** 已用完的报价会话 → 等待关池结清后再刷新报价的卖家。 */
const msfileBitfsKernelPendingRefreshes = new Map<string, string>();
/** 最内侧帧时刻（买方会话编号 → 本地毫秒）：交付墙钟用。 */
const msfileBitfsKernelLastReceivedAt = new Map<string, number>();
const msfileBitfsKernelLastSentAt = new Map<string, number>();

/** Seed 内容在内核中的名义字节数；内核只用它做进度与准入，不参与协议校验。 */
const MSFILE_BITFS_KERNEL_SEED_BYTES = 192;

function msfileBitfsKernelRuntimeKey(owner: string, seed: string): string {
  return `${owner.toLowerCase()}:${seed.toLowerCase()}`;
}

function msfileBitfsKernelRuntimeFor(owner: string, seed: string): MsfileBitfsKernelRuntime | undefined {
  return msfileBitfsKernelRuntimes.get(msfileBitfsKernelRuntimeKey(owner, seed));
}

/** 内核运行态当前可用的已连接报价链路（键为报价会话编号）。 */
function msfileBitfsKernelLinksFor(ownerPublicKeyHex: string, seedHashHex: string) {
  const owner = ownerPublicKeyHex.toLowerCase();
  const seed = seedHashHex.toLowerCase();
  const links = new Map<string, { webrtcSessionId: string; link: NonNullable<ReturnType<typeof msfileBitfsWebRtcBuyerLinks.get>> }>();
  for (const [webrtcSessionId, link] of msfileBitfsWebRtcBuyerLinks) {
    if (link.quoteSessionId && link.ownerPublicKeyHex.toLowerCase() === owner
      && link.seedHashHex.toLowerCase() === seed
      && link.ownerSessionEpoch === deps.session().sessionEpoch) {
      links.set(link.quoteSessionId, { webrtcSessionId, link });
    }
  }
  return links;
}

function msfileBitfsKernelLinks(runtime: MsfileBitfsKernelRuntime) {
  return msfileBitfsKernelLinksFor(runtime.ownerPublicKeyHex, runtime.seedHashHex);
}

/** 选一个当前已配置且报价支持的仲裁方；与开池时的选择一致。 */
async function msfileBitfsKernelArbiter(quoteView: import("@keymaster/contracts").MsFileBitfsQuoteView): Promise<string> {
  const runtime = await deps.ensureService();
  const services = (await runtime.getSettingsSnapshot()).arbitrationServices;
  const selected = services.find(service => quoteView.supportedArbiterPublicKeys.includes(service.publicKeyHex));
  if (services.length > 0 && !selected) throw new Error("报价没有本网络已配置的可信仲裁服务");
  const hex = selected?.publicKeyHex ?? quoteView.supportedArbiterPublicKeys[0];
  if (!hex) throw new Error("报价没有可用仲裁方");
  return hex.toLowerCase();
}

/** 内核报价费用估算：结算探针（开池近似同额）加仲裁基础/条目费。 */
async function msfileBitfsKernelQuoteFees(quoteView: import("@keymaster/contracts").MsFileBitfsQuoteView): Promise<SchedulerFees> {
  const display: { base?: string; perItem?: string } = {};
  await arbitrationReserve(await deps.ensureService(), quoteView.supportedArbiterPublicKeys, display);
  const feeRate = BigInt((await deps.p2pkhSettings()).feeRateSatoshisPerKb);
  if (feeRate < 1n) throw new Error("BitFS 池内手续费率配置无效");
  const owner = deps.session().activePublicKeyHex!.trim().toLowerCase();
  const minerFee = await bitfsPoolSettlementFee({
    buyerPublicKey: deps.hexToBytes(owner),
    sellerPublicKey: deps.hexToBytes(quoteView.sellerPublicKeyHex),
    arbiterPublicKey: deps.hexToBytes(await msfileBitfsKernelArbiter(quoteView)),
  }, feeRate);
  return {
    version: 1, opening: minerFee.toString(10), settlement: minerFee.toString(10),
    arbitrationBase: display.base ?? "0", arbitrationPerItem: display.perItem ?? "0",
  };
}

/** 已验签报价 → 内核 Quote。version 由宿主单调递增（同卖家后到的新报价必须能覆盖旧报价）。 */
async function msfileBitfsKernelQuote(quoteView: import("@keymaster/contracts").MsFileBitfsQuoteView, version: number): Promise<SchedulerQuote> {
  const expiresAtSeconds = Number(quoteView.quoteExpiresAtUnixSeconds);
  return {
    id: quoteView.sessionId, version, sellerId: quoteView.sellerPublicKeyHex, sessionId: quoteView.sessionId,
    expiresAt: Number.isSafeInteger(expiresAtSeconds) && expiresAtSeconds > 0 ? expiresAtSeconds * 1_000 : Date.now() + 300_000,
    blockPrice: quoteView.fullBlockPriceSatoshis, seedPrice: quoteView.seedPriceSatoshis, blockBytes: 262_144,
    maxBlocks: quoteView.maxBlocksPerBatch, fees: await msfileBitfsKernelQuoteFees(quoteView),
  };
}

/** 把一份已验签报价喂给内核；版本按该卖家在内核里的当前报价递增。 */
async function msfileBitfsKernelFeedQuote(runtime: MsfileBitfsKernelRuntime, quoteView: import("@keymaster/contracts").MsFileBitfsQuoteView): Promise<void> {
  const previous = runtime.adapter.snapshot().sellers[quoteView.sellerPublicKeyHex]?.quote?.version ?? 0;
  const quote = await msfileBitfsKernelQuote(quoteView, previous + 1);
  msfileBitfsKernelQuoteRefreshes.delete(quoteView.sellerPublicKeyHex.toLowerCase());
  await msfileBitfsKernelFeed(runtime, { eventId: `quote-${quoteView.sessionId}`, payload: { type: "quote", quote } });
}

/** 让内核立即忽略某卖家已用过的报价（版本递增 + 过期）。 */
async function msfileBitfsKernelExpireQuote(runtime: MsfileBitfsKernelRuntime, sellerId: string): Promise<void> {
  const seller = runtime.adapter.snapshot().sellers[sellerId];
  if (!seller?.quote) return;
  await msfileBitfsKernelFeed(runtime, {
    eventId: `quote-expire-${sellerId}-${seller.quote.version}`,
    payload: { type: "quote", quote: { ...seller.quote, version: seller.quote.version + 1, expiresAt: Date.now() - 1 } },
  });
}

/**
 * 协议报价会话一次采购一份费用池；内核“一池一批”需要下一批时，
 * 宿主取消旧需求并重发，让卖家给出版本更新的新报价（新 session）。
 * 必须在旧池关闭结清后调用，否则会打断 Kind 12/13 关池流程。
 */
async function msfileBitfsKernelRefreshQuote(runtime: MsfileBitfsKernelRuntime, sellerId: string, sessionId: string): Promise<void> {
  const sellerKey = sellerId.toLowerCase();
  if (msfileBitfsKernelQuoteRefreshes.has(sellerKey)) return;
  msfileBitfsKernelQuoteRefreshes.add(sellerKey);
  try {
    const target = msfileBitfsKernelLinks(runtime).get(sessionId);
    if (!target) { msfileBitfsKernelQuoteRefreshes.delete(sellerKey); return; }
    await target.link.task.cancelDemand().catch(() => undefined);
    const messageId = await target.link.task.publishDemand();
    if (runtime.entry) runtime.entry.requestMessageId = messageId;
  } catch (error) {
    msfileBitfsKernelQuoteRefreshes.delete(sellerKey);
    await writeBitfsDiagnostic("buyer-scheduler-quote-refresh-error.json", {
      seedHashHex: runtime.seedHashHex, sellerId, sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 普通钱包快照 → 内核 wallet；已准备开池（Kind 2 已落盘）的命令视为占用已反映。 */
async function msfileBitfsKernelWallet(runtime: MsfileBitfsKernelRuntime): Promise<{ revision: number; available: string; reflectedCommands: string[] }> {
  const snapshot = await waitForMsfileFundingSnapshot({
    ownerPublicKeyHex: runtime.ownerPublicKeyHex, seedHashHex: runtime.seedHashHex,
    network: deps.network(), ledger: currentMsfileBitfsFundingLedger(),
  });
  const available = snapshot.available && snapshot.state === "fresh"
    ? snapshot.items.filter((item) => !item.isSpentInMempoolTx).reduce((sum, item) => sum + BigInt(item.value), 0n)
    : 0n;
  const sessions = createBitfsSessionJournal(deps.files("bitfs-journal"));
  const prepared = new Set<string>();
  for (const record of await sessions.list()) {
    if (record.role !== "buyer" || record.ownerPublicKeyHex !== runtime.ownerPublicKeyHex
      || record.seedHashHex !== runtime.seedHashHex) continue;
    if (record.evidence.includes("kind2-opening-request")) prepared.add(record.sessionId);
  }
  const state = runtime.adapter.snapshot();
  const reflectedCommands = Object.values(state.pools)
    .filter((pool) => prepared.has(pool.sessionId))
    .map((pool) => pool.openCommandId);
  const revision = typeof snapshot.seq === "number" && Number.isSafeInteger(snapshot.seq) ? snapshot.seq : state.wallet.revision + 1;
  return { revision, available: available.toString(10), reflectedCommands };
}

/** 内核事件投递：推进适配器、按 commandId 幂等执行命令并重排唤醒。 */
async function msfileBitfsKernelFeed(runtime: MsfileBitfsKernelRuntime, input: { eventId: string; payload: SchedulerPayload; occurredAt?: number }): Promise<void> {
  const commands = await runtime.adapter.handle(input);
  for (const command of commands) await msfileBitfsKernelRunCommand(runtime, command);
  msfileBitfsKernelArmWake(runtime);
}

/** 命令失败按资金状态回灌错误事实，不静默吞掉。 */
async function msfileBitfsKernelRunCommand(runtime: MsfileBitfsKernelRuntime, command: SchedulerCommand): Promise<void> {
  try {
    await runtime.executor.run(command);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "下载策略器命令执行失败";
    await writeBitfsDiagnostic("buyer-scheduler-command-error.json", {
      seedHashHex: runtime.seedHashHex, commandId: command.commandId, type: command.type, message,
      stack: cause instanceof Error ? cause.stack : undefined,
    });
    const eventId = `command-error-${command.commandId}`;
    if (command.type === "open") {
      const pool = runtime.adapter.snapshot().pools[command.poolId];
      const record = pool ? await createBitfsSessionJournal(deps.files("bitfs-journal")).get(pool.sessionId) : undefined;
      const funded = record ? record.evidence.includes("kind2-opening-request") || record.evidence.includes("funding-transaction") : false;
      if (funded) await msfileBitfsKernelFeed(runtime, { eventId, payload: { type: "unknown", poolId: command.poolId, commandId: command.commandId } });
      else await msfileBitfsKernelFeed(runtime, { eventId, payload: { type: "open-failed", poolId: command.poolId, commandId: command.commandId, released: true } });
    } else if (command.type === "download") {
      await msfileBitfsKernelFeed(runtime, { eventId, payload: { type: "request-rejected", requestId: command.requestId, safeToRetry: true } });
    } else if (command.type === "close") {
      await msfileBitfsKernelFeed(runtime, { eventId, payload: { type: "unknown", poolId: command.poolId, commandId: command.commandId } });
    } else {
      await msfileBitfsKernelFeed(runtime, { eventId, payload: { type: "tick" } });
    }
  }
}

/** 按 nextWakeAt 安排下一次 tick；重启后由恢复的 state 重建。 */
function msfileBitfsKernelArmWake(runtime: MsfileBitfsKernelRuntime): void {
  const key = msfileBitfsKernelRuntimeKey(runtime.ownerPublicKeyHex, runtime.seedHashHex);
  const existing = msfileBitfsKernelWakes.get(key);
  if (existing) clearTimeout(existing);
  const at = runtime.adapter.nextWakeAt();
  if (at === null || !Number.isFinite(at)) { msfileBitfsKernelWakes.delete(key); return; }
  const delay = Math.max(0, Math.min(at - Date.now(), 2_147_483_647));
  const revision = runtime.adapter.snapshot().revision;
  const timer = setTimeout(() => {
    msfileBitfsKernelWakes.delete(key);
    void msfileBitfsKernelFeed(runtime, { eventId: `wake-${at}-${revision}`, payload: { type: "tick" } }).catch(() => undefined);
  }, delay);
  msfileBitfsKernelWakes.set(key, timer);
}

/** 流字节活动 → 内核请求进度（基于 meter 累计字节与本次请求基线）。 */
async function msfileBitfsKernelFeedStreamProgress(webrtcSessionId: string, bytesIn: number): Promise<void> {
  const link = msfileBitfsWebRtcBuyerLinks.get(webrtcSessionId);
  const quoteSessionId = link?.quoteSessionId;
  if (!link || !quoteSessionId) return;
  const runtime = msfileBitfsKernelRuntimeFor(link.ownerPublicKeyHex, link.seedHashHex);
  if (!runtime) return;
  const state = runtime.adapter.snapshot();
  const pool = Object.values(state.pools).find((item) => item.sessionId === quoteSessionId && item.requestId !== null);
  const requestId = pool?.requestId ?? null;
  if (!requestId) { msfileBitfsKernelProgress.delete(quoteSessionId); return; }
  const request = state.requests[requestId];
  if (!request || request.state !== "pending") return;
  let record = msfileBitfsKernelProgress.get(quoteSessionId);
  if (!record) { record = { base: bytesIn, fed: 0 }; msfileBitfsKernelProgress.set(quoteSessionId, record); return; }
  const transferred = Math.max(0, bytesIn - record.base);
  if (transferred <= record.fed) return;
  try {
    await msfileBitfsKernelFeed(runtime, {
      eventId: `progress-${requestId}-${transferred}`,
      payload: { type: "progress", requestId, bytes: transferred },
    });
    record.fed = transferred;
  } catch { /* 进度只用于停摆判定；写入失败不中断下载。 */ }
}

/** 内核 open：按执行层真实费率复算开池金额并启动协议会话。 */
async function msfileBitfsKernelOpenPool(runtime: MsfileBitfsKernelRuntime, command: Extract<SchedulerCommand, { type: "open" }>): Promise<void> {
  const target = msfileBitfsKernelLinks(runtime).get(command.sessionId);
  if (!target) throw new Error("内核所选卖家的 DataChannel 已关闭");
  await target.link.quoteAccepted;
  const protocol = await ensureMsfileBitfsBuyerProtocol(target.webrtcSessionId, target.link);
  const quoteView = (await target.link.task.listDiscoveredQuotes()).find((item) => item.sessionId === command.sessionId);
  if (!quoteView) throw new Error("找不到内核所选卖家的已验签报价");
  // 协议会话只服务一份费用池；已用完时刷新报价，让内核用新 session 重开。
  const sessionRecord = await createBitfsSessionJournal(deps.files("bitfs-journal")).get(command.sessionId);
  const consumed = sessionRecord !== undefined
    && !["quote-selected", "opening-presign", "funding-prepared"].includes(sessionRecord.phase)
    && (sessionRecord.evidence.includes("kind2-opening-request") || sessionRecord.evidence.includes("purchase-manifest") || sessionRecord.evidence.includes("download-plan"));
  if (consumed) {
    msfileBitfsKernelPendingRefreshes.set(command.sessionId, command.sellerId);
    await msfileBitfsKernelExpireQuote(runtime, command.sellerId);
    throw new Error("该报价会话已用于上一批采购；等待关池结清后刷新报价");
  }
  const state = runtime.adapter.snapshot();
  const seedPurchased = state.completed[state.seedHash] === "purchased";
  const contentBudget = BigInt(command.contentBudget);
  const seedBudget = seedPurchased ? 0n : BigInt(command.quote.seedPrice);
  if (contentBudget < seedBudget) throw new Error("内核内容预算小于 Seed 价");
  const blockBudget = contentBudget - seedBudget;
  const feeRate = BigInt((await deps.p2pkhSettings()).feeRateSatoshisPerKb);
  if (feeRate < 1n) throw new Error("BitFS 池内手续费率配置无效");
  const arbitrationDisplay: { base?: string; perItem?: string } = {};
  const arbitrationBudget = await arbitrationReserve(await deps.ensureService(), quoteView.supportedArbiterPublicKeys, arbitrationDisplay);
  const feeReserve = await protocol.configureOpeningBudget({ sessionId: command.sessionId, feeRate, arbitrationReserve: arbitrationBudget });
  const openingAmount = contentBudget + feeReserve;
  if (runtime.entry) {
    (runtime.entry.feeBreakdowns ??= new Map()).set(command.sessionId, {
      contentBudgetSatoshis: contentBudget.toString(10),
      arbitrationBaseSatoshis: arbitrationDisplay.base!,
      arbitrationPerItemSatoshis: arbitrationDisplay.perItem!,
      arbitrationItemCount: 1,
      arbitrationReserveSatoshis: arbitrationBudget.toString(10),
      settlementReserveSatoshis: (feeReserve - arbitrationBudget).toString(10),
    });
  }
  await (await purchaseTasksFor(runtime.ownerPublicKeyHex, runtime.seedHashHex)).attach(runtime.hostTaskId, command.sessionId);
  runtime.entry?.currentDemandPurchases?.add(command.sessionId);
  const progress = await protocol.startPurchase({
    sessionId: command.sessionId,
    stream: createMsfileBitfsBuyerStream(target.webrtcSessionId, target.link),
    openingAmountSatoshis: openingAmount.toString(10),
    contentBudgetSatoshis: contentBudget.toString(10),
    seedBudgetSatoshis: seedBudget.toString(10),
    seedBudgetReserved: !seedPurchased,
    blockBudgetSatoshis: blockBudget.toString(10),
    recentBytesPerSecond: null,
    mediaType: runtime.mediaType,
  });
  if (runtime.entry) {
    runtime.entry.purchase = {
      sessionId: progress.sessionId, phase: progress.phase, openingAmountSatoshis: progress.openingAmountSatoshis,
      verifiedBlockCount: progress.verifiedBlockCount, totalBlockCount: progress.totalBlockCount, message: progress.message,
    };
  }
}

/** 内核 download：把批次登记到共享计划并触发一次 Kind 5 请求。 */
async function msfileBitfsKernelDispatchDownload(runtime: MsfileBitfsKernelRuntime, command: Extract<SchedulerCommand, { type: "download" }>): Promise<void> {
  const pool = runtime.adapter.snapshot().pools[command.poolId];
  if (!pool) throw new Error("内核下载命令缺少费用池");
  const target = msfileBitfsKernelLinks(runtime).get(pool.sessionId);
  if (!target) throw new Error("内核下载命令的卖家连接已关闭");
  await target.link.quoteAccepted;
  const protocol = await ensureMsfileBitfsBuyerProtocol(target.webrtcSessionId, target.link);
  const plan = target.link.downloadPlan ?? await openMsfileBitfsBuyerDownloadPlan(runtime.ownerPublicKeyHex, runtime.seedHashHex, pool.sessionId);
  const outcome = await plan.dispatchContent(pool.sessionId, command.contentIds);
  if (outcome === "conflict") throw new Error("内核派发与下载计划冲突");
  // 新请求重新建立流进度基线。
  msfileBitfsKernelProgress.delete(pool.sessionId);
  await protocol.continueSharedDownload({ sessionId: pool.sessionId, stream: createMsfileBitfsBuyerStream(target.webrtcSessionId, target.link) });
}

/** 内核 drain：停止该池新派发，在途请求继续。 */
async function msfileBitfsKernelDrainPool(runtime: MsfileBitfsKernelRuntime, command: Extract<SchedulerCommand, { type: "drain" }>): Promise<void> {
  const pool = runtime.adapter.snapshot().pools[command.poolId];
  if (!pool) return;
  const target = msfileBitfsKernelLinks(runtime).get(pool.sessionId);
  if (!target) return;
  const plan = target.link.downloadPlan ?? await openMsfileBitfsBuyerDownloadPlan(runtime.ownerPublicKeyHex, runtime.seedHashHex, pool.sessionId);
  await plan.retirePool(pool.sessionId);
}

/** 内核 close：由宿主按意图请求Kind 12/13 关池。 */
async function msfileBitfsKernelClosePool(runtime: MsfileBitfsKernelRuntime, command: Extract<SchedulerCommand, { type: "close" }>): Promise<void> {
  const pool = runtime.adapter.snapshot().pools[command.poolId];
  if (!pool) return;
  const target = msfileBitfsKernelLinks(runtime).get(pool.sessionId);
  if (!target) throw new Error("内核关池命令的卖家连接已关闭");
  const protocol = await ensureMsfileBitfsBuyerProtocol(target.webrtcSessionId, target.link);
  await protocol.closeDispatchedPool({ sessionId: pool.sessionId, stream: createMsfileBitfsBuyerStream(target.webrtcSessionId, target.link) });
}

function msfileBitfsKernelPorts(getRuntime: () => MsfileBitfsKernelRuntime): SchedulerCommandPorts {
  return {
    openPool: (command) => msfileBitfsKernelOpenPool(getRuntime(), command),
    dispatchDownload: (command) => msfileBitfsKernelDispatchDownload(getRuntime(), command),
    drainPool: (command) => msfileBitfsKernelDrainPool(getRuntime(), command),
    closePool: (command) => msfileBitfsKernelClosePool(getRuntime(), command),
  };
}

/** 内核模式下 Seed 交付后登记 Block 清单；内核据此购买 Block。 */
async function msfileBitfsKernelEnsureManifest(runtime: MsfileBitfsKernelRuntime, sessionId: string): Promise<void> {
  const state = runtime.adapter.snapshot();
  if (state.manifestKnown && state.completed[state.seedHash] === "purchased") return;
  if (state.completed[state.seedHash] !== "purchased") return;
  const target = msfileBitfsKernelLinks(runtime).get(sessionId);
  const plan = target?.link.downloadPlan ? await target.link.downloadPlan.snapshot() : undefined;
  const hashes = plan?.blockHashesHex;
  if (!hashes || hashes.length === 0) return;
  const fileSize = BigInt(runtime.fileSizeBytes);
  const blocks = hashes.map((hash, index) => ({
    id: hash, kind: "block" as const,
    bytes: Number(fileSize - BigInt(index) * 262_144n > 262_144n ? 262_144n : fileSize - BigInt(index) * 262_144n),
  }));
  await msfileBitfsKernelFeed(runtime, { eventId: `manifest-${sessionId}`, payload: { type: "manifest", content: blocks } });
}

/** 关池交易已观察：从专款账本算出 returned/spent 并回灌内核 `closed`（含退款可用）。 */
async function msfileBitfsKernelFeedCloseSettled(runtime: MsfileBitfsKernelRuntime, sessionId: string): Promise<void> {
  const state = runtime.adapter.snapshot();
  const pool = Object.values(state.pools).find((item) => item.sessionId === sessionId
    && (item.funding === "closing" || item.funding === "open" || item.funding === "problem"));
  if (!pool || !pool.closeCommandId) return;
  const commandId = pool.closeCommandId;
  const ledger = currentMsfileBitfsFundingLedger();
  const account = await ledger.getAccount({
    ownerPublicKeyHex: runtime.ownerPublicKeyHex, seedHashHex: runtime.seedHashHex,
    network: deps.network(), nowMs: Date.now(),
  });
  const fundingPool = account.pools.find((item) => item.poolId === sessionId);
  const closeTxid = fundingPool?.recoveryTxid;
  const closeTx = account.transactions.find((item) => item.txid === closeTxid && (item.purpose === "close" || item.purpose === "refund"));
  const opening = account.utxos.find((item) => `${item.txid}:${item.vout}` === fundingPool?.openingOutpoint);
  if (!fundingPool || fundingPool.state !== "closed" || !closeTx || !opening) {
    await msfileBitfsKernelFeed(runtime, { eventId: `close-unknown-${pool.id}`, payload: { type: "unknown", poolId: pool.id, commandId } });
    return;
  }
  const amount = BigInt(opening.valueSatoshis);
  const outputs = closeTx.expectedOutputs.reduce((sum, output) => sum + BigInt(output.valueSatoshis), 0n);
  const committed = BigInt(pool.committed);
  const spent = amount - outputs;
  const returned = outputs - committed;
  if (spent < 0n || returned < 0n || returned + spent + committed !== amount) {
    // 账本金额与内核承诺对不上：不冒充事实，留问题池追溯。
    await msfileBitfsKernelFeed(runtime, { eventId: `close-mismatch-${pool.id}`, payload: { type: "unknown", poolId: pool.id, commandId } });
    return;
  }
  await msfileBitfsKernelFeed(runtime, {
    eventId: `closed-${pool.id}`,
    payload: { type: "closed", poolId: pool.id, commandId, returned: returned.toString(10), spent: spent.toString(10) },
  });
  await msfileBitfsKernelFeed(runtime, { eventId: `refund-${pool.id}`, payload: { type: "refund-available", poolId: pool.id } });
  await runtime.adapter.settle(commandId);
  runtime.executor.forget(commandId);
  msfileBitfsKernelProgress.delete(sessionId);
  // 旧池已结清：现在可以安全地让卖家给下一批新报价。
  const pendingSeller = msfileBitfsKernelPendingRefreshes.get(sessionId);
  if (pendingSeller !== undefined) {
    msfileBitfsKernelPendingRefreshes.delete(sessionId);
    await msfileBitfsKernelRefreshQuote(runtime, pendingSeller, sessionId);
  }}

/** 重启恢复：按购买任务的调度器快照重建内核运行态、喂钱包/唤醒并重放未决命令。 */
async function recoverMsfileBitfsKernelRuntimes(ownerPublicKeyHex: string): Promise<void> {
  const owner = ownerPublicKeyHex.toLowerCase();
  const network = deps.network();
  const service = await deps.ensureService();
  const settings = service.getBitfsBuyerSettings ? await service.getBitfsBuyerSettings() : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  if (settings.schedulerMode !== "on") return;
  const listed = await deps.files("bitfs-journal").list({ prefix: "scheduler/tasks/", limit: 200 });
  for (const file of listed.files) {
    const match = /^scheduler\/tasks\/([0-9a-z][0-9a-z._-]{0,127})\.json$/u.exec(file.path);
    if (!match || msfileBitfsKernelRuntimes.size >= 64) continue;
    const taskId = match[1]!;
    const store = createSchedulerSnapshotStore({ store: deps.files("bitfs-journal"), ownerPublicKeyHex: owner, network, taskId });
    let stored;
    try { stored = await store.load(); } catch { continue; }
    if (!stored) continue;
    const seed = stored.snapshot.seedHashHex;
    if (msfileBitfsKernelRuntimeFor(owner, seed)) continue;
    const hostTask = (await (await purchaseTasksFor(owner, seed)).list()).find((item) => item.taskId === taskId && item.state === "active");
    if (!hostTask) continue;
    // 文件大小从已固定清单恢复；缺失时保持 0，仅影响后续 manifest 计算。
    let fileSizeBytes = "0";
    const sessions = createBitfsSessionJournal(deps.files("bitfs-journal"));
    for (const sessionId of hostTask.sessionIds) {
      const manifestRaw = await sessions.getEvidence(sessionId, "purchase-manifest");
      if (!manifestRaw) continue;
      try { fileSizeBytes = parseBitfsBuyerPurchaseManifest(manifestRaw, seed).fileSizeBytes; break; } catch { /* 清单损坏不阻止恢复 */ }
    }
    const adapter = await SchedulerAdapter.open({
      store, clock: msfileBitfsKernelClock, taskId, seedHash: seed,
      settings: {
        maxFullBlockPriceSatoshis: settings.maxFullBlockPriceSatoshis, poolBlocks: settings.poolBlocks,
        schedulerTotalSeats: settings.schedulerTotalSeats, schedulerFloatingSeats: settings.schedulerFloatingSeats,
        schedulerRequestTimeoutMs: 5_000,
      },
      manifestKnown: false,
      content: [{ id: seed, kind: "seed", bytes: MSFILE_BITFS_KERNEL_SEED_BYTES }],
    });
    let created!: MsfileBitfsKernelRuntime;
    const executor = new SchedulerCommandExecutor(msfileBitfsKernelPorts(() => created));
    created = {
      ownerPublicKeyHex: owner, seedHashHex: seed, hostTaskId: taskId,
      fileSizeBytes, mediaType: "application/octet-stream", adapter, executor,
    };
    msfileBitfsKernelRuntimes.set(msfileBitfsKernelRuntimeKey(owner, seed), created);
    try {
      await msfileBitfsKernelFeed(created, {
        eventId: `recover-wallet-${taskId}-${created.adapter.snapshot().wallet.revision + 1}`,
        payload: { type: "wallet", ...(await msfileBitfsKernelWallet(created)) },
      });
      await msfileBitfsKernelFeed(created, { eventId: `recover-tick-${taskId}-${created.adapter.snapshot().revision}`, payload: { type: "tick" } });
      for (const outbox of created.adapter.pendingCommands()) {
        if (outbox.command) await msfileBitfsKernelRunCommand(created, outbox.command);
      }
    } catch (error) {
      await writeBitfsDiagnostic("buyer-scheduler-recovery-error.json", {
        seedHashHex: seed, taskId, message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}

/** 内核模式自动开工：自动购买开启且已有合格报价时，首个合格报价立即 start（不再等待收敛窗口）。 */
async function maybeAutoStartMsfileBitfsKernelPurchase(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  task: BitfsBuyerTask;
}): Promise<void> {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const seed = input.seedHashHex.toLowerCase();
  const service = await deps.ensureService();
  const settings = service.getBitfsBuyerSettings ? await service.getBitfsBuyerSettings() : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  if (settings.schedulerMode !== "on" || !settings.buyerAutoPurchaseEnabled) return;
  if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex?.toLowerCase() !== owner) return;
  const entry = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, seed));
  if (!entry || entry.ownerSessionEpoch !== deps.session().sessionEpoch) return;
  if (await taskForSession(owner, seed)) return;
  const quotes = await input.task.listDiscoveredQuotes();
  const links = msfileBitfsKernelLinksFor(owner, seed);
  const limit = BigInt(settings.maxFullBlockPriceSatoshis);
  const selected = quotes.filter((item) => links.has(item.sessionId))
    .filter((item) => BigInt(item.fullBlockPriceSatoshis) <= limit)
    .sort((left, right) => Number(left.fullBlockPriceSatoshis) - Number(right.fullBlockPriceSatoshis)
      || left.sessionId.localeCompare(right.sessionId))[0];
  if (!selected) return;
  try {
    await startMsfileBitfsKernelPurchase({ seedHashHex: seed, sessionId: selected.sessionId });
  } catch (error) {
    console.warn("[msfile] BitFS kernel automatic purchase was not started", error instanceof Error ? error.message : String(error));
  }
}

/** 内核购买入口：建任务、建/恢复适配器、喂事实并执行首批命令。 */
async function startMsfileBitfsKernelPurchase(input: {
  seedHashHex: string;
  sessionId: string;
  maxFullBlockPriceSatoshis?: string;
}): Promise<import("@keymaster/contracts").MsFileBitfsDemandSnapshot> {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (!owner || deps.session().vaultStatus !== "unlocked") throw new Error("请先解锁当前 Key 再购买 BitFS 文件");
  if (!isValidMsFileHashHex(input.seedHashHex)) throw new TypeError("BitFS Seed Hash 必须是 64 位小写十六进制字符");
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(input.sessionId)) throw new TypeError("BitFS 报价会话编号无效");
  const seed = input.seedHashHex.toLowerCase();
  const { task, entry } = await ensureMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: seed });
  const quotes = await task.listDiscoveredQuotes();
  const selectedQuote = quotes.find((item) => item.sessionId === input.sessionId);
  if (!selectedQuote) throw new Error("所选报价不属于当前 Seed 的已验签报价列表");
  const canonicalQuote = quotes.slice().sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
  if (!canonicalQuote || quotes.some((item) => item.fileSizeBytes !== canonicalQuote.fileSizeBytes)) {
    throw new Error("同 Seed 报价的签名文件大小不一致，不能安全建立共享下载计划");
  }
  const mediaType = selectBitfsMediaType(quotes);
  const service = await deps.ensureService();
  const settings = service.getBitfsBuyerSettings ? await service.getBitfsBuyerSettings() : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
  if (settings.schedulerMode !== "on") throw new Error("下载调度器未开启");
  const lifecycle = await purchaseTasksFor(owner, seed);
  const activeTask = (await lifecycle.list()).find((item) => item.state === "active");
  if (activeTask && activeTask.demandId !== entry.requestMessageId) throw new Error("同 Hash 已有进行中任务，请前往购买详情管理该任务");
  // 任务级并发上限仍由宿主把关；内核不感知。
  const allSessions = await createBitfsSessionJournal(deps.files("bitfs-journal")).list();
  const otherSeeds = new Set(allSessions.filter(r => r.role === "buyer" && r.ownerPublicKeyHex === owner && r.seedHashHex !== seed).map(r => r.seedHashHex));
  let activeCount = 0;
  for (const other of otherSeeds) if ((await (await purchaseTasksFor(owner, other)).list()).some(t => t.state === "active")) activeCount++;
  if (activeCount >= settings.maxConcurrentDownloads) throw new Error(`当前有 ${activeCount} 个进行中文件任务；并发上限为 ${settings.maxConcurrentDownloads}`);
  const newTask = activeTask ?? await lifecycle.begin(input.sessionId, entry.requestMessageId!, Date.now());
  await lifecycle.attach(newTask.taskId, input.sessionId);
  (entry.currentDemandPurchases ??= new Set()).add(input.sessionId);
  const plan = createBitfsBuyerDownloadPlan({ ownerPublicKeyHex: owner, seedHashHex: seed,
    fileSizeBytes: canonicalQuote.fileSizeBytes, recommendedFilename: canonicalQuote.recommendedFilename,
    taskId: newTask.legacyPlan ? undefined : newTask.taskId, store: deps.files("bitfs-journal") });
  if ((await plan.snapshot()).stopRequested) throw new Error("当前任务已停止下载，请前往购买详情管理该任务");
  const runtimeKey = msfileBitfsKernelRuntimeKey(owner, seed);
  let runtime = msfileBitfsKernelRuntimes.get(runtimeKey);
  if (!runtime || runtime.hostTaskId !== newTask.taskId) {
    const store = createSchedulerSnapshotStore({ store: deps.files("bitfs-journal"), ownerPublicKeyHex: owner, network: deps.network(), taskId: newTask.taskId });
    const adapter = await SchedulerAdapter.open({
      store, clock: msfileBitfsKernelClock, taskId: newTask.taskId, seedHash: seed,
      settings: {
        maxFullBlockPriceSatoshis: settings.maxFullBlockPriceSatoshis, poolBlocks: settings.poolBlocks,
        schedulerTotalSeats: settings.schedulerTotalSeats, schedulerFloatingSeats: settings.schedulerFloatingSeats,
        schedulerRequestTimeoutMs: 5_000,
      },
      manifestKnown: false,
      content: [{ id: seed, kind: "seed", bytes: MSFILE_BITFS_KERNEL_SEED_BYTES }],
    });
    let created!: MsfileBitfsKernelRuntime;
    const executor = new SchedulerCommandExecutor(msfileBitfsKernelPorts(() => created));
    created = {
      ownerPublicKeyHex: owner, seedHashHex: seed, hostTaskId: newTask.taskId,
      fileSizeBytes: canonicalQuote.fileSizeBytes, mediaType, entry, adapter, executor,
    };
    runtime = created;
    msfileBitfsKernelRuntimes.set(runtimeKey, runtime);
  }
  runtime.entry = entry;
  runtime.mediaType = mediaType;
  await msfileBitfsKernelFeed(runtime, { eventId: `wallet-${newTask.taskId}-${runtime.adapter.snapshot().wallet.revision + 1}`, payload: { type: "wallet", ...(await msfileBitfsKernelWallet(runtime)) } });
  for (const quoteView of quotes) {
    await msfileBitfsKernelFeedQuote(runtime, quoteView);
  }
  if (input.maxFullBlockPriceSatoshis !== undefined) {
    await msfileBitfsKernelFeed(runtime, { eventId: `slider-${input.maxFullBlockPriceSatoshis}`, payload: { type: "slider", slider: "price", value: input.maxFullBlockPriceSatoshis } });
  }
  await msfileBitfsKernelFeed(runtime, { eventId: `start-${newTask.taskId}`, payload: { type: "start" } });
  return await msfileBitfsBuyerDemandSnapshot(seed, entry, task);
}

/** 同一 Seed 的手动/自动购买共用准入锁；双击或同时到达报价只会进入一次开池。 */
async function startMsfileBitfsBuyerPurchase(input: {
  seedHashHex: string;
  sessionId: string;
  maxFullBlockPriceSatoshis?: string;
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
    const service = await deps.ensureService();
    const settings = service.getBitfsBuyerSettings ? await service.getBitfsBuyerSettings() : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
    if (settings.schedulerMode !== "on") throw new Error("下载调度器已关闭；请在 MSFile 设置中开启后再购买");
    const result = await startMsfileBitfsKernelPurchase(input);
    await writeBitfsDiagnostic("buyer-purchase-return.json", {
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
    const attempt = sessions.find(record => record.sessionId === input.sessionId && record.role === "buyer" && record.ownerPublicKeyHex === owner);
    if (attempt?.phase === "quote-selected" && attempt.evidence.includes("purchase-manifest") && !attempt.pendingTxid
      && !attempt.evidence.some(name => name === "funding-transaction" || name === "kind2-opening-request" || name === "kind3-opening-response")) {
      // 仅预检失败、尚未准备开池的尝试可直接结束；有资金证据的阶段继续按原状态对账。
      await createBitfsSessionJournal(deps.files("bitfs-journal")).update(attempt.sessionId, attempt.revision,
        { phase: "failed", failureCode: "purchase-preflight-failed", failureMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }, Date.now());
    }
    if (owner) {
      if (attempt?.evidence.includes("purchase-manifest")) await (await purchaseTasksFor(owner, input.seedHashHex)).recordFailedAttempt(input.sessionId,
        msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(owner, input.seedHashHex))?.requestMessageId ?? "failed-preflight", Date.now());
      await finishPurchaseTask(owner, input.seedHashHex, input.sessionId);
    }
    await writeBitfsDiagnostic("buyer-purchase-error.json", {
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
  const lockKey = msfileBitfsBuyerTaskKey(owner, seed);
  const previous = msfileBitfsBuyerPurchaseTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  msfileBitfsBuyerPurchaseTails.set(lockKey, gate);
  await previous;
  try {
    assertActive();
    const journal = deps.files("bitfs-journal");
    const tasks = await purchaseTasksFor(owner, seed);
    const rows = await tasks.list();
    const target = sessionId ? rows.find(t => t.sessionIds.includes(sessionId)) : undefined;
    const selectedIds = sessionId ? new Set(target?.sessionIds ?? [sessionId]) : undefined;
    for (const task of rows) {
      if (selectedIds && !task.sessionIds.some(id => selectedIds.has(id))) continue;
      const path = task.legacyPlan ? `download-plans/${seed}.json` : `download-plans/${seed}/${task.taskId}.json`;
      if (await journal.get(path)) await (await openMsfileBitfsBuyerDownloadPlan(owner, seed, task.sessionIds[0])).requestStop();
      if (task.state === "active") await tasks.end(task.taskId, "cancelled", Date.now());
    }
    // 断开所删采购的内容通道；不会发送取消关池、付款或退款请求。
    for (const [id, link] of msfileBitfsWebRtcBuyerLinks) {
      if (link.ownerPublicKeyHex.toLowerCase() !== owner || link.seedHashHex !== seed
        || (selectedIds && !selectedIds.has(link.quoteSessionId ?? link.resumedPurchaseSessionId ?? ""))) continue;
      msfileBitfsWebRtcBuyerLinks.delete(id);
      await deps.executor({ type: "lane", laneId: "msfile", operation: { type: "bitfs-seller-close", sessionId: link.transportSessionId, reason: "buyer_deleted_history" } }).catch(() => undefined);
    }
    const entry = msfileBitfsBuyerTasks.get(lockKey);
    // 清空已删任务的需求状态，杜绝调度回调把历史再次拉回普通采购。
    if (entry && (!selectedIds || (entry.purchase && selectedIds.has(entry.purchase.sessionId)))) {
      await (await entry.taskPromise).cancelDemand();
      msfileBitfsBuyerTasks.delete(lockKey);
    }
    await deleteBitfsPurchaseData({ journal, content: deps.files(""), ledger: currentMsfileBitfsFundingLedger(), owner, seed, sessionId,
      deleteContent: sessionId === undefined, assertActive });
    if (!sessionId && msfileSellerIndex) msfileSellerIndex.invalidate(seed);
  } finally { release(); if (msfileBitfsBuyerPurchaseTails.get(lockKey) === gate) msfileBitfsBuyerPurchaseTails.delete(lockKey); }
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
  if (selected.replacedBySessionId || !selected.evidence.includes("download-plan")) {
    return cancelOneMsfileBitfsBuyerPurchase({ ...input, ownerPublicKeyHex: owner, task, entry });
  }

  const plan = await openMsfileBitfsBuyerDownloadPlan(owner, input.seedHashHex, input.sessionId);
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
      const detail = failures.length ? ` 未完成原因：${failures.join("；")}` : "";
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
        // 内核路径：记录授权帧实际写出完成时刻（最内侧，白名单失败不影响发送）。
        if (link.quoteSessionId) {
          try { if (parse(frame).kind === 5) msfileBitfsKernelLastSentAt.set(link.quoteSessionId, Date.now()); }
          catch { /* 非规范帧由协议按错误处理 */ }
        }
      } catch (error) {
        await writeBitfsDiagnostic("buyer-stream-send-error.json", {
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
  void writeBitfsDiagnostic("buyer-webrtc-failure.json", {
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
    taskEntry.resumeSessionId = undefined;
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
const filterP2pkhSnapshotByBitfsFunds = msfileFundingRuntime.filterSnapshot;
const reconcileMsfileBitfsFundingInputs = msfileFundingRuntime.reconcileInputs;
const createMsfileBitfsProtocolSpend = msfileFundingRuntime.protocolSpend;
const releaseMsfileBitfsPreparedSubmission = msfileFundingRuntime.releasePreparedSubmission;
const waitForMsfileFundingSnapshot = msfileFundingRuntime.waitForSnapshot;
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

  const protocolSpend = createMsfileBitfsProtocolSpend(transactions);
  let fundingSnapshotResource: P2pkhUtxoSnapshotResource | undefined;
  const fundingDeps: BitfsFundingPrepareDeps = {
    protocolSpend,
    getAvailableSnapshot: () => waitForMsfileFundingSnapshot({ ownerPublicKeyHex: owner, seedHashHex: seed, network: input.network, ledger }),
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
  const signer = createBitfsBuyerPaymentSigner(createBitfsVaultSigner(cryptoPort),{
    network:input.network,assertActive:assertCurrentContext,requestPayment:deps.requestPayment,
    async previousTransaction(txid){
      const saved=await transactions.getTransaction(txid);if(saved)return saved;
      if(!woc?.getRawTransaction)throw new Error('BitFS previous transaction evidence unavailable');
      return deps.hexToBytes(await woc.getRawTransaction(input.network,txid));
    },
  });

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
      const settings = await deps.p2pkhSettings();
      if (input.network === "test" && !settings.bsvNetwork) {
        throw new Error("请先在 P2PKH 设置中启用测试网余额");
      }
      const resources = await deps.ensureResources(owner, settings.bsvNetwork);
      fundingSnapshotResource = resources.find((resource) => resource.network === input.network);
      if (!fundingSnapshotResource || !snapshots) throw new Error("BitFS FundingTx 的 P2PKH 余额快照尚未就绪");
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
            feeRateSatoshisPerKb: settings.feeRateSatoshisPerKb,
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
    const signer=createBitfsPaymentSigner(createBitfsVaultSigner(cryptoPort),{
      network:sellerNetwork,role:"seller",assertActive:assertSellerContext,requestPayment:deps.requestPayment,
      async previousTransaction(txid){
        assertSellerContext();const retained=await transactionJournal.getTransaction(txid);if(retained)return retained;
        for(const record of await sessions.list()){
          if(record.role!=="seller"||record.ownerPublicKeyHex!==ownerPublicKeyHex)continue;
          const raw=await sessions.getEvidence(record.sessionId,"funding-transaction");assertSellerContext();
          if(raw&&deps.bytesToHex(new Uint8Array(transactionID(raw)).reverse())===txid)return raw;
        }
        if(!woc?.getRawTransaction)throw new Error("BitFS seller funding evidence unavailable");
        const raw=deps.hexToBytes(await woc.getRawTransaction(sellerNetwork,txid));assertSellerContext();return raw;
      },
    });
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
  if (!deps.diagnosticsEnabled()) return;
  try {
    const store = deps.files( "");
    await store.put(`bitfs-diagnostics/${path}`, new TextEncoder().encode(JSON.stringify(value)));
  } catch (error) {
    console.warn("[msfile] BitFS diagnostic write failed", error instanceof Error ? error.message : String(error));
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
  await writeBitfsDiagnostic("buyer-webrtc-offer.json", {
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
    await writeBitfsDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: true });
  } catch (error) {
    await writeBitfsDiagnostic("buyer-webrtc-answer.json", { requestMessageId: input.requestMessageId, webrtcSessionId: input.webrtcSessionId, answered: false, error: error instanceof Error ? error.message : String(error) });
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
      /** 帧完整到达时刻（本地毫秒）。 */
      receivedAt?: unknown;
      /** 流计量：累计到达字节。 */
      bytesIn?: unknown;
      /** 流计量：累计写出字节。 */
      bytesOut?: unknown;
      /** 流计量：最近活动时刻。 */
      lastActivityAt?: unknown;
   };
  const manager = msfileSellerSessionManager;
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) return;
  // 旧 lease/旧 owner 的迟到事件不得进入新会话。
  if (event.ownerSessionEpoch !== lease.sessionEpoch) return;
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
      if (sellerLink) demandMonitor.updateQuote(demandMonitorScope(), sellerLink.requestMessageId, sellerLink.peerPublicKeyHex, "failed", error instanceof Error ? error.message : String(error));
      if (sellerLink) msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId as string);
      else msfileBitfsWebRtcBuyerLinks.delete(event.webrtcSessionId as string);
      await deps.executor({
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
    const link = typeof event.webrtcSessionId === "string" ? msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId) : undefined;
    if (link && link.sessionId === event.sessionId && link.ownerSessionEpoch === deps.session().sessionEpoch)
      demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "quoted");
    return;
  }
  if (event.type === "bitfs-webrtc-runtime-error") {
    const link = typeof event.webrtcSessionId === "string" ? msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId) : undefined;
    if (link) demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "failed", typeof event.message === "string" ? event.message : "WebRTC 报价连接失败");
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
    if (typeof event.webrtcSessionId === "string") {
      const link = msfileBitfsWebRtcSellerLinks.get(event.webrtcSessionId);
      if (link) demandMonitor.updateQuote(demandMonitorScope(), link.requestMessageId, link.peerPublicKeyHex, "failed",
        typeof event.errorMessage === "string" ? event.errorMessage : typeof event.reason === "string" ? event.reason : "报价连接已关闭");
      msfileBitfsWebRtcSellerLinks.delete(event.webrtcSessionId);
    }
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
         await writeBitfsDiagnostic("seller-protocol-frame-error.json", {
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
        if (buyerLink.quoteSessionId) {
          msfileBitfsKernelLastReceivedAt.set(buyerLink.quoteSessionId, typeof event.receivedAt === "number" ? event.receivedAt : Date.now());
        }
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
         await writeBitfsDiagnostic("buyer-protocol-frame-error.json", {
           webrtcSessionId: event.webrtcSessionId,
           sessionId: event.sessionId,
           message,
           stack: error instanceof Error ? error.stack : undefined
         });
         await writeBitfsDiagnostic(`buyer-protocol-${Date.now()}-error.json`, {
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
        const resume = msfileBitfsBuyerTasks.get(msfileBitfsBuyerTaskKey(buyerLink.ownerPublicKeyHex, buyerLink.seedHashHex))?.resumeSessionId;
        if (resume === saved.sessionId && savedQuote) matches.push(saved.sessionId);
      }
      if (matches.length === 1) {
        const resumedSessionId = matches[0]!;
        buyerLink.quoteSessionId = resumedSessionId;
        buyerLink.resumedPurchaseSessionId = resumedSessionId;
        await buyerLink.task.acceptQuote({
          sessionId: resumedSessionId,
          counterpartyPublicKeyHex: buyerLink.peerPublicKeyHex,
          rawKind1: (await sessions.getEvidence(resumedSessionId, "kind1-quote"))!,
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
       void writeBitfsDiagnostic("buyer-webrtc-quote-error.json", {
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
        await ensureMsfileBitfsBuyerProtocol(event.webrtcSessionId as string, buyerLink);
        const sessions = createBitfsSessionJournal(deps.files("bitfs-journal"));
        const originalOpening = await sessions.getEvidence(buyerLink.resumedPurchaseSessionId, "kind2-opening-request");
        if (!originalOpening) throw new Error("旧池恢复缺少原始开池证据");
        // 先用 exact Kind 2 绑定旧资金会话；Kind 3 重放随后驱动已有恢复状态机。
        await createMsfileBitfsBuyerStream(event.webrtcSessionId as string, buyerLink).send(originalOpening);
        return;
      }
      const service = await deps.ensureService();
      const settings = service.getBitfsBuyerSettings ? await service.getBitfsBuyerSettings() : { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
      if (settings.schedulerMode === "on") {
        // 新报价先进已有内核运行态，再按自动购买规则决定是否开工。
        const kernelRuntime = msfileBitfsKernelRuntimeFor(buyerLink.ownerPublicKeyHex, buyerLink.seedHashHex);
        if (kernelRuntime && buyerLink.quoteSessionId) {
          const quoteView = (await buyerLink.task.listDiscoveredQuotes()).find((item) => item.sessionId === buyerLink.quoteSessionId);
          if (quoteView) {
            await msfileBitfsKernelFeedQuote(kernelRuntime, quoteView);
          }
        }
        await maybeAutoStartMsfileBitfsKernelPurchase({
          ownerPublicKeyHex: buyerLink.ownerPublicKeyHex,
          seedHashHex: buyerLink.seedHashHex,
          task: buyerLink.task,
        });
        return;
      }
      // 关闭下载调度器时不再自动购买；用户可在设置中开启后手动购买。
     }).catch(async (error) => {
       const message = error instanceof Error ? error.message : String(error);
       console.warn("[msfile] BitFS automatic purchase check failed", message);
        await writeBitfsDiagnostic("buyer-protocol-auto-error.json", {
          webrtcSessionId: event.webrtcSessionId,
          sessionId: event.sessionId,
          message,
          stack: error instanceof Error ? error.stack : undefined
        });
       msfileBitfsBuyerWebRtcFailure(buyerLink, event.webrtcSessionId as string, event.sessionId as string, "buyer_protocol_error");
     });
    return;
  }
  if (event.type === "bitfs-webrtc-meter") {
    if (typeof event.webrtcSessionId === "string" && typeof event.bytesIn === "number") {
      void msfileBitfsKernelFeedStreamProgress(event.webrtcSessionId, event.bytesIn).catch(() => undefined);
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
  "settings.mediaBlockReadConcurrency.update",
  "bitfs.demand.publish",
  "bitfs.demand.cancel",
  "bitfs.purchase.start",
  "bitfs.purchase.cancel",
  "bitfs.purchase.reconnect",
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
    case "bitfs.purchase.reconnect":
    case "bitfs.demand.publish": {
      if (!isValidMsFileHashHex(control.seedHashHex)) {
        return { requestId: request.requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "BitFS Seed Hash 必须是 64 位小写十六进制字符" } };
      }
      const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
      if (!owner) throw new Error("请先解锁当前 Key 再发布 BitFS 需求");
      const { task, entry } = await ensureMsfileBitfsBuyerTask({
        ownerPublicKeyHex: owner,
        seedHashHex: control.seedHashHex,
      });
      if (control.type === "bitfs.demand.publish" && await taskForSession(owner, control.seedHashHex)) {
        const snapshot = await msfileBitfsBuyerDemandSnapshot(control.seedHashHex, entry, task);
        value = { ...snapshot, requestMessageId: null, expiresAtMs: null, quotes: [], purchase: null };
        break;
      }
      const sessionJournal = createBitfsSessionJournal(deps.files("bitfs-journal"));
      entry.resumeSessionId = undefined;
      entry.currentDemandPurchases = new Set();
      entry.purchase = undefined;
      if (control.type === "bitfs.purchase.reconnect") {
        const saved = await sessionJournal.get(control.sessionId);
        if (!saved || saved.role !== "buyer" || saved.ownerPublicKeyHex !== owner || saved.seedHashHex !== control.seedHashHex
          || ["completed", "cancelled", "refunded", "arbitration-retrieval"].includes(saved.phase)) throw new Error("该购买不属于当前 Key 或已结束");
        entry.resumeSessionId = saved.sessionId;
        entry.purchase = await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex, sessionId: saved.sessionId, task });
      }
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
      if (control.type === "bitfs.demand.publish" || entry.purchase?.phase === "connection-closed" || (resumeTarget && !resumeLinkAlive)) {
        // 显式新查询必须发布新需求。需求 TTL 可能长于报价寿命，复用缓存编号
        // 会让同 Seed 的过期报价/失败尝试阻止新请求到达卖方。轮询只读 snapshot。
        const oldRequestIds = new Set<string>();
        if (entry.requestMessageId) oldRequestIds.add(entry.requestMessageId);
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
          if (control.type === "bitfs.demand.publish" && buyerLink.quoteSessionId) {
            const saved = await sessionJournal.get(buyerLink.quoteSessionId);
            // 新查询只撤销闲置报价连接。开池中、有已签证据或结果未知的买卖
            // 通道继续交付/对账，资金恢复仍由购买详情的显式操作负责。
            if (saved && (saved.pendingTxid !== undefined
              || saved.evidence.some(name => name === "kind2-opening-request" || name === "kind3-opening-response" || name === "funding-transaction")
              || !["quote-selected", "failed", "cancelled", "completed", "refunded"].includes(saved.phase))) continue;
          }
          msfileBitfsWebRtcBuyerLinks.delete(webrtcSessionId);
          await deps.executor({
            type: "lane",
            laneId: "msfile",
            operation: { type: "bitfs-seller-close", sessionId: buyerLink.transportSessionId, reason: control.type === "bitfs.demand.publish" ? "demand_replaced" : "buyer_reconnect" },
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
      const startOwner = deps.session().activePublicKeyHex?.trim().toLowerCase();
      const startService = await deps.ensureService();
      const startSettings = startOwner && startService.getBitfsBuyerSettings
        ? await startService.getBitfsBuyerSettings()
        : undefined;
      value = startSettings?.schedulerMode === "on"
        ? await startMsfileBitfsKernelPurchase({
            seedHashHex: control.seedHashHex,
            sessionId: control.sessionId,
            ...(control.maxFullBlockPriceSatoshis === undefined ? {} : { maxFullBlockPriceSatoshis: control.maxFullBlockPriceSatoshis }),
          })
        : await startMsfileBitfsBuyerPurchase({
            seedHashHex: control.seedHashHex,
            sessionId: control.sessionId,
            ...(control.maxFullBlockPriceSatoshis === undefined ? {} : { maxFullBlockPriceSatoshis: control.maxFullBlockPriceSatoshis }),
          });
      break;
    }
    case "bitfs.purchase.cancel": {
      const cancelOwner = deps.session().activePublicKeyHex?.trim().toLowerCase();
      const cancelRuntime = cancelOwner ? msfileBitfsKernelRuntimeFor(cancelOwner, control.seedHashHex) : undefined;
      if (cancelRuntime) {
        await msfileBitfsKernelFeed(cancelRuntime, {
          eventId: `cancel-${control.sessionId}-${cancelRuntime.adapter.snapshot().revision}`,
          payload: { type: "cancel" },
        });
        const cancelTask = cancelRuntime.entry?.taskPromise ? await cancelRuntime.entry.taskPromise : undefined;
        value = await msfileBitfsBuyerDemandSnapshot(control.seedHashHex, cancelRuntime.entry, cancelTask);
        break;
      }
      value = await cancelMsfileBitfsBuyerPurchase({ seedHashHex: control.seedHashHex, sessionId: control.sessionId });
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
      const { task } = await ensureMsfileBitfsBuyerTask({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex });
      await restoreMsfileBitfsBuyerPurchaseSummary({ ownerPublicKeyHex: owner, seedHashHex: control.seedHashHex, sessionId: control.sessionId, task });
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
      await deleteMsfilePurchaseData(control.seedHashHex, control.type === "bitfs.purchase.history.delete" ? control.sessionId : undefined);
      value = null;
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
    revoke: () => { demandMonitor.clear(); arbitrationScope?.controller.abort(); arbitrationScope = undefined; stopMsfileSellerRuntime(); clearBuyerState(); msfileFundingRuntime.clear(); },
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
