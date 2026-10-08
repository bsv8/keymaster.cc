// Forum 的 Worker 侧入口。
//
// 这个版本的 Forum 只在 Window 运行单元里装配，所以这里不导出装配代码、UI
// 或任何 Window 私有实现；它只提供 Worker 可能需要的纯逻辑（协议编解码、
// 领域解析、分页纪律、发布协议计算），以便未来的 Worker 单元或集成测试在
// 不把浏览器依赖带进 Worker 模块图的前提下复用同一份实现。
//
// 具体不放进这个入口的东西：manifest / setup / UI / 仓储 / lane / 传输。
// Worker 模块图必须保持轻量，Node HTTP server 适配依赖不能进入浏览器入口。

export * from "./protocol/bytes.js";
export * from "./protocol/cbor.js";
export * from "./protocol/crypto.js";
export * from "./protocol/layout.js";
export * from "./protocol/script.js";
export * from "./protocol/signatureObjects.js";
export * from "./protocol/transaction.js";
export { buildListArgs, createForumIndexClient, ForumBusinessError, ForumResultShapeError, parseNode, parsePage } from "./domain/indexClient.js";
export { ForumListStore, listNeedsManualRefresh } from "./domain/listStore.js";
export { FORUM_SERVER_BASELINE, ForumTrustError, rootEvidenceIsUsable, verifyForumRoot } from "./domain/rootTrust.js";
export {
  buildFeeBreakdown,
  buildForumProtocolOutputs,
  estimateMinerFeeBudget,
  FORUM_MAX_INPUT_SIGNATURE_BYTES,
  ForumProtocolError,
  planForumFunding,
  reconcileMinerFee,
  totalFeeSatoshis,
  verifyChangeTipQuote,
  verifyFinalRaw,
  verifyReplyQuote,
} from "./publish/forumProtocol.js";
export {
  decodeForumMarkdown,
  extractForumAttachments,
  MARKDOWN_PARSER_VERSION,
  normalizeForumMarkdownForPublish,
  projectForumMarkdown,
  renderForumMarkdown,
} from "./markdown/markdown.js";