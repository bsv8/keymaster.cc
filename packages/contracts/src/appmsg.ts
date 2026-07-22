// packages/contracts/src/appmsg.ts
// 应用消息总线契约（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 单真值在 Keymaster 本地 DB；provider（hubmsg / 未来其它）只负责
//     远端持久化 / 在线实时推送 / 在线查询；
//   - app / plugin 公开接口**不**暴露 `ownerPublicKeyHex` / `endpoint` /
//     `senderEndpoint` / `scopeEndpoint` / `box` / `atMs` 这些系统内部概念；
//   - 公开接收目标只允许两种：
//       * 外部 app：`origin`（exact origin，scheme + host + port）
//       * 内部插件：`appId`（pluginEndpointId）
//   - 公开订阅模式只有"完整消息 hook"：`subscribeMessages(handler)` 直接
//     拿到完整 `AppMsgMessage`；
//   - provider 概念分离（见 `messageProvider.ts`）：`MessageProvider` 是
//     窄接口的 provider 工厂；`MessageProviderOperations` 是 bind 后
//     暴露的标准化 typed handle；plugin-appmsg 不直接 import provider 的
//     wire 实现；
//   - endpoint service 是**稳定长寿对象**——plugin-message 通过
//     `appmsg.endpoint.registry` 拿到一个 endpointId 对应的 service，
//     service 内部处理 owner 真值 / provider 切换的迁移，**不**再需要
//     runtime 注入临时 `<pluginId>.appmsg.client` capability；
//   - 在线语义固定为"对方当前是否连着 provider、是否能立即收到实时推送"，
//     不携带"对方有没有历史消息 / 曾经登录过 / 以后能不能补同步"等额外含义。
//
// 字段组织：
//   - 平台 internal 类型（`AppMsgEndpoint` / `AppMsgAddress`）仍保留，
//     它们是 plugin-appmsg 内核内部路由 / provider wire 适配层唯一允许
//     的"地址模型"——app / plugin **不**直接看到；
//   - 公开接收目标 / 公开消息视图（`AppMsgMessage` / `AppMsgRecipient` /
//     `AppMsgSendInput` / 等）是 app / plugin 的对外契约；
//   - 端点 service（`AppMsgEndpointService`）是 plugin-message 等业务
//     插件**唯一**允许消费的稳定入口——它把 owner / provider / scope 等
//     全部封装在内部，对外只暴露 5 个语义化方法。
//
// 旧设计（已彻底移除，施工单 2026-07-04 001 硬切换）：
//   - `APPMESSAGE_CLIENT_CAPABILITY_SUFFIX = ".appmsg.client"` 已删除；
//   - runtime 不再注入 `<pluginId>.appmsg.client` capability；
//   - `createMessageScopedClient(...)` 已删除；
//   - `AppMsgSenderProjection` 不再作为"运行时固化 owner 的参数"出现；
//     它仍作为 endpoint service 内部使用，但**不**作为 plugin-facing
//     公开类型暴露。
//
// 未来兼容：
//   - `subscribeUnfilteredMessages` / `listUnfilteredMessages` 仍保留为
//     **platform internal** 全库能力，**仅**供 `plugin-appmsg` 自己的
//     管理页直接消费；plugin-protocol 也通过这条路径拿全库（协议层是
//     系统特殊方，按 origin 路由完整消息是合理特权）；
//   - 不暴露 `kind = "all"` 的 scope 给业务页。

import type { KeyScopedStorageHandle, KeyspaceService } from "./keyspace.js";
import type {
  ActiveMessageProviderSnapshot,
  MessageProviderOperations,
  MessageProviderRegistry
} from "./messageProvider.js";

/* ============== 平台 internal 地址模型 ============== */

/** 应用消息端点的 kind（platform internal；不暴露给 app / plugin）。 */
export type AppMsgEndpointKind = "origin" | "plugin";

/**
 * 应用消息端点（platform internal）。
 *
 * 关键约束：
 *   - `kind = "origin"` 时 `id` = exact origin（scheme + host + port，port
 *     不可省略，不做 host-only 归一化，不做"443 可省略"二次归一化）；
 *   - `kind = "plugin"` 时 `id` = 稳定 pluginEndpointId（与 manifest 上
 *     声明的 `appMessageEndpoint.endpointId` 同语义，但不要求相等）；
 *   - **不**作为 app / plugin 公开字段出现；只作为 plugin-appmsg 内核
 *     内部映射 + provider wire 适配层使用。
 */
export interface AppMsgEndpoint {
  kind: AppMsgEndpointKind;
  id: string;
}

/**
 * 平台 internal 完整收件地址：owner + endpoint。
 *
 * 仅在 plugin-appmsg 内核内部使用（provider wire 上的 scope、provider
 * 的 store 主键、平台内部缓存等都依赖此结构）。app / plugin 公开接口
 * **不**允许传 `ownerPublicKeyHex` 或 `endpoint`；endpoint service
 * 在内部按当前真值自动补 owner + 内部映射 endpoint。
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
 *   - **不**包含 `endpoint` 字段，也不暴露 `ownerPublicKeyHex` / `atMs`；
 *   - sender / recipient 都用 `senderPublicKeyHex` + （`origin` 或 `appId`）
 *     表达：外部 app 用 `origin`，内部插件 / 系统应用用 `appId`；
 *     同一消息至多携带其中一个（同源端互斥）；
 *   - body 是明文 / markdown 字符串；v1 已做端到端密封（`static-static ECDH` + `AES-256-GCM`，详见 §4.2 / §4.5）；明文 / 密文边界由 `plugin-appmsg` 唯一持有，外部调用方仍按本明文 API 编程；
 *   - `clientMessageId` 是发送方侧幂等键（发送方自己带，接收方透传）。
 */
export interface AppMsgMessage {
  /** provider 服务端主键；客户端不可伪造。 */
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
  /** 正文。v1 走端到端密封；调用方仍通过明文字符串 API 读写。 */
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
 * 平台内部会按以下规则映射成真实的内部 endpoint：
 *   - 传 `origin` → `{ kind: "origin", id: <exact origin> }`
 *   - 传 `appId`  → `{ kind: "plugin", id: <appId> }`
 *
 * 外部 app 通过 keymaster 协议调用 `appmsg.send` 时：sender 投影为 session
 * 绑定 owner + `event.origin`；因此发送方**不**需要在 params 里带
 * senderOrigin——它由 endpoint service 内部按"调用端来自哪个 endpoint"决定。
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
 * 与 sender 一起被显式带入 endpoint service 的内部方法；endpoint service
 * **不**暴露这个类型给业务侧——它在 facade 实现内部按当前 owner 真值
 * 自动构造。
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
 *   - `kind = "all"`   → 当前 owner 维度的全部消息可见。
 *     **仅** `plugin-appmsg` 自己的管理页内部使用：
 *     管理页直接消费 `AppMsgCore.listUnfilteredMessages` /
 *     `subscribeUnfilteredMessages`，不走 plugin facade；其它路径
 *     （plugin-message 业务页 / 任意声明 endpoint 的插件）**不允许**走
 *     `kind = "all"`。
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
 *   - `online`：对方当前持有连上 provider 的 keymaster，会立刻收到实时
 *     推送；
 *   - `offline`：对方当前没连 provider，provider 会代收保存，对方下次上线
 *     后会补同步；
 *   - `unknown`：查询失败 / 当前 owner 无 provider 连接；**不**反向阻断
 *     发消息。
 *
 * **不**表达：
 *   - 对方当前没有 / 有历史消息；
 *   - 对方曾经 / 从未登录；
 *   - 对方以后能不能通过补同步拿到消息。
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
 *
 * `nextReconnectAtMs`（施工单 2026-07-04 003 硬切换新增）：
 *   - 仅在 `state === "closed"` 且系统正在等待下一次自动重连时为未来
 *     时间戳（unix ms）；
 *   - `state === "open"` / `state === "idle"` / 结构性不可连接场景
 *     （vault locked / 无 active key / 无 active provider）必须为
 *     `null`；
 *   - 此字段是管理页倒计时展示的**唯一真值**——页面不靠 `lastError`
 *     反推，也不自己起 5 秒定时器；
 *   - 5 秒重试间隔由 plugin-appmsg setup 内的重连协调器固定持有，
 *     写一次，触发一次状态变更即可。
 */
export interface AppMsgLocalDbSnapshot {
  state: "idle" | "open" | "closed";
  ownerPublicKeyHex: string | null;
  /** Core 当前实际绑定的 provider；尚未完成 bind 时为 null。 */
  boundProviderId?: string | null;
  lastInsertedAtMs: number;
  lastError: string | null;
  nextReconnectAtMs: number | null;
}

/* ============== 公开 facade（endpoint service 形态） ============== */

/**
 * 稳定长寿的 endpoint service（app / plugin 唯一允许消费的入口）。
 *
 * 设计缘由（施工单 2026-07-04 001 §5.3）：
 *   - endpoint 固定：service 由 `endpointId` 标识，构造后**不**变；
 *   - owner 在内部按当前真值解析：service 内部监听 owner / provider
 *     真值变化；调用方**不**感知；
 *   - `sendMessage / listMessages / getMessage / subscribeMessages /
 *     checkOnline` 都由 service 内部处理 owner 真值与 provider 切换；
 *   - `subscribeMessages(handler)` 在 owner / provider 变化时**内部**
 *     自动迁移订阅，**不**让上层 effect 重新订阅。
 *
 * 失败语义：
 *   - 当前未就绪（无 active provider / vault locked / 无 active key）：
 *     - `sendMessage` reject with `not_ready`；
 *     - `listMessages` resolve with empty；
 *     - `getMessage` resolve with null；
 *     - `subscribeMessages` 立即调用一次 handler 参数为"无内容"哨兵
 *       是不允许的——返回取消订阅函数，handler **不**被调用；
 *     - `checkOnline` resolve with `unknown` for all keys。
 */
export interface AppMsgEndpointService {
  /** 当前 endpoint id（plugin-appmsg 持有的稳定 endpoint 引用）。 */
  readonly endpoint: AppMsgEndpointId;
  /** 当前 service 是否可用（active provider + owner 真实可用）。 */
  isReady(): boolean;
  /** 发送；当前未就绪 reject with `not_ready`。 */
  sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult>;
  /** 列本地消息；当前未就绪 resolve with empty。 */
  listMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;
  /** 取单条；当前未就绪 / 不在 scope resolve with null。 */
  getMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null>;
  /**
   * 订阅自己 endpoint 内的完整消息事件。
   *
   * 返回取消订阅函数。service 内部在 owner / provider 切换时**自动迁移**
   * 订阅——上层 React effect **不需要**根据 owner 变化重新订阅。
   */
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;
  /** 批量在线查询。 */
  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;
}

/** endpoint id 公开形态。 */
export interface AppMsgEndpointId {
  kind: "origin" | "plugin";
  id: string;
}

/**
 * endpoint service registry（plugin-appmsg 提供）。
 *
 * 业务插件通过 `forEndpoint(...)` 拿到一个 endpoint 对应的稳定
 * `AppMsgEndpointService`；同一 endpoint 多次调用返回**同一实例**。
 *
 * 业务插件 disable / unregister 时调用 `releaseEndpoint(...)` 让
 * plugin-appmsg 回收内部资源。
 */
export interface AppMsgEndpointServiceRegistry {
  /** 拿一个 endpoint 的稳定 service。 */
  forEndpoint(endpoint: AppMsgEndpointId): AppMsgEndpointService;
  /** 释放一个 endpoint 的 service。 */
  releaseEndpoint(endpoint: AppMsgEndpointId): void;
  /** 列出当前已分配的 endpoint。 */
  listEndpoints(): readonly AppMsgEndpointId[];
}

/** endpoint service registry capability key。 */
export const APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY = "appmsg.endpoint.registry";

/**
 * `connectForOwner` 的结果分类（硬切换 003 修订 + 反馈"必改"第二轮）。
 *
 * 设计缘由（施工单 2026-07-04 003 §5.5 / §7 + 反馈"必改"第二轮）：
 *   - 旧契约 `connectForOwner(...): Promise<void>` 失败时只写
 *     `lastError` 不抛错，导致上层协调器分不清"已成功绑定"和"静默
 *     失败"——必须靠 `inspectLocalDb().state` 反推，且无法表达"绑定
 *     已完成但被结构性条件变化作废"的过期结果；
 *   - 新契约直接返回结构化结果，把"成功 / 结构性不可连接 / 可重试
 *     失败 / 过期（被 core 内部抢占）"四种状态外显给唯一调用者
 *     （`plugin-appmsg` setup 内的重连协调器）；
 *   - 业务插件**不**直接调 `connectForOwner`——它走 `endpoint service`
 *     路径；本类型属于 platform internal。
 *
 * `local_db_unavailable` reason 显式表达"本地消息库打不开"——本字段
 * 真实反映 core 内 `openLocalDbForOwner` 失败的真值；如果实现与本
 * 契约漂移，按"文档型契约漂移"对待。
 */
export type AppMsgConnectOutcome =
  /** bind 成功且提交未被新代次覆盖，当前 handle 真实进入 `bound`。 */
  | { kind: "connected" }
  /** 结构性条件不满足（无 provider / 无 signer / 本地 DB 不可用），不应继续 5 秒循环。 */
  | {
      kind: "structurallyOffline";
      reason: "no_active_provider" | "no_signer" | "local_db_unavailable";
    }
  /** bind 抛错或远端拒绝，可重试。协调器会安排固定 5 秒后再次尝试。 */
  | { kind: "retryableFailure"; reason: string }
  /**
   * core 内部 `connectEpoch` 自增（被同实例另一次 `connectForOwner`
   * 抢占）——结果不应被采用。**不**用于 caller 端结构代次校验；caller
   * 端过期由 caller 自己在 `await` 前后自检（详见 `connectForOwner`
   * 注释）。
   */
  | { kind: "stale" };

/* ============== 平台 internal 接口（plugin-appmsg 单例实现） ============== */

/** appmsg 平台核心 capability key。 */
export const APPMESSAGE_CORE_CAPABILITY = "appmsg.core";

/**
 * `plugin-message` 的固定 appId / `appMessageEndpoint.endpointId`
 * （施工单 2026-07-03 002 / 2026-07-04 001）。
 */
export const KEYMASTER_MESSAGE_APP_ID = "keymaster.message";

/**
 * 平台 internal 接口（plugin-appmsg 单例）。
 *
 * 设计缘由（施工单 2026-07-04 001 硬切换）：
 *   - `AppMsgCore` **不再**包含 scoped send / list / get / subscribe —
 *     这些已收口到 `AppMsgEndpointService`；
 *   - `AppMsgCore` **不**暴露 scoped client 构造方法；runtime 不再注入
 *     `<pluginId>.appmsg.client`，业务插件走 endpoint service；
 *   - `connectForOwner / disconnect / inspectLocalDb / openLocalDb` 由
 *     plugin-appmsg 内部在订阅 keyspace / vault 后驱动，**不**是 runtime
 *     的职责；
 *   - provider registry / endpoint registry 由 `AppMsgCore` 直接暴露
 *     （或通过 helper 暴露），plugin-appmsg 在 setup 阶段把它们挂到
 *     capability bus；
 *   - `subscribeUnfilteredMessages / listUnfilteredMessages` 仍保留为
 *     **platform internal** 全库能力，**仅**供 `plugin-appmsg` 自己的
 *     管理页与 `plugin-protocol` 协议层消费；plugin-message 等业务页
 *     **不**走这条路径。
 *
 * 关键边界：
 *   - `messageId` 全链路 string；
 *   - 全库读 / 全库订阅路径 (`listUnfilteredMessages` /
 *     `subscribeUnfilteredMessages`) **不**走 sender projection；
 *     它由管理页 / 协议层在 `kind = "all"` 的 scope 下消费。
 */
export interface AppMsgCore {
  /* ====== Provider registry ====== */

  /** 拿当前 provider 注册表。plugin-appmsg 内部持有的同一实例。 */
  providers(): MessageProviderRegistry;

  /* ====== Endpoint service registry ====== */

  /** 拿 endpoint service registry。plugin-appmsg 内部持有的同一实例。 */
  endpointRegistry(): AppMsgEndpointServiceRegistry;

  /* ====== 连接管理 ====== */

  /**
   * connect 当前 owner（rebind 当前 active provider）。
   *
   * 参数：
   *   - `ownerPublicKeyHex`：要绑定的 owner；
   *   - `callerEpoch`（可选，**仅** `plugin-appmsg` setup 内的重连
   *     协调器使用）：caller 端用来做"await 后自检"的标识 token。
   *     core 内部**不**读 / 不校验此值——**不是**要求与 core 内部
   *     `connectEpoch` 相等的"必须匹配 token"。caller 在 await 之前
   *     记下自己当时的 epoch，await 后若 epoch 变了就视为 stale 丢弃
   *     结果——这与"提交前校验"语义等价。
   *
   * 失败语义（硬切换 003 反馈"必改"第二轮）：
   *   - 旧实现 "失败只写 `lastError` 不抛错" 已被废弃；本方法直接返回
   *     `AppMsgConnectOutcome` 表达"connected / structurallyOffline /
   *     retryableFailure / stale"四种真值；
   *   - `stale` 来自 core 内部 `connectEpoch` 自增（被同实例另一次
   *     `connectForOwner` 抢占），**不**来自 callerEpoch；
   *   - `structurallyOffline.reason` 包含 `no_active_provider` /
   *     `no_signer` / `local_db_unavailable` 三种真值，caller 应
   *     尊重 `outcome.reason`，**不**应自己覆盖；
   *   - `disconnect` 仍保持"幂等"语义，无返回值。
   */
  connectForOwner(
    ownerPublicKeyHex: string,
    callerEpoch?: number
  ): Promise<AppMsgConnectOutcome>;
  /** 关闭连接；幂等。 */
  disconnect(): Promise<void>;
  /**
   * 把 core 拉到"结构性不可连接"态（硬切换 003 反馈"必改"）。
   *
   * 与 `disconnect()` 区别：
   *   - `disconnect()`：纯 IO 关闭，**不**清 `lastError`；
   *   - `markStructurallyOffline()`：清 `lastError` + 清
   *     `nextReconnectAtMs` + 清 `currentBoundOwner` + 抬内部
   *     `connectEpoch`，让 `inspectLocalDb().state` 稳定回 `idle`。
   *
   * 唯一调用者是 `plugin-appmsg` setup 内的重连协调器。
   */
  markStructurallyOffline(): void;
  /**
   * 由重连协调器写入下一次自动重连截止时间戳。`null` 表示清空。
   * 写入后 fire state change，让管理页立即刷新。
   */
  setNextReconnectAtMs(value: number | null): void;
  /** 读取当前等待重连截止时间戳（仅诊断）。 */
  getNextReconnectAtMs(): number | null;

  /* ====== 本地 DB 状态 ====== */

  /** 当前连接快照。 */
  inspectLocalDb(): AppMsgLocalDbSnapshot;
  /** 给指定 owner 打开本地消息库；失败时返回 null（DB 不可用降级）。 */
  openLocalDb(input: { publicKeyHex: string }): Promise<KeyScopedStorageHandle | null>;

  /* ====== 全库 / 系统接口（platform internal） ====== */

  /**
   * 平台 internal 全量订阅——**仅** `plugin-appmsg` 自己的管理页 +
   * `plugin-protocol` 协议层消费；任何其它 caller 拿到这条入口都属于
   * 越权。
   */
  subscribeUnfilteredMessages(handler: (msg: AppMsgMessage) => void): () => void;

  /**
   * 平台 internal 全量读——与 `subscribeUnfilteredMessages` 同作用域。
   */
  listUnfilteredMessages(input?: AppMsgListInput): Promise<AppMsgListResult>;

  /* ====== 同步 ====== */

  triggerSync(): Promise<void>;
  listTargetSyncStates(): Promise<AppMsgTargetSyncState[]>;

  /* ====== 在线 ====== */

  checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult>;

  /* ====== 协议层专用：以外部 origin 身份 send / list / get =====
   *
   * 设计缘由（施工单 2026-07-04 001 高优 4）：
   *   - `plugin-protocol` 是**系统特殊方**，按 origin 路由完整消息是
   *     合理特权；
   *   - 它**不**是普通 scoped 消息业务页——popup 协议层每条 request
   *     的 caller origin 是动态的（一对一、一次性 sender 投影），
   *     **不**适合走 `AppMsgEndpointService` 这种"长寿 per-endpoint
   *     抽象"；
   *   - 因此 plugin-appmsg 显式暴露三个 origin-based 系统入口，**仅**
   *     `plugin-protocol` 消费。plugin-message 等业务页**不**走这条
   *     路径——它们按 endpoint 服务自己的 stable id (`keymaster.message`)
   *     取 endpoint service。
   *   - subscribe 路径保持 `subscribeUnfilteredMessages` 系统内部入口，
   *     与 send/list/get 同属"系统特殊方特权"。
   */

  /**
   * 以 `origin` endpoint 身份发一条消息（popup 协议层专用）。
   *
   * sender 投影自动由 `origin` 派生（senderOrigin = origin）；
   * senderPublicKeyHex 由当前 bound owner 解析。
   */
  sendAsOrigin(input: {
    origin: string;
    sendInput: AppMsgSendInput;
  }): Promise<AppMsgSendResult>;

  /**
   * 以 `origin` endpoint 身份列本地消息（popup 协议层专用）。
   *
   * 返回的 items 已经过 `AppMsgScope` ACL 过滤——只返回该 origin
   * endpoint 可见的消息。
   */
  listAsOrigin(input: {
    origin: string;
    listInput?: AppMsgListInput;
  }): Promise<AppMsgListResult>;

  /**
   * 以 `origin` endpoint 身份取单条消息（popup 协议层专用）。
   *
   * 不在 origin scope 内时返回 null。
   */
  getAsOrigin(input: {
    origin: string;
    getInput: AppMsgGetInput;
  }): Promise<AppMsgMessage | null>;

  /* ====== 当前 active provider 快照（不发起 IO） ====== */

  /** 当前 active provider 快照（与 `providers().activeSnapshot()` 等价）。 */
  activeProviderSnapshot(): ActiveMessageProviderSnapshot;

  /* ====== owner / provider 变化订阅 ====== */

  /**
   * 订阅 owner 真值变化 / active provider 变化（同一 hook）。
   *
   * 设计缘由：endpoint service 实现需要监听这两个变化来内部迁移
   * subscribe。endpoint service 由 plugin-appmsg 内部持有，
   * **不**作为 plugin 公开能力。
   */
  onStateChange(handler: () => void): () => void;

  /**
   * 当前 bound provider handle（platform internal）。
   *
   * 用于 endpoint service 实现：当 owner / provider 真值变化时，
   * endpoint service 通过 `currentHandle()` 拿到最新 handle 来迁移订阅。
   * **不**作为 plugin 公开能力。
   *
   * 当前未就绪（vault locked / 无 active key / 无 active provider /
   * handle 未建立）时返回 null。
   */
  currentHandle(): MessageProviderOperations | null;

  /** keyspace 注入用（platform internal）。 */
  readonly keyspace: KeyspaceService;
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
 *   - 必须以字母开头 + 至少包含一个 dot（"a.b" 形式），与 provider 服务
 *     端 pluginEndpointIDRE 保持一致语义。
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

/* ============== appmsg 加密密封：永久消息壳 + 密文正文（施工单 2026-07-04 004 硬切换） ============== */
//
// 设计缘由：
//   - 本次把"传输壳 / 永久消息壳 / 加密正文"切成三层：
//       * 传输壳（`HubFrame`）= WebSocket binary frame，由 plugin-hubmsg
//         与 HubMsg 服务端共享；
//       * 永久消息壳（`AppMsgEnvelopeV1`）= HubMsg 持久化、转发、接收方
//         验签的唯一真值；**不**包含 RPC 壳字段（`requestId` / `method`
//         / `connectSessionId`）；
//       * 加密正文（`AppMsgPlaintextV1`）= 仅收发双方可解的业务内容；
//   - 公开 `AppMsgMessage` 业务语义保持不变；sealed record 是 platform
//     internal 形态，**不**由 app / plugin 直接接触。
//   - 加密方案（`sealSuiteId = 1`）：
//       * secp256k1 static-static ECDH（sender 长期私钥 + recipient
//         长期公钥）；
//       * HKDF-SHA256 with info = "keymaster:appmsg:seal:v1"；
//       * AES-256-GCM 12-byte 随机 nonce；
//       * envelope 签名 = sender owner 私钥对 SHA-256(envelopeBytes)
//         签 compact 64-byte secp256k1 ECDSA。
//   - 接收方必须按"先 verify signature、后 decrypt ciphertext"顺序；
//     任一步失败都 fail-closed（不落本地明文）。

/** `AppMsgEnvelopeV1` 版本号；hard-switch 锁死 v1。 */
export const APPMSG_ENVELOPE_VERSION_V1 = 1;
/** `AppMsgPlaintextV1` 版本号；hard-switch 锁死 v1。 */
export const APPMSG_PLAINTEXT_VERSION_V1 = 1;
/** HKDF info 字面量（`sealSuiteId = 1` 专用）。 */
export const APPMSG_SEAL_V1_HKDF_INFO = "keymaster:appmsg:seal:v1";

/** 加密套件 id：v1 = secp256k1 static-static ECDH + HKDF-SHA256 + AES-256-GCM。 */
export const APPMSG_SEAL_SUITE_ID_V1 = 1 as const;

/** 端点 kind 在 envelope 真值里的整数编码。 */
export const APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN = 1 as const;
export const APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN = 2 as const;

/**
 * sealed envelope 的内存字段形状（platform internal）。
 *
 * 这是 `AppMsgEnvelopeV1` 解析后的中间形态——`plugin-appmsg` 内部用
 * 来跑 verify / decrypt。HubMsg 服务端与链路上**只**看到 deterministic
 * CBOR 字节，**不**接触这个解析形态。
 *
 * 关键约束（施工单 2026-07-04 004 §4.2）：
 *   - `envelopeVersion === 1`；
 *   - `senderPublicKeyBytes.length === 33`（compressed secp256k1）；
 *   - `recipientPublicKeyBytes.length === 33`；
 *   - `nonceBytes.length === 12`（AES-GCM nonce）；
 *   - `ciphertext` 长度 0..N（GCM tag 含在 ciphertext 末尾 16 字节）；
 *   - `clientMessageId` / `createdAtMs` / endpoint id 等都是 envelope 真
 *     值的一部分，由 HubMsg 持久化、转发、接收方验签；
 *   - **不**包含 `requestId` / `method` / `connectSessionId`——这些只属于
 *     RPC 调用壳，**不**属于永久消息壳。
 */
export interface AppMsgEnvelopeV1 {
  envelopeVersion: typeof APPMSG_ENVELOPE_VERSION_V1;
  senderPublicKeyBytes: Uint8Array;
  senderEndpointKind:
    | typeof APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
    | typeof APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN;
  senderEndpointId: string;
  recipientPublicKeyBytes: Uint8Array;
  recipientEndpointKind:
    | typeof APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
    | typeof APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN;
  recipientEndpointId: string;
  /** sender 侧幂等键；与公开 `AppMsgMessage.clientMessageId` 一一对应。 */
  clientMessageId: string;
  /** sender 声明的创建时间（unix milliseconds）。 */
  createdAtMs: number;
  /** 加密套件 id；本次固定 `1`。 */
  sealSuiteId: typeof APPMSG_SEAL_SUITE_ID_V1;
  /** AES-GCM nonce；12 字节。 */
  nonceBytes: Uint8Array;
  /** AES-GCM ciphertext（含 16 字节 auth tag）。 */
  ciphertext: Uint8Array;
}

/**
 * 加密正文（platform internal）：只在密文被解出后由 plugin-appmsg 拿到。
 *
 * 关键约束：
 *   - `plaintextVersion === 1`；
 *   - `contentType` 仅 `text/plain` / `text/markdown`；
 *   - `body` 已被 UTF-8 编码为字节；**不**做 base64。
 */
export interface AppMsgPlaintextV1 {
  plaintextVersion: typeof APPMSG_PLAINTEXT_VERSION_V1;
  contentType: "text/plain" | "text/markdown";
  body: Uint8Array;
}

/**
 * 永久消息签名壳（platform internal）：envelope 真值字节 + sender 签名。
 *
 * 关键约束：
 *   - `signatureBytes.length === 64`（compact secp256k1 r||s）；
 *   - 签名对象是 `envelopeBytes`（deterministic CBOR 真值字节），**不**
 *     是 envelope 重新解析后再编码的字节——收验签必须直接对 envelopeBytes
 *     验签；
 *   - HubMsg 持久化 / 转发的也是 envelopeBytes + signatureBytes；收方先
 *     verify，后用 sender 公钥 + 自己 recipient 私钥派生密钥解密。
 */
export interface SignedAppMsgEnvelopeV1 {
  envelopeBytes: Uint8Array;
  signatureBytes: Uint8Array;
}

/**
 * 传输壳 frame kind 整数常量（platform internal；与 HubMsg 服务端共享）。
 *
 * 设计缘由（施工单 §4.1）：
 *   - 不再传 JSON 字符串 / 不再传方法名字符串 / 不再传 base64；
 *   - frame kind 与 method id 都用整数常量；
 *   - 握手顺序固定：`ServerOpen`（服务端首帧）→ `ClientBind`（客户端
 *     响应）→ `BindReady`（服务端确认）；**不**再混用 `BindReady` 充
 *     当首帧或兜底字段；
 *   - 业务帧：`Request` / `Result` / `Event`；心跳 `Ping` / `Pong`；
 *     控制帧 `Close`。
 */
export const HUB_FRAME_KIND = {
  ServerOpen: 1,
  ClientBind: 2,
  BindReady: 3,
  Request: 4,
  Result: 5,
  Event: 6,
  Ping: 7,
  Pong: 8,
  Close: 9
} as const;

export type HubFrameKind = (typeof HUB_FRAME_KIND)[keyof typeof HUB_FRAME_KIND];

/** 传输壳 frame 版本。 */
export const HUB_FRAME_VERSION = 1 as const;

/**
 * 传输壳形状（platform internal）。
 *
 * 关键约束（施工单 §4.1）：
 *   - 整型 frameVersion / frameKind；
 *   - `frameBody` 是按 frameKind 解释的二进制真值；
 *   - 最终 wire 形式 = `cborEncode([frameVersion, frameKind, frameBody])`
 *     （固定顺序数组）；
 *   - WebSocket 上只传二进制，**不**传 JSON 字符串。
 */
export interface HubFrame {
  frameVersion: typeof HUB_FRAME_VERSION;
  frameKind: HubFrameKind;
  frameBody: Uint8Array;
}

/**
 * 传输壳 wire frame body 数组形态（platform internal）。
 *
 * 施工单 §2.3 锁定"固定顺序数组，不用 map"：所有 frame body / method
 * params / method results 都必须用 `CborValue[]` 固定顺序数组，**不**
 * 用对象 map。本类型只是给业务代码提供"按位置拿值"的 TS 视图——wire
 * 编码一律走 `cborEncode([...])`。
 */

/** `server_open` frame body：[sessionId, nonce, heartbeatSec] */
export type HubFrameServerOpenBody = readonly [
  sessionId: string,
  nonce: string,
  heartbeatSec: number
];

/** `client_bind` frame body：[sessionId, publicKeyHex, issuedAtMs, signatureHex] */
export type HubFrameClientBindBody = readonly [
  sessionId: string,
  publicKeyHex: string,
  issuedAtMs: number,
  signatureHex: string
];

/** `bind_ready` frame body：[sessionId] */
export type HubFrameBindReadyBody = readonly [sessionId: string];

/** `request` frame body：[requestId, methodId, methodPayloadBytes] */
export type HubFrameRequestBody = readonly [
  requestId: string,
  methodId: number,
  methodPayloadBytes: Uint8Array
];

/** `result` frame body：[requestId, ok, resultBytes, errorBytes] */
export type HubFrameResultBody = readonly [
  requestId: string,
  ok: boolean,
  resultBytes: Uint8Array,
  errorBytes: Uint8Array
];

/** `event` frame body：[eventId, dataBytes] */
export type HubFrameEventBody = readonly [eventId: number, dataBytes: Uint8Array];

/** `close` frame body：[reason] */
export type HubFrameCloseBody = readonly [reason: string];

/** `ping` / `pong` frame body：[tsMs] */
export type HubFramePingBody = readonly [tsMs: number];

/* ============== v1 RPC method / event 整数 id ============== */

/** v1 RPC method 整数 id（**仅** wire 层使用，**不**暴露给上层）。 */
export const HUBMSG_METHOD = {
  MessageSend: 1,
  MessageList: 2,
  MessageGet: 3,
  MessageOnline: 4
} as const;

/** v1 server-pushed event 整数 id（**仅** wire 层使用）。 */
export const HUBMSG_EVENT = {
  MessageReceived: 1
} as const;

/* ============== wire method params / results（platform internal；固定顺序数组） ============== */

/**
 * `message.send` 入参 wire 形态（platform internal）。
 *
 * 设计缘由：plugin-appmsg 入站边界已经完成 seal + sign；HubMsg 现行
 * wire 只接收最小 `SignedAppMsgEnvelopeV1`，不再重复镜像 sender /
 * recipient / createdAtMs 等 envelope 内字段。
 */
export type HubMsgWireSendParams = readonly [
  envelopeBytes: Uint8Array,
  signatureBytes: Uint8Array
];

/** `message.send` 出参 wire 形态：[messageId, insertedAtMs] */
export type HubMsgWireSendResult = readonly [messageId: string, insertedAtMs: number];

/** `message.list` 入参：[ownerPublicKeyHex, scopeKind, scopeId, box, afterMessageId, beforeMessageId, limit] */
export type HubMsgWireListParams = readonly [
  ownerPublicKeyHex: string,
  scopeKind: number,
  scopeId: string,
  box: "inbox" | "sent" | "all",
  afterMessageId: string,
  beforeMessageId: string,
  limit: number
];

/** `message.list` 出参：[recordBytes..., hasMore] */
export type HubMsgWireListResult = readonly [...recordBytes: Uint8Array[], hasMore: boolean];

/** `message.get` 入参：[messageId, ownerPublicKeyHex, scopeKind, scopeId] */
export type HubMsgWireGetParams = readonly [
  messageId: string,
  ownerPublicKeyHex: string,
  scopeKind: number,
  scopeId: string
];

/** `message.online` 入参：publicKeyHex 扁平数组。 */
export type HubMsgWireOnlineParams = readonly string[];

/** `message.online` 出参：在线 publicKeyHex 数组。 */
export type HubMsgWireOnlineResult = readonly string[];

/**
 * 单条 wire stored envelope record（platform internal；**仅**
 * plugin-hubmsg 内部与 HubMsg 服务端共享）。
 *
 * HubMsg 持久化层只保留最小四元组，sender / recipient / createdAtMs /
 * clientMessageId 等都从 `envelopeBytes` 解析，不在 record 外层重复镜像。
 */
export type HubMsgWireSealedRecord = readonly [
  messageId: string,
  insertedAtMs: number,
  envelopeBytes: Uint8Array,
  signatureBytes: Uint8Array
];
