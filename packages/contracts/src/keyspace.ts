// packages/contracts/src/keyspace.ts
// Keyspace 平台契约：Active Key + Key Namespace 存储 + Key 删除。
// 设计缘由：
//   - KeyIdentity 使用公钥身份（publicKeyHex），不使用私钥、地址或
//     网络作为根 id。私钥材料只留在 Vault 内部。
//   - 平台根身份 = publicKeyHex = 压缩公钥 hex、lowercase、无 0x 前缀、
//     长度 66。本字段是平台对外唯一 key identity 根字段。
//   - 平台 key 域**不再**存在任何 surrogate id（硬切换 002 收尾）。
//     新建 / 导入 key 时必须在落库前先得到 publicKeyHex，并以
//     `publicKeyHex` 作为 vault canonical 主键；私钥借用入参、删除
//     入参、事件 payload 全部按 publicKeyHex 走。
//   - 短公钥属于 UI 显示格式，**不**作为 KeyIdentity 字段持有：
//     需要短串展示时由 UI 侧 `formatShortPublicKey(publicKeyHex)` 现算。
//   - 旧 `fingerprint` 概念已废弃,不再是 contract / storage / 业务对象的字段。
//   - active key 是平台级状态,由 keyspace 维护；业务插件通过该服务获取当前身份。
//   - 业务相关持久化必须通过 keyspace.openKeyStorage 进入 key namespace。
//     IndexedDB 没有真正嵌套 namespace,因此用 DB name 表达归属：
//     `keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>`。
//   - 删除 key 由 keyspace.deleteKey 统一调度：先 prepare -> 取消后台任务 ->
//     删 namespace DB -> 删 Vault 私钥；不允许插件自行 delete where key = ?。
//   - 硬切换 005：active key 模型收窄为"single 模式唯一一把 ready key"：
//     activePublicKeyHex 缺省即"无 active key"（异常修复态 / 过渡期）,
//     不再有"all mode 只读总览"语义。
//   - 硬切换 001（publicKeyHex 收口）：旧 `publicKeyHash` 平台身份字段已
//     从 contract 删除；新代码不允许再读 / 再传 `publicKeyHash`。

/**
 * 平台公开的 key 身份；不包含任何私钥材料，也不持有 vault 内部 uuid。
 *
 * 字段可选性约束（硬切换 002 收尾）：
 *   - `ready` key 必有 `publicKeyHex`（平台身份根字段）。
 *   - 系统中**不再**保留 `identityStatus = uninitialized | failed` 的稳态：
 *     新建 / 导入时 publicKeyHex 必须先派生再落库，unlock 后不再跑逐把
 *     key backfill；老历史 key 缺 identity 字段视为需要一次性迁移状态，
 *     旧记录保持 opaque，由 Vault 在需要解锁时报告版本错误。
 *   - 短公钥属于 UI 显示格式，**不**作为 KeyIdentity 字段持有。展示时
 *     调 `formatShortPublicKey(publicKeyHex)` 现算。
 */
export interface KeyIdentity {
  /** 平台公开身份根字段：压缩公钥 hex，lowercase、无 0x 前缀、长度 66。 */
  publicKeyHex: string;
  /** 用户标签。 */
  label: string;
  /** 私钥支持能力,例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
}

/**
 * 平台级 active key 状态（硬切换 005）。
 *
 * 设计缘由：当前 active key 不再表达"all keys"模式。`activePublicKeyHex`
 * 缺省 = 当前没有具体 active key（异常修复态 / 过渡期 / vault locked）。
 * 业务插件处理：
 *   1) activePublicKeyHex 存在：正常业务态。
 *   2) activePublicKeyHex 缺失：仅作为内部瞬时过渡或壳层识别的异常修复态。
 */
export interface ActiveKeyState {
  /**
   * 当前选中的具体 key publicKeyHex。
   * 缺省 = "无 active key"。没有 all mode 这一真值。
   */
  activePublicKeyHex?: string;
  generation?: number;
}

/** key-scoped storage 打开参数。 */
export interface KeyScopedStorageOpenInput {
  publicKeyHex: string;
  pluginId: string;
  storageId: string;
  version: number;
  /** The fourth argument is the active versionchange transaction when available. */
  upgrade(db: IDBDatabase, oldVersion: number, newVersion: number | null, transaction?: IDBTransaction): void;
}

/** key-scoped storage 句柄。 */
export interface KeyScopedStorageHandle {
  db: IDBDatabase;
  name: string;
  close(): void;
}

/** Keyspace 服务。 */
export interface KeyspaceService {
  /** Persisted selection survives lock; active() is runtime-only. */
  selected(): string | undefined;
  /** 列出平台全部 KeyIdentity（不含私钥）。 */
  listKeys(): Promise<KeyIdentity[]>;
  /** 按 publicKeyHex 取单条 KeyIdentity。 */
  getKey(publicKeyHex: string): Promise<KeyIdentity | undefined>;
  /** 取当前 active key 状态。 */
  active(): ActiveKeyState;
  /**
   * 把 active key 切到指定 publicKeyHex。
   *
   * 硬切换 004：切换前会先 quiesce 旧 active key 的 namespace
   * （cancelByKey + await 旧实例退出 + 关闭 openDbs）,再切换 active。
   * 这样保证 "task 还在跑却看到 DB connection closing" 的竞态从顺序
   * 上消失,而不是被 catch 吞掉。
   */
  setActive(publicKeyHex: string): Promise<void>;
  /**
   * 强制要求当前有 active key：activePublicKeyHex 缺失时抛错。
   * 业务插件在签名 / 转账 / 显示当前收款地址前调用。
   */
  requireActiveKey(): KeyIdentity;
  /** 订阅 active key 变化,返回取消订阅函数。 */
  onActiveKeyChanged(handler: (state: ActiveKeyState) => void): () => void;

  /**
   * 打开 key-scoped IndexedDB。DB name 形如
   * `keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>`。
   */
  openKeyStorage(input: KeyScopedStorageOpenInput): Promise<KeyScopedStorageHandle>;
  /**
   * 注册 plugin 的 key-scoped storage；建立可删除清单。
   * 必须由插件在 setup 阶段调用,keyspace 才能在 deleteKey 时找到要删除的 DB。
   */
  registerPluginStorage(input: { pluginId: string; storageId: string }): void;
  /** 当前 keyspace 已注册的 storage 列表（仅诊断）。 */
  listPluginStorages(): Array<{ pluginId: string; storageId: string }>;

  /**
   * 删除前的准备：发出 key.deleting 事件,要求插件关闭 DB handle 与后台任务。
   * 必须先 await prepareDeleteKey,再进入实际删除。
   *
   * 实现语义（硬切换 008）：实现方必须先 await background.cancelByKey
   * 把该 key 的所有 task 旧实例退出,再关闭 openDbs,最后再 emit
   * key.deleting（emit 不可 await,故关键取消必须由实现主动调用）。
   */
  prepareDeleteKey(publicKeyHex: string): Promise<void>;
  /**
   * 删除 ready key（按 publicKeyHex）。
   *
   * 硬切换 015：删除第一步必须从 Vault canonical list/record 读取目标
   * label，并要求调用方提供 case-sensitive 严格相等的 confirmationLabel，
   * 通过后再执行清理主流程：
   *   authoritative label check -> prepareDeleteKey（cancelByKey + 关闭 handle +
   *   emit key.deleting）-> 按 plugin 注册的 storage 列表逐个
   *   deleteDatabase 全部成功 -> vault.deleteKeyMaterial（仅删私钥
   *   材料,不发事件）-> emit key.deleted -> 剩余 0 把 key 时调用
   *   `vault.finalizeEmptyVaultAfterLastKeyDeletion()` 把 Vault 收敛
   *   回 `uninitialized`,否则按 active fallback 选下一把。
   *
   * 设计缘由：
   *   - label confirmation 是平台删除 API 的一部分，而不是某个页面的私有约定；
   *     这样命令面板 / 快捷操作 / 批处理等未来入口都会被同一套
   *     删除授权语义约束住。
   *   - label 不匹配时必须**完全不开始**——不调 prepareDeleteKey、不
   *     emit `key.deleting`、不取消 background 任务、不动 namespace
   *     DB / 私钥材料。错误信息使用英文（`Key label mismatch`）。
   *   - namespace DB 删除失败或 blocked 时拒绝继续删除 Vault 私钥,
   *     否则会留下归属丢失的业务数据；label 正确也不破例。
   *
   * 约束：仅允许仍处于 ready 状态的 key 通过；找不到 hex 或 key 不
   * 存在时抛 "Key not found"。
   */
  deleteKey(input: { publicKeyHex: string; confirmationLabel: string }): Promise<void>;

  /**
   * 由 background 插件在装载时调用：把 background service 注入 keyspace,
   * 供 deleteKey -> prepareDeleteKey 时 cancelByKey 使用。
   * 设计缘由：vault 插件先于 background 装载,构造 keyspace 时拿不到
   * background.service；通过可选 attach 模式解耦装载顺序。
   * 只在 background 已注册时调用；未注册的 keyspace 跳过此步,
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

/** 事件：key 被创建。payload 携带 publicKeyHex / label。 */
export const EVENT_KEY_CREATED = "key.created";
/** 事件：key 即将被删除。payload 携带 publicKeyHex,订阅者必须 abort 任务与关闭 handle。 */
export const EVENT_KEY_DELETING = "key.deleting";
/** 事件：key 已删除。payload 携带 publicKeyHex。 */
export const EVENT_KEY_DELETED = "key.deleted";
/** 事件：active key 切换。payload 是新的 ActiveKeyState。 */
export const EVENT_ACTIVE_KEY_CHANGED = "activeKey.changed";
/** 事件：identity backfill 状态变化（仅保留接口兼容，不执行旧私钥迁移）。payload: { initializing: boolean }。 */
export const EVENT_KEYSPACE_INITIALIZATION = "keyspace.initialization";

/** keyspace 事件 payload 类型。 */
export interface KeyCreatedEvent {
  publicKeyHex: string;
  label: string;
}

export interface KeyDeletingEvent {
  publicKeyHex: string;
}

export interface KeyDeletedEvent {
  publicKeyHex: string;
}

export interface ActiveKeyChangedEvent extends ActiveKeyState {}

export interface KeyspaceInitializationEvent {
  initializing: boolean;
}
