// packages/contracts/src/appmsg.ts
// 应用消息总线契约（施工单 2026-07-03 001：appmsg 本地真值、完整消息推送、在线状态、
// 系统消息应用硬切换）。
//
// 设计缘由：
//   - 单真值在 Keymaster 本地 DB；HubMsg 只负责远端持久化 / 在线实时推送 / 在线查询。
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
//     是 app / plugin 的对外契约；HubMsg wire 上的 `AppMsgMessageRecord`
//     与内部 `AppMsgMessage` 之间的转换由 plugin-appmsg 内核内部完成。

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
 * 关键约束（施工单 §4.4）：
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
 *
 * 真值写在 key-scoped 本地 DB；每个本地"收件目标" = 一个 (recipient + sender
 * 身份) 维度的 lastSyncedMessageId / lastReceivedAtMs / lastSyncError。
 *
 * UI 渲染或系统消息应用读取此形状；对外**不**走 dirty hint。
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
 *
 * 设计缘由（施工单 §5.4）：
 *   - 状态由本地库决定，**不**走远端 HubMsg 数量统计。
 *   - 锁定 / 无 active key：state = "idle"，不抛错，其余字段尽量保留
 *     上一次的快照便于 UI 渲染 stale 标记。
 */
export interface AppMsgLocalDbSnapshot {
  /** "idle" | "open" | "closed" —— 与本地 DB handle 状态对齐。 */
  state: "idle" | "open" | "closed";
  /** 当前绑定 owner publicKeyHex；未绑定时为 null。 */
  ownerPublicKeyHex: string | null;
  /** 本地库最后写入时间（unix ms；0 = 从未）。 */
  lastInsertedAtMs: number;
  /** 本地库最后错误 message（无错误时为 null）。 */
  lastError: string | null;
}

/* ============== 平台 simple facade（app / plugin 统一接口） ============== */

/**
 * app / plugin 面向系统的统一消息 facade。
 *
 * 设计缘由（施工单 §4.4 / §8.3）：
 *   - 统一 5 个公开方法：`sendMessage` / `listMessages` / `getMessage` /
 *     `subscribeMessages` / `checkOnline`。
 *   - 公开调用入参**不**包含 owner / endpoint / box / atMs 等内部概念。
 *   - 系统内部自动处理 owner 归属、endpoint 路由、本地缓存、补同步、
 *     重连、在线查询失败降级——调用方完全无感。
 *   - 失败语义：
 *       * `sendMessage` 失败 → reject；**不**回退本地写——消息必须经过
 *         HubMsg 后才算发出。
 *       * `listMessages` / `getMessage` 失败 → reject；调用方可重试或
 *         走 UI 兜底。
 *       * `subscribeMessages` handler 内部抛错 → 被吞掉，**不**反向
 *         阻断推送分发。
 *       * `checkOnline` 内部失败 → 对应 key 返回 `unknown`，不影响其它
 *         key 的查询；整体失败时**不**抛错，全部返回 `unknown`。
 */
export interface AppMsgSimpleClient {
  /** 发消息。 */
  sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult>;

  /** 列"属于自己"的本地消息（v1 简化为正向增量 list）。 */
  listMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;

  /** 单条取本地消息。 */
  getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null>;

  /**
   * 订阅对端推送的完整消息（先落本地库再分发给订阅者）。
   *
   * 调用方拿到的就是 `AppMsgMessage` 完整消息，**不**是 dirty hint。
   * 返回取消订阅函数。
   */
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;

  /**
   * 批量查若干 publicKeyHex 当前是否在线。
   *
   * 全部失败时**不**抛错，回退为全 `unknown`；不会阻塞 sendMessage。
   */
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/**
 * 兼容别名：插件 scoped message client = `AppMsgSimpleClient`。
 *
 * 旧仓库 `AppMsgPluginClient` 接口在硬切换 001 后语义收口为简单 facade；
 * 本 alias 仅维持 import 兼容；新代码请直接 `AppMsgSimpleClient`。
 */
export type AppMsgPluginClient = AppMsgSimpleClient;

/* ============== 平台 internal 接口（plugin-appmsg 单例实现） ============== */

/** appmsg 平台核心 capability key。 */
export const APPMESSAGE_CORE_CAPABILITY = "appmsg.core";

/**
 * 插件消息应用 scoped client capability key（plugin 侧）。
 *
 * 设计缘由：
 *   - 声明了 `manifest.appMessageEndpoint.endpointId` 的插件 enable 完成
 *     后，runtime host 会把 sender endpoint 已绑定的 scoped client 注入到
 *     `ctx.get(APPMSG_PLUGIN_CLIENT_CAPABILITY)`。
 *   - 未声明 endpoint 的插件 `ctx.get` 抛错（fail-closed）。
 *   - scoped client 的 `senderAppId` 固定为插件 manifest 声明的
 *     `endpointId`；插件**不**允许自报 sender endpoint。
 */
export const APPMESSAGE_PLUGIN_CLIENT_CAPABILITY = "appmsg.client";

/**
 * 面向插件的 scoped client capability key（向下兼容）。
 *
 * 同 `APPMESSAGE_PLUGIN_CLIENT_CAPABILITY`，保留别名便于旧 import。
 */
export const APPMESSAGE_CLIENT_CAPABILITY = APPMESSAGE_PLUGIN_CLIENT_CAPABILITY;

/** 系统消息应用固定 appId（施工单 §4.5 / §8.6）。 */
export const KEYMASTER_MESSAGE_APP_ID = "keymaster.message";

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

/**
 * appmsg 平台 internal 接口（plugin-appmsg 单例）。
 *
 * 设计缘由（施工单 §8.1 / §8.3）：
 *   - 由 `packages/plugin-appmsg` 内部实现，是"HubMsg WSS 连接 + key-scoped
 *     本地 DB + 推送分发 + 增量同步 + 在线查询"的唯一真值。
 *   - `protocolService` 是**外部 app** 的协议适配层，仅消费其中"给协议层
 *     用"的子集，**不**直接持有 HubMsg 连接。
 *   - owner 切换 / vault 锁状态变化时由 plugin-appmsg 自身驱动
 *     `connectForOwner` / `disconnect`；调用方不需要手动维护。
 *   - `openLocalDb(...)` 在 enable / owner 切换时由内部逻辑按 `publicKeyHex`
 *     调用 keyspace.openKeyStorage，DB 名由 plugin-appmsg 内部选定。
 *   - `messageId` 全链路 string。
 *   - `createMessageScopedClient(...)` 由 runtime host 在 enable 阶段调用；
 *     返回 sender 已绑定的对外 `AppMsgSimpleClient`。
 */
export interface AppMsgCore {
  /** connect 当前 owner。幂等。 */
  connectForOwner(ownerPublicKeyHex: string): Promise<void>;

  /** 关闭连接；幂等。 */
  disconnect(): Promise<void>;

  /** 当前连接快照（系统消息应用展示 / 诊断；不参与业务主路径）。 */
  inspectLocalDb(): AppMsgLocalDbSnapshot;

  /**
   * 给指定 owner 打开 / 复用本地消息库。
   *
   * 平台内部按 `publicKeyHex` + 固定 `storageId = "messages"` 走
   * `keyspace.openKeyStorage(...)`；打开后把 handle 缓存进 plugin-appmsg
   * 单例，切换 owner 时关闭旧 handle。
   *
   * 失败 / 不可用时返回 `null`；调用方对 null 的语义是"暂时没有本地库，
   * 列表 / 同步暂时降级"。
   */
  openLocalDb(input: { publicKeyHex: string }): Promise<KeyScopedStorageHandle | null>;

  /**
   * 列"属于自己"的本地消息。
   *
   * 关键约束（施工单 §5.3）：
   *   - **不**走 HubMsg `message.list`；本地 DB 是真值。
   *   - 失败时按 DB 不可用降级：调用方拿到的 `items` 为空数组；
   *     `hasMore = false`。
   */
  listLocalMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;

  /** 单条取本地消息；不存在或 DB 不可用 → null。 */
  getLocalMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null>;

  /** 全量发消息 + 落本地库（recipient 自己也是当前 owner 时直接本地落库）。 */
  sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult>;

  /**
   * 订阅完整消息推送。
   *
   * 调用方拿到的就是完整 `AppMsgMessage`（**不**是 dirty hint）；
   * 内部路径：HubMsg push → appmsg.core 落本地库 → 派发给本订阅者。
   */
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;

  /**
   * 主动触发一次增量同步（best-effort）。
   *
   * 设计缘由：
   *   - 重连成功 / 收到推送后 / 手动刷新：异步调一次，不会阻塞调用方。
   *   - 同步失败时记录 `lastSyncError`，**不**抛错——失败就失败，靠下次
   *     重连 / 下次推送恢复。
   */
  triggerSync(): Promise<void>;

  /**
   * 读出当前 owner 所有本地目标同步状态。
   *
   * 主要给系统消息应用渲染"最近同步时间 / 最近错误"。
   */
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;

  /**
   * 批量查若干公钥是否连着 HubMsg。
   *
   * 实现：走 HubMsg `message.online`（最小 RPC）；连接断开 / 无 owner 时
   * 整体返回 `unknown` 对象，**不**抛错。
   */
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;

  /**
   * 构造 sender 已绑定的对外 `AppMsgSimpleClient`。
   *
   * 实现：plugin-appmsg 内部 `new MessageScopedClient(this, sender)`；构造
   * 即固定 sender 投影，调用方无法更改。
   *
   * sender 形态：
   *   - 外部 app（keymaster protocol 侧）：sender = { publicKeyHex, origin }；
   *   - 内部插件（manifest.appMessageEndpoint）：sender = { publicKeyHex, appId }；
   *   - 系统消息应用（keymaster.message）：sender = { publicKeyHex, appId }。
   */
  createMessageScopedClient(input: {
    senderPublicKeyHex: string;
    senderOrigin?: string;
    senderAppId?: string;
  }): AppMsgSimpleClient;
}

/** 反注册 key-scoped storage 时由 plugin-appmsg 提供的 helper 形态。 */
export interface AppMsgPluginKeyspaceAdapter {
  /** 暴露当前 owner；缺失返回 null。 */
  resolveActivePublicKeyHex(): string | null;

  /** 同步监听 owner / vault 变化。 */
  onKeyspaceChange(handler: () => void): () => void;

  /** 调 keyspace.openKeyStorage 时的 pluginId / storageId 注入器。 */
  keyspace: KeyspaceService;
  pluginId: string;
  storageId: string;
}
