// packages/contracts/src/poker.ts
// Poker 插件契约：定义 plugin-poker 与 poker-proxy 之间、与其它平台能力
// 之间的所有协议对象与 capability 入口。
//
// 设计缘由：
//   - 硬切换 004（plugin-poker 跟随 active key + 多 Key 生命周期收敛）：
//     Poker 不再维护独立的"稳定扑克身份绑定"，Poker 身份永远跟随平台
//     `keyspace.active()` 的唯一一把 ready key。
//   - 硬切换 005 收尾：删掉 `allMode` 真值。Poker 只处理：
//       `vaultLocked` / `missing` / `notReady` / `ready`。
//     "没有 active key" 不再有 all 模式分支——只可能是 vault locked 或
//     "vault 内有 key 但都不可用"的修复态。
//   - vault locked / active key failed / uninitialized 时，Poker 一律
//     fail-closed（不连接、不重连、不允许 publish）。
//   - 业务插件不能自己再发明第二身份；唯一身份真值来自 keyspace。
//   - 切 active key 时必须先断开旧会话再按新 key 重建，不允许在同一个
//     websocket 会话里"换公钥"继续跑。
//   - 网络配置（proxy endpoint / 双平面 announce / fallback 开关）属于
//     全局配置，跨切 key 不丢；key-scoped storage 只保存"明确属于该
//     key 的扑克状态"（presences / tables / txIngest 等）。
//   - 该契约只承载类型，不放实现；实现位于 packages/plugin-poker。

import type { KeyIdentity } from "./keyspace.js";
import type { MessageBus } from "./messageBus.js";
import type { I18nPluginResources } from "./i18n.js";

/** poker 服务 capability key；plugin-poker 通过 ctx.provide 注册，宿主消费。 */
export const POKER_SERVICE_CAPABILITY = "poker.service";

/**
 * poker 插件必须显式声明的依赖。
 * 设计缘由：硬切换文档要求 plugin-poker 只能通过 capability 使用 vault
 * 与 keyspace，绝不允许 deep-import plugin-vault / plugin-p2pkh 内部。
 * plugin-poker 自己的 manifest.dependencies 必须包含这些项。
 */
export const POKER_REQUIRED_CAPABILITIES = [
  "vault.service",
  "keyspace.service",
  "runtime.messageBus",
  "i18n.service",
  "route.registry",
  "menu.registry",
  "settings.registry",
  "home.registry",
  "breadcrumb.registry"
] as const;

// ----------------------------------------------------------------------------
// Browser <-> Proxy 帧协议
// ----------------------------------------------------------------------------

/** 浏览器到 proxy 的内部协议版本号；与 poker-proxy 的 BrowserProtocolVersion 对齐。 */
export const POKER_BROWSER_PROTOCOL_VERSION = 1;

/** 帧类型常量集合。与 proxy 的 model.FrameType* 完全一致。 */
export const POKER_FRAME_TYPE = {
  AuthChallenge: "auth.challenge",
  AuthResponse: "auth.response",
  AuthOK: "auth.ok",
  AuthFail: "auth.fail",
  TopicSubscribe: "topic.subscribe",
  TopicUnsubscribe: "topic.unsubscribe",
  PresencePublish: "presence.publish",
  TablePublish: "table.publish",
  TableClose: "table.close",
  FramePublish: "frame.publish",
  FrameDeliver: "frame.deliver",
  TxPublish: "tx.publish",
  TxDeliver: "tx.deliver",
  HealthPing: "health.ping",
  HealthPong: "health.pong",
  Error: "error"
} as const;

export type PokerFrameType = (typeof POKER_FRAME_TYPE)[keyof typeof POKER_FRAME_TYPE];

/** 浏览器与 proxy 之间的内部 envelope。 */
export interface PokerBrowserEnvelope<TPayload = unknown> {
  /** 协议版本号；缺失或与 proxy 不一致时拒收。 */
  v: number;
  /** 帧类型。 */
  type: PokerFrameType;
  /** 请求 / 响应关联 id；事件可空。 */
  id?: string;
  payload?: TPayload;
}

// 各 payload 类型。
export interface PokerAuthChallenge {
  nonce: string;
  protocolVersion: number;
  endpoint?: string;
}

export interface PokerAuthResponse {
  /**
   * 必须回显 challenge 的 nonce（hex 字符串）。
   *
   * 设计缘由：proxy 的 broker.handleAuthResponse 用这个 nonce 去 challenger
   * 的 pending map 里查待校验的 challenge 并消费；缺失或不一致直接
   * auth.failed。前端的 challenge.nonce 是 hex（与 model.AuthChallengePayload.Nonce
   * 一致），response.nonce 也按 hex 原文回传。
   */
  nonce: string;
  publicKeyHex: string;
  /** 对 hex-decoded(nonce) 字节做签名（DER 或 compact 任意；proxy 仅形式校验）。 */
  signature: string;
  endpoint?: string;
  nick?: string;
}

export interface PokerAuthOK {
  publicKeyHex: string;
  protocolVersion: number;
}

export interface PokerTopicSubscribe {
  topics: string[];
}

export interface PokerPresencePublish {
  /** 已签 presence payload bytes（base64）。proxy 不解析。 */
  payload: string;
  ttlSeconds?: number;
}

export interface PokerTablePublish {
  tableId: string;
  payload: string;
  ttlSeconds?: number;
}

export interface PokerTableClose {
  tableId: string;
  payload?: string;
}

export interface PokerFramePublish {
  topic: string;
  payload: string;
}

export interface PokerFrameDeliver {
  frameId: string;
  topic: string;
  senderPub?: string;
  payload: string;
  /** "direct" / "broadcast"。 */
  route: string;
}

export interface PokerTxPublish {
  rawTx: string;
}

export interface PokerTxDeliver {
  txid: string;
  /** "direct" / "fallback-broadcast"。 */
  route: string;
  kind?: string;
  rawTx: string;
  reason?: string;
}

export interface PokerErrorPayload {
  code: string;
  message: string;
}

// ----------------------------------------------------------------------------
// 业务领域对象（plugin-poker 内部使用）
// ----------------------------------------------------------------------------

/** 一个桌。 */
export interface PokerTable {
  tableId: string;
  variant: string;
  seats: number;
  stakes: number;
  ownerPub: string;
  /** 本地是否已加入。 */
  joined?: boolean;
}

/** 一条 presence 记录。 */
export interface PokerPresence {
  publicKeyHex: string;
  endpoint?: string;
  nick?: string;
  /** 最近一次观察到的时间。 */
  seenAt: number;
}

/** 一条本地可消费的 raw tx 事件。 */
export interface PokerTxEvent {
  txid: string;
  kind?: string;
  /** 路由来源："direct" / "fallback-broadcast"。 */
  route: string;
  rawTx: Uint8Array;
  reason?: string;
  receivedAt: number;
}

// ----------------------------------------------------------------------------
// 服务契约
// ----------------------------------------------------------------------------

/** Poker 网络连接状态。 */
export type PokerConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "ready"
  | "reconnecting"
  | "failed"
  | "closed";

/** Poker 服务全局网络设置（与具体 key 无关）。 */
export interface PokerSettings {
  /** proxy WSS endpoint，缺省值由 plugin-poker 在 /settings/poker 详情页写入。 */
  proxyEndpoint: string;
  /**
   * 公告里对外暴露的 `P2PNode` 入口地址（host:port），可空。
   * 设计缘由：硬切换 001 修订版 77 行明确"对外必须保留两类真值入口
   * 语义：P2PNode 和 TxLink"。proxy 端把两类入口分别监听后，前端
   * 在 Announce / NodeSeed 等签名内容里要分别声明各自的可达入口；
   * 任何 UI / 服务都必须按双平面分别命名，禁止压成"一个 endpoint"。
   */
  announceP2PNodeEndpoint?: string;
  /** 公告里对外暴露的 `TxLink` 入口地址（host:port），可空。 */
  announceTxLinkEndpoint?: string;
  /** 是否允许 fallback-broadcast 投递（关掉则只接收 direct）。 */
  allowFallbackBroadcast: boolean;
}

/**
 * 当前 Poker 会话 key 的解析结果。
 *
 * 设计缘由（硬切换 004 + 硬切换 005 收尾）：Poker 唯一身份真值 =
 * `keyspace.active().activePublicKeyHash` 对应的那把 ready key。这里把
 * "解析当前 active key 是否可用作 Poker 身份"集中表达：
 *   - `ready`：active key 可用，session 字段给出具体 KeyIdentity。
 *   - `vaultLocked`：vault 未解锁，没有 active key 候选。
 *   - `missing`：vault 已解锁但 keyspace 内没有任何 ready key。
 *   - `notReady`：active key 存在但 identityStatus !== "ready"。
 *   - `noActiveHash`：activePublicKeyHash 缺省（异常态 / 过渡期）。
 *
 * 硬切换 005：`allMode` 已被删除——"无具体 active key" 不再有"全部 key
 * 只读总览"语义；Poker 一律按 `noActiveHash` / `missing` 处理，业务 UI
 * 通过这一枚举直接决定"Poker 设置页的 Connect 按钮是否启用 / 大厅/单桌
 * 是否允许 publish / home widget 显示哪种提示"。
 */
export type PokerSessionKeyState =
  | { kind: "ready"; key: KeyIdentity }
  | { kind: "vaultLocked" }
  | { kind: "missing" }
  | { kind: "notReady"; key: KeyIdentity; reason: string }
  | { kind: "noActiveHash" };

/**
 * PokerService 是 plugin-poker 暴露给宿主的 service 接口。
 *
 * 设计缘由：
 *   - 宿主（topbar / home widget / lobby / table）通过
 *     `ctx.get<PokerService>(POKER_SERVICE_CAPABILITY)` 拿到 service，
 *     订阅 status / tables / presences / txEvents / activePokerKey。
 *   - service 内不暴露私钥、不留明文材料；签名走 vault.withPrivateKey 闭包。
 *   - Poker 身份永远来自 `keyspace.active()`；本服务不再提供任何
 *     "把某把 key 绑定为 poker identity" 的 API（硬切换 004）。
 */
export interface PokerService {
  /** 当前连接状态。 */
  status(): PokerConnectionStatus;
  /** 订阅连接状态变化。 */
  onStatusChange(handler: (status: PokerConnectionStatus) => void): () => void;

  /**
   * 当前 Poker 会话 key 状态解析结果（见 PokerSessionKeyState）。
   * 设计缘由：硬切换 004 + 硬切换 005 收尾要求"active key 缺失 / vault
   * locked / failed / uninitialized"时一律 fail-closed；用单一解析结果
   * 把"能否建立 Poker 会话"的判断收敛在一处，避免业务 UI 各自重复判断。
   */
  getActivePokerKey(): PokerSessionKeyState;
  /**
   * 订阅 active poker key 变化。
   * - active key 从 A 切到 B：handler 立刻收到新 state；
   * - vault 锁定：handler 收到 fail-closed 状态；
   * - key.deleted 后 keyspace 决定下一把 active key：handler 收到新
   *   ready 状态时由 service 内部负责按新 key 重建会话。
   *
   * 订阅时**不会**立即推一次当前值——UI 应在 mount 时调用
   * `getActivePokerKey()` 取初值；onChange 只负责后续增量更新。
   */
  onActivePokerKeyChange(handler: (state: PokerSessionKeyState) => void): () => void;

  /** 列出当前已观察到的 presence。 */
  listPresences(): PokerPresence[];
  /** 订阅 presence 变化。 */
  onPresenceChange(handler: (p: PokerPresence) => void): () => void;

  /** 列出已观察到的 table。 */
  listTables(): PokerTable[];
  /** 订阅 table 变化。 */
  onTablesChange(handler: (tables: PokerTable[]) => void): () => void;

  /** 取出最近 N 条 tx 事件（用于 inbox / 诊断）。 */
  recentTxEvents(limit?: number): PokerTxEvent[];
  /** 订阅新 tx 事件。 */
  onTxEvent(handler: (e: PokerTxEvent) => void): () => void;

  /**
   * 主动连接 proxy。
   *
   * 前置条件（不满足直接抛错 fail-closed）：
   *   - vault.status() === "unlocked"
   *   - active key 是 single 且 identityStatus === "ready"
   *   - settings.proxyEndpoint 已配置
   */
  connect(): Promise<void>;
  /** 主动断开。 */
  disconnect(): void;

  /** 发送 topic 帧 / presence / table publish / raw tx；签名在闭包内完成。 */
  publishFrame(topic: string, payload: Uint8Array): Promise<void>;
  publishPresence(signedPayload: Uint8Array, ttlSeconds?: number): Promise<void>;
  publishTable(tableId: string, signedPayload: Uint8Array, ttlSeconds?: number): Promise<void>;
  closeTable(tableId: string, signedPayload: Uint8Array): Promise<void>;
  publishRawTx(rawTx: Uint8Array): Promise<void>;

  /** 加入 / 离开 topic 订阅。 */
  subscribeTopics(topics: string[]): Promise<void>;
  unsubscribeTopics(topics: string[]): Promise<void>;

  /**
   * 读取全局网络配置。
   *
   * 设计缘由（硬切换 004）：Poker 的 proxy endpoint / 双平面 announce /
   * fallback 开关都属于全局配置，跨切 key 不丢。plugin-poker 在
   * pokerGlobalConfig 单独存储；本方法把全局配置以 PokerSettings 形式
   * 暴露给宿主。
   */
  getSettings(): PokerSettings;
  /**
   * 更新全局网络配置。
   *
   * 设计缘由：硬切换 004 后 settings 不再写到 key-scoped DB；plugin-poker
   * 启动时一次性 hydrate 来自 pokerGlobalConfig。更新时同时触发
   * onSettingsChange；若当前已 ready 且 patch.proxyEndpoint 变化，service
   * 会主动 disconnect → reconnect，让新 endpoint 立即生效。
   */
  updateSettings(patch: Partial<PokerSettings>): Promise<void>;
  /**
   * 订阅 settings 变化。
   *
   * 设计缘由：硬切换 004 后 settings 来自 pokerGlobalConfig（localStorage /
   * 全局 IDB），不会随 binding 切换而变化；订阅时**不会**立即推一次当前值。
   */
  onSettingsChange(handler: (settings: PokerSettings) => void): () => void;

  /** 订阅 messageBus 事件（业务方用）：poker.status / poker.tx / poker.tables。 */
  readonly messageBus: MessageBus;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}

/** Poker 插件 manifest 形状。 */
export interface PokerPluginManifestInput {
  i18n?: I18nPluginResources;
}
