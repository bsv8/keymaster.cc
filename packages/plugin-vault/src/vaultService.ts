// packages/plugin-vault/src/vaultService.ts
// VaultService 实现。
// 关键不变量：
//   - 明文私钥只存在于 withPrivateKey 回调闭包内，回调结束即丢。
//   - 不持有全局明文缓存；多签名者顺序调用即依次解密。
//   - 状态机：booting -> uninitialized -> locked -> unlocked。
//   - 导出必须由 Vault 完成，因为只有 Vault 能通过 withPrivateKey 受控借用明文私钥。
//   - importPrivateKey 必须拒绝重复 publicKeyHash；错误信息使用英文。
//   - unlock 后必须执行一次 identity backfill：逐个 withPrivateKey 派生
//     publicKeyHex / publicKeyHash / fingerprint 并回写。backfill 失败的 key
//     标 identity-failed，只允许导出 / 删除。
//   - emit key.created / key.deleted 时 payload 携带 publicKeyHash，让
//     keyspace.deleteKey 能直接定位。
// 硬切换 008：unlock 完成边界收紧——"unlocked" 对 UI / 业务插件的语义是
// "keyspace ready 边界已完成，业务可以安全读取 key-scoped storage"。具体
// 顺序：password 校验 -> backfillIdentities -> keyspace.onVaultUnlocked ->
// setStatus("unlocked") + emit。失败时回退到 locked 并清空内存会话。

import type { MessageBus } from "@keymaster/runtime";
import type {
  KeyExportEnvelope,
  KeyIdentity,
  KeyRef,
  PrivateKeyMaterial,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import {
  assertWebCryptoAvailable,
  bytesToHex,
  decryptBytes,
  deriveKey,
  encryptBytes,
  encryptVerifier,
  hexToBytes,
  verifyVerifier
} from "./crypto.js";
import { encryptBsv8KeyEnvelope } from "./keyEnvelope.js";
import { deriveKeyIdentity, generatePrivateKeyHex } from "./keyIdentity.js";
import { vaultDb, type VaultKeyRecord, type VaultMetaRecord } from "./vaultDb.js";
import type { KeyspaceHandle } from "./keyspaceService.js";

/**
 * 写库成功但通知 keyspace 切 active 失败的专用错误。
 *
 * 设计缘由（硬切换 002 收尾）：`persistPrivateKey` 的契约是
 *   1) vaultDb.putKey(...)  // 已落库
 *   2) keyspace.notifyKeyCreated(...)  // 切 active
 *   3) messageBus.publish("key.created", ...)  // 通知订阅者
 *
 * 如果 2) 抛错：DB 里已经有这把新 key，但 active 没切。旧实现把 2) 的
 * 错误原样抛出，UI 看到"创建失败"提示，会让用户重复点击（实际 DB
 * 已经有 key 了）。同时 3) 是否应该发也成了问题——发出"key.created"
 * 但 keyspace.active() 不是这把，订阅者会读到不一致状态。
 *
 * 修复后：
 *   - 2) 抛错时进入"已落库但未激活"分支，抛 `KeyPersistedButActivationFailedError`，
 *     携带完整公开 `KeyRef`（`key` 字段），让 UI 进入"已保存但未 active"
 *     的成功/警告态（不要回到可重复提交的失败态），且能直接用 `err.key.id`
 *     等真值继续导出 / 删除 / 设 active，不再需要去兜底列表里反查。
 *   - 3) 在 active 切换成功之后才发；active 失败时不发"key.created"，
 *     避免订阅者从 event handler 中读 keyspace.active() 时看到与
 *     payload publicKeyHash 不一致的状态。
 *   - DB 写入发生在 1) 之后才允许 2) / 3)，确保不会发"key.created"
 *     但 DB 里没有的虚假事件。
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

/** Vault 标签最大长度。超出时拒绝写入。 */
const LABEL_MAX_LENGTH = 64;
/** generateKey 默认能力。 */
const DEFAULT_CAPABILITIES: string[] = ["p2pkh"];
/** generateKey 记录元数据：审计 / 回归测试使用。 */
const GENERATED_FORMAT = "generated";
const GENERATED_SOURCE = "vault-generated";

export interface VaultServiceDeps {
  messageBus: MessageBus;
  keyspace?: KeyspaceHandle;
}

export function createVaultService(deps: VaultServiceDeps): VaultService {
  const statusListeners = new Set<(s: VaultStatus) => void>();
  let status: VaultStatus = "booting";
  /** 当前解锁后的派生 key；锁定时为 null。 */
  let masterKey: CryptoKey | null = null;
  /** 当前解锁后的 master salt。 */
  let masterSalt: Uint8Array | null = null;
  /** 当前 key 列表的内存缓存（identity 字段已就绪），避免每次都 await IndexedDB。 */
  let keyCache: KeyRef[] | null = null;

  function setStatus(next: VaultStatus) {
    status = next;
    for (const l of statusListeners) l(next);
    if (next === "locked" || next === "uninitialized") {
      // 锁定时清空内存会话：明文 key 与 salt 全部丢弃。
      masterKey = null;
      masterSalt = null;
      keyCache = null;
    }
  }

  async function bootstrap() {
    try {
      assertWebCryptoAvailable();
      const meta = await vaultDb.getMeta();
      setStatus(meta ? "locked" : "uninitialized");
    } catch (err) {
      console.error("Vault bootstrap failed", err);
      setStatus("uninitialized");
    }
  }

  bootstrap();

  function requireMasterKey(): { key: CryptoKey; salt: Uint8Array } {
    if (!masterKey || !masterSalt) throw new Error("Vault is locked");
    return { key: masterKey, salt: masterSalt };
  }

  async function decryptMaterial(record: VaultKeyRecord): Promise<PrivateKeyMaterial> {
    const { key } = requireMasterKey();
    const plain = await decryptBytes(key, {
      salt: hexToBytes(record.cipherSaltB64),
      iv: hexToBytes(record.cipherIvB64),
      ciphertext: hexToBytes(record.cipherB64)
    });
    const decoded = new TextDecoder().decode(plain);
    const parsed = JSON.parse(decoded) as { hex: string; wif?: string };
    return { hex: parsed.hex, wif: parsed.wif };
  }

  function recordToRef(record: VaultKeyRecord): KeyRef {
    return {
      id: record.id,
      label: record.label,
      address: record.address || undefined,
      network: record.network,
      format: record.format,
      capabilities: record.capabilities,
      createdAt: record.createdAt,
      source: record.source,
      publicKeyHex: record.publicKeyHex,
      publicKeyHash: record.publicKeyHash,
      fingerprint: record.fingerprint,
      // 硬切换 008：把 vaultDb 中的 identityStatus 透传给 KeyRef 消费者
      // （keyspaceService 依赖此字段过滤 failed key）。
      identityStatus: record.identityStatus ?? "ready",
      // 透传 backfill 失败原因，供 UI 在 VaultSettingsPage 展示并定位问题。
      identityError: record.identityError
    };
  }

  async function recordToIdentity(record: VaultKeyRecord): Promise<KeyIdentity> {
    if (!record.publicKeyHash || !record.publicKeyHex) {
      throw new Error("Identity not initialized");
    }
    return {
      keyId: record.id,
      publicKeyHex: record.publicKeyHex,
      publicKeyHash: record.publicKeyHash,
      fingerprint: record.fingerprint ?? "",
      label: record.label,
      capabilities: record.capabilities,
      createdAt: record.createdAt,
      identityStatus: "ready"
    };
  }

  async function refreshKeyCache() {
    const records = await vaultDb.listKeys();
    keyCache = records.map(recordToRef);
  }

  /**
   * identity backfill：unlock 后逐把 key 走 withPrivateKey 派生公钥并写回。
   * 失败 key 标 identity-failed，但仍保持 unlocked。
   * 硬切换 008：
   *   - 整个 backfill 阶段通过 deps.keyspace?.setInitializing(true/false)
   *     暴露给 UI（KeySwitchWidget 显示"初始化中"）。
   *   - 失败时写 vaultDb.putKeyIdentityFailed 把状态持久化，keyspace 不会
   *     把这把 key 选为 active 候选。
   *   - 成功时发 key.identity.ready 事件；失败时发 key.identity.failed 事件。
   */
  async function backfillIdentities() {
    deps.keyspace?.setInitializing(true);
    try {
      const records = await vaultDb.listKeys();
      for (const record of records) {
        if (record.publicKeyHash && record.publicKeyHex && record.fingerprint) {
          // 已有完整 identity：确保 status 字段也是 ready（老 v2 记录可能
          // 没有该字段，按 ready 处理）。
          if (record.identityStatus !== "ready") {
            await vaultDb.putKeyIdentityReady(record.id);
          }
          continue;
        }
        try {
          const material = await decryptMaterial(record);
          const identity = deriveKeyIdentity(material.hex);
          // 写入 DB（同时把 identityStatus 置为 "ready"、清 identityError）。
          await vaultDb.putKeyIdentity(record.id, identity);
          // 通过事件通知 keyspace 重建候选。
          deps.messageBus.publish("key.identity.ready", {
            keyId: record.id,
            publicKeyHash: identity.publicKeyHash,
            publicKeyHex: identity.publicKeyHex,
            fingerprint: identity.fingerprint,
            label: record.label,
            capabilities: record.capabilities,
            createdAt: record.createdAt
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // 持久化失败状态——下次 unlock 时这把 key 不会作为候选。
          try {
            await vaultDb.putKeyIdentityFailed(record.id, errMsg);
          } catch (writeErr) {
            // 写失败状态本身失败：仍发事件让上游知道，但不让 vault 启动失败。
            console.error("vaultDb.putKeyIdentityFailed failed", record.id, writeErr);
          }
          deps.messageBus.publish("key.identity.failed", {
            keyId: record.id,
            label: record.label,
            error: errMsg
          });
        }
      }
      await refreshKeyCache();
    } finally {
      deps.keyspace?.setInitializing(false);
    }
  }

  /**
   * 硬切换 002：从 importPrivateKey 抽出的统一私钥持久化内部函数。
   * 负责：trim 标签 / 校验长度 / 派生公钥身份 / 重复检查 / 加密私钥 /
   * 写入 vault_keys / 清 keyCache / 通知 keyspace 新 Key / 发布 key.created。
   *
   * 设计缘由：importPrivateKey 与 generateKey 的差异只在私钥材料来源；
   * 加密、身份、active 切换、事件语义必须完全一致——任何一处复制实现
   * 都会让"用户能安全生成新 Key"的承诺与"用户能导入私钥"的现有行为
   * 出现偏差。
   */
  async function persistPrivateKey(input: {
    material: PrivateKeyMaterial;
    label: string;
    format: string;
    capabilities: string[];
    source?: string;
  }): Promise<KeyRef> {
    // 1) 锁定守卫：locked 状态 fail closed，避免在外层调用方
    //    看不到错误就泄漏。
    const { key } = requireMasterKey();
    // 2) 标签校验：trim / 非空 / 长度上限。空标签和超长标签在入口
    //    一律拒绝，错误信息使用英文。
    const label = input.label.trim();
    if (!label) throw new Error("Label is required");
    if (label.length > LABEL_MAX_LENGTH) {
      throw new Error(`Label must be at most ${LABEL_MAX_LENGTH} characters`);
    }
    // 3) 派生公钥身份并按 publicKeyHash 重复检查。
    const identity = deriveKeyIdentity(input.material.hex);
    const existing = await vaultDb.getKeyByPublicKeyHash(identity.publicKeyHash);
    if (existing) {
      throw new Error("Key already exists");
    }
    // 4) 加密私钥材料。原始 hex/WIF 不会落盘，也不会出现在 KeyRef。
    const payload = new TextEncoder().encode(
      JSON.stringify({ hex: input.material.hex, wif: input.material.wif })
    );
    const blob = await encryptBytes(key, payload);
    const id = crypto.randomUUID();
    const record: VaultKeyRecord = {
      id,
      label,
      address: "",
      network: "main",
      format: input.format,
      capabilities: input.capabilities,
      createdAt: new Date().toISOString(),
      source: input.source,
      cipherSaltB64: bytesToHex(blob.salt),
      cipherIvB64: bytesToHex(blob.iv),
      cipherB64: bytesToHex(blob.ciphertext),
      publicKeyHex: identity.publicKeyHex,
      publicKeyHash: identity.publicKeyHash,
      fingerprint: identity.fingerprint
    };
    // 5) DB 写入必须发生在 notify / emit 之前——失败时 keyspace
    //    不会误把不存在的 key 选为 active，订阅者也不会收到
    //    "key.created" 但 DB 里没有的虚假事件。
    await vaultDb.putKey(record);
    const ref = recordToRef(record);
    keyCache = null;
    // 6) 先通知 keyspace（内部把新 key 注册为 active），
    //    再 emit key.created；订阅者看到的 active 已切好。
    //
    // 硬切换 002 收尾：如果 keyspace 通知失败，DB 已经有这把 key，
    // 但 active 没切。抛 `KeyPersistedButActivationFailedError` 让 UI
    // 进入"已保存但未 active"的成功/警告态，**不**发 "key.created"——
    // 否则订阅者从事件 handler 读 keyspace.active() 会看到与 payload
    // publicKeyHash 不一致的状态（payload 是新 key，active 是旧 key）。
    if (deps.keyspace) {
      try {
        deps.keyspace.notifyKeyCreated(await recordToIdentity(record));
      } catch (notifyErr) {
        throw new KeyPersistedButActivationFailedError({
          key: ref,
          cause: notifyErr
        });
      }
    }
    // 7) 仅在 active 切换成功后才发 key.created。
    deps.messageBus.publish("key.created", {
      keyId: ref.id,
      publicKeyHash: identity.publicKeyHash,
      label
    });
    return ref;
  }

  return {
    status() {
      return status;
    },
    onStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },

    async hasVault() {
      return Boolean(await vaultDb.getMeta());
    },

    /**
     * 硬切换 008：createVault 同样需要 ready 边界。首次创建时 keyspace
     * 内部无 key（listActiveCandidates 为空 -> mode="all"）；但仍必须
     * 显式调用 onVaultUnlocked 让 keyspace 触发 setActiveInternal("all")
     * 并保持状态机一致，再 setStatus + emit。
     *
     * 失败回滚（硬切换 008 收尾）：
     *   - meta 已写入 DB
     *   - keyspace.onVaultUnlocked 抛错时，必须把 meta 也删掉，回退到
     *     "uninitialized" 状态。否则出现"内存说未初始化、存储里
     *     已有 Vault meta"的不一致——bootstrap 会把状态读到 locked
     *     而 UI 期望 uninitialized，导入 / 解锁链路都会错位。
     *   - in-memory 的 masterKey / masterSalt 必须清空，与 uninitialized
     *     状态匹配。
     */
    async createVault(password) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      const verifier = await encryptVerifier(key);
      const meta: VaultMetaRecord = {
        id: "singleton",
        saltB64: bytesToHex(salt),
        verifierSaltB64: bytesToHex(verifier.salt),
        verifierIvB64: bytesToHex(verifier.iv),
        verifierCipherB64: bytesToHex(verifier.ciphertext),
        createdAt: new Date().toISOString()
      };
      await vaultDb.putMeta(meta);
      masterSalt = salt;
      masterKey = key;
      try {
        // 与 unlock 一致：先把 keyspace 推到 ready 状态，再宣布 unlocked。
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
      } catch (err) {
        // 设计缘由：createVault 失败时必须把 meta 也删掉，保证"状态 =
        // uninitialized"与"存储里没有 Vault"一致。删除 meta 失败时仍
        // 把状态回退、抛出原始错误——不掩盖 keyspace 错误的根因。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error("vaultDb.deleteMeta failed during createVault rollback", deleteErr);
        }
        masterSalt = null;
        masterKey = null;
        setStatus("uninitialized");
        throw err;
      }
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
    },

    /**
     * 硬切换 008：unlock 的完成边界。
     * 目标顺序（必须严格按此执行）：
     *   1) 校验 meta / password
     *   2) 派生 masterKey / masterSalt 并放入内存（backfill 需要解密）
     *   3) backfillIdentities()：逐把 key 派生公钥身份并写库
     *   4) deps.keyspace.onVaultUnlocked()：选择 active key（single 模式）
     *   5) setStatus("unlocked") + emit "vault.unlocked"
     * 业务主界面（UnlockedShell / P2PKH widget）只在 status === "unlocked" 后
     * 渲染，keyspace 也已 ready，避免 widget 抢跑触发 "Key storage is not ready"。
     * 失败时必须清理 masterKey / masterSalt 并回退到 locked，避免 UI 仍停
     * 在 locked 但内存里有解锁态材料。
     */
    async unlock(password) {
      const meta = await vaultDb.getMeta();
      if (!meta) throw new Error("Vault not initialized");
      const salt = hexToBytes(meta.saltB64);
      const key = await deriveKey(password, salt);
      const ok = await verifyVerifier(key, {
        salt: hexToBytes(meta.verifierSaltB64),
        iv: hexToBytes(meta.verifierIvB64),
        ciphertext: hexToBytes(meta.verifierCipherB64)
      });
      if (!ok) throw new Error("Invalid password");
      masterSalt = salt;
      masterKey = key;
      try {
        // 1) identity backfill：失败 key 单独标 failed，不影响整体 unlocked。
        await backfillIdentities();
        // 2) keyspace 选择 active key：必须发生在 setStatus/emit 之前，
        //    否则业务插件看到 unlocked 时 active 仍是初始化期状态。
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
      } catch (err) {
        // 设计缘由：ready 边界由状态机保证；backfill 内部已 catch 单把
        // key 失败，抛到这里意味着出现了不可恢复错误（例如 keyspace
        // 抛错或 DB 不可写）。必须清理 in-memory 会话，避免 UI 仍停在
        // locked 但内存持有派生 key；同时不回 emit。
        setStatus("locked");
        throw err;
      }
      // 3) 业务可见的 unlocked：必须放到 keyspace ready 之后。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
    },

    async lock() {
      setStatus("locked");
      if (deps.keyspace) {
        deps.keyspace.onVaultLocked();
      }
      deps.messageBus.publish("vault.locked", { at: new Date().toISOString() });
    },

    async listKeys() {
      if (keyCache) return keyCache;
      await refreshKeyCache();
      return keyCache ?? [];
    },

    async getKey(id) {
      const r = await vaultDb.getKey(id);
      return r ? recordToRef(r) : undefined;
    },

    async getKeyByPublicKeyHash(publicKeyHash) {
      const r = await vaultDb.getKeyByPublicKeyHash(publicKeyHash);
      return r ? recordToRef(r) : undefined;
    },

    async findByAddress(address) {
      const r = await vaultDb.getKeyByAddress(address);
      return r ? recordToRef(r) : undefined;
    },

    async importPrivateKey(input) {
      return persistPrivateKey({
        material: input.material,
        label: input.label,
        format: input.format,
        capabilities: input.capabilities,
        source: input.source
      });
    },

    /**
     * 硬切换 002：Vault 内部安全生成新 Key。
     * 私钥由 noble secp256k1 `utils.randomPrivateKey()` 产生，仅在
     * 局部闭包内存在；身份派生、加密、active 切换、事件发布全部复用
     * `persistPrivateKey` 这条统一路径。
     */
    async generateKey(input) {
      // 1) 锁定 fail closed。放在调用 noble 之前，避免产生私钥材料
      //    之后才发现需要清场。
      requireMasterKey();
      // 2) 在 Vault 内部生成 secp256k1 私钥 hex。noble 内部走
      //    crypto.getRandomValues，安全随机源。
      const hex = generatePrivateKeyHex();
      // 3) 共用持久化路径：把 material 喂给 importPrivateKey 同一套
      //    加密 / 身份派生 / 事件流程。生成记录写死
      //    format="generated"、source="vault-generated"、capabilities
      //    默认为 ["p2pkh"]，方便审计与回归测试。
      return persistPrivateKey({
        material: { hex },
        label: input.label,
        format: GENERATED_FORMAT,
        capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
        source: GENERATED_SOURCE
      });
    },

    async removeKey(id) {
      // 硬切换 008：删除流程必须经过 keyspace.deleteKey。
      // 业务插件直接调本方法会绕过 background.cancelByKey 与 namespace DB
      // 清理，必须抛错拒绝。
      throw new Error("Use keyspace.deleteKey instead");
    },

    /**
     * 硬切换 008：实际删除私钥材料，但**不发** key.deleted 事件。
     * key.deleted 由 keyspace.deleteKey 在 namespace DB 全部删除成功后
     * 统一发一次，确保全流程只发一次。
     */
    async deleteKeyMaterial(id) {
      await vaultDb.deleteKey(id);
      keyCache = null;
    },

    async exportPrivateKey({ keyId, password }) {
      // 设计缘由：明文私钥只能从 withPrivateKey 借出，因此导出必须经过 Vault。
      // 这里不修改 key 列表、不触发 key.created / key.deleted 事件。
      if (!password) throw new Error("Backup password is required");
      const record = await vaultDb.getKey(keyId);
      if (!record) throw new Error("Unknown key");
      return this.withPrivateKey(keyId, (material) =>
        encryptBsv8KeyEnvelope(material.hex, password)
      );
    },

    async withPrivateKey(id, fn) {
      const record = await vaultDb.getKey(id);
      if (!record) throw new Error(`Unknown key ${id}`);
      const material = await decryptMaterial(record);
      try {
        return await fn(material);
      } finally {
        // material 在闭包结束后不再可达，由 GC 回收。
        // 这里不显式 zero，避免额外开销且不真正安全。
      }
    }
  };
}
