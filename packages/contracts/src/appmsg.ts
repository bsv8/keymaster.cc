// packages/contracts/src/appmsg.ts
// 应用消息总线契约（施工单 2026-07-03 001 + 2026-07-04 001 反馈）。
//
// 设计缘由：
//   - 单真值在 Keymaster 本地 DB；HubMsg 只负责远端持久化 / 在线实时推送 /
//     在线查询。
//   - app / plugin 公开接口**不**暴露 `ownerPublicKeyHex` / `endpoint` /
//     `senderEndpoint` / `scopeEndpoint` / `box` / `atMs` 这些系统内部概念。
//   - 公开接收目标只允许两种：
//       * 外部 app：`origin`（exact origin，scheme + host + port）
//       * 内部插件 / 系统应用：`appId`（pluginEndpointId）
//   - 公开订阅模式只有"完整消息 hook"：`subscribeMessages(handler)` 直接拿到
//     完整 `AppMsgMessage`，**不**再以 `appmsg.inbox_dirty` 这种 dirty hint
//     为对外协议根模型。
//   - 旧远端 owner 级诊断接口（`message.origins` / `message.counts`）以及
//     `AppMsgSystemPage` 全部删除。
//   - 系统消息应用固定 appId = `keymaster.message`，查看/管理本地消息真值。
//   - 在线语义固定为"对方当前是否连着 HubMsg、是否能立即收到实时推送"，
//     不携带"对方有没有历史消息 / 曾经登录过 / 以后能不能补同步"等额外含义。
//
// 字段组织：
//   - 平台 internal 类型（`AppMsgEndpoint` / `AppMsgAddress`）仍保留，
//     它们是 plugin-appmsg 内核内部路由 / HubMsg wire 适配层唯一允许的
//     "地址模型"——app / plugin **不**直接看到。
//   - 本文件 Public 类型（`AppMsgMessage` / `AppMsgSendInput` / 等）
//     是 app / plugin 的对外契约；HubMsg wire 上的 `HubMsgMessageRecord`
//     （plugin-appmsg 内核内部）与公开 `AppMsgMessage` 之间的转换由
//     plugin-appmsg 内核内部完成。
//   - `AppMsgCore` 接口明确包含 scoped 内部接口（`sendScopedMessage` /
//     `listScopedMessages` / `getScopedMessage` / `subscribeScopedMessages`），
//     实现层**必须**沿用 sender 投影做严格的 ACL 隔离；任何"全库读"路径
//     必须经专门的 `createSystemMessageClient(...)` / `createUnfilteredClient(...)`
//     才能开出（**仅** keymaster.message 系统消息应用允许）。

import type { KeyScopedStorageHandle, KeyspaceService } from "./keyspace.js";

/* ============== 平台 internal 地址模型 ============== */

/** 应用消息端点的 kind（platform internal；不暴露给 app / plugin）。 */
export type AppMsgEndpointKind = "origin" | "plugin";

/**
 * 应用消息端点（platform internal）。
 *
 * 关键约束：
 *   - `kind = "origin"` 时 `id` = exact origin（scheme + host + port，port
 *     不可省略，不做 host-only 归一化，不做"443 可省略"二次归一化）。
 *   - `kind = "plugin"` 时 `id` = 稳定 pluginEndpointId（与 manifest 上声明
 *     的 `appMessageEndpoint.endpointId` 同语义，但不要求相等）。
 *   - **不**作为 app / plugin 公开字段出现；只作为 plugin-appmsg 内核内部
 *     映射 + HubMsg wire 适配层使用。
 */
export interface AppMsgEndpoint {
  kind: AppMsgEndpointKind;
  id: string;
}

/**
 * 平台 internal 完整收件地址：owner + endpoint。
 *
 * 仅在 plugin-appmsg 内核内部使用（HubMsg wire 上的 scope、HubMsg 的 store
 * 主键、平台内部缓存等都依赖此结构）。app / plugin 公开接口**不**允许
 * 传 `ownerPublicKeyHex` 或 `endpoint`，system 由 `appmsg.core` 自动补
 * owner + 内部映射 endpoint。
 */
export interface AppMsgAddress {
  ownerPublicKeyHex: string;
  endpoint: AppMsgEndpoint;
}

/* ============== 公开消息视图（app / plugin 真实看到的形状） ============== */

/** v1 支持的消息正文内容类型。 */
export type AppMsgContentType = "text/plain" | "text/markdown";

/**
 * 公开消息视图：app / plugin 看到的就是这个形状。
 *
 * 关键约束（施工单 §4.4 + 反馈 §"必须修改"）：
 *   - **不**包含 `endpoint` 字段，也不暴露 `ownerPublicKeyHex` / `atMs`。
 *   - sender / recipient 都用 `senderPublicKeyHex` + （`origin` 或 `appId`）
 *     表达：外部 app 用 `origin`，内部插件 / 系统应用用 `appId`。
 *     同一消息至多携带其中一个（同源端互斥）。
 *   - body 是明文 / markdown 字符串；v1 不做端到端加密。
 *   - `clientMessageId` 是发送方侧幂等键（发送方自己带，接收方透传）。
 */
export interface AppMsgMessage {
  /** HubMsg 服务端主键；客户端不可伪造。 */
  messageId: string;
  /** 调用方幂等键（发送方设）。 */
  clientMessageId: string;
  /** 发送方 publicKeyHex。 */
  senderPublicKeyHex: string;
  /** 发送方来源 exact origin（外部 app 才有值）。 */
  senderOrigin?: string;
  /** 发送方来源 appId（内部插件 / 系统应用才有值）。 */
  senderAppId?: string;
  /** 收件方 publicKeyHex。 */
  recipientPublicKeyHex: string;
  /** 收件方来源 exact origin（外部 app 才有值）。 */
  recipientOrigin?: string;
  /** 收件方来源 appId（内部插件 / 系统应用才有值）。 */
  recipientAppId?: string;
  /** 正文内容类型。 */
  contentType: AppMsgContentType;
  /** 正文。v1 不做加密。 */
  body: string;
  /** 客户端声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 服务端入库时间（unix milliseconds）。 */
  insertedAtMs: number;
}

/* ============== 公开 facade 入参形状 ============== */

/**
 * 公开目标：app / plugin 调用 `sendMessage` 时指定的目标只能取这两种之一。
 *
 * 平台内部会按以下规则映射成真实的 HubMsg endpoint：
 *   - 传 `origin` → `{ kind: "origin", id: <exact origin> }`
 *   - 传 `appId`  → `{ kind: "plugin", id: <appId> }`
 *
 * 外部 app 通过 keymaster 协议调用 `appmsg.send` 时：sender 投影为 session
 * 绑定 owner + `event.origin`；因此发送方**不**需要在 params 里带
 * senderOrigin——它由 `event.origin` 决定。
 *
 * 内部插件调用 `appmsg.client.send` 时：sender 投影为 session 绑定 owner +
 * 插件 manifest 声明的 `appMessageEndpoint.endpointId`。
 */
export interface AppMsgRecipient {
  recipientPublicKeyHex: string;
  /** 外部 app 形式的目标：exact origin（scheme + host + port）。 */
  recipientOrigin?: string;
  /** 内部插件 / 系统应用形式的目标：pluginEndpointId / appId。 */
  recipientAppId?: string;
}

/** 公开发送输入（app / plugin 视角）。 */
export interface AppMsgSendInput extends AppMsgRecipient {
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}

/** 公开 `sendMessage` 成功结果。 */
export interface AppMsgSendResult {
  messageId: string;
  createdAtMs: number;
}

/** 公开 list 输入：仅"按时间正向增量"。 */
export interface AppMsgListInput {
  /** 翻页上界（inclusive）；缺省按 service 默认。 */
  limit?: number;
  /**
   * 增量同步游标（exclusive 上界）：仅返回 `messageId > afterMessageId` 的
   * 记录。缺省 = 从该 owner 当前保留的最新一条之后开始。
   */
  afterMessageId?: string;
}

/** 公开 list 结果。 */
export interface AppMsgListResult {
  items: AppMsgMessage[];
  /** 当前 list 还有更多记录。 */
  hasMore: boolean;
}

/** 公开 get 输入。 */
export interface AppMsgGetInput {
  messageId: string;
}

/* ============== 平台 internal：sender 投影 + scope ============== */

/**
 * sender 投影——平台内部用，描述"我以什么身份发 / 收消息"。
 *
 * 与 sender 一起被显式带入 `AppMsgCore` 的所有 scoped 方法；任何 caller
 * 都**必须**在自己手里持有 `senderPublicKeyHex`（来自当前 connect session
 * 或自己 manifest 上声明的 endpointId）才能调这些方法。
 */
export interface AppMsgSenderProjection {
  senderPublicKeyHex: string;
  /** 外部 app 形式：exact origin（scheme + host + port）。 */
  senderOrigin?: string;
  /** 内部插件 / 系统应用形式：pluginEndpointId / appId。 */
  senderAppId?: string;
}

/**
 * 平台内部 sender 可见 scope——用于本地 DB 读取 / 订阅时做 ACL 隔离。
 *
 *   - `kind = "origin"` → 仅 `recipientOrigin === scope.id` 或
 *     `senderOrigin === scope.id` 的消息可见；
 *   - `kind = "plugin"` → 仅 `recipientAppId === scope.id` 或
 *     `senderAppId === scope.id` 的消息可见；
 *   - `kind = "all"`   → 当前 owner 维度的全部消息可见（**仅** keymaster.message
 *     系统消息应用允许使用——见 `createSystemMessageClient(...)`）。
 */
export interface AppMsgScope {
  ownerPublicKeyHex: string;
  kind: "origin" | "plugin" | "all";
  /** scope = origin / plugin 时填 `id`（origin 或 appId）；`all` 时为 null。 */
  id: string | null;
}

/* ============== 在线状态 ============== */

/**
 * 单把公钥的在线状态。
 *
 * 语义固定（施工单 §4.6）：
 *   - `online`：对方当前持有连上 HubMsg 的 keymaster，会立刻收到实时推送。
 *   - `offline`：对方当前没连 HubMsg，HubMsg 会代收保存，对方下次上线后会补同步。
 *   - `unknown`：查询失败 / 当前 owner 无 HubMsg 连接；**不**反向阻断发消息。
 *
 * **不**表达：
 *   - 对方当前没有 / 有历史消息
 *   - 对方曾经 / 从未登录
 *   - 对方以后能不能通过补同步拿到消息
 */
export type AppMsgOnlineStatus = "online" | "offline" | "unknown";

/** 批量在线查询结果。 */
export type AppMsgOnlineResult = Record<string /* publicKeyHex */, AppMsgOnlineStatus>;

/** `checkOnline` 输入：candidate publicKeyHexes。 */
export type AppMsgOnlineInput = string[];

/* ============== 本地同步状态（仅系统消息应用 / 诊断使用） ============== */

/**
 * 单个本地收件目标的同步状态（施工单 §8.2）。
 */
export interface AppMsgTargetSyncState {
  /** 收件目标维度稳定 key：`<origin|appId>:<id>`。 */
  targetKey: string;
  /** 最近一次成功增量同步过的 messageId；缺省 `""`（尚未同步）。 */
  lastSyncedMessageId: string;
  /** 最近一次收到 push 消息时间（unix ms；0 = 从未）。 */
  lastReceivedAtMs: number;
  /** 最近一次同步开始时间（unix ms；0 = 从未）。 */
  lastSyncStartedAtMs: number;
  /** 最近一次同步结束时间（unix ms；0 = 从未）。 */
  lastSyncCompletedAtMs: number;
  /** 最近一次同步错误 message（无错误时为 null）。 */
  lastSyncError: string | null;
}

/**
 * 当前 owner 的本地消息库连接状态（用于系统消息应用展示）。
 */
export interface AppMsgLocalDbSnapshot {
  state: "idle" | "open" | "closed";
  ownerPublicKeyHex: string | null;
  lastInsertedAtMs: number;
  lastError: string | null;
}

/* ============== 平台 simple facade（app / plugin 统一接口） ============== */

/**
 * app / plugin 面向系统的统一消息 facade。
 *
 * 设计缘由（施工单 §4.4 / §8.3 + 反馈 §"必须修改"）：
 *   - 统一 5 个公开方法：`sendMessage` / `listMessages` / `getMessage` /
 *     `subscribeMessages` / `checkOnline`。
 *   - 公开调用入参**不**包含 owner / endpoint / box / atMs 等内部概念。
 *   - 系统内部根据"创建 facade 时固化的 sender 投影"做严格的 ACL 隔离：
 *       * `sendMessage(recipient, ...)`：sender 自动取 facade 固化的 sender；
 *       * `listMessages()`：仅返回 sender scope 内可见的消息；
 *       * `getMessage({messageId})`：不在 sender scope 内时返回 null；
 *       * `subscribeMessages(handler)`：仅分发 sender scope 内的事件；
 *       * `checkOnline(hexes)`：与 sender 解耦，全局行为。
 *   - facade 持有 sender 投影不可变；调用方不可改。
 *
 * 失败语义：
 *   - `sendMessage` 失败 → reject；message 必须经过 HubMsg 才算发出；
 *   - `listMessages` / `getMessage` 失败 → reject 或空；
 *   - `subscribeMessages` handler 内部抛错 → 吞掉；
 *   - `checkOnline` 内部失败 → 对应 key 返回 `unknown`，不影响其它 key。
 */
export interface AppMsgSimpleClient {
  sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult>;
  listMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;
  getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null>;
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/* ============== 平台 internal 接口（plugin-appmsg 单例实现） ============== */

/** appmsg 平台核心 capability key。 */
export const APPMESSAGE_CORE_CAPABILITY = "appmsg.core";

/** 系统消息应用固定 appId（施工单 §4.5 / §8.6）。 */
export const KEYMASTER_MESSAGE_APP_ID = "keymaster.message";

/**
 * 插件 scoped client capability key（plugin 侧）。
 */
export const APPMESSAGE_PLUGIN_CLIENT_CAPABILITY = "appmsg.client";

/**
 * 兼容别名：插件 scoped message client = `AppMsgSimpleClient`。
 */
export type AppMsgPluginClient = AppMsgSimpleClient;

/* === Scoped 输入形状 === */

/** 平台 internal: 发送（已含 sender 投影）。 */
export interface AppMsgSendScopedInput extends AppMsgSenderProjection, AppMsgRecipient {
  contentType: AppMsgContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}

/** 平台 internal: list（已含 sender 投影）。 */
export interface AppMsgListScopedInput extends AppMsgSenderProjection {
  afterMessageId?: string;
  limit?: number;
}

/** 平台 internal: get（已含 sender 投影）。 */
export interface AppMsgGetScopedInput extends AppMsgSenderProjection {
  messageId: string;
}

/** 平台 internal: 订阅（已含 sender 投影）。 */
export interface AppMsgSubscribeScopedInput extends AppMsgSenderProjection {
  handler: (msg: AppMsgMessage) => void;
}

/**
 * appmsg 平台 internal 接口（plugin-appmsg 单例）。
 *
 * 设计缘由：
 *   - 平台 external 公开接口收口为 `AppMsgSimpleClient`：5 个简单方法，
 *     sender 投影在 facade 创建时固化。
 *   - 平台 internal 完整接口在 `AppMsgCore` 内显式声明 scoped 操作；
 *     任何实现必须按 sender 投影做 ACL 隔离，**不允许**走"全库读"。
 *   - `subscribeScopedMessages` 内部保存 `match(msg)` 过滤项；
 *     call site 只在自己 scope 内的事件被分发。
 *   - `createMessageScopedClient(...)` 用固化 sender 投影构造对外 facade。
 *   - `createUnfilteredClient(...)` **仅** keymaster.message 系统应用允许
 *     ——这个工厂在 plugin-appmsg 单例内由 `KEYMASTER_MESSAGE_APP_ID` 校验；
 *     其它 caller 拿到的是受限 `AppMsgSimpleClient`。
 *
 * 关键边界：
 *   - `messageId` 全链路 string。
 *   - send / list / get / subscribe 任何操作都**必须**带 sender 投影
 *     （不存在"无 sender 的 list"路径）；
 *   - 唯一例外是 `createUnfilteredClient` —— 它仅给系统消息应用使用，
 *     由 `createSystemMessageClient(ownerPublicKeyHex)` 工厂代理。
 */
export interface AppMsgCore {
  /* ====== 连接管理 ====== */

  /** connect 当前 owner。幂等。 */
  connectForOwner(ownerPublicKeyHex: string): Promise<void>;
  /** 关闭连接；幂等。 */
  disconnect(): Promise<void>;

  /* ====== 本地 DB 状态 ====== */

  /** 当前连接快照。 */
  inspectLocalDb(): AppMsgLocalDbSnapshot;
  /** 给指定 owner 打开本地消息库；失败时返回 null（DB 不可用降级）。 */
  openLocalDb(input: { publicKeyHex: string }): Promise<KeyScopedStorageHandle | null>;

  /* ====== Scoped 操作（platform internal） ====== */

  /** send（按 sender 投影路由 + 严格映射 endpoint）。 */
  sendScopedMessage(input: AppMsgSendScopedInput): Promise<AppMsgSendResult>;

  /** list（按 sender 投影过滤可见消息）。 */
  listScopedMessages(input: AppMsgListScopedInput): Promise<AppMsgListResult>;

  /** get（按 sender 投影过滤可见消息；不在 scope 内返回 null）。 */
  getScopedMessage(input: AppMsgGetScopedInput): Promise<AppMsgMessage | null>;

  /** 订阅完整消息（按 sender 投影过滤）。返回取消订阅函数。 */
  subscribeScopedMessages(input: AppMsgSubscribeScopedInput): () => void;

  /**
   * 平台 internal 全量订阅——**仅** keymaster.message 系统消息应用允许
   * 构造。Plugin-appmsg 实现层在收到此调用时校验调用方具备
   * "system message app" 身份（manifest.appMessageEndpoint.endpointId
   * === KEYMASTER_MESSAGE_APP_ID），否则拒绝。
   */
  subscribeUnfilteredMessages(handler: (msg: AppMsgMessage) => void): () => void;

  /**
   * 平台 internal 全量读——与 `subscribeUnfilteredMessages` 同作用域。
   */
  listUnfilteredMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;

  /* ====== 公开 facade 构造 ====== */

  /** 构造 sender 固化的对外 facade。 */
  createMessageScopedClient(input: AppMsgSenderProjection): AppMsgSimpleClient;

  /**
   * 系统消息应用专用 facade：appId = keymaster.message，sender = 当前 owner
   * publicKeyHex；其内部使用 `subscribeUnfilteredMessages` / `listUnfilteredMessages`。
   */
  createSystemMessageClient(input: { ownerPublicKeyHex: string }): AppMsgSimpleClient;

  /* ====== 同步 ====== */

  triggerSync(): Promise<void>;
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;

  /* ====== 在线 ====== */

  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/**
 * 反注册 key-scoped storage 时由 plugin-appmsg 提供的 helper 形态。
 */
export interface AppMsgPluginKeyspaceAdapter {
  resolveActivePublicKeyHex(): string | null;
  onKeyspaceChange(handler: () => void): () => void;
  keyspace: KeyspaceService;
  pluginId: string;
  storageId: string;
}

/**
 * pluginEndpointId 字段命名合法性（runtime / contracts 共享）。
 *
 * 设计缘由：
 *   - 限制为 portable subset：小写字母 / 数字 / 下划线 / 点；必须以字母
 *     开头；不允许连续点；不允许以点结尾；
 *   - 必须以字母开头 + 至少包含一个 dot（"a.b" 形式），与 HubMsg 服务端
 *     pluginEndpointIDRE 保持一致语义。
 */
export function isValidPluginEndpointIdShape(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.length > 128) return false;
  const re = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
  return re.test(id);
}

/**
 * exact origin 字段命名合法性（runtime / contracts 共享）。
 */
export function isValidExactOriginShape(origin: string): boolean {
  if (typeof origin !== "string" || origin.length === 0) return false;
  const re = /^(https?):\/\/([^/:]+):(\d+)$/;
  return re.test(origin);
}
