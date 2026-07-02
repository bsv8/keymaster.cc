// packages/contracts/src/appmsg.ts
// 应用消息总线（appmsg）契约。
//
// 设计缘由（施工单 2026-07-01 002 硬切换）：
//   - Keymaster 对外协议新增 `appmsg.send` / `appmsg.list` / `appmsg.get`；
//   - 外部 app 与内部插件共用同一条收件地址模型：
//       AppMsgAddress = ownerPublicKeyHex + endpoint
//   - endpoint 第二维隔离真值；不允许"只按 owner"做 inbox。
//   - 收件地址两种 kind：
//       * "origin"：id = exact origin（scheme + host + port，端口不可丢）。
//       * "plugin"：id = 稳定 pluginEndpointId。
//   - 字段命名：**不**叫 `keyId`（已被 Vault 私钥句柄占用）；
//     **不**要求等于 manifest.id；要求全局唯一。
//   - v1 只支持 `text/plain` 与 `text/markdown`；不做未读计数、已读回执、
//     群聊、附件、撤回、跨节点 session 恢复。
//   - 对外实时提示仅 `appmsg.inbox_dirty`（dirty event）；
//     完整消息正文真值来自 `appmsg.list` / `appmsg.get`。
//   - 本文件**只**放地址 / 内容类型 / 单条消息视图 / 内部 event 形状 /
//     capability 接口；对外"方法 + 入参与结果"在 `protocol.ts` 收口
//     （带 `connectSessionId`）。两者字段同源，避免重复定义。

/** 应用消息端点的 kind。v1 仅允许 origin 与 plugin 两种。 */
export type AppMsgEndpointKind = "origin" | "plugin";

/**
 * 应用消息端点（地址模型的第二维）。
 *
 * 关键约束（施工单 2026-07-01 002）：
 *   - `kind = "origin"` 时 `id` = exact origin（scheme + host + port），
 *     port **不可**省略，**不**做 host-only 归一化，**不**做"443 可省略"
 *     平台二次归一化。
 *   - `kind = "plugin"` 时 `id` = 稳定 `pluginEndpointId`，必须全局唯一。
 *   - 不允许存在第三种 `kind`。
 */
export interface AppMsgEndpoint {
  kind: AppMsgEndpointKind;
  id: string;
}

/**
 * 统一应用消息收件地址（单真值：owner + endpoint）。
 *
 * 关键约束：
 *   - `ownerPublicKeyHex` 仍是 owner 根身份真值（与 connect session 同源）；
 *   - endpoint 是第二维隔离真值，没有这一维就不允许实现 inbox；
 *   - sender 与 recipient **都**使用本结构（不允许"只有 owner 没有 endpoint"
 *     的消息记录）。
 */
export interface AppMsgAddress {
  ownerPublicKeyHex: string;
  endpoint: AppMsgEndpoint;
}

/** v1 支持的消息正文内容类型。 */
export type AppMsgContentType = "text/plain" | "text/markdown";

/** `appmsg.list` 的 box。 */
export type AppMsgListBox = "inbox" | "sent" | "all";

/**
 * 一条应用消息的对外视图。
 *
 * 关键约束：
 *   - sender 与 recipient 都是完整地址（含 endpoint），与 HubMsg 服务端
 *     主表 `app_messages` 的字段一一对应；
 *   - `clientMessageId` 是调用方幂等键；
 *   - `body` 是明文 / markdown 字符串；v1 不做端到端加密。
 */
export interface AppMsgMessage {
  /** HubMsg 服务端主键；客户端不可伪造，由 `message.send` 返回。 */
  messageId: string;
  /** 调用方幂等键。 */
  clientMessageId: string;
  /** sender 完整地址。 */
  sender: AppMsgAddress;
  /** recipient 完整地址。 */
  recipient: AppMsgAddress;
  /** 正文内容类型。 */
  contentType: AppMsgContentType;
  /** 正文。v1 不做加密。 */
  body: string;
  /** 客户端声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 服务端入库时间（unix milliseconds）；`message.list` / `message.get` 返回。 */
  insertedAtMs: number;
}

/**
 * 对外 `appmsg.inbox_dirty` event payload。
 *
 * 关键约束：
 *   - v1 对外 event 只推送 dirty hint（owner + endpoint + atMs），
 *     **不**携带完整消息正文；
 *   - 接收方按 `ownerPublicKeyHex + endpoint` 识别 dirty box，
 *     然后调 `appmsg.list` 拉正文；
 *   - 推送给"当前 exact origin 对应 endpoint"的 caller；其它 endpoint
 *     收不到自己的 dirty 事件（也不应该收）。
 */
export interface AppMsgInboxDirtyEvent {
  ownerPublicKeyHex: string;
  endpoint: AppMsgEndpoint;
  /** dirty 提示时间（unix milliseconds）；不保证递增，仅作为去重 / 排序参考。 */
  atMs: number;
}

/**
 * 内部 `appmsg.message_received` event payload（仅给平台真值层使用）。
 *
 * 关键约束：
 *   - 该 event **不**对外暴露，只在内部 `appmsg.core` 与 `appmsg.client`
 *     之间、以及插件 host 的 plugin context 注入使用；
 *   - 完整消息正文先落本地缓存（`appmsg.core`），再决定是否对外推
 *     `appmsg.inbox_dirty`。
 */
export interface AppMsgMessageReceivedEvent {
  message: AppMsgMessage;
}

/**
 * `appmsg.list` 成功结果。
 *
 * 设计缘由：与 `protocol.ts` 的对外 `AppMsgListResult` 同字段；本形状
 * 是平台内部 / 插件侧复用版本（无 connectSessionId）。
 */
export interface AppMsgListResult {
  items: AppMsgMessage[];
  /** 当前 box 还有更多记录。 */
  hasMore: boolean;
}

/** `appmsg.send` 成功结果。 */
export interface AppMsgSendResult {
  messageId: string;
  createdAtMs: number;
}

/**
 * 内部 `appmsg.list` 入参形状（不含 connectSessionId）。
 *
 * 设计缘由：平台内部 / 插件侧调 `appmsg.core.list` / `appmsg.client.list`
 * 时不需要 sessionId（sender 由 core 用当前 bind owner 投影）；
 * 真正的对外形状（带 connectSessionId）见 `protocol.ts` 的
 * `AppMsgListParams`。
 */
export interface AppMsgListInternalParams {
  box: AppMsgListBox;
  afterMessageId?: string;
  beforeMessageId?: string;
  limit?: number;
}

/** appmsg 平台能力（单 WSS 连接 + 缓存 + 推送真值）的 capability key。 */
export const APPMESSAGE_CORE_CAPABILITY = "appmsg.core";

/**
 * appmsg 面向插件的 scoped client capability key。
 *
 * 关键约束：
 *   - 仅当插件 manifest 声明了 `appMessageEndpoint.endpointId` 时，
 *     host 才会把对应 scoped client 注入 `ctx.get(APPMESSAGE_CLIENT_CAPABILITY)`；
 *   - 未声明 endpoint 的插件 `ctx.get` 应抛错（fail-closed）。
 *   - scoped client 的 `senderEndpoint = { kind: "plugin", id: <pluginEndpointId> }`，
 *     插件**不**允许自报 sender endpoint。
 */
export const APPMESSAGE_CLIENT_CAPABILITY = "appmsg.client";

/**
 * 平台 `appmsg.core` 内部接口。
 *
 * 关键约束（施工单 2026-07-01/002 共同冻结 + 003 对齐）：
 *   - 由 `packages/plugin-appmsg` 内部实现，是 HubMsg WSS 连接 + 本地
 *     缓存 + 推送分发的唯一真值；
 *   - `protocolService` 是**外部 app** 的协议适配层，仅消费此接口，
 *     **不**直接持有 HubMsg 连接；
 *   - 连接 owner-bound，endpoint 随业务请求自带（`list / get` 用
 *     `scope: AppMsgAddress`；`send` 用 `sender: AppMsgAddress`）；
 *   - 服务端按 `scope` 做 ACL：仅当 `(scope.owner, scope.endpoint)`
 *     匹配 sender 或 recipient 之一时返回；其它 endpoint 看不到；
 *   - `connectForOwner(ownerPublicKeyHex)` / `disconnect()` 由 plugin-appmsg
 *     在 owner 切换 / vault 锁状态变化时驱动（不需要外部调用方手动维护）。
 *   - `messageId` 全链路 string：DB int64，wire string；调用方**不**应
 *     期待 number 类型。
 */
export interface AppMsgCore {
  /** connect 当前 owner。幂等。 */
  connectForOwner(ownerPublicKeyHex: string): Promise<void>;

  /** 关闭连接；幂等。 */
  disconnect(): Promise<void>;

  /**
   * 列 inbox / sent。`scope` 是"当前调用方的地址身份"，服务端用它
   * 做 ACL：仅返回 sender 或 recipient 侧匹配 `scope` 的 message。
   */
  list(input: {
    scope: AppMsgAddress;
    params: AppMsgListInternalParams;
  }): Promise<AppMsgListResult>;

  /** 单条取消息。`scope` 同 list 的语义。 */
  get(input: {
    scope: AppMsgAddress;
    messageId: string;
  }): Promise<AppMsgMessage | null>;

  /** 发消息；服务端落库后回 `messageId`。sender 由调用方提供完整地址。 */
  send(input: {
    sender: AppMsgAddress;
    recipientOwnerPublicKeyHex: string;
    recipientEndpoint: AppMsgEndpoint;
    contentType: AppMsgContentType;
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): Promise<AppMsgSendResult>;

  /** 订阅对端推送的 inbox dirty 事件（不暴露完整消息正文）。 */
  subscribeInboxDirty(
    handler: (event: AppMsgInboxDirtyEvent) => void
  ): () => void;

  /** 内部订阅：服务端推送的完整消息（先落缓存、再对外推 dirty）。 */
  subscribeMessageReceived(
    handler: (event: AppMsgMessageReceivedEvent) => void
  ): () => void;
}

/**
 * 面向插件的 scoped `appmsg.client` 接口。
 *
 * 关键约束：
 *   - 注入到插件 `ctx` 时，sender endpoint 已经固定为插件 manifest 声明的
 *     `pluginEndpointId`；插件只传 recipient / body / contentType。
 *   - 插件**不**允许自报 sender endpoint；**不**允许传 sender。
 *   - 返回完整消息 list / get 的对象**不**包含 sender 全字段（sender 是
 *     自己，便于 UI 渲染）。
 */
export interface AppMsgPluginClient {
  /** 插件 sender endpoint id；UI 展示 / 调试用。 */
  readonly endpointId: string;

  /** 以插件身份列自己 endpoint 的 inbox / sent。 */
  list(input: {
    box: AppMsgListBox;
    afterMessageId?: string;
    beforeMessageId?: string;
    limit?: number;
  }): Promise<AppMsgListResult>;

  /** 以插件身份单条取消息。 */
  get(messageId: string): Promise<AppMsgMessage | null>;

  /** 以插件身份发消息；recipient 与正文由插件提供。 */
  send(input: {
    recipientOwnerPublicKeyHex: string;
    recipientEndpoint: AppMsgEndpoint;
    contentType: AppMsgContentType;
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): Promise<AppMsgSendResult>;

  /** 订阅对端推送的 inbox dirty 事件（按自己 endpoint 过滤）。 */
  subscribeInboxDirty(handler: (event: AppMsgInboxDirtyEvent) => void): () => void;
}

/**
 * scoped client 注入由 `packages/runtime/src/createPluginHost.ts` 在
 * enable 阶段直接完成：声明了 `appMessageEndpoint.endpointId` 的插件
 * 在 enable 成功后，host 把 sender 已绑定的 `AppMsgPluginClient` 注入到
 * `<pluginId>.appmsg.client`。插件作者最终体验是"声明 endpoint →
 * 拿到 scoped client"，**不**再走"全局工厂 + 手动 forEndpoint()"的
 * 中间形态。
 *
 * 工厂类型已在施工单 2026-07-01/003 落地后从 contracts 删去
 * （避免插件作者把它当全局 capability 误用）。
 */

/**
 * 在用户视角判断 pluginEndpointId 字段命名的有效性。
 *
 * 关键约束（施工单 2026-07-01 002 第 6 节）：
 *   - **不**允许叫 `keyId` / `keyid`（与 Vault 私钥句柄语义冲突）；
 *   - **不**要求等于 manifest id；
 *   - 要求在同 Keymaster 安装内全局唯一；
 *   - runtime 在 register 阶段做唯一性校验，冲突即 fail-closed。
 */
export function isValidPluginEndpointIdShape(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.length > 128) return false;
  // 限制为 portable subset：小写字母 / 数字 / 下划线 / 点；
  // 必须以字母开头；不允许连续点；不允许以点结尾。
  // 与 HubMsg 服务端 pluginEndpointIDRE 保持一致语义。
  const re = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
  return re.test(id);
}

/**
 * 在用户视角判断 exact origin 字段命名的有效性。
 *
 * 关键约束（施工单 2026-07-01 002 第 4.2 节）：
 *   - port 是 origin 的一部分；
 *   - 不做 host-only 归一化；
 *   - 不做"443 可省略"二次归一化。
 */
export function isValidExactOriginShape(origin: string): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  // scheme + host + ":" + port
  const re = /^(https?):\/\/([^/:]+):(\d+)$/;
  return re.test(origin);
}