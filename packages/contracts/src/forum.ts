// packages/contracts/src/forum.ts
// Forum 客户端领域契约；人类可读说明见 docs/Forum.md。
//
// 设计缘由：
//   - Forum 只持有索引、阅读位置与发布任务，不复制正文、不保存 HTML 渲染结果；
//   - 正文与附件一律由 MSFile 获取、验证并统一存放，Forum 只持有 seed hash；
//   - 签名能力来自 Vault 的受控 active key，Forum 不取得私钥；
//   - 资金与广播来自 P2PKH 的协议 spend，Forum 不自己拼交易广播路径；
//   - 所有金额按接口约定使用规范十进制字符串，内部计算用 bigint；
//   - 本文件只允许类型、字面量常量与无依赖纯函数。

import { defineCapability } from "webloom-framework";

import type { BsvNetwork } from "./vault.js";

/* ============== 身份、信任与配置 ============== */

/** 三种真实入口。WSS 是 libp2p transport，不是普通 WebSocket JSON。 */
export type ForumEndpointKind = "https" | "libp2p-wss" | "webrtc-direct";

/** libp2p protocol ID；与 roundtrip SDK 的常量一致。 */
export const FORUM_PROTOCOL_ID = "/roundtrip/1";
/** HTTPS 入口路径；操作只来自已签名的 body.op。 */
export const FORUM_HTTP_PATH = "/roundtrip";

export interface ForumEndpointConfig {
  readonly kind: ForumEndpointKind;
  /** https 与 wss 使用完整 URL；Direct 使用部署给出的完整 multiaddr。 */
  readonly url: string;
  /** Direct 部署的 PeerId；与论坛服务公钥必须对应。 */
  readonly peerId?: string;
  /** WebRTC Direct 的 certhash；由部署配置提供，客户端不猜测。 */
  readonly certhash?: string;
}

export interface ForumConfig {
  /** 本地稳定配置 ID，不参与协议。 */
  readonly id: string;
  readonly label: string;
  readonly network: BsvNetwork;
  /** 固定创世根 txid；后续论坛声明不替换此 ID。 */
  readonly forumTxid: string;
  /** 配置的论坛服务公钥；用于响应与 indexSig 验证。 */
  readonly forumPublicKeyHex: string;
  readonly endpoints: readonly ForumEndpointConfig[];
}

/** 根验证证据。保存它是为了让「信任锚何时、基于哪个 raw、由谁签名」可复查。 */
export interface ForumRootVerification {
  /** 证据所属的本地配置；同一个根可以被多个配置引用。 */
  readonly configId: string;
  readonly forumTxid: string;
  /** 首次下载的根 raw；不重新编码、不改变字节。 */
  readonly rawTxHex: string;
  readonly forumName: string;
  /** 声明的初始回复价，规范十进制字符串。 */
  readonly tipPrice: string;
  readonly forumPublicKeyHex: string;
  /** vout 0 的收款公钥；必须与 forumPublicKeyHex 相同。 */
  readonly payToPublicKeyHex: string;
  readonly verifiedAtMs: number;
  /** 服务端协议基线版本，写进证据以便协议升级后重新核对。 */
  readonly baseline: string;
}

/* ============== 索引视图 ============== */

export type ForumNodeStatus = "confirmed" | "mempool";

/**
 * 一个索引节点的视图。
 *
 * 三个价格含义不同，界面必须分别展示：初始价是节点自带的未来回复价，
 * 确认价只含已确认事件，生效价还包含内存池事件。
 */
export interface ForumNodeView {
  readonly txid: string;
  readonly parentTxid: string | null;
  readonly depth: number;
  readonly authorPublicKeyHex: string;
  readonly replyMasterSeedHash: string | null;
  readonly tipPrice: string;
  readonly confirmedTipPrice: string;
  readonly effectiveTipPrice: string;
  readonly status: ForumNodeStatus;
  readonly blockHeight: number | null;
  readonly blockHash: string | null;
  readonly txIndex: number | null;
  readonly vout: number;
  readonly hasChildren: boolean;
  /** 仅根节点有值。 */
  readonly forumName?: string;
}

export interface ForumNodeDetail extends ForumNodeView {
  readonly forum: ForumRootVerification | undefined;
  /** 服务端当前观察到的索引状态；离线缓存必须标注为缓存。 */
  readonly indexState: "confirmed" | "mempool" | "unknown";
}

export interface ForumListPage {
  readonly forumTxid: string;
  readonly operation: ForumListOperation;
  readonly parentTxid: string;
  /** 列表确认部分的快照高度。 */
  readonly snapshotHeight: number;
  /** 内存池视图版本；变化说明内存池视图已经换代。 */
  readonly mempoolRevision: number;
  /** 严格保留服务端顺序；客户端不按本地时间重排。 */
  readonly items: readonly ForumNodeView[];
  /** null 表示当前视图已读完；末页不表示未来不会出现新回复。 */
  readonly nextCursor: string | null;
}

export type ForumListOperation = "list_boards" | "list_posts" | "list_replies";

/** 页大小：默认 20，上限 100，与服务端一致。 */
export const FORUM_PAGE_SIZE_DEFAULT = 20;
export const FORUM_PAGE_SIZE_MAX = 100;

export interface ForumListRequest {
  readonly configId: string;
  readonly operation: ForumListOperation;
  readonly forumTxid: string;
  readonly parentTxid: string;
  readonly limit: number;
  /** 有 cursor 时不得再传 snapshot_height。 */
  readonly cursor?: string;
  readonly snapshotHeight?: number;
  readonly signal?: AbortSignal;
}

/** 服务端业务错误码全集；客户端按 code 展示，不解析英文 message。 */
export type ForumErrorCode =
  | "INVALID_ARGS"
  | "INVALID_SIGNATURE"
  | "NOT_AUTHOR"
  | "NODE_NOT_FOUND"
  | "INVALID_PARENT"
  | "INVALID_LIMIT"
  | "INVALID_CURSOR"
  | "SNAPSHOT_INVALIDATED"
  | "INVALID_SNAPSHOT"
  | "HANDLER_FAILED";

/** 视图失效：旧请求必须撤销并重新读第一页，整组页被替换。 */
export interface ForumSnapshotInvalidated {
  readonly code: "SNAPSHOT_INVALIDATED";
  readonly operation: ForumListOperation;
  readonly parentTxid: string;
}

/* ============== 正文状态与投影 ============== */

/**
 * 正文状态。索引失败与正文失败分别展示：正文不可达时仍显示节点与回复结构。
 *
 * `verified` 是唯一可以送入 Markdown renderer 的状态；`partial` 也不允许，
 * 不完整文件不能作为已验证的完整 Markdown 返回。
 */
export type ForumContentState =
  | "not-fetched"
  | "fetching"
  | "partial"
  | "verified"
  | "unreachable"
  | "verification-failed";

/** 正文附件引用：`msfile:<64 字符小写 seedhash>`。这是客户端内容约定，不改变链上协议。 */
export const FORUM_ATTACHMENT_SCHEME = "msfile:";

export interface ForumContentStatus {
  readonly seedHashHex: string;
  readonly state: ForumContentState;
  /** 已验证的完整字节数；只有 verified 状态有值。 */
  readonly verifiedBytes?: string;
  /** 展示用的稳定失败码，例如 MSFile 的错误码。 */
  readonly failureCode?: string;
  /** 本地已有完整正文，因此离线可读；界面据此标注「缓存」。 */
  readonly localCopy: boolean;
}

/** 标题/摘要投影。必须绑定内容 hash 与解析版本，可重建，不作为内容真值。 */
export interface ForumContentProjection {
  readonly seedHashHex: string;
  readonly title: string;
  readonly summary: string;
  /** 解析版本；解析规则变化时投影失效而不是被复用。 */
  readonly parserVersion: number;
  readonly bytes: string;
}

export interface ForumReadingView {
  readonly node: ForumNodeView;
  readonly content: ForumContentStatus;
  readonly projection?: ForumContentProjection;
  /** 仅 verified 状态有值：已验证的 UTF-8 正文。 */
  readonly markdown?: string;
  /** 超限时给出文件入口，正文不送入 renderer。 */
  readonly oversize?: { readonly bytes: string; readonly limitBytes: string };
  readonly attachments: readonly ForumAttachmentRef[];
  /** 正文来自本地副本，展示的价格与索引状态必须标为缓存。 */
  readonly offline: boolean;
}

export interface ForumAttachmentRef {
  readonly seedHashHex: string;
  /** 正文中出现的原始写法，便于界面展示失败位置。 */
  readonly reference: string;
  readonly state: ForumContentState;
  /** 附件价格与大小限制由 MSFile 执行，Forum 不复制策略。 */
  readonly failureCode?: string;
}

/** 正文上限：1 MiB（正文文件，不含附件）。 */
export const FORUM_MARKDOWN_MAX_BYTES = 1024 * 1024;
/** 投影版本；解析规则变化时递增，旧投影随之失效。 */
export const FORUM_MARKDOWN_PARSER_VERSION = 1;

/* ============== 发布 ============== */

export type ForumPublishKind = "reply" | "changetip";

export type ForumPublishPhase =
  | "draft"
  | "content-frozen"
  | "signed"
  | "quoted"
  | "budget-confirmed"
  | "funding-prepared"
  | "quote-rechecked"
  | "raw-prepared"
  | "broadcast-dispatched"
  | "reconciling"
  | "awaiting-index"
  | "indexed-mempool"
  | "indexed-confirmed"
  | "failed";

/** 报价快照。`parentTipPrice` 必须来自本次关联响应，不混用缓存初始价。 */
export interface ForumQuoteSnapshot {
  readonly payToPublicKeyHex: string;
  readonly indexPrice: string;
  readonly lastBlockHeight: string;
  readonly parentTipPrice?: string;
  readonly indexSigHex: string;
  readonly quotedAtMs: number;
}

/** 费用确认项。每一项都必须能被用户读懂来源。 */
export interface ForumFeeBreakdownItem {
  readonly label:
    | "content-acquisition"
    | "content-publication"
    | "funding-miner-fee"
    | "index-price"
    | "parent-author-tip"
    | "protocol-miner-fee";
  /** 规范十进制字符串。 */
  readonly amountSatoshis: string;
  /** 该项的证据来源说明；未知来源不得编造金额。 */
  readonly detail: string;
}

export interface ForumBudgetConfirmation {
  readonly version: number;
  readonly items: readonly ForumFeeBreakdownItem[];
  readonly totalSatoshis: string;
  readonly confirmedAtMs: number;
}

/** 广播状态。未知不是失败，也不允许据此判定未广播。 */
export type ForumBroadcastState =
  | "not-dispatched"
  | "dispatched"
  | "observed-unconfirmed"
  | "observed-confirmed"
  | "unknown"
  | "definitely-not-dispatched";

/** 链上观测：钱包侧看到确认不等于 Forum 已确认索引。 */
export interface ForumChainObservation {
  readonly state: "unknown" | "mempool" | "confirmed" | "absent";
  readonly blockHeight?: number;
  readonly observedAtMs: number;
}

/** 索引观测。changetip 不是节点，不能用 get_node(changetip txid) 判定成功。 */
export interface ForumIndexObservation {
  readonly state: "unknown" | "mempool" | "confirmed";
  /**
   * changetip 专用的限制标记：当前接口不能精确证明某一修改事件被接受，
   * 只能展示链上证据加目标节点当前价格视图。
   */
  readonly eventAcceptanceQueryable: boolean;
  readonly observedAtMs: number;
}

/**
 * 发布任务记录。
 *
 * 不持久化私钥、签名 capability、lease、运行句柄，也不把旧 connectSession
 * 当恢复授权；raw/hash 一律原样保存，不经重新编码。
 */
export interface ForumPublishTask {
  readonly taskId: string;
  /** 任务创建时的 owner；恢复后不得用当前身份直接提交旧 raw。 */
  readonly ownerPublicKeyHex: string;
  readonly network: BsvNetwork;
  readonly forumConfigId: string;
  readonly forumTxid: string;
  readonly forumPublicKeyHex: string;
  readonly kind: ForumPublishKind;
  /** reply 是父节点 txid；changetip 是被改价节点 txid。 */
  readonly targetTxid: string;
  /** 冻结后的正文只存 hash，正文本体在 MSFile。 */
  readonly replyMasterSeedHash?: string;
  /** 新节点自己的未来回复价。 */
  readonly tipPrice: string;
  readonly operatorSigHex?: string;
  readonly quote?: ForumQuoteSnapshot;
  readonly budget?: ForumBudgetConfirmation;
  /** 资金准备交易与专用 UTXO outpoint。 */
  readonly funding?: { readonly txid: string; readonly vout: number; readonly rawTxHex: string };
  /** P2PKH 持久化的协议提交 ID；恢复只引用它，不引用页面内存的 operation ID。 */
  readonly submissionId?: string;
  readonly finalRawTxHex?: string;
  readonly txid?: string;
  readonly broadcastState: ForumBroadcastState;
  readonly chainObservation: ForumChainObservation;
  readonly indexObservation: ForumIndexObservation;
  readonly phase: ForumPublishPhase;
  /** 可判定错误；不可判定的情形写进 phase 而不是编造原因。 */
  readonly failureCode?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ForumPublishDraft {
  readonly kind: ForumPublishKind;
  readonly targetTxid: string;
  /** 未冻结的正文草稿可以存在 Forum；冻结后只保留 hash。 */
  readonly markdown?: string;
  readonly tipPrice: string;
}

/* ============== Capability ============== */

export interface ForumService {
  /* 配置与信任 */
  listConfigs(): Promise<readonly ForumConfig[]>;
  getConfig(configId: string): Promise<ForumConfig | undefined>;
  saveConfig(config: ForumConfig): Promise<void>;
  removeConfig(configId: string): Promise<void>;
  /**
   * 下载根 raw，核对 txid、固定输出结构与 forumSig，检查两个输出都点名配置的
   * 论坛公钥；成功才保存验证证据。forumSig 从当前声明的名称、价格与全部
   * input outpoint 顺序重建，采用当前四项数组规则，拒绝旧三项形式。
   */
  verifyRoot(configId: string, options?: { signal?: AbortSignal }): Promise<ForumRootVerification>;
  getRootVerification(configId: string): Promise<ForumRootVerification | undefined>;

  /* 索引浏览 */
  listBoards(input: ForumListRequest): Promise<ForumListPage>;
  listPosts(input: ForumListRequest): Promise<ForumListPage>;
  listReplies(input: ForumListRequest): Promise<ForumListPage>;
  getNode(configId: string, txid: string, options?: { signal?: AbortSignal }): Promise<ForumNodeDetail>;

  /* 阅读 */
  /** 请求 MSFile 内容任务；同 hash 的并发请求由 MSFile 合并。 */
  ensureContent(configId: string, seedHashHex: string, options?: { signal?: AbortSignal }): Promise<ForumContentStatus>;
  /** 读取已验证正文；只有 verified 状态返回 markdown。只走本地优先路径。 */
  readContent(configId: string, seedHashHex: string, options?: { signal?: AbortSignal }): Promise<ForumReadingView>;
  /**
   * 用户明确「阅读」时调用：先请求 MSFile 获取再读已验证正文。
   *
   * 这是唯一允许为正文付费的入口；列表浏览与展开回复只走 readContent。
   */
  openAndFetch(configId: string, seedHashHex: string, options?: { signal?: AbortSignal }): Promise<ForumReadingView>;
  /** 读取一个附件；附件失败不阻塞正文。 */
  readAttachment(configId: string, seedHashHex: string, options?: { signal?: AbortSignal }): Promise<ForumContentStatus>;

  /* 发布 */
  /** 冻结正文到 MSFile 并返回其 seed hash。 */
  freezeContent(configId: string, markdown: string, options?: { signal?: AbortSignal }): Promise<{ readonly seedHashHex: string; readonly bytes: string }>;
  /** 结构化 operatorSig：Worker 内重建规范字节，页面不能提交任意 digest。 */
  preparePublish(input: ForumPublishPrepareInput): Promise<ForumPublishTask>;
  /** 取报价并验 indexSig；parent_tip_price 从本次响应取得。 */
  quotePublish(taskId: string, options?: { signal?: AbortSignal }): Promise<ForumPublishTask>;
  /** 展示费用项并记录用户确认的预算版本。 */
  confirmBudget(taskId: string): Promise<ForumBudgetConfirmation>;
  /** 资金准备后重新询价并构建无找零 raw。 */
  buildAndSubmit(taskId: string, options?: { signal?: AbortSignal }): Promise<ForumPublishTask>;
  /** 广播未知时对账原交易，不自动构建重复付款。 */
  reconcile(taskId: string, options?: { signal?: AbortSignal }): Promise<ForumPublishTask>;
  /** 只释放明确未派发的输入占用；未知或已派发不得调用。 */
  cancelUndispatched(taskId: string): Promise<void>;
  listPublishTasks(configId?: string): Promise<readonly ForumPublishTask[]>;
  getPublishTask(taskId: string): Promise<ForumPublishTask | undefined>;
}

export interface ForumPublishPrepareInput {
  readonly configId: string;
  readonly kind: ForumPublishKind;
  readonly targetTxid: string;
  readonly markdown?: string;
  readonly tipPrice: string;
  /** 已冻结的正文 hash；与 markdown 二选一。 */
  readonly replyMasterSeedHash?: string;
  readonly signal?: AbortSignal;
}

export const FORUM_SERVICE_CAPABILITY = defineCapability<ForumService>({
  kind: "local",
  id: "forum.service",
  version: "1",
});

/* ============== 无依赖纯函数 ============== */

/**
 * 解析规范十进制 uint64 字符串。
 *
 * 规则与服务端 `parseCanonicalUint` 一致：只接受无前导零的十进制正整数，
 * 范围 `0..2^64-1`。JSON number 形式一律拒绝：a number 是 double，价格到 2^53
 * 以上会在不同解析器里变成不同的值。
 */
export function normalizeForumAmount(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(input)) return undefined;
  if (BigInt(input) > 0xffffffffffffffffn) return undefined;
  return input;
}

/** 金额字符串转 bigint；非规范输入 fail closed，不截断也不隐式转换。 */
export function forumAmountToBigInt(input: unknown): bigint | undefined {
  const normalized = normalizeForumAmount(input);
  return normalized === undefined ? undefined : BigInt(normalized);
}

/**
 * 校验安全整数形式的金额。
 *
 * 现有钱包用 JS number 表示金额，超出安全整数时必须明确拒绝，而不是截断或
 * 隐式转换；这条边界是协议金额与钱包数值之间唯一允许的交叉点。
 */
export function isSafeForumWalletAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** `msfile:<seedhash>` 附件引用的严格解析。 */
export function parseForumAttachmentReference(reference: string): string | undefined {
  if (!reference.startsWith(FORUM_ATTACHMENT_SCHEME)) return undefined;
  const seedHashHex = reference.slice(FORUM_ATTACHMENT_SCHEME.length);
  return /^[0-9a-f]{64}$/u.test(seedHashHex) ? seedHashHex : undefined;
}

/** 页大小规范化；越界与非整数一律拒绝，让调用方回落到默认值。 */
export function normalizeForumPageSize(value: unknown): number {
  if (!Number.isSafeInteger(value)) return FORUM_PAGE_SIZE_DEFAULT;
  const size = value as number;
  return size >= 1 && size <= FORUM_PAGE_SIZE_MAX ? size : FORUM_PAGE_SIZE_DEFAULT;
}