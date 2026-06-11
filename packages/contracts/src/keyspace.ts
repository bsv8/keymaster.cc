// packages/contracts/src/keyspace.ts
// Keyspace 平台契约：Active Key + Key Namespace 存储 + Key 删除。
// 设计缘由：
//   - KeyIdentity 使用公钥身份（publicKeyHex / publicKeyHash / fingerprint），
//     不使用私钥、地址或网络作为根 id。私钥材料只留在 Vault 的 withPrivateKey 闭包内。
//   - active key 是平台级状态，由 keyspace 维护；业务插件通过该服务获取当前身份。
//   - 业务相关持久化必须通过 keyspace.openKeyStorage 进入 key namespace。
//     IndexedDB 没有真正嵌套 namespace，因此用 DB name 表达归属：
//     `keymaster.key.<publicKeyHash>.plugin.<pluginId>.<storageId>`。
//   - 删除 key 由 keyspace.deleteKey 统一调度：先 prepare -> 取消后台任务 ->
//     删 namespace DB -> 删 Vault 私钥；不允许插件自行 delete where key = ?。
//   - ActiveKeyMode = "all" 只用于只读总览；签名 / 广播 / 导出 / 删除 / 显示
//     收款地址等动作必须要求 single 模式。

/**
 * 平台公开的 key 身份；不包含任何私钥材料。
 *
 * 字段可选性约束（硬切换 008 收尾）：
 *   - `ready` key 必须有 `publicKeyHex` / `publicKeyHash` / `fingerprint`。
 *   - `failed` key 可以没有这三个字段：例如 backfill 阶段解密失败，或老
 *     旧记录尚未 backfill 的情况。
 *   - `failed` key 只能导出 / 删除；不允许作为 active key。
 *   - `uninitialized` key 通常是 import 后 backfill 暂未跑完；UI 显示
 *     "初始化中"。
 */
export interface KeyIdentity {
  /** Vault 内部 key id，签名时传给 vault.withPrivateKey 借用私钥。 */
  keyId: string;
  /** 压缩公钥 hex；ready 必有，failed 可能缺省。 */
  publicKeyHex?: string;
  /** 平台 namespace id，建议 sha256(compressed public key) 的 hex；ready 必有，failed 可能缺省。 */
  publicKeyHash?: string;
  /** 短展示指纹，例如 publicKeyHash 前后截断；ready 必有，failed 可能缺省。 */
  fingerprint?: string;
  /** 用户标签。 */
  label: string;
  /** 私钥支持能力，例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /**
   * identity 状态：uninitialized 标识 Vault 解锁后 backfill 尚未完成，
   * failed 标识 backfill 解密失败。这两种状态下不允许作为 active key 候选。
   * 未设置或 "ready" 表示可以正常参与 active key 切换。
   */
  identityStatus?: "ready" | "uninitialized" | "failed";
  /** backfill 失败原因；仅在 identityStatus === "failed" 时有值。 */
  identityError?: string;
}

/** 当前 active key 模式。 */
export type ActiveKeyMode = "single" | "all";

/** 平台级 active key 状态。 */
export interface ActiveKeyState {
  mode: ActiveKeyMode;
  /**
   * mode = "single" 时必填；mode = "all" 时禁止。
   * 业务插件可以按 state 决定默认上下文。
   */
  activePublicKeyHash?: string;
}

/** key-scoped storage 打开参数。 */
export interface KeyScopedStorageOpenInput {
  publicKeyHash: string;
  pluginId: string;
  storageId: string;
  version: number;
  upgrade(db: IDBDatabase, oldVersion: number, newVersion: number | null): void;
}

/** key-scoped storage 句柄。 */
export interface KeyScopedStorageHandle {
  db: IDBDatabase;
  name: string;
  close(): void;
}

/** Keyspace 服务。 */
export interface KeyspaceService {
  /** 列出平台全部 KeyIdentity（不含私钥）。 */
  listKeys(): Promise<KeyIdentity[]>;
  /** 按 publicKeyHash 取单条 KeyIdentity。 */
  getKey(publicKeyHash: string): Promise<KeyIdentity | undefined>;
  /** 取当前 active key 状态。 */
  active(): ActiveKeyState;
  /** 把 active key 切到指定 publicKeyHash。 */
  setActive(publicKeyHash: string): Promise<void>;
  /** 进入 all-keys 只读模式。 */
  setAll(): Promise<void>;
  /**
   * 强制要求 single 模式：all 模式或无 key 时抛错。
   * 业务插件在签名 / 转账 / 显示当前收款地址前调用。
   */
  requireActiveKey(): KeyIdentity;
  /** 订阅 active key 变化，返回取消订阅函数。 */
  onActiveChange(handler: (state: ActiveKeyState) => void): () => void;

  /**
   * 打开 key-scoped IndexedDB。DB name 形如
   * `keymaster.key.<publicKeyHash>.plugin.<pluginId>.<storageId>`。
   */
  openKeyStorage(input: KeyScopedStorageOpenInput): Promise<KeyScopedStorageHandle>;
  /**
   * 注册 plugin 的 key-scoped storage；建立可删除清单。
   * 必须由插件在 setup 阶段调用，keyspace 才能在 deleteKey 时找到要删除的 DB。
   */
  registerPluginStorage(input: { pluginId: string; storageId: string }): void;
  /** 当前 keyspace 已注册的 storage 列表（仅诊断）。 */
  listPluginStorages(): Array<{ pluginId: string; storageId: string }>;

  /**
   * 删除前的准备：发出 key.deleting 事件，要求插件关闭 DB handle 与后台任务。
   * 必须先 await prepareDeleteKey，再进入实际删除。
   *
   * 实现语义（硬切换 008）：实现方必须先 await background.cancelByKey
   * 把该 key 的所有 task 旧实例退出，再关闭 openDbs，最后再 emit
   * key.deleting（emit 不可 await，故关键取消必须由实现主动调用）。
   */
  prepareDeleteKey(publicKeyHash: string): Promise<void>;
  /**
   * 删除 ready key（按 publicKeyHash）。
   *
   * 硬切换 002：删除第一步必须是 `vault.verifyPassword(password)`，
   * 通过后再执行清理主流程：
   *   verifyPassword -> prepareDeleteKey（cancelByKey + 关闭 handle +
   *   emit key.deleting）-> 按 plugin 注册的 storage 列表逐个
   *   deleteDatabase 全部成功 -> vault.deleteKeyMaterial（仅删私钥
   *   材料，不发事件）-> emit key.deleted -> 剩余 0 把 key 时调用
   *   `vault.finalizeEmptyVaultAfterLastKeyDeletion()` 把 Vault 收敛
   *   回 `uninitialized`，否则按 active fallback 选下一把。
   *
   * 设计缘由：
   *   - 密码作为平台删除 API 的一部分，而不是某个页面的私有约定；
   *     这样命令面板 / 快捷操作 / 批处理等未来入口都会被同一套
   *     删除授权语义约束住。
   *   - 密码错误时必须**完全不开始**——不调 prepareDeleteKey、不
   *     emit `key.deleting`、不取消 background 任务、不动 namespace
   *     DB / 私钥材料。错误信息使用英文（`Invalid password`）。
   *   - namespace DB 删除失败或 blocked 时拒绝继续删除 Vault 私钥，
   *     否则会留下归属丢失的业务数据；密码正确也不破例。
   *
   * 约束：仅允许 `identityStatus === "ready"` 的 key 通过；传 failed key
   * 的 hash 会抛 "Key not found"。要清理 failed key 必须改走
   * deleteKeyById(keyId)。
   */
  deleteKey(input: { publicKeyHash: string; password: string }): Promise<void>;

  /**
   * 按 keyId 删除一个 key（管理入口）。
   *
   * 硬切换 002：与 `deleteKey` 一样，第一步必须是 `vault.verifyPassword
   * (password)`；通过后再走 namespace 清理 + 私钥删除 + active fallback /
   * empty-vault finalize 主流程。
   *
   * 设计缘由：硬切换 008 收尾——failed key 仍可能有 publicKeyHash（vault
   * 不在 putKeyIdentityFailed 时清空 identity 字段），deleteKey(hash) 又
   * 拒绝 failed，因此 UI 管理页必须走 keyId 路径。本方法覆盖四种情况：
   *   - ready + 有 hash：走完整 namespace 清理（cancelByKey + 删 namespace
   *     DB + 删私钥材料 + emit key.deleted）。
   *   - failed + 有 hash：同上（不依赖 identityStatus 过滤）。
   *   - ready / failed + 无 hash：仅删私钥材料 + emit key.deleted（payload
   *     不带 publicKeyHash，因为没有 namespace DB 可删）。
   *   - 不存在的 keyId：抛 "Key not found"。
   * active fallback：删的是 active key 时切到下一把 ready key；删空最后
   * 一把 key 时调 `vault.finalizeEmptyVaultAfterLastKeyDeletion()` 让
   * Vault 最终状态收敛到 `uninitialized`（不再仅 fallback 到 `all`）。
   */
  deleteKeyById(input: { keyId: string; password: string }): Promise<void>;

  /**
   * 由 background 插件在装载时调用：把 background service 注入 keyspace，
   * 供 deleteKey -> prepareDeleteKey 时 cancelByKey 使用。
   * 设计缘由：vault 插件先于 background 装载，构造 keyspace 时拿不到
   * background.service；通过可选 attach 模式解耦装载顺序。
   * 只在 background 已注册时调用；未注册的 keyspace 跳过此步，
   * 此时 deleteKey 走"无 background cancel"路径（仅关闭 handle + emit）。
   */
  attachBackgroundService?(service: import("./background.js").BackgroundService): void;

  /** 平台是否仍处于 identity backfill 阶段。 */
  isInitializing(): boolean;
  /** 订阅初始化状态变化。 */
  onInitializationChange(handler: (initializing: boolean) => void): () => void;
}

/** keyspace capability key。 */
export const KEYSPACE_SERVICE_CAPABILITY = "keyspace.service";

/** 事件：key 被创建。payload 携带 keyId / publicKeyHash / label。 */
export const EVENT_KEY_CREATED = "key.created";
/** 事件：key 即将被删除。payload 携带 publicKeyHash，订阅者必须 abort 任务与关闭 handle。 */
export const EVENT_KEY_DELETING = "key.deleting";
/** 事件：key 已删除。payload 携带 publicKeyHash / keyId（仅诊断用）。 */
export const EVENT_KEY_DELETED = "key.deleted";
/** 事件：active key 切换。payload 是新的 ActiveKeyState。 */
export const EVENT_ACTIVE_KEY_CHANGED = "activeKey.changed";
/** 事件：identity backfill 状态变化。payload: { initializing: boolean }。 */
export const EVENT_KEYSPACE_INITIALIZATION = "keyspace.initialization";

/** keyspace 事件 payload 类型。 */
export interface KeyCreatedEvent {
  keyId: string;
  publicKeyHash: string;
  label: string;
}

export interface KeyDeletingEvent {
  publicKeyHash: string;
  keyId?: string;
}

export interface KeyDeletedEvent {
  publicKeyHash: string;
  keyId?: string;
}

export interface ActiveKeyChangedEvent extends ActiveKeyState {}

export interface KeyspaceInitializationEvent {
  initializing: boolean;
}
