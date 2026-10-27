// Forum 领域服务。
//
// 这是插件对外的唯一入口，把协议、网络、MSFile、Vault 与 P2PKH 组装成论坛
// 浏览/阅读/发布流程，同时把边界规则挡在这一层：
//
//   - Forum 不复制正文，不保存 HTML 渲染结果作为内容真值；
//   - 冻结后的正文只存 hash；未冻结的草稿才留在 Forum；
//   - 签名只接受结构化字段，字节在本模块内重建；
//   - 广播走统一中心，未知只对账原交易，不自动重复付款；
//   - 锁定、切 Key、Scope 撤销时中止连接与新签名，迟到结果不写入新会话。

import type {
  ActiveKeyCrypto,
  BsvNetwork,
  ForumAttachmentContent,
  ForumBudgetConfirmation,
  ForumConfig,
  ForumBroadcastState,
  ForumChainObservation,
  ForumContentStatus,
  ForumEndpointConfig,
  ForumFeeBreakdownItem,
  ForumListPage,
  ForumListRequest,
  ForumNodeDetail,
  ForumPublicationReachability,
  ForumPublishPrepareInput,
  ForumPublishPhase,
  ForumPublishTask,
  ForumQuoteSnapshot,
  ForumReadingView,
  ForumRootVerification,
  ForumService,
  MsFileContentService,
  MsFileContentStatus,
  ProtocolSpendService,
  ProtocolSpendInput,
} from "@keymaster/contracts";
import {
  FORUM_MARKDOWN_MAX_BYTES,
  forumAmountToBigInt,
  normalizeForumAmount,
  normalizeForumPageSize,
} from "@keymaster/contracts";

import { multiaddr as parseMultiaddr } from "@multiformats/multiaddr";

import { bytesToHex, hexToBytes } from "../protocol/bytes.js";
import { rawTxHexByteLength } from "../protocol/rawLength.js";
import { sha256Digest } from "../protocol/crypto.js";
import {
  signChangeTipOperatorObject,
  signReplyOperatorObject,
  type SigningPort,
} from "../protocol/signatureObjects.js";
import { parseTransaction } from "../protocol/transaction.js";
import {
  decodeForumMarkdown,
  extractForumAttachments,
  normalizeForumMarkdownForPublish,
  projectForumMarkdown,
} from "../markdown/markdown.js";
import { createForumIndexClient, ForumBusinessError, ForumResultShapeError } from "./indexClient.js";
import { ForumListStore } from "./listStore.js";
import { ForumTrustError, rootEvidenceIsUsable, verifyForumRoot } from "./rootTrust.js";
import type { ForumSelfOutputService } from "./forumSelfOutputs.js";
import {
  createForumRepository,
  type ForumDispatchLeaseHandle,
  type ForumIndexCacheEntry,
  type ForumRepository,
} from "../storage/forumRepository.js";
import {
  buildFeeBreakdown,
  buildForumProtocolOutputs,
  estimateMinerFeeBudget,
  ForumProtocolError,
  reconcileMinerFee,
  totalFeeSatoshis,
  verifyChangeTipQuote,
  verifyFinalRaw,
  verifyReplyQuote,
  type ForumQuoteFields,
} from "../publish/forumProtocol.js";
import { FORUM_FEE_RATE_SATOSHIS_PER_KB } from "./forumFundingSource.js";
import {
  createForumRoundtripClient,
  createHttpsTransport,
  createLibp2pTransport,
  createVaultRoundtripSigner,
  ForumIdentityError,
  type ForumRoundtripClient,
  type ForumTransport,
} from "../network/roundtripClient.js";
import { hexToBytes as protocolHexToBytes } from "../protocol/bytes.js";

export const FORUM_CONTENT_PURPOSE = "";
export const FORUM_MAX_MARKDOWN_BYTES = FORUM_MARKDOWN_MAX_BYTES;

export interface ForumServiceDeps {
  repository: ForumRepository;
  /** Provider scope cancellation, independent of the caller Window. */
  signal?: AbortSignal;
  /** Instance-owned funding source; Worker never uses the legacy Window singleton. */
  fundingSource?(): ForumFundingSource | undefined;
  content: MsFileContentService;
  /** 当前 owner 的受控签名能力；私钥不进入本模块。 */
  activeCrypto(): Promise<ActiveKeyCrypto>;
  /** 当前 owner 公钥（小写 hex）；锁定或切 Key 后必须变化。 */
  ownerPublicKeyHex(): string;
  /** P2PKH 受控协议 spend；资金准备、无找零构建与广播都经过它。 */
  protocolSpend(): ProtocolSpendService | undefined;
  /** Window P2P lane 分发；libp2p 入口用它执行请求。 */
  dispatchP2p?(operation: unknown, signal: AbortSignal): Promise<unknown>;
  /**
   * 查询**这一个**持久提交当前的广播状态。
   *
   * 恢复路径的唯一依据：绝不重建、绝不二次派发。缺席时对账只更新链上与索引证据。
   */
  observeBroadcast?(input: {
    readonly ownerPublicKeyHex: string;
    readonly network: BsvNetwork;
    readonly txid: string;
    readonly submissionId: string;
  }): Promise<ForumBroadcastState>;
  /** 按 txid 查链上传播状态。 */
  observeChain?(network: BsvNetwork, txid: string, signal?: AbortSignal): Promise<ForumChainObservation["state"]>;
  /**
   * 按 (network, txid) 取创世根 raw。
   *
   * 论坛服务端只提供 `/roundtrip` 与 `/readyz`，没有创世 raw 下载接口，因此 raw
   * 必须来自链数据源而不是向论坛站点 GET。返回的字节随后会被独立验证：地址与
   * 来源都不替代身份，配置的论坛公钥才是信任锚。
   */
  fetchRootRaw(input: { readonly network: BsvNetwork; readonly txid: string }, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** 自有输出服务（FT05：识别 / 保护 / 归集）。缺席时这三项明确不可用。 */
  selfOutputs?(): ForumSelfOutputService | undefined;
  /** 当前会话世代；锁定/切 Key/Scope 撤销后变化，迟到结果据此丢弃。 */
  sessionEpoch(): string;
  now?(): number;
  randomId?(): string;
}

/** 连接对象；每条 (configId, endpoint) 一条，用完释放。 */
interface Connection {
  readonly client: ForumRoundtripClient;
  readonly transport: ForumTransport;
  readonly epoch: string;
  readonly ownerPublicKeyHex: string;
}

/**
 * 发布阶段的合法前驱。
 *
 * 阶段只能沿这张图前进：两个页面同时点「发布」时，第二个页面会因为阶段已经推进
 * 而落到 `reconciling`，而不是各自构造一笔交易。
 */
const PHASE_TRANSITIONS: Readonly<Record<ForumPublishPhase, readonly ForumPublishPhase[]>> = Object.freeze({
  draft: ["content-frozen", "signed"],
  "content-frozen": ["signed"],
  signed: ["quoted"],
  quoted: ["budget-confirmed"],
  "budget-confirmed": ["funding-prepared", "reconciling"],
  // 资金准备与报价复核之间允许回到费用确认：报价变了就重新确认，而不是照旧发。
  "funding-prepared": ["quote-rechecked", "raw-prepared", "budget-confirmed"],
  "quote-rechecked": ["raw-prepared", "budget-confirmed"],
  // raw-prepared 之后可以先记 broadcast-dispatched，也可以直接进入对账或等待索引：
  // 派发与首次观测在同一次调用里完成，中间态不一定被单独持久化。
  "raw-prepared": ["broadcast-dispatched", "reconciling", "awaiting-index", "failed"],
  "broadcast-dispatched": ["reconciling", "awaiting-index"],
  reconciling: ["awaiting-index", "indexed-mempool", "indexed-confirmed", "reconciling", "failed"],
  "awaiting-index": ["indexed-mempool", "indexed-confirmed", "reconciling"],
  "indexed-mempool": ["indexed-confirmed", "reconciling"],
  "indexed-confirmed": [],
  failed: ["draft", "reconciling"],
});

export class ForumPublishTransitionError extends Error {
  readonly code = "phase-conflict";

  constructor(readonly from: ForumPublishPhase, readonly to: ForumPublishPhase) {
    super(`发布任务阶段不能从 ${from} 前进到 ${to}`);
    this.name = "ForumPublishTransitionError";
  }
}

export function canAdvancePublishPhase(from: ForumPublishPhase, to: ForumPublishPhase): boolean {
  if (from === to) return true;
  return (PHASE_TRANSITIONS[from] ?? []).includes(to);
}

/** 阶段推进守卫：不合法的推进直接失败，而不是让两个页面各写各的。 */
function assertPhaseAdvance(from: ForumPublishPhase, to: ForumPublishPhase): void {
  if (!canAdvancePublishPhase(from, to)) throw new ForumPublishTransitionError(from, to);
}

/** 已经构造过协议交易的阶段：资金可能被在途交易花费，一律不可回收。 */
const POST_PROTOCOL_TX_PHASES: readonly ForumPublishPhase[] = Object.freeze([
  "raw-prepared", "broadcast-dispatched", "reconciling", "awaiting-index", "indexed-mempool", "indexed-confirmed",
]);

/** 派发前的三个阶段，按发生顺序排列。 */
type DispatchPreparedPhase = "funding-prepared" | "quote-rechecked" | "raw-prepared";

/**
 * 租约不可用时各路径自己的处理结果。
 *
 * `unavailable` 表示别的标签页正在处理这笔任务：**没有做任何写入**。
 * 该做什么由调用方决定——发布可以对账，取消必须拒绝，回收必须拒绝。
 */
export type DispatchLeaseOutcome<T> =
  | { readonly kind: "ran"; readonly value: T }
  | { readonly kind: "unavailable"; readonly leaseHolderId?: string };

/**
 * 派发期间可用的持有权上下文。
 *
 * 它只暴露三件事：核对持有权、带令牌写任务、以及租约本身。执行流程不能绕过它们
 * 直接调 `writeTask`，否则栅栏令牌就形同虚设。
 */
interface DispatchLeaseContext {
  readonly lease: ForumDispatchLeaseHandle;
  /** 不可逆动作前调用；租约被接管或过期时抛错。 */
  assertHeld(): Promise<void>;
  /** 带栅栏令牌写任务。 */
  writeTask(task: ForumPublishTask): Promise<void>;
}

/**
 * 派发租约的有效期。
 *
 * 取得租约到构造、验签、派发与首次对账通常在几秒内，因此给一分钟余量；上限的
 * 作用是「上一个标签页崩了以后任务仍可被接管」，不是限制正常流程的时长。
 */
const FORUM_DISPATCH_LEASE_TTL_MS = 60_000;

const DISPATCH_PREPARED_PHASES: readonly DispatchPreparedPhase[] = Object.freeze([
  "funding-prepared",
  "quote-rechecked",
  "raw-prepared",
]);

/** 阶段在派发前序列中的位置；不在序列里返回 -1。 */
function dispatchPreparedIndex(phase: ForumPublishPhase): number {
  return DISPATCH_PREPARED_PHASES.indexOf(phase as DispatchPreparedPhase);
}

/** 固定 1 sat 数据输出的金额；位置固定，所以金额恒定。 */
const FORUM_DATA_OUTPUT_SATOSHIS = 1n;

/**
 * 按报价算出固定输出的**金额序列**。
 *
 * 只在这里算一次金额，`confirmBudget`、`buildAndSubmit` 的资金额度与最终 raw 复核
 * 都取自同一个函数，避免「确认的额度」和「实际构造的布局」各算各的。
 * 索引费为零仍保留 vout 0：位置是协议的一部分，不因金额为零而消失。
 */
export function fixedOutputValues(kind: "reply" | "changetip", quote: ForumQuoteSnapshot): readonly bigint[] {
  const indexPrice = forumAmountToBigInt(quote.indexPrice) ?? 0n;
  const values: bigint[] = [indexPrice, FORUM_DATA_OUTPUT_SATOSHIS];
  if (kind === "reply") {
    // 父价为零时省略 vout 2：不生成零值打赏输出。
    const parentTipPrice = forumAmountToBigInt(quote.parentTipPrice ?? "0") ?? 0n;
    if (parentTipPrice > 0n) values.push(parentTipPrice);
  }
  return values;
}

/**
 * 复核后的报价是否改变了已确认的费用。
 *
 * 只比较进入交易输出的两项：索引费与父作者金额。`last_block_height` 与 `indexSig`
 * 一定随每次报价变化，它们是承诺本身而不是费用，不构成「费用变化」。
 */
export function quoteDiffersFromBudget(
  budget: ForumBudgetConfirmation | undefined,
  quote: ForumQuoteSnapshot,
  kind: "reply" | "changetip",
): boolean {
  if (budget === undefined) return true;
  const confirmedIndex = findingOf(budget, "index-price");
  const confirmedTip = findingOf(budget, "parent-author-tip") ?? "0";
  const expectedTip = kind === "reply" ? quote.parentTipPrice ?? "0" : "0";
  return confirmedIndex !== quote.indexPrice || confirmedTip !== expectedTip;
}

export function createForumService(deps: ForumServiceDeps): ForumService {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? defaultRandomId;
  const connections = new Map<string, Connection>();
  /**
   * 每个发布任务一把互斥锁。
   *
   * 这是「多页不重复发布」的落点：所有会推进任务阶段的入口都在同一把锁里重新读取
   * 任务，因此第二个页面看到的一定是第一个页面已经写入的阶段与 submissionId，
   * 从而落到对账而不是重新构造。同一 owner-session Worker 的所有窗口共享此锁；
   * 持久租约和 submission 证据继续负责中断恢复。
   */
  deps.signal?.addEventListener("abort", () => {
    for (const connection of connections.values()) { connection.client.dispose(); void connection.transport.dispose().catch(() => undefined); }
    connections.clear();
  }, { once: true });
  const taskLocks = new Map<string, Promise<unknown>>();
  /**
   * 当前页面实例的稳定标识。
   *
   * 挂在 Window 全局上而不是 Map 上：同一页面重入必须拿到同一个 id（否则自己会
   * 把自己的租约当成别人的），而同一浏览器的不同标签页各有各的全局。
   */
  const holderId = (): string => {
    const scope = globalThis as { __forumDispatchHolderId?: string };
    if (typeof scope.__forumDispatchHolderId === "string" && scope.__forumDispatchHolderId.length > 0) {
      return scope.__forumDispatchHolderId;
    }
    scope.__forumDispatchHolderId = randomId();
    return scope.__forumDispatchHolderId;
  };
  const listStores = new Map<string, ForumListStore>();

  /** 会话 fence：锁定、切 Key 或 Scope 撤销后，迟到结果不得写入。 */
  const assertFresh = (epoch: string, ownerPublicKeyHex: string): void => {
    const current = deps.sessionEpoch();
    if (epoch !== current) {
      throw new ForumIdentityError("会话世代已变化，结果不得写入新会话");
    }
    if (ownerPublicKeyHex !== deps.ownerPublicKeyHex()) {
      throw new ForumIdentityError("当前 owner 已变化，结果不得写入新会话");
    }
  };

  const selfOutputContext = async () => {
    const epoch = deps.sessionEpoch(), owner = deps.ownerPublicKeyHex().toLowerCase();
    if (!epoch || !/^(02|03)[0-9a-f]{64}$/u.test(owner)) throw new ForumIdentityError("Wallet identity unavailable");
    const crypto = await deps.activeCrypto();
    assertFresh(epoch, owner);
    const identity = { ...crypto.getIdentity() };
    if (identity.publicKeyHex.toLowerCase() !== owner || (identity.bsvNetwork !== "main" && identity.bsvNetwork !== "test")) throw new ForumIdentityError("Wallet crypto identity mismatch");
    return { network: identity.bsvNetwork, assertActive() {
      assertFresh(epoch, owner);
      const current = crypto.getIdentity();
      if (current.publicKeyHex !== identity.publicKeyHex || current.bsvNetwork !== identity.bsvNetwork) throw new ForumIdentityError("Wallet crypto identity changed");
    } };
  };

  const signingPort = async (): Promise<{ port: SigningPort; ownerPublicKeyHex: string; epoch: string }> => {
    const epoch = deps.sessionEpoch();
    const ownerPublicKeyHex = deps.ownerPublicKeyHex().toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/u.test(ownerPublicKeyHex)) {
      throw new ForumIdentityError("当前 Key 未解锁，没有可用的发布身份");
    }
    const crypto = await deps.activeCrypto();
    const identity = crypto.getIdentity();
    // roundtrip 的 from、operatorSig 的签名身份与 vout 1 的 clientpublickey
    // 必须相同；三者之一漂移都会让服务端拒收。
    if (identity.publicKeyHex.toLowerCase() !== ownerPublicKeyHex) {
      throw new ForumIdentityError("签名能力与当前 owner 不是同一身份");
    }
    return {
      port: {
        signDigest: async (digest) => {
          const result = await crypto.signDigest({ digest: toArrayBuffer(digest), format: "der" });
          if (result.format !== "der") throw new ForumIdentityError("业务签名必须是严格 DER");
          return new Uint8Array(result.signature);
        },
        verifyDigest: async () => false,
      },
      ownerPublicKeyHex,
      epoch,
    };
  };

  const transportFor = async (config: ForumConfig, endpoint: ForumEndpointConfig, epoch: string, ownerPublicKeyHex: string): Promise<Connection> => {
    const key = connectionKey(config.id, endpoint);
    const existing = connections.get(key);
    // 锁定、切 Key 或 Scope 撤销后旧连接不再可用：身份变了就不能复用。
    if (existing !== undefined && existing.epoch === epoch && existing.ownerPublicKeyHex === ownerPublicKeyHex) {
      return existing;
    }
    if (existing !== undefined) {
      await existing.transport.dispose();
      connections.delete(key);
    }
    const { port } = await signingPort();
    const signer = createVaultRoundtripSigner(await deps.activeCrypto(), { publicKeyHex: ownerPublicKeyHex });
    const transport =
      endpoint.kind === "https"
        ? createHttpsTransport({ baseUrl: endpoint.url })
        : createLibp2pTransport({
            dispatch: (operation, signal) => {
              const dispatch = deps.dispatchP2p;
              if (dispatch === undefined) {
                throw new ForumIdentityError("libp2p 入口不可用：Window P2P lane 未注册");
              }
              return dispatch(operation, signal);
            },
            endpoint,
            forumPublicKeyHex: config.forumPublicKeyHex.toLowerCase(),
          });
    const scopedTransport: ForumTransport = {
      ...transport,
      exchange: (bytes, signal) => transport.exchange(bytes, deps.signal ? AbortSignal.any([deps.signal, signal]) : signal),
    };
    const client = createForumRoundtripClient({
      signer,
      transport: scopedTransport,
      forumPublicKeyHex: config.forumPublicKeyHex.toLowerCase(),
      callerPublicKeyHex: ownerPublicKeyHex,
    });
    const connection: Connection = { client, transport, epoch, ownerPublicKeyHex };
    connections.set(key, connection);
    return connection;
  };

  const connectionFor = async (config: ForumConfig): Promise<Connection> => {
    const epoch = deps.sessionEpoch();
    const ownerPublicKeyHex = deps.ownerPublicKeyHex().toLowerCase();
    if (config.endpoints.length === 0) {
      throw new ForumTrustError("no-endpoint", "论坛配置没有启用任何连接地址");
    }
    // 三种入口共享同一套语义：第一个失败就换下一个，而不是把失败当成功。
    const failures: string[] = [];
    for (const endpoint of config.endpoints) {
      try {
        return await transportFor(config, endpoint, epoch, ownerPublicKeyHex);
      } catch (error) {
        failures.push(`${endpoint.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new ForumTrustError("no-transport", `全部连接入口都失败：${failures.join("；")}`);
  };

  const indexClientFor = async (config: ForumConfig) => {
    const connection = await connectionFor(config);
    const epoch = connection.epoch;
    const owner = connection.ownerPublicKeyHex;
    return {
      configId: config.id,
      connection,
      assertFresh: () => assertFresh(epoch, owner),
      client: createForumIndexClient({
        client: connection.client,
        root: (configId) => rootCache.get(configId),
      }),
    };
  };

  // 根验证证据的进程内缓存；磁盘副本才是恢复来源。
  const rootCache = new Map<string, ForumRootVerification>();
  const projectCache = new Map<string, ForumReadingView["projection"]>();

  const withConnection = async <T>(
    configId: string,
    run: (input: {
      config: ForumConfig;
      connection: Connection;
      index: Awaited<ReturnType<typeof indexClientFor>>;
    }) => Promise<T>,
  ): Promise<T> => {
    const config = await deps.repository.readConfig(configId).then((value) => value ?? undefined);
    if (config === undefined) throw new ForumTrustError("unknown-config", `论坛配置 ${configId} 不存在`);
    const index = await indexClientFor(config);
    const result = await run({ config, connection: index.connection, index });
    // 任何结果在交付前都要过会话 fence：切 Key 期间的迟到响应不能进新会话。
    assertFresh(index.connection.epoch, index.connection.ownerPublicKeyHex);
    return result;
  };

  /** 单节点查询；get_node 是节点详情的唯一来源。 */
  const getNodeFor = async (configId: string, txid: string, options?: { signal?: AbortSignal }): Promise<ForumNodeDetail> =>
    withConnection(configId, async ({ index }) => index.client.getNode(configId, txid, options));

  const listStoreFor = async (config: ForumConfig, input: ForumListRequest): Promise<ForumListStore> => {
    const key = `${input.configId}|${input.operation}|${input.parentTxid}`;
    const existing = listStores.get(key);
    if (existing !== undefined) return existing;
    const index = await indexClientFor(config);
    const store = new ForumListStore(
      {
        configId: input.configId,
        operation: input.operation,
        parentTxid: input.parentTxid,
        forumTxid: input.forumTxid,
      },
      async ({ cursor, snapshotHeight, signal }) => {
        index.assertFresh();
        const page = await loadPage(index.client, input, cursor, snapshotHeight, signal);
        // 缓存标注离线/旧快照，不能作为当前报价与付款的真值。
        //
        // 写失败不能静默：缓存写不进去（路径不接受 64 位 hash、记录损坏、存储不可用）
        // 会让离线阅读悄悄失效，而页面上看不出任何症状。因此记一笔诊断日志，让它
        // 可被追查；读取路径仍然 fail closed（拿不到缓存就是没有缓存）。
        await persistCache(config, input, page).catch((error: unknown) => {
          console.warn("[forum] index cache write failed", input.operation, input.parentTxid, error);
        });
        return page;
      },
    );
    listStores.set(key, store);
    return store;
  };

  /**
   * 对账一个发布任务。
   *
   * 三套证据分别采集、分别保存，互不覆盖：
   *   - 广播：从持久 submission 查这**同一个**提交的状态；
   *   - 链上：按 txid 查传播状态；
   *   - Forum 索引：reply 用 get_node；changetip 用目标节点价格视图。
   *
   * Forum 查不到节点**不代表**交易无效或没广播：那是三个独立的事实，界面要分开
   * 显示，不能因为索引还没发现就把广播状态改成 unknown。
   */
  const reconcileTask = async (taskId: string, options?: { signal?: AbortSignal }): Promise<ForumPublishTask> => {
    const task = await requireTask(taskId);
    // B 已由论坛按真实区块位置确认，是终态；停止重复查询，不能因暂时的
    // 网络失败或滞后的 A 响应把它降级。A 则继续对账，允许超时后再入块。
    if (task.phase === "indexed-confirmed") return task;
    if (task.txid === undefined || task.submissionId === undefined) {
      // 没有 txid 或提交编号说明还没有派发证据；此时只允许走 cancelUndispatched。
      return task;
    }
    let next = task;

    // 1. 广播证据：只查这个持久提交，不重建也不二次派发。
    const broadcast = deps.observeBroadcast?.({
      ownerPublicKeyHex: task.ownerPublicKeyHex,
      network: task.network,
      txid: task.txid,
      submissionId: task.submissionId,
    });
    if (broadcast !== undefined) {
      try {
        next = { ...next, broadcastState: await broadcast, updatedAtMs: now() };
      } catch {
        // 查询广播失败不改变既有广播状态：保持上一次的结论而不是猜测。
      }
    }

    // 2. 链上证据：按 txid 查传播状态，与广播/索引分开保存。
    const chain = deps.observeChain?.(task.network, task.txid, options?.signal);
    if (chain !== undefined) {
      try {
        next = {
          ...next,
          chainObservation: { state: await chain, observedAtMs: now() },
          updatedAtMs: now(),
        };
      } catch {
        // 链数据源不可用时保持上一份观测。
      }
    }

    // 3. Forum 索引证据。
    if (task.kind === "reply") {
      try {
        const node = await getNodeFor(task.forumConfigId, task.txid, options);
        const indexState = node.status === "confirmed" ? "confirmed" : "mempool";
        next = {
          ...next,
          indexObservation: { state: indexState, eventAcceptanceQueryable: true, observedAtMs: now() },
          phase: node.status === "confirmed" ? "indexed-confirmed" : "indexed-mempool",
          updatedAtMs: now(),
        };
      } catch (error) {
        if (error instanceof ForumBusinessError && (error.code === "NODE_NOT_FOUND" || error.code === "INVALID_PARENT")) {
          // 索引还没发现：广播与链上状态原样保留，只把索引证据标为 unknown。
          next = {
            ...next,
            indexObservation: { state: "unknown", eventAcceptanceQueryable: true, observedAtMs: now() },
            phase: next.broadcastState === "observed-confirmed" ? "awaiting-index" : "reconciling",
            updatedAtMs: now(),
          };
        } else {
          throw error;
        }
      }
    } else {
      // changetip 不是节点：不能用 get_node(changetip txid) 判定成功。
      // 这里刷新目标节点的当前价格视图；事件是否被接受不可查询，保持明确限制。
      // 目标节点的当前价格视图是 changetip 唯一可查询的间接证据。
      await getNodeFor(task.forumConfigId, task.targetTxid, options).catch(() => undefined);
      next = {
        ...next,
        indexObservation: { state: "unknown", eventAcceptanceQueryable: false, observedAtMs: now() },
        phase: next.broadcastState === "observed-confirmed" ? "awaiting-index" : "reconciling",
        updatedAtMs: now(),
      };
    }

    // 索引结果变动不得覆盖原交易证据：raw、txid、submissionId 与 funding 原样保留。
    await deps.repository.writeTask(next);
    return next;
  };

  /**
   * 请求报价并独立验证 indexSig。
   *
   * 首次报价与资金准备后的复核走同一条路：请求参数完全相同，验证方式也相同——
   * 都用**将要上链的输出**重建 indexSig，而不是相信响应里的字段。
   */
  const requestQuote = async (
    task: ForumPublishTask,
    parent: ForumNodeDetail,
    options?: { signal?: AbortSignal },
  ): Promise<ForumQuoteSnapshot> => {
    if (task.operatorSigHex === undefined) throw new ForumProtocolError("no-operator-sig", "任务还没有 operatorSig");
    const config = await requireConfig(task.forumConfigId);
    const { ownerPublicKeyHex, epoch } = await signingPort();
    if (ownerPublicKeyHex !== task.ownerPublicKeyHex) {
      throw new ForumIdentityError(`任务属于 ${task.ownerPublicKeyHex.slice(0, 16)}…，当前身份是 ${ownerPublicKeyHex.slice(0, 16)}…`);
    }
    const connection = await connectionFor(config);
    const op = task.kind === "reply" ? "quote_reply" : "quote_changetip";
    const args: Record<string, string> =
      task.kind === "reply"
        ? {
            kind: "bsv8.reply.1",
            parent_txid: parent.txid,
            parent_publickey: parent.authorPublicKeyHex,
            reply_masterseedhash: task.replyMasterSeedHash as string,
            tip_price: task.tipPrice,
            operatorSig: task.operatorSigHex,
          }
        : {
            kind: "bsv8.changetip.1",
            parent_txid: parent.txid,
            tip_price: task.tipPrice,
            operatorSig: task.operatorSigHex,
          };
    const outcome = await connection.client.call({ op, args }, options?.signal);
    assertFresh(epoch, ownerPublicKeyHex);
    if (!outcome.ok) {
      throw new ForumBusinessError(outcome.error.code, outcome.error.message);
    }
    const quote = parseQuote(outcome.result, task.kind);
    if (task.kind === "reply") {
      verifyReplyQuote({
        forumPublicKeyHex: task.forumPublicKeyHex,
        parentTxid: parent.txid,
        parentPublicKeyHex: parent.authorPublicKeyHex,
        replyMasterSeedHash: task.replyMasterSeedHash as string,
        tipPrice: task.tipPrice,
        operatorSigHex: task.operatorSigHex,
        clientPublicKeyHex: ownerPublicKeyHex,
        quote,
      });
    } else {
      verifyChangeTipQuote({
        forumPublicKeyHex: task.forumPublicKeyHex,
        parentTxid: parent.txid,
        tipPrice: task.tipPrice,
        operatorSigHex: task.operatorSigHex,
        clientPublicKeyHex: ownerPublicKeyHex,
        quote,
      });
    }
    return quote;
  };

  /**
   * 落盘派发前的三个阶段之一。
   *
   * 已推进到更后面的阶段时不回退：崩溃恢复重跑同一段流程必须幂等，否则第二次
   * 运行会自己和自己冲突。真正要往回走的是费用变化，那由 `rollbackToBudget` 明确表达。
   */
  const persistDispatchPhase = async (
    task: ForumPublishTask,
    phase: DispatchPreparedPhase,
    lease: DispatchLeaseContext,
    next: ForumPublishTask,
  ): Promise<ForumPublishTask> => {
    const reached = dispatchPreparedIndex(task.phase);
    const target = reached >= dispatchPreparedIndex(phase) ? task.phase : phase;
    if (reached < dispatchPreparedIndex(phase)) assertPhaseAdvance(task.phase, phase);
    const saved: ForumPublishTask = { ...next, phase: target, updatedAtMs: now() };
    // 走租约上下文写入：租约已被接管时，令牌落后会让这一次写入直接失败，
    // 从而不会把接管方的进展覆盖成旧持有者的过期状态。
    await lease.writeTask(saved);
    return saved;
  };

  /**
   * 冻结正文到 MSFile。
   *
   * 冻结即归一化：统一 LF、去掉 BOM。发布后原始字节不再改动，因此规范化只在这里
   * 做一次，后续都按 hash 引用。
   */
  const freezeOnly = async (
    markdown: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ seedHashHex: string; bytes: string }> => {
    const bytes = normalizeForumMarkdownForPublish(markdown);
    if (bytes.byteLength > FORUM_MAX_MARKDOWN_BYTES) {
      throw new ForumProtocolError("markdown-oversize", `正文 ${bytes.byteLength} 字节超过 ${FORUM_MAX_MARKDOWN_BYTES} 字节上限`);
    }
    const imported = await deps.content.importContent({
      bytes,
      fileName: "post.md",
      mediaType: "text/markdown; charset=utf-8",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return { seedHashHex: imported.seedHashHex, bytes: imported.byteLength };
  };

  /**
   * 读发布可达性证据。
   *
   * 查询失败按「不可达」处理而不是当作可达：这里唯一的可选答案是「读者能不能取到」，
   * 拿不到证据时不能显示成能。
   */
  const reachabilityOf = async (
    configId: string,
    seedHashHex: string,
    options?: { signal?: AbortSignal },
  ): Promise<ForumPublicationReachability> => {
    void configId;
    try {
      const evidence = await deps.content.publicationReachability(seedHashHex, options);
      return {
        seedHashHex,
        reachable: evidence.published,
        sourceIds: evidence.sourceIds,
        detail: evidence.detail,
        observedAtMs: now(),
      };
    } catch {
      return {
        seedHashHex,
        reachable: false,
        sourceIds: [],
        detail: "无法取得发布可达性证据；不据此声称正文已可被读者获取",
        observedAtMs: now(),
      };
    }
  };

  /**
   * 费用或父状态变化后回到费用确认。
   *
   * 已经花出去的专用资金保留原记录（它仍然受保护），但预算必须由用户重新确认：
   * 费用变化意味着「用户点头同意的数字」不再等于实际要付的数字。
   */
  const rollbackToBudget = async (task: ForumPublishTask, reason: string): Promise<ForumPublishTask> => {
    assertPhaseAdvance(task.phase, "budget-confirmed");
    const rolled: ForumPublishTask = {
      ...task,
      budget: undefined,
      phase: "budget-confirmed",
      failureCode: "quote-changed",
      updatedAtMs: now(),
    };
    await deps.repository.writeTask(rolled);
    throw new ForumProtocolError("quote-changed", reason);
  };

  /**
   * 派发前的跨标签页仲裁。
   *
   * 顺序是「先拿租约，再重读任务，再动钱」：
   *
   *   1. 取得租约。失败说明另一个标签页在处理，直接落到对账。
   *   2. **重新读取任务**。拿租约之前读到的阶段可能已经过期——另一个页面可能
   *      已经提交并释放了租约。只用锁外的旧 task 会按过期状态重新构造一遍。
   *   3. 执行期间持续续租，并在每个不可逆动作前核对持有权。慢请求或页面被
   *      暂停超过 TTL 后，`assertHeld` 会失败并阻止后续动作。
   *   4. 阶段推进带栅栏令牌写入：租约被接管后，旧持有者的写入一定失败。
   *
   * 这仍然不是 Worker 级仲裁（签名与状态转换跑在 Window），但跨标签页的
   * 重复资金准备与重复派发在这里被挡住，且失效路径是 fail closed 的。
   */
  const withDispatchLease = async <T>(
    stale: ForumPublishTask,
    run: (lease: DispatchLeaseContext, current: ForumPublishTask) => Promise<T>,
  ): Promise<DispatchLeaseOutcome<T>> => {
    const holder = holderId();
    const lease = await deps.repository.acquireDispatchLease(
      {
        taskId: stale.taskId,
        holderId: holder,
        ownerPublicKeyHex: stale.ownerPublicKeyHex,
        acquiredAtMs: now(),
      },
      FORUM_DISPATCH_LEASE_TTL_MS,
    );
    // 拿不到租约只报告「有人在处理」，**不做任何写入、也不代替调用方决定业务语义**：
    // 发布可以对账原提交，取消必须拒绝，回收必须拒绝。把这段业务判断塞进辅助函数
    // 会让「取消」被悄悄改写成「对账」——那正是预签名取消被绕过的原因。
    if (lease === undefined) {
      return { kind: "unavailable" };
    }
    const renewTimer = startLeaseRenewal(lease, holder);
    try {
      // 拿到租约后重读：此刻的阶段才是真的当前状态。
      const current = await requireTask(stale.taskId);
      const context: DispatchLeaseContext = {
        lease,
        /** 不可逆动作前的持有权核对；续租失败也算失去租约。 */
        assertHeld: async () => {
          await lease.assertHeld();
        },
        /** 带栅栏令牌写任务；令牌落后时仓储直接拒绝。 */
        writeTask: (task) => deps.repository.writeTask(task, { fencingToken: lease.lease.fencingToken }),
      };
      return { kind: "ran", value: await run(context, current) };
    } finally {
      renewTimer.stop();
      await lease.release();
    }
  };

  /**
   * 发布路径的租约封装。
   *
   * 发布是唯一允许在拿不到租约时退化为「只对账」的动作：那里已经有原提交，
   * 对账不会花第二次钱。取消与回收没有这个性质，因此它们各自处理不可用分支。
   */
  const withDispatchLeaseForPublish = async <T extends ForumPublishTask>(
    stale: ForumPublishTask,
    run: (lease: DispatchLeaseContext, current: ForumPublishTask) => Promise<T>,
  ): Promise<T> => {
    const outcome = await withDispatchLease(stale, run);
    if (outcome.kind === "ran") return outcome.value;
    if (stale.submissionId !== undefined && stale.txid !== undefined) {
      return (await reconcileTask(stale.taskId)) as T;
    }
    throw new ForumProtocolError(
      "dispatch-leased",
      `发布任务 ${stale.taskId} 正由另一个页面处理，本次不做资金准备或派发`,
    );
  };

  /**
   * 定期续租。
   *
   * 不续租的话，一次慢的报价或签名就会让租约过期并被接管，旧持有者随后还能
   * 继续构造——那是「互斥看起来成立、实际不成立」的典型。续租失败立即停：
   * 此时租约已经不是自己的了。
   */
  const startLeaseRenewal = (lease: ForumDispatchLeaseHandle, holder: string): { stop(): void } => {
    const timer = setInterval(() => {
      void (async () => {
        const renewed = await lease.renew(lease.lease).catch(() => undefined);
        if (renewed === undefined) {
          // 失去租约：停止续租，后续 assertHeld 会阻止所有不可逆动作。
          clearInterval(timer);
          return;
        }
        lease.lease = renewed;
      })();
    }, Math.max(1_000, Math.floor(FORUM_DISPATCH_LEASE_TTL_MS / 3)));
    return {
      stop() {
        clearInterval(timer);
        void holder;
      },
    };
  };
  return {
    async listConfigs(): Promise<readonly ForumConfig[]> {
      const ids = await deps.repository.listConfigIds();
      const configs: ForumConfig[] = [];
      for (const id of ids) {
        const config = await deps.repository.readConfig(id);
        if (config !== undefined) configs.push(config);
      }
      return configs;
    },

    getConfig: (configId) => deps.repository.readConfig(configId).then((value) => value ?? undefined),

    async saveConfig(config: ForumConfig): Promise<void> {
      await deps.repository.writeConfig(normalizeConfig(config));
    },

    async removeConfig(configId: string): Promise<void> {
      // 删除 Forum 配置不删除 MSFile 内容：正文真值不属于 Forum。
      await deps.repository.deleteConfig(configId);
      rootCache.delete(configId);
      for (const key of [...listStores.keys()]) {
        if (key.startsWith(`${configId}|`)) {
          listStores.get(key)?.dispose();
          listStores.delete(key);
        }
      }
    },

    async verifyRoot(configId: string, options): Promise<ForumRootVerification> {
      const config = await deps.repository.readConfig(configId);
      if (config === undefined) throw new ForumTrustError("unknown-config", `论坛配置 ${configId} 不存在`);
      if (config.network !== "main" && config.network !== "test") {
        throw new ForumTrustError("network", `论坛配置网络必须是 main 或 test，实际 ${String(config.network)}`);
      }
      const rawTxBytes = await deps.fetchRootRaw({ network: config.network, txid: config.forumTxid }, options);
      const evidence = verifyForumRoot({ config, rawTxBytes, nowMs: now() });
      await deps.repository.writeRoot(evidence);
      rootCache.set(configId, evidence);
      return evidence;
    },

    async getRootVerification(configId: string): Promise<ForumRootVerification | undefined> {
      const cached = rootCache.get(configId);
      if (cached !== undefined) return cached;
      return (await deps.repository.readRoot(configId)) ?? undefined;
    },

    listBoards: (input) => withConnection(input.configId, async ({ index }) => index.client.listBoards(input)),
    listPosts: (input) => withConnection(input.configId, async ({ index }) => index.client.listPosts(input)),
    listReplies: (input) => withConnection(input.configId, async ({ index }) => index.client.listReplies(input)),

    async getNode(configId: string, txid: string, options): Promise<ForumNodeDetail> {
      return withConnection(configId, async ({ index }) => index.client.getNode(configId, txid, options));
    },

    async ensureContent(configId, seedHashHex, options): Promise<ForumContentStatus> {
      void configId;
      // 只有明确的阅读动作才允许动用资金；列表浏览不会走到这里。
      const status = await deps.content.ensureContent({
        seedHashHex,
        allowPurchase: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return toForumContentStatus(status);
    },

    async readAttachment(configId, seedHashHex, options): Promise<ForumContentStatus> {
      void configId;
      // 附件价格与大小限制由 MSFile 执行；附件失败不阻塞正文。
      const status = await deps.content.getContentStatus(seedHashHex).catch(() => undefined);
      if (status !== undefined && status.state === "verified") return toForumContentStatus(status);
      const ensured = await deps.content.ensureContent({
        seedHashHex,
        allowPurchase: false,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return toForumContentStatus(ensured);
    },

    /**
     * 读取已验证附件的字节。
     *
     * 读取链路是「先本地附件，再按需远程」：
     *
     *   1. **先**用附件入口试本地：`openVerifiedAttachment` 不套 Markdown 的 1 MiB
     *      上限，所以本地的大附件在这里就能读到。走正文 `ensureContent` 会先被正文
     *      限额拦住，附件入口等于永远到不了。
     *   2. 本地没有时，`ensureContent` 才负责调度获取（含远程），此时才允许付费：
     *      这是用户明确点开附件的动作，与列表浏览的「不得自动购买」规则不冲突。
     *
     * 拿不到就返回 undefined，界面据此显示「未获取」，而不是展示一个空图片框并声称
     * 附件已就绪。
     */
    async readAttachmentContent(configId, seedHashHex, options): Promise<ForumAttachmentContent | undefined> {
      void configId;
      const local = await deps.content.openVerifiedAttachment(seedHashHex, options);
      if (local !== undefined) {
        return {
          seedHashHex: local.seedHashHex,
          bytes: local.bytes,
          byteLength: local.byteLength,
          ...(local.mediaType === undefined ? {} : { mediaType: local.mediaType }),
          ...(local.fileName === undefined ? {} : { fileName: local.fileName }),
        };
      }
      // 本地没有：交给 MSFile 调度远程获取。用户点开附件是明确的获取授权，
      // 价格上限仍由 MSFile 的既有买方设置约束，Forum 不自己决定付多少。
      //
      // `asAttachment` 不可省：默认的正文 1 MiB 限额会在下载完成后把一份完整落盘的
      // 2 MiB 图片判成 too-large，于是下面的附件读取永远拿不到它。
      const ensured = await deps.content.ensureContent({
        seedHashHex,
        allowPurchase: true,
        asAttachment: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (ensured.state !== "verified") return undefined;
      const fetched = await deps.content.openVerifiedAttachment(seedHashHex, options);
      if (fetched === undefined) return undefined;
      return {
        seedHashHex: fetched.seedHashHex,
        bytes: fetched.bytes,
        byteLength: fetched.byteLength,
        ...(fetched.mediaType === undefined ? {} : { mediaType: fetched.mediaType }),
        ...(fetched.fileName === undefined ? {} : { fileName: fetched.fileName }),
      };
    },

    /**
     * 用户明确「阅读」时调用：先请求 MSFile 获取，再读已验证正文。
     *
     * 这是唯一允许为正文付费的入口；列表浏览与展开回复只走 `readContent` 的
     * 本地优先路径。获取失败时仍然返回状态，正文不可达不阻塞节点与回复结构。
     */
    async openAndFetch(configId: string, seedHashHex: string, options): Promise<ForumReadingView> {
      void configId;
      await deps.content.ensureContent({
        seedHashHex,
        allowPurchase: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return readVerifiedReading(deps.content, seedHashHex, options);
    },

    async readContent(configId: string, seedHashHex: string, options): Promise<ForumReadingView> {
      void configId;
      return readVerifiedReading(deps.content, seedHashHex, options);
    },

async freezeContent(configId, markdown, options): Promise<{ seedHashHex: string; bytes: string }> {
      const { seedHashHex, bytes } = await freezeOnly(markdown, options);
      void configId;
      return { seedHashHex, bytes };
    },

    /**
     * 冻结正文并记录发布可达性。
     *
     * 两条事实分开：正文冻结进 MSFile 是链上发布的前提；读者能否取得那份内容是
     * 发布渠道的事。渠道缺失**不阻止**冻结（链上 data 输出照样指向这个 seed hash），
     * 但可达性必须被记录下来，否则界面只能显示「已发布」，而读者根本取不到。
     */
    async preparePublishContent(configId, markdown, options): Promise<{ seedHashHex: string; bytes: string; publication: ForumPublicationReachability }> {
      const { seedHashHex, bytes } = await freezeOnly(markdown, options);
      const publication = await reachabilityOf(configId, seedHashHex, options);
      return { seedHashHex, bytes, publication };
    },

    async publicationReachability(configId, seedHashHex, options): Promise<ForumPublicationReachability> {
      return reachabilityOf(configId, seedHashHex, options);
    },

    async preparePublish(input: ForumPublishPrepareInput): Promise<ForumPublishTask> {
      const config = await deps.repository.readConfig(input.configId);
      if (config === undefined) throw new ForumTrustError("unknown-config", `论坛配置 ${input.configId} 不存在`);
      if (!rootEvidenceIsUsable(await deps.repository.readRoot(input.configId), config)) {
        throw new ForumTrustError("root-unverified", "论坛根尚未验证，不能发布");
      }
      const { ownerPublicKeyHex } = await signingPort();
      const tipPrice = normalizeForumAmount(input.tipPrice);
      if (tipPrice === undefined) {
        throw new ForumProtocolError("tip-price", "未来回复价必须是规范十进制 uint64");
      }
      let replyMasterSeedHash = input.replyMasterSeedHash;
      if (input.kind === "reply") {
        if (replyMasterSeedHash === undefined) {
          if (input.markdown === undefined) {
            throw new ForumProtocolError("content", "reply 必须带已冻结正文 hash 或正文");
          }
          // 正文冻结在 MSFile；Forum 只保留 hash。
          replyMasterSeedHash = (await deps.content.importContent({
            bytes: normalizeForumMarkdownForPublish(input.markdown),
            fileName: "post.md",
            mediaType: "text/markdown; charset=utf-8",
            ...(input.signal ? { signal: input.signal } : {}),
          })).seedHashHex;
        }
      }
      const task: ForumPublishTask = {
        taskId: randomId(),
        ownerPublicKeyHex,
        network: config.network,
        forumConfigId: config.id,
        forumTxid: config.forumTxid,
        forumPublicKeyHex: config.forumPublicKeyHex.toLowerCase(),
        kind: input.kind,
        targetTxid: input.targetTxid,
        ...(replyMasterSeedHash === undefined ? {} : { replyMasterSeedHash }),
        tipPrice,
        broadcastState: "not-dispatched",
        chainObservation: { state: "unknown", observedAtMs: now() },
        indexObservation: { state: "unknown", eventAcceptanceQueryable: input.kind === "reply", observedAtMs: now() },
        phase: "draft",
        createdAtMs: now(),
        updatedAtMs: now(),
      };
      // 写前日志：不可逆动作之前先落盘，崩溃后据此恢复而不是从头再来。
      await deps.repository.writeTask(task);
      return task;
    },

    async quotePublish(taskId: string, options): Promise<ForumPublishTask> {
      return withTaskLock(taskId, async (task) => {
      if (task.submissionId !== undefined) {
        // 另一个页面已经把任务推进到派发之后：不再重新报价。
        return reconcileTask(taskId, options);
      }
      const { port, ownerPublicKeyHex, epoch } = await signingPort();
      if (ownerPublicKeyHex !== task.ownerPublicKeyHex) {
        // 恢复时不把旧授权句柄当成当前身份的授权。
        throw new ForumIdentityError(`任务属于 ${task.ownerPublicKeyHex.slice(0, 16)}…，当前身份是 ${ownerPublicKeyHex.slice(0, 16)}…`);
      }
      const parent = await getNodeFor(task.forumConfigId, task.targetTxid, options);
      const operatorSig = await signOperator(task, port, {
        parentTxid: parent.txid,
        parentPublicKeyHex: parent.authorPublicKeyHex,
        replyMasterSeedHash: task.replyMasterSeedHash ?? undefined,
        tipPrice: task.tipPrice,
      });
      const signed: ForumPublishTask = {
        ...task,
        operatorSigHex: bytesToHex(operatorSig),
        phase: "signed",
        updatedAtMs: now(),
      };
      assertPhaseAdvance(task.phase, "signed");
      await deps.repository.writeTask(signed);
      // 签名先落盘再报价：报价请求失败时仍然留着 operatorSig，恢复不必重签。
      const quote = await requestQuote(signed, parent, options);
      assertPhaseAdvance("signed", "quoted");
      const quoted: ForumPublishTask = { ...signed, quote, phase: "quoted", updatedAtMs: now() };
      await deps.repository.writeTask(quoted);
      return quoted;
      });
    },

    async confirmBudget(taskId: string, options?: { signal?: AbortSignal }): Promise<ForumBudgetConfirmation> {
      return withTaskLock(taskId, async (task) => {
      if (task.submissionId !== undefined) {
        // 已经派发：费用确认不再有意义，避免界面把预算改到一笔已广播的交易上。
        throw new ForumProtocolError("already-dispatched", "交易已派发，不能再确认费用");
      }
      const quote = task.quote;
      if (quote === undefined) throw new ForumProtocolError("no-quote", "任务还没有报价");
      const sources = (deps.fundingSource ?? fundingSources)?.();
      if (sources === undefined) throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法计算费用");
      // 两笔交易的费用都按当前报价算：协议矿工费预算由固定输出数决定，
      // 资金准备矿工费由 P2PKH 的同源估算给出。首次确认时预算还不存在，
      // 因此绝不能从 budget 里读矿工费——那会得到 0。
      const fixedOutputs = fixedOutputValues(task.kind, quote);
      const minerFeeBudgetSatoshis = estimateMinerFeeBudget({
        inputCount: 1,
        outputCount: fixedOutputs.length,
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
      });
      const plan = await sources.planDedicatedFunding({
        network: task.network,
        fixedOutputsSatoshis: fixedOutputs.reduce((total, value) => total + value, 0n),
        protocolMinerFeeBudgetSatoshis: minerFeeBudgetSatoshis,
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
      });
      const items: ForumFeeBreakdownItem[] = buildFeeBreakdown({
        kind: task.kind,
        indexPrice: quote.indexPrice,
        ...(quote.parentTipPrice === undefined ? {} : { parentTipPrice: quote.parentTipPrice }),
        fundingMinerFee: plan.fundingMinerFeeSatoshis.toString(),
        protocolMinerFee: minerFeeBudgetSatoshis.toString(),
      });
      const budget: ForumBudgetConfirmation = {
        version: (task.budget?.version ?? 0) + 1,
        items,
        totalSatoshis: totalFeeSatoshis(items),
        confirmedAtMs: now(),
      };
      // 报价变化后回到费用确认是合法路径，不算阶段回退。
      assertPhaseAdvance(task.phase, "budget-confirmed");
      void options;
      await deps.repository.writeTask({ ...task, budget, phase: "budget-confirmed", updatedAtMs: now() });
      return budget;
      });
    },

    async buildAndSubmit(taskId: string, options): Promise<ForumPublishTask> {
      return withTaskLock(taskId, async (stale) => withDispatchLeaseForPublish(stale, async (lease, current) => {
      // 注意：这里的 `task` 是**取得租约之后**重读的那一份，不是锁外读到的旧阶段。
      const task = current;
      if (task.submissionId !== undefined) return reconcileTask(taskId, options);
      if (task.phase === "failed") {
        throw new ForumProtocolError("task-failed", "该发布任务已处于失败状态，不能重新派发");
      }
      if (task.budget === undefined) throw new ForumProtocolError("no-budget", "费用尚未确认");
      if (task.quote === undefined) throw new ForumProtocolError("no-quote", "任务还没有报价");
      const sources = (deps.fundingSource ?? fundingSources)?.();
      if (sources === undefined) throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法准备专用资金 UTXO");
      const spend = deps.protocolSpend();
      if (spend === undefined) {
        throw new ForumProtocolError("no-funding", "P2PKH 协议资金能力不可用，无法发布");
      }
      // 用户确认的矿工费预算是协议交易唯一的费用上限。缺省或零说明没有真正确认过，
      // 此时不能因为「恰好能构造出交易」就继续。
      const minerFeeBudgetSatoshis = forumAmountToBigInt(findingOf(task.budget, "protocol-miner-fee") ?? "") ?? 0n;
      if (minerFeeBudgetSatoshis <= 0n) {
        throw new ForumProtocolError("no-fee-budget", "费用确认里没有协议矿工费预算，拒绝按未确认的额度派发");
      }
      const parent = await getNodeFor(task.forumConfigId, task.targetTxid, options);

      // 1. 按当前报价算固定输出与专用资金额度。只准备所需金额：协议交易没有找零
      //    输出，多拆出来的部分会直接变成矿工费。
      const quotedOutputs = fixedOutputValues(task.kind, task.quote);
      const quotedMinerFeeBudget = estimateMinerFeeBudget({
        inputCount: 1,
        outputCount: quotedOutputs.length,
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
      });
      const fundingPlan = await sources.planDedicatedFunding({
        network: task.network,
        fixedOutputsSatoshis: quotedOutputs.reduce((total, value) => total + value, 0n),
        protocolMinerFeeBudgetSatoshis: minerFeeBudgetSatoshis,
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
      });
      if (quotedMinerFeeBudget > minerFeeBudgetSatoshis) {
        // 确认的预算已经不足以覆盖本次固定输出布局：回到费用确认而不是硬发。
        return rollbackToBudget(task, "确认的矿工费预算不足以覆盖本次固定输出布局，请重新确认费用");
      }
      // 准备资金是不可逆动作（会广播一笔拆钱交易）：动钱之前核对持有权。
      await lease.assertHeld();
      const funding = await ensureDedicatedFunding(task, fundingPlan.requiredSatoshis, (deps.fundingSource ?? fundingSources)?.());

      // 2. 落盘资金准备阶段：这一步已经把不可逆的钱花出去了，必须有阶段证据。
      const prepared = await persistDispatchPhase(task, "funding-prepared", lease, {
        ...task,
        funding: { txid: funding.txid, vout: funding.input.vout, rawTxHex: funding.rawTxHex },
      });

      // 3. 资金准备后重新询价：费用或父状态变了就回到确认，让用户重新决定。
      const rechecked = await requestQuote(prepared, parent, options);
      if (quoteDiffersFromBudget(prepared.budget, rechecked, prepared.kind)) {
        return rollbackToBudget(
          { ...prepared, quote: rechecked },
          "资金准备后报价已变化，请重新确认费用",
        );
      }
      const recheckedOutputs = fixedOutputValues(prepared.kind, rechecked);
      if (recheckedOutputs.length !== quotedOutputs.length) {
        return rollbackToBudget({ ...prepared, quote: rechecked }, "资金准备后父状态变化导致输出数改变，请重新确认费用");
      }
      const recheckedTask = await persistDispatchPhase(prepared, "quote-rechecked", lease, { ...prepared, quote: rechecked });

      // 4. 按复核后的报价构建固定输出的无找零交易。
      const outputs = buildForumProtocolOutputs({
        kind: recheckedTask.kind,
        parentTxidHex: parent.txid,
        parentPublicKeyHex: parent.authorPublicKeyHex,
        ...(recheckedTask.replyMasterSeedHash === undefined ? {} : { replyMasterSeedHashHex: recheckedTask.replyMasterSeedHash }),
        tipPrice: forumAmountToBigInt(recheckedTask.tipPrice) ?? 0n,
        operatorSig: hexToBytes(recheckedTask.operatorSigHex as string),
        lastBlockHeight: forumAmountToBigInt(rechecked.lastBlockHeight) ?? 0n,
        indexSig: hexToBytes(rechecked.indexSigHex),
        clientPublicKeyHex: recheckedTask.ownerPublicKeyHex,
        quote: rechecked,
        ...(rechecked.parentTipPrice === undefined ? {} : { parentTipPriceSatoshis: forumAmountToBigInt(rechecked.parentTipPrice) ?? 0n }),
      });

      // 5. 显式 presign 产生已授权签名和持久占用，尚未广播；后续必须对账同一提交。
      //    受控无找零：输入超出固定输出的差额必须精确成为矿工费，且不超过
      //    用户确认的预算。零值输出是固定位置协议输出的一部分（索引费为 0 的 vout 0）。
      const preview = await spend.presign({
        requestingPluginId: "forum",
        // 只花专用资金 UTXO；钱包大额余额差不会直接变成矿工费。
        inputs: [funding.input],
        outputs: outputs.map((output, index) => ({
          // 钱包侧用 number 表示金额：越过安全整数必须明确拒绝而不是截断。
          value: requireSafeWalletSatoshis(output.value, `forum-vout-${index}`),
          scriptHex: bytesToHex(output.lockingScript),
          label: `forum-vout-${index}`,
        })),
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
        noChangeRule: {
          maxMinerFeeSatoshis: requireSafeWalletSatoshis(minerFeeBudgetSatoshis, "协议矿工费预算"),
          allowZeroValueOutputs: true,
        },
      });

      // 6. 广播前复核：raw 自己就是证据，从它重建并验签、核对输出数与费用。
      const rawBytes = protocolHexToBytes(preview.rawTxHex);
      verifyFinalRaw({
        forumPublicKeyHex: recheckedTask.forumPublicKeyHex,
        kind: recheckedTask.kind,
        rawTxBytes: rawBytes,
        expectedTxid: preview.txid,
      });
      parseTransaction(rawBytes, sha256Digest);
      const actualFee = reconcileMinerFee({
        totalInputSatoshis: funding.availableSatoshis,
        outputs: outputs.map((output) => ({ value: output.value, lockingScript: output.lockingScript })),
        serializedSizeBytes: rawTxHexByteLength(preview.rawTxHex),
        feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
        maxMinerFeeSatoshis: minerFeeBudgetSatoshis,
      });
      // prepare 报告的是 number；跨回协议金额前先确认没有越过安全整数。
      const reportedFee = BigInt(requireSafeWalletSatoshis(BigInt(preview.estimatedFeeSatoshis), "prepare 报告的矿工费"));
      if (actualFee.actualMinerFeeSatoshis !== reportedFee) {
        throw new ForumProtocolError(
          "fee-evidence",
          `从 raw 复算的矿工费 ${actualFee.actualMinerFeeSatoshis} 与 prepare 报告的 ${reportedFee} 不一致`,
        );
      }

      // 7. 派发前把提交编号、raw 与 txid 落盘。不可逆动作之前必须有证据，
      //    否则广播成功后响应丢失就会没有任何可对账的东西。
      const rawPrepared = await persistDispatchPhase(recheckedTask, "raw-prepared", lease, {
        ...recheckedTask,
        funding: { txid: funding.txid, vout: funding.input.vout, rawTxHex: funding.rawTxHex },
        submissionId: preview.submissionId,
        finalRawTxHex: preview.rawTxHex,
        txid: preview.txid,
        broadcastState: "not-dispatched",
      });

      // 8. 才派发。派发前再核对一次持有权：构造 raw 的过程可能已经超过 TTL。
      await lease.assertHeld();
      const result = await spend.submit(preview);
      const dispatched: ForumPublishTask = {
        ...rawPrepared,
        broadcastState: mapBroadcastState(result.status),
        phase: result.status === "unknown" ? "reconciling" : "awaiting-index",
        updatedAtMs: now(),
      };
      assertPhaseAdvance("raw-prepared", dispatched.phase === "reconciling" ? "reconciling" : "awaiting-index");
      await deps.repository.writeTask(dispatched);
      // 9. 派发后立即对账原提交，让链上与索引状态有第一份观测。
      return reconcileTask(taskId, options);
      }));
    },

    reconcile: (taskId, options) => reconcileTask(taskId, options),

    async listSelfOutputs(input) {
      if (Object.keys(input).some(key => !["txids", "signal"].includes(key))) throw new ForumIdentityError("Wallet selectors are not accepted");
      const txids = [...input.txids], signal = input.signal;
      const context = await selfOutputContext();
      const result = await requireSelfOutputs().list(context.network, txids, signal);
      context.assertActive();
      return result;
    },

    async protectSelfOutputs(outputs, ...args: []) {
      if (args.length) throw new ForumIdentityError("Wallet selectors are not accepted");
      const rows = outputs.map(row => ({ ...row })), context = await selfOutputContext();
      const result = await requireSelfOutputs().protect(rows, context.network);
      context.assertActive();
      return result;
    },

    async unprotectSelfOutputs(outputs) {
      const rows = outputs.map(row => ({ ...row })), context = await selfOutputContext();
      context.assertActive();
      requireSelfOutputs().unprotect(rows);
    },

    async sweepSelfOutputs(input) {
      if (Object.keys(input).some(key => !["outpoints", "feeRateSatoshisPerKb", "signal"].includes(key))) throw new ForumIdentityError("Wallet selectors are not accepted");
      const outpoints = input.outpoints.map(row => ({ ...row })), feeRateSatoshisPerKb = input.feeRateSatoshisPerKb ?? FORUM_FEE_RATE_SATOSHIS_PER_KB, signal = input.signal;
      const context = await selfOutputContext();
      const sources = (deps.fundingSource ?? fundingSources)?.();
      if (sources === undefined) throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法归集自有输出");
      const result = await requireSelfOutputs().sweep({ network: context.network, outpoints, feeRateSatoshisPerKb, ...(signal === undefined ? {} : { signal }) });
      context.assertActive();
      return result;
    },

    /**
     * 显式回收任务的当前专用资金。
     *
     * 所有可失败的判断都在**不可逆动作之前**完成，而且**锁外与租约内各做一次**：
     * 取得租约期间任务可能被另一个标签页取消或推进，只在锁外判一次就会拿着过期的
     * 结论去改任务状态（例如把并发的 `failed` 覆盖成 `budget-confirmed`）。
     *
     * 与发布、取消共用同一把派发租约，因此回收期间不会有另一条路径在动这笔任务。
     *
     * 回收**当前**资金必然改变任务，但怎么改取决于任务是否已被取消：
     *   - 未取消：钱扫回钱包后这笔任务没有资金可用，必须回到 `budget-confirmed`；
     *   - 已取消（`failed` + `cancelled`）：保持取消状态，只清资金引用——
     *     把它改回 `budget-confirmed` 等于替用户把一个已取消的发布重新激活。
     */
    async recoverFunding(taskId) {
      const sources = (deps.fundingSource ?? fundingSources)?.();
      if (sources === undefined) throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法回收专用资金");
      if (sources.recoverDedicatedFunding === undefined) {
        throw new ForumProtocolError("funding-unavailable", "该资金来源不支持显式回收");
      }
      const task = await requireTask(taskId);
      const expected = task.funding === undefined
        ? undefined
        : { txid: task.funding.txid, vout: task.funding.vout };
      // 锁外先判一次：明显不可回收时不必去抢租约。
      await assertFundingRecoverable(task, expected);
      const outcome = await withDispatchLease(task, async (lease, reread) => {
        // 租约内重判：等待期间任务可能已被取消或推进。
        const current = reread;
        const target = await assertFundingRecoverable(current, expected);
        await lease.assertHeld();
        const recovered = await sources.recoverDedicatedFunding!({
          ownerPublicKeyHex: current.ownerPublicKeyHex,
          network: current.network,
          taskId: current.taskId,
          feeRateSatoshisPerKb: FORUM_FEE_RATE_SATOSHIS_PER_KB,
          // 依据：由本服务仲裁后声明这笔钱不再被任何任务引用。
          reason: { unused: true },
        });
        await lease.writeTask({
          ...current,
          phase: target === "reactivate" ? "budget-confirmed" : current.phase,
          failureCode: target === "reactivate" ? "funding-recovered" : current.failureCode,
          funding: undefined,
          budget: target === "reactivate" ? undefined : current.budget,
          updatedAtMs: now(),
        });
        return { txid: recovered.txid, recoveredSatoshis: recovered.recoveredSatoshis };
      });
      if (outcome.kind === "ran") return outcome.value;
      // 别人正在处理这笔任务：回收涉及不可逆动作，一律拒绝，绝不「顺便」改状态。
      throw new ForumProtocolError("dispatch-leased", `发布任务 ${task.taskId} 正由另一个页面处理，本次不回收专用资金`);
    },

    /**
     * 取消未派发的任务。
     *
     * 与发布、回收共用派发租约：取消与回收交错时，谁后取得租约谁按重读到的状态
     * 判断，不会用一个标签页的过期视图覆盖另一个标签页刚写下的取消结果。
     */
    /**
     * 取消未派发的任务。
     *
     * 判据是**持久提交的实际派发状态**，不是「有没有 submissionId」：
     * `raw-prepared` 阶段就已经保存了 submissionId，此时它完全可能仍是明确未派发。
     * 按 submissionId 一刀切拒绝会让用户永远取消不掉刚预签名的任务；反过来只看
     * 阶段而不查提交，又会在已派发时错误地释放占用。
     *
     * 因此分三步，每步都以观察到的广播状态为准：
     *   1. 锁外看任务自己的 `broadcastState`（没有 submission 时它就是「未派发」）；
     *   2. 取得租约后重读任务，再向钱包查**同一个**持久提交的实际状态；
     *   3. 只有 `not-dispatched` / `definitely-not-dispatched` 才释放占用并标记取消，
     *      `unknown` 一律拒绝——「查不到」不是「没派发」。
     *
     * 与发布、回收共用派发租约：取消与回收交错时谁都不覆盖对方的结论。
     */
    async cancelUndispatched(taskId: string): Promise<void> {
      const task = await requireTask(taskId);
      assertCancellable(task, task.broadcastState);
      const outcome = await withDispatchLease(task, async (lease, reread) => {
        await lease.assertHeld();
        const current = reread;
        const observed = await observeCurrentBroadcastState(current);
        assertCancellable(current, observed);
        // 有持久预签名提交就必须真的释放：提交还在准备态时留着它，普通转账会撞上
        // 占用，而任务一旦标成已取消，这笔占用就没有任何人会再去处理它。
        // 因此释放能力缺失或释放失败都**不允许**标记取消，任务状态保持原样。
        await releasePreparedSubmissionIfAny(current);
        await lease.writeTask({ ...current, phase: "failed", failureCode: "cancelled", updatedAtMs: now() });
        return current;
      });
      if (outcome.kind === "ran") return;
      // 别人正在处理这笔任务：取消必须拒绝，不能退化成对账——
      // 那会把用户的「取消」悄悄变成「等它派发」。
      throw new ForumProtocolError("dispatch-leased", `发布任务 ${task.taskId} 正由另一个页面处理，本次不执行取消`);
    },

    async listPublishTasks(configId): Promise<readonly ForumPublishTask[]> {
      return deps.repository.listTasks(configId);
    },

    getPublishTask: (taskId) => deps.repository.readTask(taskId).then((value) => value ?? undefined),
  };

  async function loadPage(
    client: ReturnType<typeof createForumIndexClient>,
    input: ForumListRequest,
    cursor: string | undefined,
    snapshotHeight: number | undefined,
    signal: AbortSignal,
  ): Promise<ForumListPage> {
    const request: ForumListRequest = {
      ...input,
      limit: normalizeForumPageSize(input.limit),
      ...(cursor === undefined ? {} : { cursor }),
      // 有 cursor 时不再传 snapshot_height。
      ...(cursor === undefined ? (snapshotHeight === undefined ? {} : { snapshotHeight }) : {}),
      signal,
    };
    if (input.operation === "list_boards") return client.listBoards(request);
    if (input.operation === "list_posts") return client.listPosts(request);
    return client.listReplies(request);
  }

  async function persistCache(config: ForumConfig, input: ForumListRequest, page: ForumListPage): Promise<void> {
    const entry: ForumIndexCacheEntry = {
      configId: config.id,
      operation: input.operation,
      parentTxid: input.parentTxid,
      snapshotHeight: page.snapshotHeight,
      mempoolRevision: page.mempoolRevision,
      items: page.items,
      nextCursor: page.nextCursor,
      cachedAtMs: now(),
      stale: false,
    };
    await deps.repository.writeIndexCache(entry);
  }

  /**
   * 在任务互斥锁内执行一个阶段推进。
   *
   * `run` 收到的是**锁内重新读取**的任务：调用方在锁外读到的阶段可能已经被另一个
   * 页面推进，所以不能直接用。
   *
   * 这把锁只在进程内。同一浏览器的第二个标签页持有另一个 Window 实例，因此
   * 不可逆动作还要靠派发租约（owner 文件存储的条件写）跨标签页互斥。
   */
  async function withTaskLock<T>(taskId: string, run: (task: ForumPublishTask) => Promise<T>): Promise<T> {
    const previous = taskLocks.get(taskId) ?? Promise.resolve();
    // 前一个阶段失败不应让后一个阶段永远拿不到锁。
    const gate = previous.catch(() => undefined);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    taskLocks.set(taskId, held);
    await gate;
    try {
      const task = await requireTask(taskId);
      return await run(task);
    } finally {
      release();
      if (taskLocks.get(taskId) === held) taskLocks.delete(taskId);
    }
  }

  /**
   * 释放本任务的预签名提交；没有提交时什么都不做。
   *
   * 「没有提交」和「有提交但释放不了」是两回事：后者必须失败。少了这一步，一个
   * 预签名但未派发的任务会被标成已取消，而它那笔还没释放的占用就此悬空。
   */
  async function releasePreparedSubmissionIfAny(task: ForumPublishTask): Promise<void> {
    if (task.submissionId === undefined) return;
    const release = deps.protocolSpend()?.releasePreparedSubmission;
    if (release === undefined) {
      throw new ForumProtocolError(
        "release-unavailable",
        "当前无法释放预签名提交占用，不能标记任务为已取消",
      );
    }
    if (task.txid === undefined) {
      throw new ForumProtocolError(
        "release-unavailable",
        `提交 ${task.submissionId} 没有 txid 证据，无法确认释放对象`,
      );
    }
    await release({
      txid: task.txid,
      submissionId: task.submissionId,
    });
  }

  /**
   * 任务当前广播状态：优先看钱包对**同一个持久提交**的观察，没有提交时就是未派发。
   *
   * 观察缺席或抛错一律返回 `unknown`：无法证明未派发时不允许释放占用。
   */
  async function observeCurrentBroadcastState(task: ForumPublishTask): Promise<ForumBroadcastState> {
    if (task.submissionId === undefined) return "not-dispatched";
    const observe = deps.observeBroadcast;
    if (observe === undefined) return "unknown";
    try {
      return await observe({
        ownerPublicKeyHex: task.ownerPublicKeyHex,
        network: task.network,
        txid: task.txid ?? "",
        submissionId: task.submissionId,
      });
    } catch {
      return "unknown";
    }
  }

  /**
   * 取消判据：`not-dispatched` 与 `definitely-not-dispatched` 可以取消。
   *
   * 其余全部拒绝，包括 `unknown`——「查不到」不是「没派发」，按可取消处理会让
   * 一笔可能已经上链的交易失去占用保护。
   */
  function assertCancellable(task: ForumPublishTask, state: ForumBroadcastState): void {
    if (state === "not-dispatched" || state === "definitely-not-dispatched") return;
    throw new ForumProtocolError(
      "not-cancellable",
      `交易广播状态为 ${state}，只有明确未派发才能取消并释放输入占用`,
    );
  }

  /**
   * 回收前的统一判据。
   *
   * 锁外（避免无谓抢租约）与租约内（防止并发覆盖）调用的是同一份，因此两条路径
   * 不会出现「锁外通过、锁内才发现不行」的偏差。
   *
   * 返回回收成功后任务该怎么落地：`reactivate` 回到费用确认，`stay-cancelled`
   * 保持取消状态。
   */
  async function assertFundingRecoverable(
    task: ForumPublishTask,
    expected: { txid: string; vout: number } | undefined,
  ): Promise<"reactivate" | "stay-cancelled"> {
    if (task.ownerPublicKeyHex !== deps.ownerPublicKeyHex().toLowerCase()) {
      throw new ForumProtocolError("owner-mismatch", "该任务属于别的 owner，不能回收它的资金");
    }
    const cancelled = task.phase === "failed" && task.failureCode === "cancelled";
    // 任务自己的广播状态说不派发就不派发：`dispatched`/`unknown` 一律拒绝，
    // 这里不接受「大概没派发」。
    if (task.broadcastState === "dispatched" || task.broadcastState === "unknown") {
      throw new ForumProtocolError("already-dispatched", "该任务已派发或结果未知，不能回收它的专用资金");
    }
    // 取消后的任务仍然可以回收——取消只说明不再发布，钱还是用户的。
    if (task.phase === "failed" && !cancelled) {
      throw new ForumProtocolError("phase-conflict", `任务处于失败状态（${task.failureCode ?? "未知"}），只有已取消的任务可以回收资金`);
    }
    // 存在持久提交时，光看任务状态不够：预签名阶段就已经保存了 submissionId。
    // 判断依据必须是**同一个提交的实际派发状态**：
    //   - 未取消：提交随时可能被派发，直接拒绝；
    //   - 已取消：取消链路已按「明确未派发才释放」释放过它，这里再核一次，
    //     证明确认它确实没有进入网络。历史提交证据保留在任务上不删除。
    if (task.submissionId !== undefined) {
      if (!cancelled) {
        throw new ForumProtocolError("already-dispatched", "该任务存在尚未确认释放的预签名提交，不能回收专用资金");
      }
      const observed = await observeCurrentBroadcastState(task);
      if (observed !== "not-dispatched" && observed !== "definitely-not-dispatched") {
        throw new ForumProtocolError(
          "already-dispatched",
          `已取消任务的提交 ${task.submissionId} 当前状态为 ${observed}，不能确认它未派发，不回收专用资金`,
        );
      }
    }
    if (POST_PROTOCOL_TX_PHASES.includes(task.phase)) {
      throw new ForumProtocolError("phase-conflict", `阶段 ${task.phase} 已经过了构造协议交易这一步，不能回收当前资金`);
    }
    if (task.funding === undefined) {
      throw new ForumProtocolError("funding-unavailable", "该任务没有已准备的专用资金可回收");
    }
    // 资金坐标必须逐项一致：只比 txid 会漏掉「同一笔交易的不同 vout」。
    if (expected !== undefined && (task.funding.txid !== expected.txid || task.funding.vout !== expected.vout)) {
      throw new ForumProtocolError("funding-unavailable", "任务资金已变化，请重新查看后再回收");
    }
    if (cancelled) return "stay-cancelled";
    // 回收后必须能回到费用确认，否则钱扫走了任务却卡在原阶段。
    if (!canAdvancePublishPhase(task.phase, "budget-confirmed")) {
      throw new ForumPublishTransitionError(task.phase, "budget-confirmed");
    }
    return "reactivate";
  }

  /** 自有输出服务缺席时明确失败，而不是静默返回「没有自有输出」。 */
  function requireSelfOutputs(): ForumSelfOutputService {
    const outputs = deps.selfOutputs?.();
    if (outputs === undefined) {
      throw new ForumProtocolError("self-outputs-unavailable", "自有输出能力不可用（缺少链数据源或协议 spend）");
    }
    return outputs;
  }

  async function requireTask(taskId: string): Promise<ForumPublishTask> {
    const task = await deps.repository.readTask(taskId);
    if (task === undefined) throw new ForumProtocolError("unknown-task", `发布任务 ${taskId} 不存在`);
    return task;
  }

  async function requireConfig(configId: string): Promise<ForumConfig> {
    const config = await deps.repository.readConfig(configId);
    if (config === undefined) throw new ForumTrustError("unknown-config", `论坛配置 ${configId} 不存在`);
    return config;
  }

}

async function signOperator(
  task: ForumPublishTask,
  port: SigningPort,
  context: { parentTxid: string; parentPublicKeyHex: string; replyMasterSeedHash?: string; tipPrice: string },
): Promise<Uint8Array> {
  if (task.kind === "changetip") {
    return signChangeTipOperatorObject(
      { kind: "bsv8.changetip.1", parentTxid: hexToBytes(context.parentTxid), tipPrice: forumAmountToBigInt(context.tipPrice) ?? 0n },
      port,
      sha256Digest,
    );
  }
  const seedHash = context.replyMasterSeedHash ?? task.replyMasterSeedHash;
  if (seedHash === undefined) throw new ForumProtocolError("seed-hash", "reply 缺少已冻结正文 hash");
  return signReplyOperatorObject(
    {
      kind: "bsv8.reply.1",
      parentTxid: hexToBytes(context.parentTxid),
      parentPublicKey: hexToBytes(context.parentPublicKeyHex),
      replyMasterSeedHash: hexToBytes(seedHash),
      tipPrice: forumAmountToBigInt(context.tipPrice) ?? 0n,
    },
    port,
    sha256Digest,
  );
}

function parseQuote(result: Record<string, unknown>, kind: "reply" | "changetip"): ForumQuoteSnapshot {
  const fields: ForumQuoteFields = {
    payToPublicKeyHex: readString(result.payto_publickey, "payto_publickey"),
    indexPrice: readAmount(result.index_price, "index_price"),
    lastBlockHeight: readAmount(result.last_block_height, "last_block_height"),
    indexSigHex: readHex(result.indexSig, "indexSig"),
  };
  // parent_tip_price 只在 quote_reply 响应里；changetip 没有这个字段。
  const parentTipPrice = kind === "reply" && result.parent_tip_price !== undefined
    ? readAmount(result.parent_tip_price, "parent_tip_price")
    : undefined;
  if (!/^(02|03)[0-9a-f]{64}$/u.test(fields.payToPublicKeyHex)) {
    throw new ForumResultShapeError("payto_publickey 必须是 33 字节压缩公钥");
  }
  return {
    ...fields,
    ...(parentTipPrice === undefined ? {} : { parentTipPrice }),
    quotedAtMs: Date.now(),
  };
}

/**
 * 广播状态映射。
 *
 * 拒绝与丢弃是各自的终态，不能都折成「已观测未确认」——那会让界面显示一笔从未
 * 被网络接受的交易。`not-dispatched` 是唯一可以释放输入的状态。
 */
function mapBroadcastState(status: string): ForumPublishTask["broadcastState"] {
  switch (status) {
    case "broadcast-pending-woc":
    case "woc-observed-unconfirmed":
      return "observed-unconfirmed";
    case "woc-confirmed":
      return "observed-confirmed";
    case "not-dispatched":
      return "definitely-not-dispatched";
    case "woc-dropped":
    case "rejected":
    case "provider-inconsistent":
      return "not-dispatched";
    default:
      // unknown 不是失败，也不能据此判定未广播。
      return "unknown";
  }
}

function emptyNode(): ForumReadingView["node"] {
  // 阅读视图在还没有节点上下文时使用占位节点；界面必须以 content 状态为准。
  return {
    txid: "",
    parentTxid: null,
    depth: 0,
    authorPublicKeyHex: "",
    replyMasterSeedHash: null,
    tipPrice: "0",
    confirmedTipPrice: "0",
    effectiveTipPrice: "0",
    status: "mempool",
    blockHeight: null,
    blockHash: null,
    txIndex: null,
    vout: 0,
    hasChildren: false,
  };
}

function toForumContentStatus(status: MsFileContentStatus): ForumContentStatus {
  const state =
    status.state === "absent"
      ? "not-fetched"
      : status.state === "verified"
        ? "verified"
        : status.state === "fetching"
          ? "fetching"
          : status.state === "partial"
            ? "partial"
            : status.state === "unreachable"
              ? "unreachable"
              : "verification-failed";
  return {
    seedHashHex: status.seedHashHex,
    state,
    localCopy: status.localCopy,
    ...(status.verifiedBytes === undefined ? {} : { verifiedBytes: status.verifiedBytes }),
    ...(status.failureCode === undefined ? {} : { failureCode: status.failureCode }),
  };
}

function normalizeConfig(config: ForumConfig): ForumConfig {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(config.id)) {
    throw new ForumTrustError("config-id", "配置 ID 必须是稳定的小写标识");
  }
  if (!/^(02|03)[0-9a-f]{64}$/u.test(config.forumPublicKeyHex)) {
    throw new ForumTrustError("forum-key", "论坛服务公钥必须是 33 字节压缩公钥");
  }
  if (!/^[0-9a-f]{64}$/u.test(config.forumTxid)) {
    throw new ForumTrustError("forum-txid", "创世根 txid 必须是 64 字符小写 hex");
  }
  const endpoints = config.endpoints.map((endpoint) => normalizeEndpoint(endpoint));
  if (endpoints.length === 0) throw new ForumTrustError("no-endpoint", "至少需要一个连接地址");
  return { ...config, forumPublicKeyHex: config.forumPublicKeyHex.toLowerCase(), endpoints };
}

/**
 * 校验一个 libp2p multiaddr。
 *
 * WSS 与 WebRTC Direct 的配置值必须是**完整 multiaddr**（`/dns4/…/tcp/443/wss`、
 * `/…/webrtc-direct/certhash/…/p2p/…`），不是 URL：`multiaddr()` 要求以 `/` 开头，
 * `wss://host` 会在拨号时被拒，而合法的 multiaddr 又过不了 URL 形态的校验——
 * 两个方向都不通。这里直接按 multiaddr 解析，并要求它确实带有所需的 transport、
 * `p2p` 分量以及（Direct 时的）certhash。
 */
function normalizeMultiaddrEndpoint(endpoint: ForumEndpointConfig, kind: "libp2p-wss" | "webrtc-direct"): ForumEndpointConfig {
  let parsed: ReturnType<typeof parseMultiaddr>;
  try {
    parsed = parseMultiaddr(endpoint.url);
  } catch (cause) {
    throw new ForumTrustError(
      "endpoint",
      `${kind} 地址必须是完整 multiaddr（以 / 开头），不是 URL：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const components = parsed.getComponents().map((component) => component.name);
  if (!components.includes("p2p")) {
    // 没有 p2p 分量就无法把远端身份 pin 到配置的论坛公钥。
    throw new ForumTrustError("endpoint", `${kind} multiaddr 必须带 /p2p/<PeerId> 分量`);
  }
  if (kind === "libp2p-wss") {
    if (!components.includes("wss")) {
      throw new ForumTrustError("endpoint", "libp2p-wss 地址必须带 /wss 分量");
    }
    if (components.includes("webrtc-direct")) {
      throw new ForumTrustError("endpoint", "WSS 与 WebRTC Direct 是不同 transport，不能混在同一个 multiaddr 里");
    }
    return { kind, url: parsed.toString() };
  }
  if (!components.includes("webrtc-direct")) {
    throw new ForumTrustError("endpoint", "WebRTC Direct 地址必须带 /webrtc-direct 分量");
  }
  if (!components.includes("certhash")) {
    // certhash 由部署提供；缺失时 SDK 无法做 Direct 认证，客户端不猜测。
    throw new ForumTrustError("endpoint", "WebRTC Direct multiaddr 必须带 /certhash/<u64> 分量");
  }
  return {
    kind,
    url: parsed.toString(),
    ...(endpoint.peerId === undefined ? {} : { peerId: endpoint.peerId }),
    ...(endpoint.certhash === undefined ? {} : { certhash: endpoint.certhash }),
  };
}

export function normalizeEndpoint(endpoint: ForumEndpointConfig): ForumEndpointConfig {
  if (endpoint.kind === "https") {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      throw new ForumTrustError("endpoint", `HTTPS 地址不合法：${endpoint.url}`);
    }
    // HTTPS 部署需要允许 Keymaster 来源的 CORS/OPTIONS；这里只做形状校验。
    if (url.protocol !== "https:") {
      throw new ForumTrustError("endpoint", "HTTPS 入口必须是 https:// 地址");
    }
    return { kind: "https", url: url.toString() };
  }
  if (endpoint.kind === "libp2p-wss") return normalizeMultiaddrEndpoint(endpoint, "libp2p-wss");
  return normalizeMultiaddrEndpoint(endpoint, "webrtc-direct");
}

function connectionKey(configId: string, endpoint: ForumEndpointConfig): string {
  return `${configId}|${endpoint.kind}|${endpoint.url}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * 读取已验证正文并组装展示视图。
 *
 * 只有 `verified` 状态会把正文交给 renderer；超限内容给出文件入口而不是截断；
 * 本地完整副本的阅读视图标记为 offline，界面据此把价格与索引状态标为缓存。
 */
async function readVerifiedReading(
  content: MsFileContentService,
  seedHashHex: string,
  options?: { signal?: AbortSignal },
): Promise<ForumReadingView> {
  // 只读本地已验证副本：列表与展开回复不应触发付费获取。
  const status = await content.openVerifiedContent(seedHashHex, options);
  if (status === undefined) {
    const current = await content.getContentStatus(seedHashHex);
    return {
      node: emptyNode(),
      content: toForumContentStatus(current),
      attachments: [],
      offline: false,
    };
  }
  const decoded = decodeForumMarkdown(status.bytes);
  const attachments = extractForumAttachments(decoded.markdown ?? "");
  const base: ForumReadingView = {
    node: emptyNode(),
    content: {
      seedHashHex,
      state: decoded.accepted ? "verified" : "verification-failed",
      verifiedBytes: status.byteLength,
      localCopy: true,
      ...(decoded.failureCode === undefined ? {} : { failureCode: decoded.failureCode }),
    },
    attachments,
    // 本地完整正文断网后仍可阅读，因此界面据此把价格与索引状态标为缓存。
    offline: true,
  };
  if (decoded.accepted && decoded.markdown !== undefined) {
    // 只有 verified 状态才把正文交给 renderer。
    return { ...base, markdown: decoded.markdown, projection: projectForumMarkdown(decoded.markdown, seedHashHex) };
  }
  if (decoded.oversize !== undefined) {
    // 超限内容保留索引并给出文件入口，不直接送入 renderer。
    return { ...base, oversize: decoded.oversize };
  }
  return base;
}

/** 费用确认项金额；找不到或非规范都 fail closed。 */
function findingOf(budget: ForumBudgetConfirmation | undefined, label: ForumFeeBreakdownItem["label"]): string | undefined {
  return budget?.items.find((item) => item.label === label)?.amountSatoshis;
}

/**
 * 钱包侧金额的安全整数闸门。
 *
 * 协议金额是 bigint，跨到 `ProtocolSpendOutput.value: number` 这一步是唯一允许的
 * 交叉点；越过 2^53-1 必须明确拒绝，而不是截断或隐式转换出一个用户没确认过的值。
 */
function requireSafeWalletSatoshis(value: bigint, label: string): number {
  if (value < 0n) throw new ForumProtocolError("amount", `${label} 不能为负数`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ForumProtocolError("amount-safe-integer", `${label} 超出钱包安全整数范围，拒绝截断`);
  }
  return Number(value);
}

interface DedicatedFunding {
  readonly txid: string;
  readonly vout: number;
  readonly rawTxHex: string;
  readonly availableSatoshis: bigint;
  readonly input: ProtocolSpendInput;
}

/**
 * 取（或准备）发布用的专用资金 UTXO。
 *
 * 专用资金是普通 P2PKH 资金准备交易产出的单输入 UTXO：准备交易本身可以找零，
 * 之后的协议交易只花这一个 UTXO，钱包的大额余额差不会直接变成矿工费。
 *
 * 关键约束：`ProtocolSpendService` 只使用调用方给的输入，自己不选币，所以这里
 * 必须提供一个真实存在、金额已知、且不是被保护输入的 UTXO。
 *
 * 额度必须等于本次报价下的「固定输出 + 确认的矿工费预算」：协议交易没有找零
 * 输出，拆多了的部分会直接变成矿工费。已有记录覆盖不了本次报价时作废并重备，
 * 被作废的 UTXO 同时解除保护登记，因此钱不会被锁死。
 */
async function ensureDedicatedFunding(
  task: ForumPublishTask,
  requiredSatoshis: bigint,
  sources: ForumFundingSource | undefined,
): Promise<DedicatedFunding> {
  if (sources === undefined) {
    throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法准备专用资金 UTXO");
  }
  // 1. 复查专用资金记录：额度够且未花费就直接用，避免每次发布都重新拆钱。
  //
  //    `readDedicatedFunding` 已经让 P2PKH 核对过链上状态并恢复保护登记：Forum 自己
  //    的记录不足以证明「这个 UTXO 还能花」，绕开核对就会拿已花费的输出继续构造。
  //    这里再比一次额度，是因为「够花」与「本次报价要多少」是两个问题。
  const existing = await sources.readDedicatedFunding(task.ownerPublicKeyHex, task.network, task.taskId, requiredSatoshis);
  if (existing !== undefined) {
    const spent = await sources.isSpent(task.network, existing.txid, existing.vout);
    const available = BigInt(existing.valueSatoshis);
    if (!spent && available >= requiredSatoshis) {
      return {
        txid: existing.txid,
        vout: existing.vout,
        rawTxHex: existing.rawTxHex,
        availableSatoshis: available,
        input: {
          txid: existing.txid,
          vout: existing.vout,
          value: requireSafeWalletSatoshis(available, "专用资金 UTXO 金额"),
          address: existing.address,
        },
      };
    }
    // 已被花费，或额度覆盖不了本次报价：作废记录并按新额度重新准备。
    await sources.clearDedicatedFunding(task.ownerPublicKeyHex, task.network, task.taskId);
  }

  // 2. 没有可用专用资金时，按本次报价的固定输出加矿工费预算准备一笔。
  const prepared = await sources.prepareDedicatedFunding({
    ownerPublicKeyHex: task.ownerPublicKeyHex,
    network: task.network,
    taskId: task.taskId,
    requiredSatoshis,
  });
  const value = BigInt(prepared.valueSatoshis);
  if (value < requiredSatoshis) {
    throw new ForumProtocolError(
      "funding-insufficient",
      `专用资金 ${value} sat 不足：本次发布需要 ${requiredSatoshis} sat`,
    );
  }
  return {
    txid: prepared.txid,
    vout: prepared.vout,
    rawTxHex: prepared.rawTxHex,
    availableSatoshis: value,
    input: {
      txid: prepared.txid,
      vout: prepared.vout,
      value: requireSafeWalletSatoshis(value, "专用资金 UTXO 金额"),
      address: prepared.address,
    },
  };
}

/** 专用资金记录；`ownerPublicKeyHex` 让恢复路径能拒绝别的身份的记录。 */
export interface ForumFundingRecord {
  readonly fundingId?: string;
  readonly txid: string;
  readonly vout: number;
  readonly rawTxHex: string;
  readonly valueSatoshis: string;
  readonly address: string;
  readonly ownerPublicKeyHex?: string;
}

/** 一次发布的资金计划：两笔交易的费用分别给出。 */
export interface ForumFundingPlan {
  /** 专用 UTXO 的目标金额 = 协议固定输出 + 协议矿工费预算。 */
  readonly requiredSatoshis: bigint;
  /** 资金准备交易自身的矿工费（聪）。 */
  readonly fundingMinerFeeSatoshis: bigint;
}

/**
 * 专用资金来源。
 *
 * 装配期注入：把「读专用资金 / 判断是否已花费 / 计划额度 / 准备新资金 / 作废记录」
 * 交给 P2PKH 与链数据源。Forum 不自己选币、不拼资金准备交易，也不接触私钥。
 */
export interface ForumFundingSource {
  /**
   * 读并核对专用资金记录。
   *
   * `requiredSatoshis` 让实现能在核对阶段就判断额度是否够：额度不足时返回 undefined，
   * 调用方因此不会拿一个不够用的 UTXO 去构造协议交易（那条路只会得到 funding-insufficient
   * 并反复重试同一笔旧资金）。
   */
  readDedicatedFunding(
    ownerPublicKeyHex: string,
    network: BsvNetwork,
    taskId: string,
    requiredSatoshis: bigint,
  ): Promise<ForumFundingRecord | undefined>;
  isSpent(network: BsvNetwork, txid: string, vout: number): Promise<boolean>;
  /**
   * 按本次报价算专用资金额度与资金准备矿工费。
   *
   * 单独给出是因为两笔交易的费用要同时进费用确认：额度只由固定输出与确认过的
   * 矿工费预算决定，不能用一个固定上界代替。
   */
  planDedicatedFunding(input: {
    readonly network: BsvNetwork;
    readonly fixedOutputsSatoshis: bigint;
    readonly protocolMinerFeeBudgetSatoshis: bigint;
    readonly feeRateSatoshisPerKb: number;
  }): Promise<ForumFundingPlan>;
  prepareDedicatedFunding(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    taskId: string;
    requiredSatoshis: bigint;
  }): Promise<ForumFundingRecord>;
  clearDedicatedFunding(ownerPublicKeyHex: string, network: BsvNetwork, taskId: string): Promise<void>;
  /**
   * 显式回收：把这笔专用资金扫回 owner 地址。
   *
   * 缺席表示该资金来源没有回收能力（例如不做 on-chain 观察的实现），此时调用方必须
   * 明确失败，不能假装「已经不需要这笔钱」。
   */
  recoverDedicatedFunding?(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    taskId: string;
    feeRateSatoshisPerKb: number;
    reason: { supersededBy: string } | { unused: true };
  }): Promise<{ txid: string; recoveredSatoshis: string }>;
  /** 按 outpoint 查这笔专用资金的链上状态。 */
  observeFunding(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    taskId: string;
    txid: string;
    vout: number;
  }): Promise<string>;
}

let fundingSources: (() => ForumFundingSource | undefined) | undefined;

export function setForumFundingSource(source: (() => ForumFundingSource | undefined) | undefined): void {
  fundingSources = source;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ForumResultShapeError(`${label} 必须是字符串`);
  return value;
}

function readHex(value: unknown, label: string): string {
  const text = readString(value, label);
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(text)) {
    throw new ForumResultShapeError(`${label} 必须是偶数长度的小写 hex`);
  }
  return text;
}

function readAmount(value: unknown, label: string): string {
  const text = readString(value, label);
  if (normalizeForumAmount(text) === undefined) {
    throw new ForumResultShapeError(`${label} 必须是规范十进制 uint64 字符串`);
  }
  return text;
}

function defaultRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export { createForumRepository, ForumListStore, forumRepositoryStorageOf };
const forumRepositoryStorageOf = undefined;