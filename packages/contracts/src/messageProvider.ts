// packages/contracts/src/messageProvider.ts
// 消息服务 provider 契约（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - `hubmsg` 只是某一种消息服务的 provider；未来还可能有第二种。
//   - 系统是单选 active provider 模式：同一时刻只有一个 provider 处于
//     active 状态。
//   - provider 必须**不**感知 owner / vault / active key 的真值——这些
//     由系统中心（plugin-appmsg）持有。provider 接收一个 `ProviderSigner`
//     闭包，借 owner 私钥完成自己的 bind / send 签名。
//   - provider 必须**不**返回 wire-level 类型（`HubMsgMessageRecord` 等）；
//     对外只输出标准化后的 `AppMsgMessage` / 标准化结果，让 plugin-appmsg
//     完全不接触 wire 细节。
//   - provider 共享注册表（registry）由 `plugin-appmsg` 提供；provider
//     自己只负责 `register(...)`，**不**持有 registry 真值——避免"第二个
//     provider 来时谁拥有注册表"再次出现。

import type { AppMsgMessage, AppMsgOnlineStatus } from "./appmsg.js";

/* ============== provider 注册表 capability ============== */

/**
 * 消息服务 provider 注册表 capability key（由 plugin-appmsg 在 setup 时
 * provide；provider 插件在自己 setup 里调用 `registry.register(...)`）。
 */
export const MESSAGE_PROVIDER_REGISTRY_CAPABILITY = "message.provider.registry";

/* ============== provider 给 plugin-appmsg 用的 owner signer 抽象 ============== */

/**
 * bind 时由 plugin-appmsg 提供给 provider 的 owner signer 抽象。
 *
 * 设计缘由（硬切换 2026-07-04 001 修订）：
 *   - provider **不**直接拿 owner 私钥；它只接收这个闭包；
 *   - provider 不知道 signer 内部如何借私钥——这是 vault / keyspace 的
 *     系统逻辑，不属于 provider 域；
 *   - signer 是**通用原语**——`signChallenge({challenge})` 接受任意字节
 *     数组并返回 hex 签名，**不**夹带任何具体 provider 的协议字段
 *     （sessionId / nonce / issuedAtMs 等）。HubMsg 自己的四元组拼接
 *     规则（`canonicalBindText`）下沉到 `plugin-hubmsg`；
 *   - 当前平台 vault 持有 secp256k1 私钥，所以 signer 内部走
 *     `SHA-256(challenge) + secp256k1 compact 64-byte`；未来若
 *     provider 改用 ed25519，由 vault 配套提供对应密钥即可；
 *   - provider 拿到的 hex 签名按自己的协议格式使用（HubMsg 直接用；
 *     其它 provider 可自行验证格式）。
 */
export interface ProviderSigner {
  publicKeyHex: string;
  /**
   * 用 owner 私钥对 `challenge` 字节做 secp256k1 (SHA-256 + compact
   * 64-byte r||s) 签名，返回小写 hex。
   *
   * 失败语义：vault 不可用 / 私钥不可借 → reject。
   */
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

/* ============== provider 句柄的标准化接口 ============== */

/**
 * bind 后由 provider 返回的连接句柄。
 *
 * 设计缘由：
 *   - **不**暴露 `request<TParams, TResult>("message.send", ...)` 这种
 *     字符串方法名接口——那只是把"wire record 泄漏"换成"wire method
 *     string 泄漏"，plugin-appmsg 仍然在理解该 provider 的协议名。
 *   - 暴露**语义化 typed 方法**——sendMessage / listMessages / getMessage /
 *     subscribeMessages / checkOnline 与 plugin-appmsg 的业务语义同构；
 *     provider 内部怎么映射到自己的 wire，由 provider 自己负责。
 *   - 推送事件 `subscribeMessages` 推给 handler 的数据**必须是**标准化
 *     `AppMsgMessage`，不允许再推 wire record；provider 内部完成
 *     wire → public 翻译。
 */
export interface MessageProviderHandle {
  /** 当前连接状态。 */
  state(): MessageProviderState;
  /** 关闭这个 handle；幂等。再次调用 send / list / subscribe 抛错。 */
  close(): void;
}

/** Provider 连接状态。 */
export type MessageProviderState = "idle" | "connecting" | "bound" | "closed";

/* ============== 在线查询入参 / 出参 ============== */

/** Provider 层的批量在线查询入参。 */
export interface ProviderOnlineInput {
  publicKeyHexes: string[];
}

/** Provider 层的批量在线查询出参。 */
export type ProviderOnlineResult = Record<string /* publicKeyHex */, AppMsgOnlineStatus>;

/* ============== provider 健康 ============== */

/**
 * Provider 健康状态快照。
 *
 * provider 在被 register 时可以同步给一个初值，每次 connect / disconnect
 * / 出错时更新；plugin-appmsg 通过 `health()` 拉取最新值供管理页展示。
 */
export interface MessageProviderHealth {
  /** 当前是否可用（最近一次 connect 成功且 handle 未关闭）。 */
  isHealthy: boolean;
  /** 最近一次错误 message；无错误时为 null。 */
  lastError: string | null;
  /** 最近一次成功连接时间（unix ms；0 = 从未）。 */
  lastConnectedAtMs: number;
}

/* ============== provider 主接口 ============== */

/**
 * 一个消息服务 provider（plugin-hubmsg / 未来第二个 provider）。
 *
 * 设计缘由：
 *   - **窄接口**：不包含 owner 真相、active key / vault 生命周期、本地
 *     消息库、业务页 / 管理页、keymaster.message 业务语义；
 *   - **bind()** 是 connection-level 操作：每次 owner 真值变化 / 切换
 *     provider 都需要重新 bind；
 *   - **sendMessage / listMessages / getMessage / subscribeMessages /
 *     checkOnline** 不在 `MessageProvider` 接口上——它们是 bind 后
 *     `MessageProviderHandle` 上的方法。Provider 本身**不**持有连接真值，
 *     它只是工厂。
 */
export interface MessageProvider {
  /** Provider 唯一 id（plugin-hubmsg 提供时是 `"hubmsg"`）。 */
  readonly id: string;
  /** 人类可读名字（管理页展示用）。 */
  readonly displayName: string;
  /**
   * 借 owner signer 建立一条连接 + bind。
   *
   * 失败语义：
   *   - signer 不可用 / connect 失败 / bind 失败：reject；
   *   - 同一 provider 多次 bind：第二次应先 close 旧 handle，再返回新的
   *     handle（实现层保证）。
   */
  bind(input: { signer: ProviderSigner }): Promise<MessageProviderHandle>;
  /** 关闭 provider 当前持有的 handle；幂等。 */
  shutdown(): Promise<void>;
  /**
   * Provider 健康快照。
   *
   * 失败语义：**不**抛错；调用失败时返回 `{ isHealthy: false, lastError,
   * lastConnectedAtMs: 0 }`。
   */
  health(): MessageProviderHealth;
  /**
   * 批量在线查询。
   *
   * 失败语义：
   *   - 当前 handle 未建立 / handle 已关闭：返回所有输入 key 对应
   *     `"unknown"`；
   *   - provider 协议层失败：返回所有输入 key 对应 `"unknown"`，**不**
   *     反向抛错。
   */
  checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult>;
}

/**
 * 给 `MessageProviderHandle` 加上的业务方法扩展。
 *
 * 设计缘由：`MessageProviderHandle` 只描述"如何关闭 / 看状态"这种
 * provider-neutral 行为；具体的"发消息 / 拉消息 / 订阅"是 provider
 * 业务层行为。`MessageProvider` 在 `bind()` 返回值上**直接**返回这个
 * 复合类型（typed handler），让 plugin-appmsg 通过 typed 方法操作。
 *
 * 实现层（例如 plugin-hubmsg）`MessageProviderHandle` 同时实现 `state()`
 * `close()` 和这些业务方法。
 */
export interface MessageProviderOperations extends MessageProviderHandle {
  /** 发送一条消息到指定 recipient。失败语义由 provider 自己定义。 */
  sendMessage(input: ProviderSendInput): Promise<ProviderSendResult>;
  /** 拉取一个 endpoint 的历史消息（按时间正向）。 */
  listMessages(input: ProviderListInput): Promise<ProviderListResult>;
  /** 按 messageId 拉单条。scope 外返回 null。 */
  getMessage(input: ProviderGetInput): Promise<AppMsgMessage | null>;
  /**
   * 订阅推送消息。
   *
   * handler 收到的是标准化 `AppMsgMessage`，provider 内部负责 wire →
   * public 翻译。返回取消订阅函数。
   */
  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void;
  /**
   * 批量在线查询。
   *
   * 失败语义同 `MessageProvider.checkOnline`。
   */
  checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult>;
}

/* ============== provider 业务层输入 / 输出形状 ============== */

/**
 * provider 业务层的 sender 投影：plugin-appmsg 在每次 send 时把
 * 当前 owner 的 sender projection 注入；provider 负责把它映射成
 * 自己 wire 的 sender 字段。
 */
export interface ProviderSenderProjection {
  senderPublicKeyHex: string;
  senderOrigin?: string;
  senderAppId?: string;
}

/**
 * provider 业务层的发送入参。
 *
 * 设计缘由：与 `AppMsgSendInput` 同形，但**不**带任何系统内部概念
 * （owner / endpoint / box / atMs 等），由 provider 自己决定如何映射。
 */
export interface ProviderSendInput {
  sender: ProviderSenderProjection;
  recipientPublicKeyHex: string;
  recipientOrigin?: string;
  recipientAppId?: string;
  contentType: "text/plain" | "text/markdown";
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}

/** provider 业务层的发送结果。 */
export interface ProviderSendResult {
  messageId: string;
  createdAtMs: number;
}

/**
 * provider 业务层的 list 入参。
 *
 * 设计缘由：list 按"owner + endpoint"过滤；`scopeEndpoint` 必须填——
 * plugin-appmsg 在调 list 前已经从 endpoint service 解析出当前 endpoint
 * 真值。
 */
export interface ProviderListInput {
  ownerPublicKeyHex: string;
  scopeEndpoint: ProviderEndpointRef;
  afterMessageId?: string;
  limit?: number;
}

/**
 * provider 业务层的 list 结果。
 *
 * **每条 item 已经是标准化 `AppMsgMessage`**——provider 内部把 wire record
 * 翻译成公开形态再返回。
 */
export interface ProviderListResult {
  items: AppMsgMessage[];
  hasMore: boolean;
}

/**
 * provider 业务层的 get 入参。
 *
 * 与 list 类似：scopeEndpoint 限定可见范围；scope 外返回 null。
 */
export interface ProviderGetInput {
  ownerPublicKeyHex: string;
  scopeEndpoint: ProviderEndpointRef;
  messageId: string;
}

/** provider 业务层的 endpoint 引用。 */
export interface ProviderEndpointRef {
  kind: "origin" | "plugin";
  id: string;
}

/* ============== 当前 active provider 快照 ============== */

/**
 * 当前 active provider 的状态快照。
 *
 * `providerId === null` 表示"系统未选择消息服务"——此时 plugin-appmsg
 * 应进入 not-ready 状态，plugin-message 走空态降级。
 */
export interface ActiveMessageProviderSnapshot {
  providerId: string | null;
  displayName: string | null;
  isHealthy: boolean;
  lastError: string | null;
}

/* ============== 注册表 ============== */

/**
 * provider 共享注册表 capability key。
 */
export const MESSAGE_PROVIDER_REGISTRY_CAPABILITY_DUP = MESSAGE_PROVIDER_REGISTRY_CAPABILITY;

/**
 * Provider 注册表（plugin-appmsg 持有唯一实例并 provide）。
 *
 * 设计缘由：
 *   - provider 注册表**不**归 provider 自己拥有——必须由系统中心
 *     （plugin-appmsg）持有，避免多 provider 抢注册表真值；
 *   - 同一 provider id 重复注册：抛错；
 *   - `setActive(id)` 必须先把当前 active provider 的 handle 关闭，再
 *     触发订阅者的回调；plugin-appmsg 在收到回调后用新 active provider
 *     重新 bind。
 */
export interface MessageProviderRegistry {
  /**
   * 注册一个 provider。
   *
   * 失败语义：重复 id 抛错。
   */
  register(provider: MessageProvider): void;
  /** 取消注册；不存在时 no-op。 */
  unregister(providerId: string): void;
  /** 列出全部已注册的 provider。 */
  list(): readonly MessageProvider[];
  /**
   * 设置当前 active provider。
   *
   * 失败语义：
   *   - `providerId === null` → 进入 not-ready；
   *   - `providerId` 不在已注册集合里 → 抛错；
   *   - 切换成功 → 通知所有 `onActiveChange` 订阅者，**由订阅者**负责
   *     重新 bind 与订阅迁移；注册表本身**不**持有连接真值。
   */
  setActive(providerId: string | null): Promise<void>;
  /** 当前 active provider；未选择时为 null。 */
  active(): MessageProvider | null;
  /** 当前 active 快照（不发起任何 IO）。 */
  activeSnapshot(): ActiveMessageProviderSnapshot;
  /**
   * 订阅 active provider 变化（setActive 成功 / provider unregister）。
   *
   * handler 在切换 / 卸载完成后被调，**不**在切换过程中被调。
   */
  onActiveChange(handler: (snapshot: ActiveMessageProviderSnapshot) => void): () => void;
}

/**
 * 注册表持久化 key：active provider id 写入 localStorage。
 *
 * 设计缘由：
 *   - active provider 是**系统选择**，不是临时 UI 状态；
 *   - 用户切换一次后必须记住；下次启动如果该 provider 不存在 / 不可用
 *     才进入 not-ready，**不**自动 fallback 到 hubmsg。
 */
export const APPMSG_ACTIVE_PROVIDER_STORAGE_KEY = "appmsg.activeProviderId";