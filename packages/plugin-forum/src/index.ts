// Forum 插件的 Window 公开入口。
//
// 导出协议编解码、领域客户端、分页状态机与根信任验证，供其它插件与集成测试
// 复用；私有仓储与 UI 不从这里出去。

export { forumPlugin, forumSetup, FORUM_PLUGIN_ID } from "./manifest.js";
export { forumResources } from "./resources.js";

/* 协议层：确定性 CBOR、脚本、签名对象、交易布局。 */
export * from "./protocol/bytes.js";
export * from "./protocol/cbor.js";
export * from "./protocol/crypto.js";
export * from "./protocol/layout.js";
export * from "./protocol/script.js";
export * from "./protocol/signatureObjects.js";
export * from "./protocol/transaction.js";
export {
  CBOR_BOUNDARY_INTEGERS,
  CBOR_MAX_UINT64_VECTOR,
  CBOR_NON_CANONICAL_VECTORS,
  FORUM_INPUTS_VECTOR,
  FORUM_OBJECT_VECTOR,
  FORUM_SIGNATURE_VECTOR,
  MINIMAL_UINT_VECTORS,
} from "./protocol/vectors.js";

/* 网络层。 */
export { createForumRoundtripClient, createHttpsTransport, createLibp2pTransport, createVaultRoundtripSigner, ForumIdentityError, ForumResponseShapeError, ForumTransportError } from "./network/roundtripClient.js";
export { FORUM_LANE_ID, ForumP2pLane } from "./network/forumP2pLane.js";

/* 领域层。 */
export { buildListArgs, createForumIndexClient, ForumBusinessError, ForumResultShapeError, parseNode, parsePage } from "./domain/indexClient.js";
export { ForumListStore, listNeedsManualRefresh } from "./domain/listStore.js";
export { createForumService } from "./domain/forumService.js";
export { FORUM_SERVER_BASELINE, ForumTrustError, rootEvidenceIsUsable, verifyForumRoot } from "./domain/rootTrust.js";

/* 正文与 Markdown。 */
export {
  decodeForumMarkdown,
  extractForumAttachments,
  FORUM_ALLOWED_LINK_PROTOCOLS,
  MARKDOWN_PARSER_VERSION,
  mergeAttachmentStates,
  normalizeForumMarkdownForPublish,
  projectForumMarkdown,
  renderForumMarkdown,
} from "./markdown/markdown.js";

/* 发布协议。 */
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