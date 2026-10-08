// Forum 索引领域客户端。
//
// 四种查询共用一个入口，因为它们是同一种形状：父节点标识 + 可选页大小 +
// 可选游标 + 可选快照高度，响应都是 `{parent_txid, snapshot_height,
// mempool_revision, items, next_cursor}`。
//
// 解析是严格的：字段缺失、类型不对、金额不是规范十进制字符串，都必须失败。
// 客户端不允许「尽力而为」地把半个响应读成可用数据——那会让界面展示一个服务端
// 并没有承诺过的视图。
//
// 游标纪律：游标绑定论坛、操作、父节点与页面世代；不解析、不修改、不跨父节点
// 复用。有 cursor 时不再传 snapshot_height。

import type {
  ForumErrorCode,
  ForumListOperation,
  ForumListPage,
  ForumListRequest,
  ForumNodeDetail,
  ForumNodeView,
  ForumRootVerification,
} from "@keymaster/contracts";
import { FORUM_PAGE_SIZE_DEFAULT, FORUM_PAGE_SIZE_MAX, forumAmountToBigInt } from "@keymaster/contracts";

import type { ForumArgs, ForumCallOutcome, ForumRoundtripClient } from "../network/roundtripClient.js";

/** 服务端业务错误。界面按 code 展示，不解析英文 message。 */
export class ForumBusinessError extends Error {
  readonly code: ForumErrorCode;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForumBusinessError";
    this.code = code as ForumErrorCode;
  }

  /** 视图失效：必须撤销该列表的旧请求并重新读第一页。 */
  get isSnapshotInvalidated(): boolean {
    return this.code === "SNAPSHOT_INVALIDATED";
  }

  /** 游标不可用：报错并清理该游标，不无限重试。 */
  get isCursorInvalid(): boolean {
    return this.code === "INVALID_CURSOR";
  }
}

/** 响应形状错误：服务端回了不该回的东西，不能当作空页。 */
export class ForumResultShapeError extends Error {
  readonly code = "result-shape";

  constructor(message: string) {
    super(message);
    this.name = "ForumResultShapeError";
  }
}

/** 列表请求的父字段名：每个操作按协议文档单独命名。 */
const PARENT_ARG: Readonly<Record<ForumListOperation, "forum_txid" | "board_txid" | "parent_txid">> = Object.freeze({
  list_boards: "forum_txid",
  list_posts: "board_txid",
  list_replies: "parent_txid",
});

/** 请求参数名与 `PARENT_ARG` 一一对应；服务端拒绝任何未知字段。 */
export function buildListArgs(input: ForumListRequest, operation: ForumListOperation): ForumArgs {
  const limit = Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= FORUM_PAGE_SIZE_MAX ? input.limit : FORUM_PAGE_SIZE_DEFAULT;
  const args: ForumArgs = { [PARENT_ARG[operation]]: input.parentTxid, limit };
  // 有 cursor 时不得再传 snapshot_height：服务端会把两者解释成互相矛盾的要求。
  if (input.cursor !== undefined) {
    args.cursor = input.cursor;
    return args;
  }
  if (input.snapshotHeight !== undefined && Number.isSafeInteger(input.snapshotHeight) && input.snapshotHeight >= 0) {
    args.snapshot_height = input.snapshotHeight;
  }
  return args;
}

export interface ForumIndexClientDeps {
  client: ForumRoundtripClient;
  /** 根验证证据；离线时用它标注缓存视图，不能当当前报价真值。 */
  root?(configId: string): ForumRootVerification | undefined;
}

/** 四种查询的统一领域入口。 */
export function createForumIndexClient(deps: ForumIndexClientDeps) {
  const call = async (op: string, args: ForumArgs, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const outcome: ForumCallOutcome = await deps.client.call({ op, args }, signal);
    if (outcome.ok) return outcome.result;
    throw new ForumBusinessError(outcome.error.code, outcome.error.message);
  };

  const list = async (operation: ForumListOperation, input: ForumListRequest): Promise<ForumListPage> => {
    const result = await call(operation, buildListArgs(input, operation), input.signal);
    return parsePage(operation, input, result);
  };

  return {
    listBoards: (input: ForumListRequest): Promise<ForumListPage> => list("list_boards", input),
    listPosts: (input: ForumListRequest): Promise<ForumListPage> => list("list_posts", input),
    listReplies: (input: ForumListRequest): Promise<ForumListPage> => list("list_replies", input),

    async getNode(configId: string, txid: string, options?: { signal?: AbortSignal }): Promise<ForumNodeDetail> {
      const result = await call("get_node", { txid }, options?.signal);
      const node = parseNode(result);
      const forum = deps.root?.(configId);
      return {
        ...node,
        forum,
        // 服务端没有单独的索引状态字段：返回了节点且 status 是 confirmed 就是已确认索引。
        indexState: node.status === "confirmed" ? "confirmed" : "mempool",
      };
    },
  };
}

/* ============== 严格解析 ============== */

export function parsePage(operation: ForumListOperation, request: ForumListRequest, result: Record<string, unknown>): ForumListPage {
  const parentTxid = requireHash(result.parent_txid, "parent_txid");
  if (parentTxid !== request.parentTxid) {
    // 服务端回的父必须与请求一致，否则这条页属于另一条列表。
    throw new ForumResultShapeError(`响应 parent_txid ${parentTxid} 与请求 ${request.parentTxid} 不一致`);
  }
  const snapshotHeight = requireNonNegativeInteger(result.snapshot_height, "snapshot_height");
  const mempoolRevision = requireNonNegativeInteger(result.mempool_revision, "mempool_revision");
  const rawItems = result.items;
  if (!Array.isArray(rawItems)) throw new ForumResultShapeError("响应 items 必须是数组");
  const items = rawItems.map((item, index) => parseNode(asRecord(item, `items[${index}]`)));
  const nextCursor = parseNextCursor(result.next_cursor);
  return { forumTxid: request.forumTxid, operation, parentTxid, snapshotHeight, mempoolRevision, items, nextCursor };
}

function parseNextCursor(value: unknown): string | null {
  // 游标是字符串或显式 null，不能是缺失：客户端要能区分「读完」与「服务端忘了给」。
  if (value === null) return null;
  if (typeof value !== "string") throw new ForumResultShapeError("next_cursor 必须是字符串或 null");
  return value;
}

export function parseNode(value: Record<string, unknown>): ForumNodeView {
  const record = value;
  const status = requireString(record.status, "status");
  if (status !== "confirmed" && status !== "mempool") {
    throw new ForumResultShapeError(`status 必须是 confirmed 或 mempool，实际 ${status}`);
  }
  const node: ForumNodeView = {
    txid: requireHash(record.txid, "txid"),
    parentTxid: record.parent_txid === null ? null : requireHash(record.parent_txid, "parent_txid"),
    depth: requireNonNegativeInteger(record.depth, "depth"),
    authorPublicKeyHex: requirePublicKey(record.author_publickey, "author_publickey"),
    replyMasterSeedHash:
      record.reply_masterseedhash === null ? null : requireHash(record.reply_masterseedhash, "reply_masterseedhash"),
    tipPrice: requireAmount(record.tip_price, "tip_price"),
    confirmedTipPrice: requireAmount(record.confirmed_tip_price, "confirmed_tip_price"),
    effectiveTipPrice: requireAmount(record.effective_tip_price, "effective_tip_price"),
    status,
    blockHeight: record.block_height === null ? null : requireNonNegativeInteger(record.block_height, "block_height"),
    blockHash: record.block_hash === null ? null : requireHash(record.block_hash, "block_hash"),
    txIndex: record.tx_index === null ? null : requireNonNegativeInteger(record.tx_index, "tx_index"),
    vout: requireNonNegativeInteger(record.vout, "vout"),
    hasChildren: requireBoolean(record.has_children, "has_children"),
  };
  // forum_name 只在根节点出现；回复节点没有论坛名，编造一个就成了第二份真值。
  if (typeof record.forum_name === "string") {
    return { ...node, forumName: record.forum_name };
  }
  return node;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ForumResultShapeError(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ForumResultShapeError(`${label} 必须是字符串`);
  return value;
}

function requireHash(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new ForumResultShapeError(`${label} 必须是 64 字符小写 hex`);
  return text;
}

function requirePublicKey(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^(02|03)[0-9a-f]{64}$/u.test(text)) throw new ForumResultShapeError(`${label} 必须是 33 字节压缩公钥`);
  return text;
}

function requireAmount(value: unknown, label: string): string {
  const text = requireString(value, label);
  // 金额必须是规范十进制字符串；服务端不会发 JSON number，收到就说明对端不对。
  if (forumAmountToBigInt(text) === undefined) {
    throw new ForumResultShapeError(`${label} 必须是规范十进制 uint64 字符串，实际 ${text}`);
  }
  return text;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ForumResultShapeError(`${label} 必须是布尔值`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ForumResultShapeError(`${label} 必须是安全整数`);
  }
  return value;
}

/**
 * 高度、序号与游标类字段还必须非负。
 *
 * 服务端不会发负数；收到负数说明对端不是这一版协议，界面拿它排序会得到一个
 * 「比创世还早」的块，所以这里直接失败而不是渲染出来。
 */
function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requireSafeInteger(value, label);
  if (parsed < 0) throw new ForumResultShapeError(`${label} 不能为负数，实际 ${parsed}`);
  return parsed;
}