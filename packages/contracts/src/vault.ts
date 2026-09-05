// packages/contracts/src/vault.ts
// Vault 契约：私钥存储 + 内存解密的统一入口。
// 关键安全约束：明文私钥只允许在 Vault 内部短暂存在。
//
// 硬切换（007 + 001 + 002 收尾）后的根身份：
//   - KeyRef / KeyIdentity 使用公钥身份（publicKeyHex）。平台根身份
//     字段唯一,系统**不再**存在 key 域 surrogate id：
//       * `KeyRef` 不再持有 `id`（vault 内部 uuid 主键已删除）。
//       * Vault canonical store 主键 = publicKeyHex。
//       * `deleteKey` 入参是 publicKeyHex。
//         硬切换 002 之后不再有 "failed / uninitialized" 稳态。
//   - 短公钥属于 UI 显示格式，**不**作为 KeyRef 字段持有；展示时由
//     UI 调 `formatShortPublicKey(publicKeyHex)` 现算。
//   - 旧 `fingerprint` 概念已废弃，不再是 contract / storage / 业务对象的字段。
//   - `address` 与 `network` 仍作为兼容展示字段保留——它们**不是**
//     owner 真值、不是 key 根身份。新逻辑禁止用这两字段做身份 / 地
//     址 / 网络 / 资产判断；地址应从 P2PKH resource 派生，网络由具
//     体 plugin / resource 持有，资产判断走对应 plugin 的 namespace。

import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";
import type { VaultSessionState } from "./vaultSession.js";
import type { CoordinatorCommandResult } from "./sessionCoordinator.js";

export type BsvNetwork = "main" | "test";

/** 私钥元数据，写入 platform K-V repository 时持久化的部分。
 *
 * 硬切换 002 收尾：
 *   - 删除 `id` 字段（vault 内部 uuid）。canonical 主键是 publicKeyHex
 *     （同样也是记录落库前的身份派生前置条件，不允许先随机生成再回填）。
 *   - publicKeyHex 是 ready 记录必填的字段；缺它意味着迁移未完成。
 *   - 系统中**不再**存在 `identityStatus = uninitialized | failed` 的稳态。
 *     本接口上为兼容以前的显式字段不再出现。
 */
export interface KeyRef {
  /** 平台公开身份根字段：压缩公钥 hex；ready 记录必填。 */
  publicKeyHex: string;
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
  /**
   * 兼容字段：派生出来的 BSV 主网地址。**不是 owner 真值，不是
   * key 根身份。** 保留仅用于 Vault 设置页等历史兼容展示；新逻辑
   * 禁止依赖此字段做身份 / 地址判断——业务插件需要地址时，应从
   * P2PKH resource（`p2pkh_addresses` store）按
   * `publicKeyHex + network` 派生。
   */
  address?: string;
  /**
   * 兼容字段：导入时推断的网络。**不是 owner 真值，不是 key 根身
   * 份。** 网络判断由具体 plugin / resource（`p2pkh_addresses` 的
   * `network` 字段）持有；Vault 行上的 `network` 仅作历史兼容展
   * 示。新逻辑禁止依赖此字段做资产 / 网络判断。
   */
  network?: BsvNetwork;
}

/** Key 明文材料：仅在内存中使用，禁止落盘。 */
interface VaultKeyMaterial {
  /** 32 字节十六进制小写编码。 */
  hex: string;
  /** 原始 WIF（如果导入时提供）。 */
  wif?: string;
}

/** Vault 状态机。
 *
 * 硬切换 002 收尾：`VaultStatus = "unlocked"` 的语义被再次收紧。
 *
 * - 旧语义：一份常驻的全局解锁材料放在内存里。
 * - 新语义：表示 Vault 会话**和** keyspace ready 边界都已完成——
 *   1) 当前 session 的解锁材料已在内存；
 *   2) KeyHold v2 record validation（旧记录保持 opaque，不执行私钥迁移）
 *      publicKeyHex）已完成；
 *   3) keyspace.onVaultUnlocked() 已 await 完成（即 keyspace 处于
 *      一致状态，active key 已选定）。
 *
 * 业务插件在 status === "unlocked" 之后才允许读取 key-scoped storage。
 * 旧实现中"unlocked 早于 keyspace ready"会触发
 * "Key storage is not ready"，属于根因泄漏到 UI 的错误。
 *
 * 实现保证：unlock() 的完成顺序必须为
 *   KeyHold v2 validation -> keyspace.onVaultUnlocked -> setStatus("unlocked") + emit
 * 失败时回退到 "locked" 并清空内存会话（fail-closed）。
 */
export type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";

export interface VaultLifecycleSnapshot {
  status: VaultStatus;
  activePublicKeyHex?: string;
  sessionEpoch: string;
  vaultLifecycleRevision: number;
}

/**
 * Versioned ciphertext envelope for plugin-owned local secrets.
 * The fields are intentionally opaque to consumers; plaintext never belongs
 * in the public Vault or protocol contracts.
 */
export interface VaultSealedSecret {
  /** 当前只接受独立域密钥 + salt-bound AAD 的 v2 envelope。 */
  version: 2;
  saltHex: string;
  nonceHex: string;
  ciphertextHex: string;
}

/** Minimal capability for sealing plugin secrets with the Vault password key. */
export interface VaultLocalSecretService {
  seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret>;
  open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array>;
}

/**
 * 私钥导出 envelope（bsv8 key envelope）。
 * 设计缘由：导出必须由 Vault 完成，因为只有 Vault 能接触到明文私钥。
 * importer 插件不能接触明文，因此不能实现导出。
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

/** 一把业务私钥上的 WebAuthn PRF 保护器公开信息。 */
export interface PasskeyProtection {
  /** 本地保护器标识；当前等于 credential id 的 base64url 编码。 */
  id: string;
  /** 用户可读名称，例如“MacBook Touch ID”。 */
  label: string;
  /** WebAuthn relying party id。 */
  rpId: string;
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
}

/**
 * "Key 已落库但未能自动设为 active"专用错误。
 *
 * 设计缘由（硬切换 002 收尾 + 硬切换 009）：
 *   - 出现在 `importPrivateKey` / `generateKey` / `createVaultWithInitialKey`
 *     路径上：K-V 已经写入了新 Key（这一步成功），但 keyspace
 *     `notifyKeyCreated` / `activateCreatedKey` 抛错，active 没切。
 *   - UI 必须**不**把这种错误当作"完全失败"——私钥材料已经安全落库，
 *     用户仍可继续导出 / 删除 / 手动切 active。错误携带完整公开
 *     KeyRef（`err.key`），调用方基于 `err.key.publicKeyHex` 即可对位
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
 * "首 Key 已落库但未自动 active"待展示 notice（硬切换 009 收尾 +
 * 硬切换 002 收尾）。
 *
 * 由 `vault.createVaultWithInitialKey` 命中
 * `KeyPersistedButActivationFailedError` 时设置；UI 通过
 * `vault.getInitialActivationNotice()` 读取并展示。`publicKeyHex` 已
 * 足够定位那一把 key，无需额外的 vault 内部句柄。
 */
export interface InitialActivationNotice {
  publicKeyHex: string;
  label: string;
}

/** Vault 服务：被 plugin-vault 实现并以 "vault.service" capability 暴露。 */
export interface VaultService {
  /** 当前状态。 */
  status(): VaultStatus;
  /** 订阅状态变化，返回取消订阅函数。 */
  onLifecycleChange(handler: (snapshot: VaultLifecycleSnapshot) => void): () => void;
  /** 当前 session 快照；无 session 时返回 null。 */
  getLifecycleSnapshot(): VaultLifecycleSnapshot;

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
   * 由 Vault 统一完成的 active key 切换。
   *
   * 设计缘由：切 active 需要先验证锁屏密码，再重新建立当前 session
   * 的 active-key capability，最后才同步 keyspace active 状态。把这段
   * 事务边界收口到 Vault，避免 UI 先校验密码、再单独调用 keyspace
   * 造成两条真值来源。
   */
  activateKey(input: { publicKeyHex: string; password: string }): Promise<CoordinatorCommandResult>;
  /** 使用指定 WebAuthn PRF 保护器解密并切换 active key。 */
  activateKeyWithPasskey(input: {
    passkeyId: string;
  }): Promise<CoordinatorCommandResult>;
  /** 列出目标私钥的 passkey，供切换私钥界面渲染独立按钮。 */
  listPasskeysForKey(publicKeyHex: string): Promise<PasskeyProtection[]>;
  /** 列出当前 active 私钥的 passkey；不接收公钥，避免双重目标真值。 */
  listCurrentKeyPasskeys(): Promise<PasskeyProtection[]>;
  /**
   * 为当前 active 私钥添加 WebAuthn PRF 保护器。
   * 当前 session 的内存私钥是唯一材料来源，不接收公钥或 Vault 密码。
   */
  addPasskeyToCurrentKey(input: {
    label: string;
  }): Promise<PasskeyProtection>;
  /**
   * 移除一个 passkey 保护器；无需密码，因为这只删除一个冗余解密器，
   * 不会解密或导出私钥。密码保护器始终保留，不能由此接口删除。
   */
  removePasskeyFromCurrentKey(input: {
    passkeyId: string;
  }): Promise<void>;
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
   * 设计缘由（硬切换 009 + 硬切换 002）：
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
   * 设计缘由（硬切换 010 + 硬切换 002 收尾）：
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
   *         加密失败、K-V 写入失败等） —— 内部回滚 meta、清空内存会话、
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
      material: VaultKeyMaterial;
      /** importer 推断出的格式，例如 "wif-mainnet"、"bsv8-key-envelope"。 */
      format: string;
      capabilities: string[];
      source?: string;
    };
  }): Promise<KeyRef>;
  /** 用密码解锁选中的 KeyHold v2 记录；旧记录返回 Unsupported。 */
  unlock(password: string): Promise<CoordinatorCommandResult>;
  /** 锁定，丢弃内存中的明文。 */
  lock(): Promise<CoordinatorCommandResult>;
  /**
   * 修改锁屏密码。
   *
   * 设计缘由：
   *   - 需要同时重加密 `vault_meta` 与全部 `vault_keys`，因此必须由
   *     Vault 自己完成原子轮换，UI 不能拆成"先改 meta 再改 key"。
   *   - 成功后旧密码立即失效，且 Vault 保持锁定状态，不自动重新解锁。
   *   - 失败必须保持旧数据可用，不写入半成品记录。
   */
  changePassword(input: { oldPassword: string; newPassword: string }): Promise<void>;
  /** 硬切换 001：宿主 teardown 时调用。幂等：可重复调用；可容忍部分资源已清。 */
  dispose?(): void;

  /**
   * 仅校验锁屏密码是否正确，不改变 Vault 状态；仅供解锁、密码变更等
   * 仍需密码的流程。私钥删除由 KeyspaceService 的 label confirmation
   * 授权，不使用此方法。
   *
   * 设计缘由：
   *   - 业务插件不能复制一套密码校验逻辑；需要密码的流程统一由
   *     Vault 自己拿 verifier 比对。
   *   - 与 `unlock(password)` 严格区分：
   *       * `unlock` 会派生当前 session 材料并验证 KeyHold v2 文档、
   *         通知 keyspace、emit `vault.unlocked`，创建一段新会话；
   *       * `verifyPassword` **只**比对 verifier，不会改变 session 材料
   *         / `keyCache` / `status`，不会触发 migration，
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
   *     不能由 keyspace 越层动 `vaultKeyRepository.deleteMeta()`，也不能让 UI 凭
   *     "本地列表 length === 0"自己跳转；状态源必须是 Vault。
   *   - 仅允许在"Vault 仍存在但 key 列表已空"的收尾场景调用；否则
   *     fail closed。具体来说：
   *       * 进入时必须**再次**确认 `vault_keys` 为空（哪怕 keyspace
   *         判断剩余 0；fail-closed 防御）；
   *       * 不空则抛错，例如 `Vault still has keys`，绝不能继续删
   *         meta 把用户其它 key 弄成"无 meta、有 key"的脏状态。
   *   - 内部必须：清理内存会话（session 材料 / keyCache）
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
  /**
   * 按 publicKeyHex 查找 key 元数据——平台身份查找的主路径。
   *
   * 设计缘由：硬切换后系统不再存在 vault 内部 uuid 主键；任何需要
   * 定位 key 的调用方都按 `publicKeyHex` 走。地址查找如果仍需保留，
   * 由 `findByAddress` 兜底。
   */
  getKey(publicKeyHex: string): Promise<KeyRef | undefined>;
  /**
   * 兼容接口：按 address 查找 key 元数据。
   * 设计缘由：保留只是给历史路径兜底；新代码应使用 `getKey(publicKeyHex)`。
   */
  findByAddress?(address: string): Promise<KeyRef | undefined>;

  /** 导入一个私钥，保存后返回 KeyRef。允许同一个 vault 存在多个 key。 */
  importPrivateKey(input: {
    password: string;
    label: string;
    material: VaultKeyMaterial;
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
   *     按现有加密规则写入 `vault_keys`（keyPath = publicKeyHex），并复用
   *     `importPrivateKey` 的身份派生、重复检查、active 切换与事件发布路径。
   *   - 仅允许 Vault 已解锁时调用；locked 状态必须 fail closed。
   *   - 默认 `capabilities = ["p2pkh"]`；记录字段固定为
   *     `format = "generated"`、`source = "vault-generated"`，方便审计
   *     与回归测试。
   *
   * 不在公开契约中暴露：明文 hex / WIF、`material`、随机源替代接口。
  */
  generateKey(input: {
    password: string;
    label: string;
    capabilities?: string[];
  }): Promise<KeyRef>;
  /**
   * 删除一个 key 及其加密材料（硬切换 008 + 硬切换 002）。
   * 设计缘由：实际删除流程由 keyspace.deleteKey 统一调度：
   *   1) background.cancelByKey
   *   2) 关闭 owner K-V Repository handle
   *   3) 删除 owner namespace 的 K-V 内容
   *   4) vault.deleteKeyMaterial（仅删私钥材料，不发 key.deleted 事件）
   *   5) emit key.deleted（由 keyspace 统一发一次）
   * 不允许业务插件直接调本方法绕过 keyspace。
   */
  deleteKeyMaterial(publicKeyHex: string): Promise<void>;
  /**
   * @deprecated 改用 keyspace.deleteKey。本方法保留仅为满足 contract 编译，
   * 实际调用将抛出 "Use keyspace.deleteKey instead"。
   */
  removeKey(publicKeyHex: string): Promise<void>;

  /**
   * 导出单 Key Backup。
   * v2 备份把密码与所有 WebAuthn PRF passkey 作为独立 protectors 导出；
   * 任一仍可用的 protector 都对应同一把业务私钥。导出不接触明文私钥。
   * 返回值是可直接下载的 JSON 字符串。
   */
  exportKeyBackup(publicKeyHex: string): Promise<string>;
  /** 导出当前 active 私钥的加密备份；不接收公钥。 */
  exportCurrentKeyBackup(): Promise<string>;
  /**
   * 导入单 Key Backup。
   * 设计缘由：恢复需要来源 Vault 密码和目标 Vault 密码，导入侧不接触
   * 明文私钥，只负责按目标 Vault 重新加密并落库。
   */
  importKeyBackup?(input: {
    backup: string;
    sourcePassword: string;
    targetPassword: string;
  }): Promise<KeyRef>;

  /**
   * 返回受控 active key capability。调用方不能拿到 raw private key。
   */
  createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto>;
  /**
   * 为独立 appView session 创建专属 worker capability。
   * appView 不能复用 Keymaster 当前 session capability。
   */
  createAppViewSession(input: {
    sessionId: string;
    publicKeyHex: string;
    password: string;
  }): Promise<ActiveKeyCrypto>;
  /** 销毁单个 appView session。 */
  disposeAppViewSession(sessionId: string, reason?: string): void;
  /** 销毁全部 appView session。 */
  disposeAllAppViewSessions(reason?: string): void;

  /* ============== appView owner runtime bootstrap ============== */
  // 设计缘由（施工单 2026-06-30 002）：
  //   - appView Session Window **不**导入整套 vault runtime；
  //     launcher 用受控 `createAppViewSession({ sessionId, publicKeyHex, password })`
  //     capability，交给 Session Window 拼成 `SessionRuntimeBootstrap`。
  //   - 旧的 runtime handoff 已删除：不允许让 appView Session Window
  //     模拟"完整解锁钱包窗口"。
  //   - Session Window 在 appView mode 下可以是 `locked` 态——业务方法
  //     是否可执行取决于 `OwnerExecutionRuntime` 能否解析到：
  //     `bootstrap_runtime`（Session Window 启动早期注入的）；
  //     appView mode 不允许后续回退到 `vault_runtime`。
  //   - 未来若要支持"为单 key 持久化"或"key 级别跨窗口 unlock"，
  //     另出一份施工单；本接口**不**重开 unlock runtime export/import。
}
