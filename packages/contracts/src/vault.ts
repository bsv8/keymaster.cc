// packages/contracts/src/vault.ts
// Vault 契约：私钥存储 + 内存解密的统一入口。
// 关键安全约束：明文私钥只允许在 withPrivateKey 回调内短暂存在。
//
// 硬切换（007 + 001 收口）后的根身份：
//   - KeyRef / KeyIdentity 使用公钥身份（publicKeyHex）。平台根身份
//     字段唯一，不再保留 `publicKeyHash`。
//   - 短公钥属于 UI 显示格式，**不**作为 KeyRef 字段持有；展示时由
//     UI 调 `formatShortPublicKey(publicKeyHex)` 现算。
//   - 旧 `fingerprint` 概念已废弃，不再是 contract / storage / 业务对象的字段。
//   - `address` 与 `network` 不再是 KeyRef 的根身份字段；仅作为兼容展示
//     字段保留，业务方不应再通过 address 反查 key。
//   - 找 key 的主路径是 publicKeyHex，地址查找应交给 P2PKH 自己的 namespace。
//   - `keyId` 是 Vault 内部借用句柄，不是 namespace 根 id。

export type BsvNetwork = "main" | "test";

/** 私钥元数据，写入 IndexedDB 时持久化的部分。 */
export interface KeyRef {
  /** 唯一 key id，由 vault 生成。 */
  id: string;
  /** 人类可读标签。 */
  label: string;
  /** 私钥格式，例如 "wif"、"hex"、"json-file"。 */
  format: string;
  /** 私钥支持的能力列表，例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 导入来源，可选。 */
  source?: string;
  /** 压缩公钥 hex；平台公开身份根字段。ready 必有，failed 可能缺省。 */
  publicKeyHex?: string;
  /**
   * 硬切换 008：identity backfill 状态。缺省或 "ready" 表示可作为
   * active key 候选；"failed" 表示 backfill 失败，keyspace 不会选为
   * active key。vault.listKeys 在 refreshKeyCache 时把 status 映射到 KeyRef。
   *
   * 硬切换 003 收尾：短公钥不属于 contract 字段，UI 展示时由
   * `formatShortPublicKey(publicKeyHex)` 现算。
   *
   * 硬切换 001 收口：旧 `publicKeyHash` 平台身份字段已从 KeyRef 删除。
   */
  identityStatus?: "ready" | "failed";
  /** backfill 失败原因；仅在 identityStatus === "failed" 时有值。 */
  identityError?: string;
  /**
   * 兼容字段：派生出来的 BSV 主网地址。已不再是 key 根身份。
   * 保留仅用于 Vault 设置页等兼容展示；业务插件应通过 P2PKH namespace
   * 在自己的 resource 内查地址。
   */
  address?: string;
  /**
   * 兼容字段：导入时推断的网络。已不再是 key 根身份。
   * 网络由具体 plugin/resource 派生。
   */
  network?: BsvNetwork;
}

/** 私钥明文材料：仅在内存中使用，禁止落盘。 */
export interface PrivateKeyMaterial {
  /** 32 字节十六进制小写编码。 */
  hex: string;
  /** 原始 WIF（如果导入时提供）。 */
  wif?: string;
}

/** Vault 状态机。
 *
 * 硬切换 008：`VaultStatus = "unlocked"` 的语义被收紧。
 *
 * - 旧语义：`masterKey` 已放入内存，masterSalt 已放入内存。
 * - 新语义：表示 Vault 会话**和** keyspace ready 边界都已完成——
 *   1) masterKey / masterSalt 已在内存；
 *   2) identity backfill（逐把 key 派生公钥身份）已完成；
 *   3) keyspace.onVaultUnlocked() 已 await 完成（即 keyspace 处于
 *      一致状态，active key 已选定或进入 mode="all"）。
 *
 * 业务插件在 status === "unlocked" 之后才允许读取 key-scoped storage。
 * 旧实现中"unlocked 早于 keyspace ready"会触发
 * "Key storage is not ready"，属于根因泄漏到 UI 的错误。
 *
 * 实现保证：unlock() 的完成顺序必须为
 *   backfillIdentities -> keyspace.onVaultUnlocked -> setStatus("unlocked") + emit
 * 失败时回退到 "locked" 并清空内存会话（fail-closed）。
 */
export type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";

/**
 * 私钥导出 envelope（bsv8 key envelope）。
 * 设计缘由：导出必须由 Vault 完成，因为只有 Vault 能通过 withPrivateKey
 * 受控借用明文私钥。importer 插件不能借用明文，因此不能实现导出。
 * 格式与外部生态（bsv8）一致：加密 JSON（Argon2id + XChaCha20-Poly1305），
 * 不是 Keymaster 私有格式，也不提供明文 hex / WIF 导出。
 */
export interface KeyExportEnvelope {
  /** 可选 compressed public key hex，便于 bsv8 导入 API 直接使用。 */
  pubkey_hex?: string;
  version: "kek-v1";
  key_id: "default";
  kdf: "argon2id";
  kdf_params: {
    memory_kib: number;
    time_cost: number;
    parallelism: number;
    salt_hex: string;
  };
  cipher: "xchacha20poly1305";
  nonce_hex: string;
  ciphertext_hex: string;
  aad: string;
  created_at_unix: number;
}

/**
 * "Key 已落库但未能自动设为 active"专用错误。
 *
 * 设计缘由（硬切换 002 收尾 + 硬切换 009）：
 *   - 出现在 `importPrivateKey` / `generateKey` / `createVaultWithInitialKey`
 *     路径上：DB 已经写入了新 Key（这一步成功），但 keyspace
 *     `notifyKeyCreated` / `activateCreatedKey` 抛错，active 没切。
 *   - UI 必须**不**把这种错误当作"完全失败"——私钥材料已经安全落库，
 *     用户仍可继续导出 / 删除 / 手动切 active。错误携带完整公开
 *     `KeyRef`（`err.key`），调用方拿到 `err.key.id` 就能直接走
 *     后续管理动作，不再需要去列表里反查。
 *   - 错误信息使用英文。
 *
 * 该类在 `packages/contracts` 暴露，让 shell（apps/web）等**不**依赖
 * plugin-vault 内部模块的代码也能用 `instanceof` 判断。
 */
export class KeyPersistedButActivationFailedError extends Error {
  /** 已落库的完整公开 KeyRef，UI 可直接基于此做导出 / 设 active / 删除。 */
  readonly key: KeyRef;
  /** 原始错误（keyspace 抛的），用于日志。 */
  readonly cause: unknown;

  constructor(input: { key: KeyRef; cause: unknown }) {
    super(
      `Key "${input.key.label}" was persisted but activation failed before key.created: ${
        input.cause instanceof Error ? input.cause.message : String(input.cause)
      }`
    );
    this.name = "KeyPersistedButActivationFailedError";
    this.key = input.key;
    this.cause = input.cause;
  }
}

/**
 * "首 Key 已落库但未自动 active"待展示 notice（硬切换 009 收尾）。
 *
 * 由 `vault.createVaultWithInitialKey` 命中
 * `KeyPersistedButActivationFailedError` 时设置；UI 通过
 * `vault.getInitialActivationNotice()` 读取并展示。字段足够让
 * Key 管理页定位具体那一把 key，无需再去兜底列表里反查。
 */
export interface InitialActivationNotice {
  keyId: string;
  publicKeyHex?: string;
  label: string;
}

/** Vault 服务：被 plugin-vault 实现并以 "vault.service" capability 暴露。 */
export interface VaultService {
  /** 当前状态。 */
  status(): VaultStatus;
  /** 订阅状态变化，返回取消订阅函数。 */
  onStatusChange(handler: (status: VaultStatus) => void): () => void;

  /**
   * "首 Key 已落库但未自动 active"待展示 notice。
   *
   * 设计缘由（硬切换 009 收尾）：消息总线事件是瞬时的，UI 在 LockedShell
   * 切到 UnlockedShell 时容易错过这条事件。改用可查询的 vault state：
   *
   *   - `createVaultWithInitialKey` 命中 `KeyPersistedButActivationFailedError`
   *     时写入本 notice；
   *   - UI（AppShell / 顶栏）在挂载时通过 `getInitialActivationNotice()` 读取
   *     并展示提示横幅；
   *   - notice 在以下情况下自动清除：
   *       * 用户手动 `setActive` 把该 key 切为 active；
   *       * 用户 `lock()` 钱包（会话结束）；
   *   - 显式清除走 `clearInitialActivationNotice()`。
   *
   * 错误信息使用英文。
   */
  getInitialActivationNotice(): InitialActivationNotice | null;
  clearInitialActivationNotice(): void;
  /**
   * 订阅 notice 变化（设置 / 清除）。返回取消订阅函数。
   * 订阅时会立即把当前 notice 值喂给 handler，避免新挂载的 UI 漏掉
   * 已存在的 notice。
   */
  onInitialActivationNoticeChange(
    handler: (notice: InitialActivationNotice | null) => void
  ): () => void;

  /** 是否存在 vault_meta（首次启动为 false）。 */
  hasVault(): Promise<boolean>;
  /**
   * 创建 vault，密码用于派生加密 key。
   *
   * 本方法**仅**表示"创建一个空 Vault"：它不会自动生成或导入任何 Key。
   * 仅供"导入私钥"流程使用——该流程需要先有 Vault 才能保存外部私钥。
   * 首次进入应用选择"新建钱包"必须改走 `createVaultWithInitialKey`，
   * 这样新建钱包会同时创建 Vault 并落第一把 Key；继续把本方法当作
   * "新建钱包"会让用户进入"已解锁但 0 key"的状态。
   */
  createVault(password: string): Promise<void>;
  /**
   * 首启"新建钱包"高层能力：创建空 Vault + 立即在 Vault 内部生成首把 Key +
   * 设为 active key。
   *
   * 设计缘由（硬切换 009）：
   *   - "新建钱包"是一个**业务动作**，不是"创建空 Vault"与"生成 Key"两个
   *     独立底层调用的拼装。把事务边界放在 Vault 内部，页面层不需要关心
   *     失败时 meta 是否需要回滚、内存会话是否需要清理。
   *   - 复用现有 `generateKey` 路径：身份派生、查重、加密落库、active 切换、
   *     `key.created` 事件全部一致；不允许在本方法里复制私钥生成与持久化
   *     逻辑。
   *   - 失败处理：
   *       * `createVault` 自身失败（已存在 / meta 写入失败）—— 抛原错；
   *       * 首 Key **未落库**时的 `generateKey` 失败 —— 内部回滚 meta、
   *         清理内存会话、状态回到 `uninitialized`，再把原错抛给上层；
   *       * 首 Key **已落库**但 active 切换失败 —— 抛
   *         `KeyPersistedButActivationFailedError`，**不**回滚已落库 Key
   *         （与 generateKey 现有语义保持一致），UI 进入"已创建但未自动
   *         active"的成功/警告态。
   *   - 仅当 `status === "uninitialized"` 允许调用；locked / unlocked /
   *     booting 状态必须 fail closed。后续 unlock 不会重复调用本方法。
   *
   * 错误信息使用英文。
   */
  createVaultWithInitialKey(input: {
    password: string;
    label?: string;
    capabilities?: string[];
  }): Promise<KeyRef>;
  /**
   * 首启"导入私钥"高层能力：先校验当前 `status === "uninitialized"`，再
   * **一次性**写 `vault_meta` + 把导入私钥加密落库 + 设为 active + 切到
   * `unlocked`。
   *
   * 设计缘由（硬切换 010）：
   *   - 首启导入是一个完整业务动作，不是"创建空 Vault" + "保存首把导入
   *     Key"两个可分离产品步骤的拼装。把事务边界收敛在 Vault 内部，
   *     页面层不需要关心：
   *       * meta 是否已经写入；
   *       * 首把导入 key 是否已经落库；
   *       * active 是否已经切换；
   *       * 失败时是否要回滚到 `uninitialized`。
   *   - 这条路径是首启导入**唯一**的高层入口；不允许再让首启导入先调
   *     `createVault()` 再走 `/import` —— 那会制造"有锁屏密码但 0 key"
   *     的空 Vault 状态。
   *   - 复用现有 `importPrivateKey` 路径（`persistPrivateKey` 内部函数）：
   *     身份派生、查重、加密落库、active 切换、`key.created` 事件全部一致；
   *     不允许在本方法里复制私钥持久化逻辑。
   *   - 失败处理：
   *       * `createVault` / meta 写入失败 —— 抛原错，状态保持
   *         `uninitialized`；
   *       * 首把导入 key **未落库**（解析失败、重复 publicKeyHex、
   *         加密失败、DB 写入失败等） —— 内部回滚 meta、清空内存会话、
   *         状态回到 `uninitialized`，再把原错抛给上层；
   *       * 首把导入 key **已落库**但 active 切换失败 —— 抛
   *         `KeyPersistedButActivationFailedError`，**不**回滚已落库 key
   *         （与 `importPrivateKey` 现有语义保持一致），UI 进入"已保存
   *         但未自动 active"的成功/警告态。
   *   - 仅当 `status === "uninitialized"` 允许调用；locked / unlocked /
   *     booting 状态必须 fail closed（已有 Vault 时导入更多 key 走的是
   *     已解锁态的 `importPrivateKey`，不是本方法）。
   *   - 不允许本方法被首启导入以外的流程使用；首启"新建钱包"仍走
   *     `createVaultWithInitialKey`。
   *
   * 错误信息使用英文。
   */
  createVaultWithImportedKey(input: {
    /** 本机 Vault 锁屏密码——与导入源密码是两个独立字段。 */
    vaultPassword: string;
    /** 导入解析成功后交给 Vault 落库的私钥材料。 */
    key: {
      label: string;
      material: PrivateKeyMaterial;
      /** importer 推断出的格式，例如 "wif-mainnet"、"bsv8-key-envelope"。 */
      format: string;
      capabilities: string[];
      source?: string;
    };
  }): Promise<KeyRef>;
  /** 用密码解锁，会解密所有 key 索引（不解密私钥本身）。 */
  unlock(password: string): Promise<void>;
  /** 锁定，丢弃内存中的明文。 */
  lock(): Promise<void>;
  /** 硬切换 001：宿主 teardown 时调用。幂等：可重复调用；可容忍部分资源已清。 */
  dispose?(): void;

  /**
   * 仅校验锁屏密码是否正确，不改变 Vault 状态（硬切换 002 删除授权）。
   *
   * 设计缘由：
   *   - 删除 Key 这类危险操作必须要求用户**重新**输入锁屏密码，不能把
   *     "之前已经 unlock"视为永久授权；本方法是收敛密码真值校验的
   *     平台入口，由 Vault 自己拿 verifier 比对，不能让业务插件复制
   *     一套密码校验逻辑。
   *   - 与 `unlock(password)` 严格区分：
   *       * `unlock` 会派生 masterKey、跑 identity backfill、通知
   *         keyspace、emit `vault.unlocked`，创建一段新会话；
   *       * `verifyPassword` **只**比对 verifier，不会改变 `masterKey
   *         / masterSalt / keyCache / status`，不会重跑 backfill，
   *         不会发任何事件。
   *   - 调用前 Vault 不要求处于特定状态：locked / unlocked 都允许，
   *     uninitialized / booting 必须 fail closed（没有 verifier 可校验）。
   *   - 校验失败抛英文错误，例如 `Invalid password`；与 `unlock` 错误
   *     文案一致以便统一 i18n 处理。
   */
  verifyPassword(password: string): Promise<void>;

  /**
   * 删空最后一把 Key 后的"空 Vault 收尾"——把 Vault 状态机最终收敛到
   * `uninitialized`（硬切换 002）。
   *
   * 设计缘由：
   *   - "删完最后一把 Key 后应该回到首启欢迎页"是平台级生命周期，
   *     不能由 keyspace 越层动 `vaultDb.deleteMeta()`，也不能让 UI 凭
   *     "本地列表 length === 0"自己跳转；状态源必须是 Vault。
   *   - 仅允许在"Vault 仍存在但 key 列表已空"的收尾场景调用；否则
   *     fail closed。具体来说：
   *       * 进入时必须**再次**确认 `vault_keys` 为空（哪怕 keyspace
   *         判断剩余 0；fail-closed 防御）；
   *       * 不空则抛错，例如 `Vault still has keys`，绝不能继续删
   *         meta 把用户其它 key 弄成"无 meta、有 key"的脏状态。
   *   - 内部必须：清理内存会话（masterKey / masterSalt / keyCache）
   *     -> 删除 `vault_meta` -> 通知现有依赖 `vault.locked` 的清理
   *     链路（业务插件需要结束 unlocked 会话内存）-> 最终
   *     `setStatus("uninitialized")`。
   *   - 错误信息使用英文。
   */
  finalizeEmptyVaultAfterLastKeyDeletion(): Promise<void>;

  /**
   * 硬切换 005 收尾：已解锁壳层守卫调用的"0 key 异常态恢复入口"。
   *
   * 触发场景：AppShell 检测到 `vault.status() === "unlocked"` 但
   * `keyspace.listKeys()` 为空。这通常是异常残留——bootstrap / unlock
   * 路径上的 0 key 护栏如果漏掉，已经进了 unlocked 又没有任何 key，
   * 必须从这里收敛回 `uninitialized`。
   *
   * 与 `finalizeEmptyVaultAfterLastKeyDeletion` 的区别：
   *   - `finalizeEmptyVaultAfterLastKeyDeletion` 是"删完最后一把 key"
   *     的收尾入口，**严格**要求删完，必须把 meta 删干净才允许
   *     状态收敛；本方法是异常守卫的容错入口，meta 删除失败时
   *     仍要把状态收敛到 uninitialized，让用户进首启 welcome 重试。
   *   - 两条路径最终都收敛到 uninitialized；区别是严格的强度。
   *
   * 仅允许在 `status === "unlocked"` + `listKeys().length === 0` 调用；
   * 其它状态 / 还有 key 时抛错拒绝。错误信息使用英文。
   */
  recoverEmptyVaultToUninitialized(): Promise<void>;

  /** 列出所有 key 元数据。 */
  listKeys(): Promise<KeyRef[]>;
  /** 按 id 取单个 key 元数据。 */
  getKey(id: string): Promise<KeyRef | undefined>;
  /**
   * 按 publicKeyHex 查找 key 元数据。平台身份查找的主路径。
   * 设计缘由：硬切换后地址不再是根 id，平台找 key 必须走公钥身份。
   */
  getKeyByPublicKeyHex(publicKeyHex: string): Promise<KeyRef | undefined>;
  /**
   * 兼容接口：按 address 查找 key 元数据。
   * 设计缘由：保留只是给历史路径兜底；新代码应使用 getKeyByPublicKeyHex。
   */
  findByAddress?(address: string): Promise<KeyRef | undefined>;

  /** 导入一个私钥，保存后返回 KeyRef。允许同一个 vault 存在多个 key。 */
  importPrivateKey(input: {
    label: string;
    material: PrivateKeyMaterial;
    format: string;
    capabilities: string[];
    source?: string;
  }): Promise<KeyRef>;
  /**
   * 在 Vault 内部安全生成一把新 secp256k1 Key，立即加密落库并返回公开 KeyRef。
   *
   * 设计缘由（硬切换 002）：
   *   - 私钥材料由 Vault 内部使用密码学安全随机源（noble secp256k1
   *     `utils.randomPrivateKey()`）生成；调用方只能拿到公开 KeyRef，
   *     永远拿不到明文私钥。
   *   - 明文私钥只允许在 `generateKey` 局部调用链中短暂存在；生成后立即
   *     按现有加密规则写入 `vault_keys`，并复用 `importPrivateKey` 的
   *     身份派生、重复检查、active 切换与事件发布路径。
   *   - 仅允许 Vault 已解锁时调用；locked 状态必须 fail closed。
   *   - 默认 `capabilities = ["p2pkh"]`；记录字段固定为
   *     `format = "generated"`、`source = "vault-generated"`，方便审计
   *     与回归测试。
   *
   * 不在公开契约中暴露：明文 hex / WIF、`material`、随机源替代接口。
   */
  generateKey(input: {
    label: string;
    capabilities?: string[];
  }): Promise<KeyRef>;
  /**
   * 删除一个 key 及其加密材料（硬切换 008）。
   * 设计缘由：实际删除流程由 keyspace.deleteKey 统一调度：
   *   1) background.cancelByKey
   *   2) 关闭 namespace db
   *   3) deleteDatabase namespace
   *   4) vault.deleteKeyMaterial（仅删私钥材料，不发 key.deleted 事件）
   *   5) emit key.deleted（由 keyspace 统一发一次）
   * 不允许业务插件直接调本方法绕过 keyspace。
   */
  deleteKeyMaterial(id: string): Promise<void>;
  /**
   * @deprecated 改用 keyspace.deleteKey。本方法保留仅为满足 contract 编译，
   * 实际调用将抛出 "Use keyspace.deleteKey instead"。
   */
  removeKey(id: string): Promise<void>;

  /**
   * 导出私钥为 bsv8 加密 envelope。
   * 设计缘由：明文私钥只能从 withPrivateKey 借出，因此导出必须经过 Vault。
   * 该方法不修改 key 列表，不触发 key.created / key.deleted 事件。
   */
  exportPrivateKey(input: { keyId: string; password: string }): Promise<KeyExportEnvelope>;

  /**
   * 临时借用私钥。
   * 关键设计缘由：明文私钥永远不进入 React state、不写普通 IndexedDB、不进 global capability。
   * 签名逻辑（如 P2PKH signer）必须通过 withPrivateKey 在闭包内使用，调用结束后立即释放。
   */
  withPrivateKey<T>(keyId: string, fn: (material: PrivateKeyMaterial) => Promise<T> | T): Promise<T>;

  /* ============== appView session signer bootstrap（施工单 2026-06-29 003 硬切换） ============== */
  // 设计缘由（施工单 2026-06-29 003 硬切换）：
  //   - appView Session Window **不再**导入整套 vault unlock runtime；
  //     launcher 改为用现有 `withPrivateKey(keyId, fn)` 借出 owner 私钥
  //     明文 hex，把它交给 Session Window 拼成 `SessionSignerBootstrap`。
  //   - `exportUnlockRuntimeForSessionWindow()` /
  //     `importUnlockRuntimeFromLauncher(handoff)` 这两个 API 已删除：
  //     不允许再让 appView Session Window 模拟"完整解锁钱包窗口"。
  //   - Session Window 的 vault 在 appView mode 下可以是 `locked` 态——
  //     业务方法是否可执行取决于 `connectSessionId` 的 `runtimeBinding`
  //     与对应 runtime 是否就绪。
  //   - 如果未来真要支持"为单 key 持久化"或"key 级别跨窗口 unlock"，
  //     那是另一份施工单；本单**不**重开 unlock runtime export/import。
}
