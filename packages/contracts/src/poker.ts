// packages/contracts/src/poker.ts
// Poker 插件契约：定义 plugin-poker 与 poker-proxy 之间、与其它平台能力
// 之间的所有协议对象与 capability 入口。
//
// 设计缘由：
//   - 硬切换 001 要求 "plugin-poker 持有 poker 能力契约与 UI，与 proxy
//     建立 WSS 会话；本地完成签名、验签、状态推进、钱包调用"。
//   - 该契约只承载类型，不放实现；实现位于 packages/plugin-poker。
//   - browser <-> proxy 的帧类型与 proxy 端 BrowserEnvelope 1:1 对齐，
//     JSON 字段名采用 camelCase（proxy 的 encoding/json 默认）。
//   - 必须把 capability key 集中导出（"poker.service"），runtime 通过
//     ctx.get("poker.service") 获取服务实例。

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

/** Poker 服务设置。 */
export interface PokerSettings {
  /** proxy WSS endpoint，缺省值由 plugin-poker 在 SettingsPage 写入。 */
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
 * 稳定 poker identity 绑定记录。
 *
 * 设计缘由：硬切换 001 修订版 100 / 567 / 764 行明确"稳定扑克身份必须
 * 独立于当前 active key 切换"。本结构是 plugin-poker 在 key-scoped
 * IndexedDB 里持久化的"poker identity 选择"：用户在 settings 里显式
 * 挑一把 vault key 作为 poker 身份，切换 active key 不会隐式改变它。
 *
 * 字段：
 *   - bound: 用户已经显式绑定一把 key；解锁后这把 key 即 poker identity。
 *   - publicKeyHash: 被绑定 key 的稳定 namespace id。
 *   - publicKeyHex: 缓存的压缩公钥 hex（presence / chat / announce 都用它）。
 *   - keyId: vault.withPrivateKey 的 key id（签名通道）。
 *   - label: 创建绑定时记录的人类标签（仅展示，可与 vault label 不同步）。
 *   - boundAt: 绑定建立时间。
 */
export interface PokerIdentityBinding {
  bound: true;
  publicKeyHash: string;
  publicKeyHex: string;
  keyId: string;
  label: string;
  boundAt: number;
}

/** 当前没有显式绑定时的占位记录，service.getIdentityBinding 可能返回 null。 */
export type PokerIdentityBindingState = PokerIdentityBinding | null;

/** Settings 页 / lobby 列出"可选 poker identity"用的轻量公开身份。 */
export interface PokerIdentityCandidate {
  keyId: string;
  publicKeyHash: string;
  publicKeyHex: string;
  label: string;
  /** 是否当前 active key（仅 UI 提示）。 */
  isActive: boolean;
}

/**
 * PokerService 是 plugin-poker 暴露给宿主的 service 接口。
 *
 * 设计缘由：
 *   - 宿主（topbar / home widget）通过 ctx.get<PokerService>(POKER_SERVICE_CAPABILITY)
 *     拿到 service，订阅 status / tables / presences / txEvents。
 *   - service 内不暴露私钥、不留明文材料；签名走 vault.withPrivateKey 闭包。
 */
export interface PokerService {
  /** 当前连接状态。 */
  status(): PokerConnectionStatus;
  /** 订阅连接状态变化。 */
  onStatusChange(handler: (status: PokerConnectionStatus) => void): () => void;

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

  /** 主动连接 proxy（解锁后才能调用，vault 锁定 fail-closed）。 */
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

  /** 读取 / 写入 settings。 */
  getSettings(): PokerSettings;
  updateSettings(patch: Partial<PokerSettings>): Promise<void>;
  /**
   * 订阅 settings 变化。
   *
   * 设计缘由：bindIdentity 后 service 会异步从 key-scoped IDB 拉回该 identity
   * 的 settings；如果 UI 只在 mount 时调 `getSettings()` 一次，刷新后会
   * 看到空表单 / 错误禁用 Connect 按钮。该回调在两条路径上都会触发：
   *   - `updateSettings(patch)` 完成后；
   *   - 内部 `hydrateSettingsForCurrentIdentity()` 完成后（binding 切换）。
   * 订阅时**不会**立即推一次当前值——UI 仍应在 mount 时调 `getSettings()`
   * 取初值；onChange 只负责后续增量更新。
   */
  onSettingsChange(handler: (settings: PokerSettings) => void): () => void;

  // --------------------------------------------------------------------------
  // 稳定 poker identity 绑定（硬切换 001 修订版 100 / 567 / 764 行）
  // --------------------------------------------------------------------------

  /**
   * 当前绑定的 poker identity。
   *
   * 设计缘由：plugin-poker 的 presence / table owner / chat 身份必须独立于
   * keyspace.active() 切换。`null` 表示用户尚未在 settings 里显式绑定，
   * 此时所有 publish 路径 fail-closed。
   */
  getIdentityBinding(): PokerIdentityBindingState;

  /** 订阅绑定变化（解绑 → null；重新绑定 → 新对象）。 */
  onIdentityBindingChange(handler: (b: PokerIdentityBindingState) => void): () => void;

  /**
   * 列出当前可作为 poker identity 的候选 vault key（`identityStatus = "ready"`
   * 且有 publicKeyHex 的 key）。仅展示用，不暴露任何 capability 反射。
   */
  listIdentityCandidates(): Promise<PokerIdentityCandidate[]>;

  /**
   * 显式绑定一把 vault key 作为 poker identity。
   *
   * 设计缘由：硬切换文档要求"允许用户显式选择一把 vault key 作为 poker
   * 身份；绑定结果独立于当前 active key 切换"。
   *
   * 副作用：写 key-scoped storage（落地）+ 触发 onIdentityBindingChange +
   * 若已连接 proxy，会主动 disconnect 以避免用旧身份维持 session。
   */
  bindIdentity(input: { publicKeyHash: string; label?: string }): Promise<PokerIdentityBinding>;

  /**
   * 清除当前绑定。
   *
   * 设计缘由：用户主动放弃 poker 玩法 / 即将删除该 key 时调用。绑定清除
   * 后 connect/publish 均 fail-closed，直到下一次 bindIdentity。
   */
  unbindIdentity(): Promise<void>;

  /** 订阅 messageBus 事件（业务方用）：poker.status / poker.tx / poker.tables。 */
  readonly messageBus: MessageBus;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}

/** Poker 插件 manifest 形状。 */
export interface PokerPluginManifestInput {
  i18n?: I18nPluginResources;
}
