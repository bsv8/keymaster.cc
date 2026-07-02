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

/* ============== 施工单 2026-07-02 001：appmsg 系统级诊断 ============== */

/**
 * `appmsg.core.inspectConnection()` 返回的连接快照。
 *
 * 设计缘由（施工单 2026-07-02 001）：
 *   - 这是系统页（`/system/messages`）唯一读到的"连接真值"；UI 用它
 *     展示状态 / owner / URL / 最近一次成功 bind 时间 / 最近一次错误
 *     / 最近一次收到消息时间。
 *   - 同步返回；不允许做"重连后取数"等隐式行为。
 *   - 锁定态（vault locked / 无 active key）下也允许读：state 会
 *     显示 `disconnected` / `no_owner`，但其它字段（url、lastError）
 *     仍可展示。
 */
export interface AppMsgConnectionSnapshot {
  /** 当前 connection state：与 `HubMsgConnectionState` 同语义。 */
  state: "idle" | "connecting" | "bound" | "closed";
  /** 当前绑定 owner；未 bind 时为 null。 */
  ownerPublicKeyHex: string | null;
  /** HubMsg WSS URL（从 `AppMsgCoreConfig.url` 投影；与运行时一致）。 */
  url: string;
  /** 最近一次成功 bind 时间（unix ms；0 = 从未 bind）。 */
  lastBoundAtMs: number;
  /** 最近一次 bind / connect / receive 错误 message（无错误时为 null）。 */
  lastError: string | null;
  /** 最近一次收到 push 消息的时间（unix ms；0 = 从未收到）。 */
  lastReceivedAtMs: number;
}

/**
 * 单个 channel（origin / plugin endpoint）的消息数量。
 *
 * 设计缘由（施工单 2026-07-02 001）：
 *   - 这是 HubMsg `message.counts` 内部 RPC 的内部投影形状。
 *   - `inbox` = 当前 owner 收到的、`recipientEndpoint` 匹配该 channel
 *     的消息数；`sent` = 当前 owner 发出的、`senderEndpoint` 匹配该
 *     channel 的消息数；`all = inbox + sent`。
 *   - self-send（sender == recipient）既计入 inbox 也计入 sent——
 *     与 HubMsg 服务端语义一致。
 *   - **不**包含任何 message body / markdown / 私钥相关字段。
 */
export interface AppMsgChannelCount {
  /** inbox 数量。 */
  inbox: number;
  /** sent 数量。 */
  sent: number;
  /** all 数量（= inbox + sent）。 */
  all: number;
}

/**
 * `appmsg.core.countScopes()` 返回的每 scope 计数结果。
 *
 * 设计缘由（施工单 2026-07-02 001）：
 *   - 内部 UI 读方法；**不**对外暴露给第三方 app。
 *   - 任何 scope 整体调用失败时 `error` 字段非空，`counts` 为 null；
 *     单 scope 内的部分失败不细化（按"全成功 / 全失败"两态上报）。
 *   - 单次调用中 scopes 之间相互独立：一个 scope 失败不影响其它。
 */
export interface AppMsgChannelCountBox {
  /** 该 scope 对应的完整地址（owner + endpoint）。 */
  scope: AppMsgAddress;
  /** 数量；`error` 非空时为 null。 */
  counts: AppMsgChannelCount | null;
  /** 错误 message（成功时为 null）。 */
  error: string | null;
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
 *   - `createPluginScopedClient(endpointId)` 由 runtime host 在 enable
 *     阶段调用；返回 sender endpoint 已绑定的 `AppMsgPluginClient`。
 *     runtime **不**直接 import `plugin-appmsg`——避免循环依赖；
 *     工厂形态收口在 `AppMsgCore` 接口里。
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

  /**
   * runtime host 在 enable 阶段调用：产出一个 sender endpoint
   * 已绑定到 `endpointId` 的 scoped `appmsg.client`。
   *
   * 设计缘由（施工单 2026-07-01/003）：
   *   - runtime **不**直接 import plugin-appmsg（避免循环依赖）；
   *     通过 contracts 的 `AppMsgCore.createPluginScopedClient` 间接
   *     拿 scoped client。
   *   - endpointId 必须在调用前由 runtime 完成 `isValidPluginEndpointIdShape`
   *     + 全局唯一性校验；这里**不**再二次校验。
   *   - 返回的 client 的 `endpointId` 字段就是传入的 endpointId，
   *     插件作者拿到的最终形态是"声明 endpoint → 拿到 scoped client"。
   *   - 同时，**内部**把 `endpointId` 登记到 plugin endpoint 注册表
   *     （`listKnownPluginEndpoints()` 的真值），供系统页渲染
   *     "plugin 渠道" 行。
   */
  createPluginScopedClient(endpointId: string): AppMsgPluginClient;

  /* ============== 施工单 2026-07-02 001：系统级诊断内部方法 ============== */

  /**
   * best-effort reconnect（系统页手动刷新用）。
   *
   * 当前已 bound 时 no-op；未 bound 但有 current owner 时尝试一次
   * `connectForOwner(currentBoundOwner)`；失败时记录 `lastError`。
   * 失败时**不**抛错——best-effort。
   *
   * 之所以存在：系统页手动刷新要走这条路径（**不**直接调
   * `connectForOwner`），才能让 `appmsg.reconnect.begin / .failed`
   * 落到 `/settings/logs`，否则验收项 8.1 的 reconnect 日志会失配。
   */
  reconnectIfNeeded(): Promise<void>;

  /**
   * 同步读当前连接快照。
   *
   * 边界：
   *   - **不**重连、不抛错；任何状态下都能读。
   *   - 锁定 / 无 active key 时 `state = "idle"`,`ownerPublicKeyHex = null`,
   *     `lastError` 仍可能保留上一次失败信息。
   *   - 内部仅供平台 UI（系统页 `AppMsgSystemPage`）使用；
   *     **不**通过 capability 暴露给第三方 app。
   */
  inspectConnection(): AppMsgConnectionSnapshot;

  /**
   * 同步列出已通过 `createPluginScopedClient(endpointId)` 登记过的
   * plugin 端点 id。
   *
   * 边界：
   *   - 这是 plugin 渠道目录的**唯一**真值：仅当一个插件 manifest
   *     声明了 `appMessageEndpoint.endpointId` 并被 host enable
   *     后，id 才会出现在这里。
   *   - **不**包含 origin 渠道；origin 渠道通过
   *     `listKnownOrigins()` 从 HubMsg 取真值。
   *   - 顺序无保证；UI 自己按需排序。
   *   - 内部仅供平台 UI 使用；**不**对外暴露。
   */
  listKnownPluginEndpoints(): string[];

  /**
   * 同步拉取当前 owner 在 HubMsg 中已知 origin 列表。
   *
   * 边界：
   *   - 这是 origin 渠道目录的真值；与 `listKnownPluginEndpoints()`
   *     互补。
   *   - 底层调 HubMsg `message.origins` 内部 RPC；连接断开 /
   *     无 owner 时 reject。
   *   - 内部仅供平台 UI 使用；**不**对外暴露给第三方 app。
   */
  listKnownOrigins(): Promise<string[]>;

  /**
   * 批量取若干 scope 的 `inbox / sent / all` 计数。
   *
   * 边界（施工单 2026-07-02 001）：
   *   - scopes 之间相互独立：一个 scope 失败只让对应 `AppMsgChannelCountBox`
   *     的 `error` 字段非空，其它 scope 仍正常返回。
   *   - 整体调用失败（如连接断开 / 无 owner）时**所有** scope 的
   *     `error` 字段都非空，UI 据此把"刷新状态"标为失败。
   *   - 底层调 HubMsg `message.counts` 内部 RPC；**不**通过
   *     `message.list` 拉明细再本地计数。
   *   - 内部仅供平台 UI 使用；**不**对外暴露。
   */
  countScopes(scopes: AppMsgAddress[]): Promise<AppMsgChannelCountBox[]>;

  /**
   * 系统页 (`/system/messages`) 失败阶段的 page-level 系统日志入口。
   *
   * 用途：`countScopes` 内部只在它的"自己跑完 message.counts RPC"
   * 阶段写 `appmsg.diagnostics.refresh.*` 日志。但页面流程里
   * `listKnownOrigins` / `reconnectIfNeeded` 也可能失败——这些阶段
   * 失败时，page 应当**主动**调本方法写一条
   * `appmsg.diagnostics.refresh.failed`，让 `/settings/logs` 能按
   * 事件名检索到完整刷新失败链路。
   *
   * `stage` 字段语义：
   *   - `reconnect` —— `reconnectIfNeeded` 抛错
   *   - `list_known_origins` —— `listKnownOrigins` 抛错
   *
   * 本方法本身**不**抛错：日志写失败吞掉，**不**反向影响页面渲染。
   */
  logDiagnosticsRefreshFailed(input: { stage: string; err: string; durationMs: number }): Promise<void>;
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