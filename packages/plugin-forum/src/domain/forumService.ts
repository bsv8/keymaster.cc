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
import { createForumRepository, type ForumRepository, type ForumIndexCacheEntry } from "../storage/forumRepository.js";
import {
  buildFeeBreakdown,
  buildForumProtocolOutputs,
  ForumProtocolError,
  planForumFunding,
  reconcileMinerFee,
  totalFeeSatoshis,
  verifyChangeTipQuote,
  verifyFinalRaw,
  verifyReplyQuote,
  type ForumQuoteFields,
} from "../publish/forumProtocol.js";
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
  "funding-prepared": ["quote-rechecked", "raw-prepared"],
  "quote-rechecked": ["raw-prepared"],
  // raw-prepared 之后可以先记 broadcast-dispatched，也可以直接进入对账或等待索引：
  // 派发与首次观测在同一次调用里完成，中间态不一定被单独持久化。
  "raw-prepared": ["broadcast-dispatched", "reconciling", "awaiting-index", "failed"],
  "broadcast-dispatched": ["reconciling", "awaiting-index"],
  reconciling: ["awaiting-index", "indexed-mempool", "indexed-confirmed", "reconciling", "failed"],
  "awaiting-index": ["indexed-mempool", "indexed-confirmed", "reconciling"],
  "indexed-mempool": ["indexed-confirmed", "reconciling"],
  "indexed-confirmed": ["reconciling"],
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

export function createForumService(deps: ForumServiceDeps): ForumService {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? defaultRandomId;
  const connections = new Map<string, Connection>();
  /**
   * 每个发布任务一把互斥锁。
   *
   * 这是「多页不重复发布」的落点：所有会推进任务阶段的入口都在同一把锁里重新读取
   * 任务，因此第二个页面看到的一定是第一个页面已经写入的阶段与 submissionId，
   * 从而落到对账而不是重新构造。锁只在进程内——同一浏览器多个标签页各自持有
   * 一个 Window 实例，跨标签的互斥仍然要靠持久 submission 对账兜底。
   */
  const taskLocks = new Map<string, Promise<unknown>>();
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
          const result = await crypto.signDigest({ publicKeyHex: ownerPublicKeyHex, digest: toArrayBuffer(digest), format: "der" });
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
    const client = createForumRoundtripClient({
      signer,
      transport,
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
        await persistCache(config, input, page).catch(() => undefined);
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
      void configId;
      // 冻结即归一化：统一 LF、去掉 BOM。发布后原始字节不再改动。
      const bytes = normalizeForumMarkdownForPublish(markdown);
      if (bytes.byteLength > FORUM_MARKDOWN_MAX_BYTES) {
        throw new ForumProtocolError("markdown-oversize", `正文 ${bytes.byteLength} 字节超过 ${FORUM_MARKDOWN_MAX_BYTES} 字节上限`);
      }
      const imported = await deps.content.importContent({
        bytes,
        fileName: "post.md",
        mediaType: "text/markdown; charset=utf-8",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { seedHashHex: imported.seedHashHex, bytes: imported.byteLength };
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
      const config = await requireConfig(task.forumConfigId);
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
      const updated: ForumPublishTask = {
        ...task,
        operatorSigHex: bytesToHex(operatorSig),
        phase: "signed",
        updatedAtMs: now(),
      };
      await deps.repository.writeTask(updated);

      const connection = await connectionFor(config);
      const op = task.kind === "reply" ? "quote_reply" : "quote_changetip";
      const args: Record<string, string> =
        task.kind === "reply"
          ? {
              kind: "bsv8.reply.1",
              parent_txid: parent.txid,
              parent_publickey: parent.authorPublicKeyHex,
              reply_masterseedhash: updated.replyMasterSeedHash as string,
              tip_price: task.tipPrice,
              operatorSig: updated.operatorSigHex as string,
            }
          : {
              kind: "bsv8.changetip.1",
              parent_txid: parent.txid,
              tip_price: task.tipPrice,
              operatorSig: updated.operatorSigHex as string,
            };
      const outcome = await connection.client.call({ op, args }, options?.signal);
      assertFresh(epoch, ownerPublicKeyHex);
      if (!outcome.ok) {
        throw new ForumBusinessError(outcome.error.code, outcome.error.message);
      }
      const quote = parseQuote(outcome.result, task.kind);
      // 广播前复核：客户端自己用将要上链的输出重建并验证 indexSig。
      if (task.kind === "reply") {
        verifyReplyQuote({
          forumPublicKeyHex: task.forumPublicKeyHex,
          parentTxid: parent.txid,
          parentPublicKeyHex: parent.authorPublicKeyHex,
          replyMasterSeedHash: updated.replyMasterSeedHash as string,
          tipPrice: task.tipPrice,
          operatorSigHex: updated.operatorSigHex as string,
          clientPublicKeyHex: ownerPublicKeyHex,
          quote,
        });
      } else {
        verifyChangeTipQuote({
          forumPublicKeyHex: task.forumPublicKeyHex,
          parentTxid: parent.txid,
          tipPrice: task.tipPrice,
          operatorSigHex: updated.operatorSigHex as string,
          clientPublicKeyHex: ownerPublicKeyHex,
          quote,
        });
      }
      assertPhaseAdvance(updated.phase, "quoted");
      const quoted: ForumPublishTask = { ...updated, quote, phase: "quoted", updatedAtMs: now() };
      await deps.repository.writeTask(quoted);
      return quoted;
      });
    },

    async confirmBudget(taskId: string): Promise<ForumBudgetConfirmation> {
      return withTaskLock(taskId, async (task) => {
      if (task.submissionId !== undefined) {
        // 已经派发：费用确认不再有意义，避免界面把预算改到一笔已广播的交易上。
        throw new ForumProtocolError("already-dispatched", "交易已派发，不能再确认费用");
      }
      const quote = task.quote;
      if (quote === undefined) throw new ForumProtocolError("no-quote", "任务还没有报价");
      const funding = task.funding;
      const minerFee = estimateProtocolMinerFee(task, funding);
      const items: ForumFeeBreakdownItem[] = buildFeeBreakdown({
        kind: task.kind,
        indexPrice: quote.indexPrice,
        ...(quote.parentTipPrice === undefined ? {} : { parentTipPrice: quote.parentTipPrice }),
        protocolMinerFee: minerFee.toString(),
        ...(funding === undefined ? {} : { fundingMinerFee: "0" }),
      });
      const budget: ForumBudgetConfirmation = {
        version: (task.budget?.version ?? 0) + 1,
        items,
        totalSatoshis: totalFeeSatoshis(items),
        confirmedAtMs: now(),
      };
      assertPhaseAdvance(task.phase, "budget-confirmed");
      await deps.repository.writeTask({ ...task, budget, phase: "budget-confirmed", updatedAtMs: now() });
      return budget;
      });
    },

    async buildAndSubmit(taskId: string, options): Promise<ForumPublishTask> {
      return withTaskLock(taskId, async (task) => {
      // 锁内重读：另一个页面可能已经派发或已经失败。
      if (task.submissionId !== undefined) return reconcileTask(taskId, options);
      if (task.phase === "failed") {
        throw new ForumProtocolError("task-failed", "该发布任务已处于失败状态，不能重新派发");
      }
      if (task.budget === undefined) throw new ForumProtocolError("no-budget", "费用尚未确认");
      if (task.quote === undefined) throw new ForumProtocolError("no-quote", "任务还没有报价");
      const spend = deps.protocolSpend();
      if (spend === undefined) {
        throw new ForumProtocolError("no-funding", "P2PKH 协议资金能力不可用，无法发布");
      }
      const parent = await getNodeFor(task.forumConfigId, task.targetTxid, options);
      const funding = await ensureDedicatedFunding(task, options);

      // 1. 先按固定输出布局构建无找零交易。
      const outputs = buildForumProtocolOutputs({
        kind: task.kind,
        parentTxidHex: parent.txid,
        parentPublicKeyHex: parent.authorPublicKeyHex,
        ...(task.replyMasterSeedHash === undefined ? {} : { replyMasterSeedHashHex: task.replyMasterSeedHash }),
        tipPrice: forumAmountToBigInt(task.tipPrice) ?? 0n,
        operatorSig: hexToBytes(task.operatorSigHex as string),
        lastBlockHeight: forumAmountToBigInt(task.quote.lastBlockHeight) ?? 0n,
        indexSig: hexToBytes(task.quote.indexSigHex),
        clientPublicKeyHex: task.ownerPublicKeyHex,
        quote: task.quote,
        ...(task.quote.parentTipPrice === undefined ? {} : { parentTipPriceSatoshis: forumAmountToBigInt(task.quote.parentTipPrice) ?? 0n }),
      });
      const fixedOutputsSatoshis = outputs.reduce((total, output) => total + output.value, 0n);

      // 2. 专用资金必须覆盖固定输出 + 用户确认的矿工费预算；差额只在预算内成为矿工费。
      const minerFeeBudgetSatoshis = forumAmountToBigInt(findingOf(task.budget, "protocol-miner-fee")) ?? 0n;
      const plan = planForumFunding({
        availableSatoshis: funding.availableSatoshis,
        fixedOutputsSatoshis,
        maxMinerFeeSatoshis: minerFeeBudgetSatoshis,
        feeRateSatoshisPerKb: 1,
      });

      // 3. prepare 只构造并签名，不派发；这一步结束仍未产生不可逆副作用。
      const preview = await spend.prepare({
        ownerPublicKeyHex: task.ownerPublicKeyHex,
        requestingPluginId: "forum",
        network: task.network,
        // 只花专用资金 UTXO；钱包大额余额差不会直接变成矿工费。
        inputs: [funding.input],
        outputs: outputs.map((output, index) => ({
          // 钱包侧用 number 表示金额：越过安全整数必须明确拒绝而不是截断。
          value: requireSafeWalletSatoshis(output.value, `forum-vout-${index}`),
          scriptHex: bytesToHex(output.lockingScript),
          label: `forum-vout-${index}`,
        })),
        feeRateSatoshisPerKb: 1,
        // 不提供 changeAddress：协议交易没有找零输出。
      });

      // 4. 广播前复核：raw 自己就是证据，从它重建并验签、核对输出数与费用。
      const rawBytes = protocolHexToBytes(preview.rawTxHex);
      verifyFinalRaw({
        forumPublicKeyHex: task.forumPublicKeyHex,
        kind: task.kind,
        rawTxBytes: rawBytes,
        expectedTxid: preview.txid,
      });
      parseTransaction(rawBytes, sha256Digest);
      const actualFee = reconcileMinerFee({
        totalInputSatoshis: funding.availableSatoshis,
        outputs: outputs.map((output) => ({ value: output.value, lockingScript: output.lockingScript })),
        serializedSizeBytes: rawTxHexByteLength(preview.rawTxHex),
        feeRateSatoshisPerKb: 1,
        maxMinerFeeSatoshis: minerFeeBudgetSatoshis > 0n ? minerFeeBudgetSatoshis : plan.minerFeeBudgetSatoshis,
      });
      // prepare 报告的是 number；跨回协议金额前先确认没有越过安全整数。
      const reportedFee = BigInt(requireSafeWalletSatoshis(BigInt(preview.estimatedFeeSatoshis), "prepare 报告的矿工费"));
      if (actualFee.actualMinerFeeSatoshis !== reportedFee) {
        throw new ForumProtocolError(
          "fee-evidence",
          `从 raw 复算的矿工费 ${actualFee.actualMinerFeeSatoshis} 与 prepare 报告的 ${reportedFee} 不一致`,
        );
      }

      // 5. 派发前把提交编号、raw 与 txid 落盘。不可逆动作之前必须有证据，
      //    否则广播成功后响应丢失就会没有任何可对账的东西。
      assertPhaseAdvance(task.phase, "raw-prepared");
      const prepared: ForumPublishTask = {
        ...task,
        funding: { txid: funding.txid, vout: funding.input.vout, rawTxHex: funding.rawTxHex },
        submissionId: preview.submissionId,
        finalRawTxHex: preview.rawTxHex,
        txid: preview.txid,
        broadcastState: "not-dispatched",
        phase: "raw-prepared",
        updatedAtMs: now(),
      };
      await deps.repository.writeTask(prepared);

      // 6. 才派发。
      const result = await spend.submit(preview);
      const dispatched: ForumPublishTask = {
        ...prepared,
        broadcastState: mapBroadcastState(result.status),
        phase: result.status === "unknown" ? "reconciling" : "awaiting-index",
        updatedAtMs: now(),
      };
      assertPhaseAdvance("raw-prepared", dispatched.phase === "reconciling" ? "reconciling" : "awaiting-index");
      await deps.repository.writeTask(dispatched);
      // 7. 派发后立即对账原提交，让链上与索引状态有第一份观测。
      return reconcileTask(taskId, options);
      });
    },

    reconcile: (taskId, options) => reconcileTask(taskId, options),

    async cancelUndispatched(taskId: string): Promise<void> {
      const task = await requireTask(taskId);
      if (task.broadcastState === "dispatched" || task.broadcastState === "unknown") {
        // 已派发或未知的输入不得提前释放，否则可能双花同一笔资金。
        throw new ForumProtocolError("not-cancellable", "交易已派发或结果未知，不能释放输入占用");
      }
      const spend = deps.protocolSpend();
      if (spend?.releasePreparedSubmission !== undefined && task.submissionId !== undefined && task.txid !== undefined) {
        await spend.releasePreparedSubmission({
          ownerPublicKeyHex: task.ownerPublicKeyHex,
          network: task.network,
          txid: task.txid,
          submissionId: task.submissionId,
        });
      }
      await deps.repository.writeTask({ ...task, phase: "failed", failureCode: "cancelled", updatedAtMs: now() });
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

function estimateProtocolMinerFee(task: ForumPublishTask, funding: ForumPublishTask["funding"]): bigint {
  void funding;
  const budget = task.budget;
  if (budget === undefined) return 0n;
  const item = budget.items.find((candidate) => candidate.label === "protocol-miner-fee");
  return forumAmountToBigInt(item?.amountSatoshis ?? "0") ?? 0n;
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
 */
async function ensureDedicatedFunding(task: ForumPublishTask, options?: { signal?: AbortSignal }): Promise<DedicatedFunding> {
  const sources = fundingSources?.();
  if (sources === undefined) {
    throw new ForumProtocolError("funding-unavailable", "没有可用的资金来源，无法准备专用资金 UTXO");
  }
  // 1. 复查专用资金记录：已有可用 UTXO 就直接用，避免每次发布都重新拆钱。
  const existing = await sources.readDedicatedFunding(task.ownerPublicKeyHex, task.network, task.taskId);
  if (existing !== undefined) {
    const spent = await sources.isSpent(task.network, existing.txid, existing.vout);
    if (!spent) {
      return {
        txid: existing.txid,
        vout: existing.vout,
        rawTxHex: existing.rawTxHex,
        availableSatoshis: BigInt(existing.valueSatoshis),
        input: {
          txid: existing.txid,
          vout: existing.vout,
          value: requireSafeWalletSatoshis(BigInt(existing.valueSatoshis), "专用资金 UTXO 金额"),
          address: existing.address,
        },
      };
    }
    // 记录指向的 UTXO 已被花费：作废记录并重新准备。
    await sources.clearDedicatedFunding(task.ownerPublicKeyHex, task.network, task.taskId);
  }

  // 2. 没有可用专用资金时，按固定输出加矿工费预算从钱包准备一笔。
  //    论坛此时的固定输出总额尚未确定（要先拿到父节点价格），因此这里只确保
  //    一笔足以覆盖最小 publish 的专用资金，真正的额度复核在调用方完成。
  const requiredSatoshis = sources.minimumDedicatedFundingSatoshis(task.network);
  const prepared = await sources.prepareDedicatedFunding({
    ownerPublicKeyHex: task.ownerPublicKeyHex,
    network: task.network,
    taskId: task.taskId,
    requiredSatoshis,
  });
  return {
    txid: prepared.txid,
    vout: prepared.vout,
    rawTxHex: prepared.rawTxHex,
    availableSatoshis: BigInt(prepared.valueSatoshis),
    input: {
      txid: prepared.txid,
      vout: prepared.vout,
      value: requireSafeWalletSatoshis(BigInt(prepared.valueSatoshis), "专用资金 UTXO 金额"),
      address: prepared.address,
    },
  };
}

/**
 * 专用资金来源。
 *
 * 装配期注入：把「读专用资金 / 判断是否已花费 / 准备新资金 / 作废记录」交给
 * P2PKH 与链数据源。Forum 不自己选币、不拼资金准备交易，也不接触私钥。
 */
export interface ForumFundingSource {
  readDedicatedFunding(
    ownerPublicKeyHex: string,
    network: BsvNetwork,
    taskId: string,
  ): Promise<{ txid: string; vout: number; rawTxHex: string; valueSatoshis: string; address: string } | undefined>;
  isSpent(network: BsvNetwork, txid: string, vout: number): Promise<boolean>;
  prepareDedicatedFunding(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    taskId: string;
    requiredSatoshis: bigint;
  }): Promise<{ txid: string; vout: number; rawTxHex: string; valueSatoshis: string; address: string }>;
  clearDedicatedFunding(ownerPublicKeyHex: string, network: BsvNetwork, taskId: string): Promise<void>;
  /** 按 outpoint 查这笔专用资金的链上状态。 */
  observeFunding(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    taskId: string;
    txid: string;
    vout: number;
  }): Promise<string>;
  /** 单次发布的最小专用资金额度：固定输出上界加矿工费预算。 */
  minimumDedicatedFundingSatoshis(network: BsvNetwork): bigint;
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