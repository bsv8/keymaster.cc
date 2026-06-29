// packages/plugin-vault/src/vaultService.ts
// VaultService 实现。
// 关键不变量：
//   - 明文私钥只存在于 withPrivateKey 回调闭包内，回调结束即丢。
//   - 不持有全局明文缓存；多签名者顺序调用即依次解密。
//   - 状态机：booting -> uninitialized -> locked -> unlocked。
//   - 导出必须由 Vault 完成，因为只有 Vault 能通过 withPrivateKey 受控借用明文私钥。
//   - importPrivateKey 必须拒绝重复 publicKeyHex；错误信息使用英文。
//   - unlock 后必须执行一次 identity backfill：逐个 withPrivateKey 派生
//     publicKeyHex 并回写。backfill 失败的 key
//     标 identity-failed，只允许导出 / 删除。
//   - emit key.created / key.deleted 时 payload 携带 publicKeyHex，让
//     keyspace.deleteKey 能直接定位。
// 硬切换 008：unlock 完成边界收紧——"unlocked" 对 UI / 业务插件的语义是
// "keyspace ready 边界已完成，业务可以安全读取 key-scoped storage"。具体
// 顺序：password 校验 -> backfillIdentities -> keyspace.onVaultUnlocked ->
// setStatus("unlocked") + emit。失败时回退到 locked 并清空内存会话。
//
// 硬切换 003 收尾：
//   - 系统不再生成、缓存、回写、透传 `fingerprint` 字段。
//   - 短公钥属于 UI 显示格式，**不**在 vault 层派生。展示时由 UI
//     调 `formatShortPublicKey(publicKeyHex)` 现算。
//   - 旧库残留 `fingerprint` 仍可能存在于 `vault_keys` 记录上，读取时
//     忽略，回写时也不再续命。

import type { MessageBus } from "@keymaster/runtime";
import {
  EVENT_ACTIVE_KEY_CHANGED,
  KeyPersistedButActivationFailedError,
  type ActiveKeyState,
  type KeyExportEnvelope,
  type KeyIdentity,
  type KeyRef,
  type PluginLogger,
  type PrivateKeyMaterial,
  type UnlockRuntimeHandoff,
  type VaultService,
  type VaultStatus
} from "@keymaster/contracts";
import {
  aesGcmKeyFromRawBits,
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

// 透传 contracts 中的 KeyPersistedButActivationFailedError：
// plugin-vault 内部旧实现 / 测试仍可直接 import 本文件的符号，
// 行为与直接 import contracts 完全一致。设计缘由见 contracts/src/vault.ts。
export { KeyPersistedButActivationFailedError };

/**
 * "首 Key 已落库但未自动 active"待展示 notice。
 *
 * 设计缘由（硬切换 009 收尾）：之前这条 notice 走 messageBus
 * `vault.created.persisted` 事件 + 页面级订阅，但消息总线事件是瞬时的，
 * 用户从 LockedShell 跳到首页时，VaultSettingsPage 通常尚未挂载，
 * 订阅方收不到事件，notice 消失。
 *
 * 修复后改用可查询的 vault state：
 *   - `createVaultWithInitialKey` 命中 `KeyPersistedButActivationFailedError`
 *     时写入本 notice；
 *   - AppShell / 顶栏在挂载时通过 `getInitialActivationNotice()` 读取并展示
 *     提示横幅；
 *   - 用户手动切 active 后（active 变成这把 key）、用户 lock 后、或
 *     显式调 `clearInitialActivationNotice()` 后，notice 自动清空。
 */
export interface InitialActivationNotice {
  keyId: string;
  publicKeyHex?: string;
  label: string;
}

/** Vault 标签最大长度。超出时拒绝写入。 */
const LABEL_MAX_LENGTH = 64;
/** generateKey 默认能力。 */
const DEFAULT_CAPABILITIES: string[] = ["p2pkh"];
/** generateKey 记录元数据：审计 / 回归测试使用。 */
const GENERATED_FORMAT = "generated";
const GENERATED_SOURCE = "vault-generated";

/**
 * 首启"新建钱包"默认标签：`Key YYYY-MM-DD HH:mm`。
 * 收敛在 Vault 内部：shell / VaultSettingsPage 复用同一格式。
 */
function defaultInitialKeyLabel(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `Key ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export interface VaultServiceDeps {
  messageBus: MessageBus;
  keyspace?: KeyspaceHandle;
  /**
   * 硬切换 002：业务插件注入的 logger。
   * vault 关键轨迹（unlock / lock / key created / deleted / active changed /
   * identity failed）走统一日志。不传时不记日志。
   */
  logger?: PluginLogger;
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
  /**
   * "首 Key 已落库但未自动 active"待展示 notice。
   * 见 {@link InitialActivationNotice}。
   */
  let pendingActivationNotice: InitialActivationNotice | null = null;
  /** notice 变化订阅器。 */
  const noticeListeners = new Set<(n: InitialActivationNotice | null) => void>();
  /** messageBus 事件订阅的清理句柄。bootstrap 后挂载，setStatus(unlocked) 时启用。 */
  let activeChangeUnsub: (() => void) | null = null;

  function setPendingActivationNotice(next: InitialActivationNotice | null) {
    if (
      next === pendingActivationNotice ||
      (next && pendingActivationNotice && next.keyId === pendingActivationNotice.keyId)
    ) {
      return;
    }
    pendingActivationNotice = next;
    for (const l of noticeListeners) l(next);
  }

  function setStatus(next: VaultStatus) {
    status = next;
    for (const l of statusListeners) l(next);
    if (next === "locked" || next === "uninitialized") {
      // 锁定时清空内存会话：明文 key 与 salt 全部丢弃。
      masterKey = null;
      masterSalt = null;
      keyCache = null;
      // 锁定时清除"首 Key 未激活"notice：会话结束，下一次 unlock
      // 不应再展示上一次会话的 notice。
      setPendingActivationNotice(null);
      deps.logger?.info({
        scope: "vault.lifecycle",
        event: "vault.locked",
        message: "Vault locked"
      });
      if (activeChangeUnsub) {
        activeChangeUnsub();
        activeChangeUnsub = null;
      }
    } else if (next === "unlocked") {
      deps.logger?.info({
        scope: "vault.lifecycle",
        event: "vault.unlocked",
        message: "Vault unlocked"
      });
      // 解锁后挂载 active 变化监听：如果用户随后手动把 notice 那把 key
      // 设为 active，自动清除 notice。
      if (!activeChangeUnsub) {
        const handler = (state: ActiveKeyState) => {
          if (
            pendingActivationNotice &&
            pendingActivationNotice.publicKeyHex &&
            state.activePublicKeyHex === pendingActivationNotice.publicKeyHex
          ) {
            setPendingActivationNotice(null);
          }
        };
        activeChangeUnsub = deps.messageBus.subscribe(EVENT_ACTIVE_KEY_CHANGED, handler);
      }
    }
  }

  async function bootstrap() {
    try {
      assertWebCryptoAvailable();
      const meta = await vaultDb.getMeta();
      if (!meta) {
        setStatus("uninitialized");
        return;
      }
      // 硬切换 005 收尾：meta 存在但 vault_keys 已空是异常态——
      // 不允许进入"locked / unlocked 但 0 key"的假状态。直接清理 meta
      // 并收敛到 uninitialized，让用户进入首启 welcome。
      const keys = await vaultDb.listKeys();
      if (keys.length === 0) {
        try {
          await vaultDb.deleteMeta();
        } catch (delErr) {
          console.error("vaultDb.deleteMeta during empty-bootstrap failed", delErr);
        }
        setStatus("uninitialized");
        return;
      }
      setStatus("locked");
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
      // 硬切换 008：把 vaultDb 中的 identityStatus 透传给 KeyRef 消费者
      // （keyspaceService 依赖此字段过滤 failed key）。
      identityStatus: record.identityStatus ?? "ready",
      // 透传 backfill 失败原因，供 UI 在 VaultSettingsPage 展示并定位问题。
      identityError: record.identityError
    };
  }

  async function recordToIdentity(record: VaultKeyRecord): Promise<KeyIdentity> {
    if (!record.publicKeyHex) {
      throw new Error("Identity not initialized");
    }
    return {
      keyId: record.id,
      publicKeyHex: record.publicKeyHex,
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
   *
   * 硬切换 003 收尾：
   *   - 只回写 publicKeyHex，不再回写 fingerprint。
   *   - 老记录已有 fingerprint 字段时，putKeyIdentity 内部已白名单构造
   *     字段，不会把 fingerprint 续命。
   *   - key.identity.ready payload 也不再带 fingerprint（订阅方需要短公钥
   *     时由 UI 侧现算）。
   *
   * 硬切换 001 收口：identity 字段统一为 publicKeyHex；vault 内部已不
   * 再保留旧的平台 namespace 派生字段。
   */
  async function backfillIdentities() {
    deps.keyspace?.setInitializing(true);
    try {
      const records = await vaultDb.listKeys();
      for (const record of records) {
        if (record.publicKeyHex) {
          // 已有完整 identity：确保 status 字段也是 ready（老 v2 记录可能
          // 没有该字段，按 ready 处理）。即便老记录还残留 fingerprint，
          // putKeyIdentityReady 内部也是白名单构造，不会写回。
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
          // 通过事件通知 keyspace 重建候选。payload 不再带 fingerprint。
          deps.messageBus.publish("key.identity.ready", {
            keyId: record.id,
            publicKeyHex: identity.publicKeyHex,
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
    // 3) 派生公钥身份并按 publicKeyHex 重复检查。
    const identity = deriveKeyIdentity(input.material.hex);
    const existing = await vaultDb.getKeyByPublicKeyHex(identity.publicKeyHex);
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
      publicKeyHex: identity.publicKeyHex
    };
    // 5) DB 写入必须发生在 notify / emit 之前——失败时 keyspace
    //    不会误把不存在的 key 选为 active，订阅者也不会收到
    //    "key.created" 但 DB 里没有的虚假事件。
    await vaultDb.putKey(record);
    const ref = recordToRef(record);
    keyCache = null;
    // 6) 先通知 keyspace（内部把新 key 注册为 active），再 emit key.created；
    //    订阅者看到的 active 已切好。
    //
    // 硬切换 002 收尾：如果 keyspace 通知失败，DB 已经有这把 key，但 active
    // 没切。抛 `KeyPersistedButActivationFailedError` 让 UI 进入"已保存但
    // 未 active"的成功/警告态，**不**发 "key.created"——否则订阅者从
    // 事件 handler 读 keyspace.active() 会看到与 payload publicKeyHex
    // 不一致的状态（payload 是新 key，active 是旧 key）。
    //
    // 硬切换 004 收尾：必须 await notifyKeyCreated。keyspace 内部会
    // 先 await quiesceNamespace(prev.active) 把旧 key 的后台任务停稳，
    // 然后才切 active；同步不 await 等于把旧 key 的 history-backfill
    // 留在内存里继续跑，新 active 的 namespace DB 一旦被业务插件打开，
    // 旧 task 仍可能撞 `database connection is closing`——和手动
    // setActive 的同类竞态。
    if (deps.keyspace) {
      try {
        await deps.keyspace.notifyKeyCreated(await recordToIdentity(record));
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
      publicKeyHex: identity.publicKeyHex,
      label
    });
    deps.logger?.info({
      scope: "vault.key",
      event: "key.created",
      message: "Vault key created",
      data: { keyId: ref.id, publicKeyHex: identity.publicKeyHex, label },
      keyScope: { publicKeyHex: identity.publicKeyHex }
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

    /**
     * 读取"首 Key 已落库但未自动 active"notice。
     *
     * 返回的是当前快照；不会因读取而清除。清除必须显式调
     * `clearInitialActivationNotice()`，或在 `setActive` 把该 key 切为
     * active / `lock()` 时由 vault 内部清掉。
     */
    getInitialActivationNotice() {
      return pendingActivationNotice;
    },

    /** 显式清除 notice。 */
    clearInitialActivationNotice() {
      setPendingActivationNotice(null);
    },

    /** 订阅 notice 变化（设置 / 清除），用于 UI 实时刷新。 */
    onInitialActivationNoticeChange(handler) {
      noticeListeners.add(handler);
      // 立即把当前值喂给订阅方，避免新挂载时漏掉已存在的 notice。
      handler(pendingActivationNotice);
      return () => noticeListeners.delete(handler);
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
     * 硬切换 009：首启"新建钱包"高层能力。
     *
     * 内部顺序（**严格按此执行，不能调 this.createVault()**）：
     *   1) 校验 status === "uninitialized"（其余状态 fail closed）。
     *   2) 写 meta + 把派生 key/salt 放入内存（不调 setStatus）。
     *   3) 调 `deps.keyspace.onVaultUnlocked()` 让 keyspace 进入 ready 状态
     *      （与 unlock 的 ready 边界保持一致）。
     *   4) 调 `generateKey({ label, capabilities })`：复用私钥生成 /
     *      身份派生 / 加密落库 / active 切换 / `key.created` 事件。
     *   5) **只有 generateKey 成功后才** `setStatus("unlocked")` + emit
     *      `vault.unlocked`。这一步是修复硬切换 009 收尾的核心——
     *      App.tsx 会在看到 `unlocked` 时立刻切到 UnlockedShell，P2PKH
     *      service 也会在 `vault.unlocked` 事件后启动自己的解锁链路。
     *      提前宣布 unlocked 会让主界面在"首 Key 尚未落库"的中间态
     *      渲染，违反施工单"主界面应已带首 Key"的硬切换语义。
     *   6) 失败回滚：
     *        a) 步骤 2/3 失败（meta 写入 / keyspace ready）—— 与
     *           createVault 一致：删 meta、清空内存会话、抛原错，**不**
     *           宣布 unlocked，状态保持 uninitialized。
     *        b) generateKey 抛 `KeyPersistedButActivationFailedError` —
     *           首 Key 已落库但 active 没切上。**先**保存
     *           `InitialActivationNotice` 给 UI 在主界面展示，**再**
     *           `setStatus("unlocked")` 让用户能进入已解锁主界面手动
     *           切 active；抛 `KeyPersistedButActivationFailedError` 给
     *           调用方（shell 端不必再处理：unlocked 状态已发出，App
     *           会自动切到 UnlockedShell）。
     *        c) generateKey 抛其它错（首 Key 未落库）—— 删 meta、清空
     *           内存会话、状态回到 "uninitialized"、抛原错，**不**宣布
     *           unlocked。
     *
     * 设计缘由：
     *   - "新建钱包"必须与"创建空 Vault"语义解耦；本方法是面向 shell
     *     的唯一首启入口，导入私钥仍走 `createVault`。
     *   - 把事务边界收敛在 Vault 内部，shell 端不需要知道"失败时 meta
     *     要不要回滚"或"内存会话要不要清理"。
     *   - 不复用 `this.createVault()`，因为它的 setStatus("unlocked") +
     *     publish("vault.unlocked") 副作用会导致主界面在首 Key 落库前
     *     就被渲染。
     */
    async createVaultWithInitialKey(input) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      // 1) 准备 meta + 内存会话。**不**调 setStatus("unlocked")。
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(input.password, salt);
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
      // 2) keyspace ready 边界（与 createVault / unlock 一致）。
      try {
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
      } catch (err) {
        // keyspace ready 失败：与 createVault 同样的回滚——删 meta、
        // 清空内存会话、抛原错。状态保持 uninitialized（从未切到 unlocked）。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithInitialKey rollback",
            deleteErr
          );
        }
        masterSalt = null;
        masterKey = null;
        throw err;
      }
      // 3) 生成首 Key。复用 generateKey 走 persistPrivateKey 统一路径。
      const label = (input.label ?? defaultInitialKeyLabel()).trim();
      let firstKeyRef: KeyRef;
      try {
        firstKeyRef = await this.generateKey({
          label,
          capabilities: input.capabilities
        });
      } catch (err) {
        if (err instanceof KeyPersistedButActivationFailedError) {
          // 已落库但未自动 active：保存 notice，让 UI 在已解锁主界面
          // 展示"首 Key 已保存，请手动切 active"。**仍**宣布 unlocked，
          // 让用户能进入主界面手动修复——首 Key 已经安全落库，回滚
          // 反而会隐藏真实状态。
          setPendingActivationNotice({
            keyId: err.key.id,
            publicKeyHex: err.key.publicKeyHex,
            label: err.key.label
          });
          setStatus("unlocked");
          deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
          throw err;
        }
        // 首 Key 未落库：DB 里只有刚建好的空 Vault，必须把它清掉，
        // 回到 uninitialized 状态，避免"已创建空 Vault 但没有 Key"
        // 的脏状态泄漏到下次 bootstrap。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithInitialKey rollback",
            deleteErr
          );
        }
        masterSalt = null;
        masterKey = null;
        setStatus("uninitialized");
        throw err;
      }
      // 4) 完整成功：宣布 unlocked + emit。这是"新建钱包"的真正完成点。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
      return firstKeyRef;
    },

    /**
     * 硬切换 010：首启"导入私钥"高层能力。
     *
     * 内部顺序（**严格按此执行，不能调 this.createVault()**）：
     *   1) 校验 status === "uninitialized"（其余状态 fail closed）。
     *   2) 写 meta + 把派生 key/salt 放入内存（不调 setStatus）。
     *   3) 调 `deps.keyspace.onVaultUnlocked()` 让 keyspace 进入 ready
     *      状态（与 unlock 的 ready 边界保持一致）。
     *   4) 调 `importPrivateKey({ label, material, format, capabilities,
     *      source })`：复用 `persistPrivateKey` 内部函数——身份派生 /
     *      查重 / 加密落库 / active 切换 / `key.created` 事件。
     *   5) **只有 importPrivateKey 成功后才** `setStatus("unlocked")` +
     *      emit `vault.unlocked`。这样 App.tsx 看到 unlocked 时这把导入
     *      key 已经落库，避免主界面在"首 Key 尚未落库"的中间态渲染。
     *   6) 失败回滚：
     *        a) 步骤 2/3 失败（meta 写入 / keyspace ready）—— 与
     *           createVault 一致：删 meta、清空内存会话、抛原错，**不**
     *           宣布 unlocked，状态保持 uninitialized。
     *        b) importPrivateKey 抛 `KeyPersistedButActivationFailedError`
     *           — 首 Key 已落库但 active 没切上。**先**保存
     *           `InitialActivationNotice` 给 UI 在主界面展示，**再**
     *           `setStatus("unlocked")` 让用户能进入已解锁主界面手动切
     *           active；抛 `KeyPersistedButActivationFailedError` 给调用
     *           方（shell 端不必再处理：unlocked 状态已发出，App 会自动
     *           切到 UnlockedShell）。
     *        c) importPrivateKey 抛其它错（首 Key 未落库；常见：label
     *           为空 / 长度超限 / 重复 publicKeyHex / DB 写入失败）——
     *           删 meta、清空内存会话、状态回到 "uninitialized"、抛原
     *           错，**不**宣布 unlocked。
     *
     * 设计缘由：
     *   - 首启"导入私钥"必须与"创建空 Vault"语义解耦；本方法是面向
     *     shell 的唯一首启入口，**不**再让"导入私钥"走 createVault()
     *     + 跳 `/import` 的旧路径——那会制造"有锁屏密码但 0 key"的空
     *     Vault 状态。
     *   - 把事务边界收敛在 Vault 内部，shell 端不需要知道"失败时 meta
     *     要不要回滚"或"内存会话要不要清理"。
     *   - 不复用 `this.createVault()`，因为它的 setStatus("unlocked") +
     *     publish("vault.unlocked") 副作用会导致主界面在首 Key 落库前
     *     就被渲染。
     *   - 本方法与 `createVaultWithInitialKey` 对称：两者都是
     *     "首启一次性建 Vault + 落首 Key + 切 active"；区别仅在
     *     "首 Key 是 Vault 内部生成"还是"由调用方解析外部材料后传入"。
     *   - 调用方语义：调用本方法前，**私钥材料必须已经解析成功**——
     *     解析失败不允许进入本方法。解析失败必须停在首启导入向导里，
     *     不写 vault_meta，状态保持 uninitialized。
     */
    async createVaultWithImportedKey(input) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      // 1) 准备 meta + 内存会话。**不**调 setStatus("unlocked")。
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(input.vaultPassword, salt);
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
      // 2) keyspace ready 边界（与 createVault / unlock 一致）。
      try {
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
      } catch (err) {
        // keyspace ready 失败：与 createVault 同样的回滚——删 meta、
        // 清空内存会话、抛原错。状态保持 uninitialized（从未切到 unlocked）。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithImportedKey rollback",
            deleteErr
          );
        }
        masterSalt = null;
        masterKey = null;
        throw err;
      }
      // 3) 持久化首把导入 Key。复用 importPrivateKey -> persistPrivateKey
      //    统一路径：身份派生 / 查重 / 加密落库 / active 切换 / 事件。
      let firstKeyRef: KeyRef;
      try {
        firstKeyRef = await this.importPrivateKey({
          label: input.key.label,
          material: input.key.material,
          format: input.key.format,
          capabilities: input.key.capabilities,
          source: input.key.source
        });
      } catch (err) {
        if (err instanceof KeyPersistedButActivationFailedError) {
          // 已落库但未自动 active：保存 notice，让 UI 在已解锁主界面
          // 展示"首 Key 已保存，请手动切 active"。**仍**宣布 unlocked，
          // 让用户能进入主界面手动修复——首 Key 已经安全落库，回滚
          // 反而会隐藏真实状态。
          setPendingActivationNotice({
            keyId: err.key.id,
            publicKeyHex: err.key.publicKeyHex,
            label: err.key.label
          });
          setStatus("unlocked");
          deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
          throw err;
        }
        // 首 Key 未落库：DB 里只有刚建好的空 Vault，必须把它清掉，
        // 回到 uninitialized 状态，避免"已创建空 Vault 但没有 Key"
        // 的脏状态泄漏到下次 bootstrap。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithImportedKey rollback",
            deleteErr
          );
        }
        masterSalt = null;
        masterKey = null;
        setStatus("uninitialized");
        throw err;
      }
      // 4) 完整成功：宣布 unlocked + emit。这是"首启导入"的真正完成点。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
      return firstKeyRef;
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
     *
     * 硬切换 005 收尾：unlock 收尾前再次校验 vault_keys 不为 0；空列表
     * 是异常态（meta 还在但 0 key），按"meta 残留"路径收敛到
     * uninitialized 而不是 unlocked——这是与 bootstrap 路径一致的护栏。
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
        // 硬切换 005 收尾：unlock 收尾前若 vault_keys 已空，按"meta 残留"
        // 路径收敛到 uninitialized——直接清空内存会话、删 meta，不再走
        // keyspace.onVaultUnlocked / setStatus("unlocked")。
        const remaining = await vaultDb.listKeys();
        if (remaining.length === 0) {
          if (deps.keyspace) {
            try {
              await deps.keyspace.onVaultLocked();
            } catch (err) {
              console.error("keyspace.onVaultLocked during empty-unlock failed", err);
            }
          }
          try {
            await vaultDb.deleteMeta();
          } catch (delErr) {
            console.error("vaultDb.deleteMeta during empty-unlock failed", delErr);
          }
          masterKey = null;
          masterSalt = null;
          keyCache = null;
          setStatus("uninitialized");
          return;
        }
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
      // 硬切换 004：lock 的顺序收紧——setStatus("locked") 之后，先
      // await keyspace.onVaultLocked()（平台级锁屏清理屏障：cancelByKey
      // + await 旧 task 退出 + 关闭 namespace DB handle），再 publish
      // `vault.locked`。
      //
      // 设计缘由：`vault.locked` 的语义被收紧为"平台级资源已停稳"——
      // 业务插件订阅者不再承担"我必须先 cancel 才安全"的职责。如果
      // keyspace.onVaultLocked 抛错，必须冒泡——禁止在这里 catch 后
      // 伪装成成功锁屏；调用方（AppShell）会把未发布的 vault.locked
      // 视作"锁屏尚未完成"。
      setStatus("locked");
      if (deps.keyspace) {
        await deps.keyspace.onVaultLocked();
      }
      deps.messageBus.publish("vault.locked", { at: new Date().toISOString() });
    },

    /**
     * 硬切换 005 收尾：已解锁壳层守卫调用——"0 key 异常态"恢复入口。
     *
     * 触发场景：AppShell 检测到 vault.status === "unlocked" 且
     * keyspace.active().activePublicKeyHex 缺失且 listKeys 为空。
     * 此时必须把状态收敛到 uninitialized（不是 locked），让用户进
     * 入首启 welcome 而不是撞上"已经看到主界面但永远没有 key"。
     *
     * 实现：复用 finalizeEmptyVaultAfterLastKeyDeletion 的同构清理
     * 流程——清空内存会话、触发 keyspace.onVaultLocked、删 meta、
     * 状态收敛到 uninitialized。但与"删完最后一把 key"不同的是
     * 本方法**不**在 finally 块里抛错——壳层守卫的目标是
     * "即使有残留也能从 uninitialized 入口继续"，与
     * finalizeEmptyVaultAfterLastKeyDeletion 严格"meta 必须删干净"
     * 的语义有差异。
     *
     * 设计缘由：bootstrap 路径里已经做了"meta 存在但 0 key 就清 meta"
     * 的护栏；本方法在 unlocked 状态补做一次同源护栏。两条路径都
     * 收敛到 uninitialized。
     */
    async recoverEmptyVaultToUninitialized() {
      // 1) 校验：仅在 unlocked + 0 key 时允许触发。其它状态抛错拒绝。
      if (status !== "unlocked") {
        throw new Error("recoverEmptyVaultToUninitialized requires unlocked state");
      }
      const remaining = await vaultDb.listKeys();
      if (remaining.length > 0) {
        throw new Error("recoverEmptyVaultToUninitialized requires zero keys");
      }
      // 2) 通知 keyspace 收尾。硬切换 004：await keyspace.onVaultLocked()
      // —— await 旧 task 退出 + 关闭 namespace DB。
      if (deps.keyspace) {
        try {
          await deps.keyspace.onVaultLocked();
        } catch (err) {
          console.error("keyspace.onVaultLocked during recover failed", err);
        }
      }
      // 3) 清空内存会话。
      masterKey = null;
      masterSalt = null;
      keyCache = null;
      setPendingActivationNotice(null);
      if (activeChangeUnsub) {
        activeChangeUnsub();
        activeChangeUnsub = null;
      }
      // 4) 删 meta，状态收敛到 uninitialized。
      try {
        await vaultDb.deleteMeta();
      } catch (delErr) {
        // meta 删除失败仍要把状态收敛：UI 至少能切回 welcome 让用户重试。
        console.error("vaultDb.deleteMeta during recover failed", delErr);
      }
      setStatus("uninitialized");
    },

    /**
     * 硬切换 001：vault service 自我清理。
     * 幂等：host teardown 多次调用安全。当前动作是清空内存中的 status listener
     * 与 active-change 订阅。
     */
    dispose() {
      if (activeChangeUnsub) {
        activeChangeUnsub();
        activeChangeUnsub = null;
      }
      statusListeners.clear();
      noticeListeners.clear();
    },

    /* ============== 同源 Session Window bootstrap 一次性交接（施工单 2026-06-29 001） ============== */

    /**
     * 导出当前 vault 的 unlock runtime 交接包，**仅供同源 Session Window
     * bootstrap 使用**。
     *
     * 设计缘由（施工单 2026-06-29 001 硬切换）：
     *   - 必须仅在 `status === "unlocked"` 时允许；其它状态 throw。
     *   - 交接包只服务于本次 Session Window bootstrap；**不**写入任何
     *     长期存储（localStorage / sessionStorage / IndexedDB / URL）。
     *   - **不**走 postMessage 事件队列（launcher 在子窗口 listener 挂好
     *     之前发消息会丢失）。handoff 由 launcher 持有在自己 `window`
     *     上的 registry 中；Session Window mount 时**主动**调
     *     `window.opener.__keymaster_session_window_bootstrap__.acquire
     *     (token)` 拉取——同源直接 JS 调用，**没有**时序竞态。
     *   - 导出后 launcher 可以立即关窗；Session Window 通过
     *     `importUnlockRuntimeFromLauncher(handoff)` 导入，导入成功后
     *     Session Window 自身进入与正常 `unlock()` 成功后等价的内存态。
     *   - **不**做"持久化 unlock runtime"——只做一次性内存交接；刷新 /
     *     关闭后 Session Window 仍然必须走解锁 / `connect.resume`。
     *   - 关键安全语义：handoff 包含 masterKey raw bytes（PBKDF2 输出）
     *     + masterSalt。两者一并发送意味着 launcher 把解锁态内存材料
     *     全部交给 Session Window；launcher 关窗后这些材料**只**存在
     *     Session Window 当前内存中。**信任域 = 同源**——只有 launcher
     *     主动发起的同源子窗口可以消费。
     */
    async exportUnlockRuntimeForSessionWindow(): Promise<UnlockRuntimeHandoff> {
      if (status !== "unlocked") {
        throw new Error("Vault is not unlocked");
      }
      if (!masterKey || !masterSalt) {
        throw new Error("Vault unlock runtime not initialized");
      }
      // 1) 从 masterKey (CryptoKey) 反向导出 raw 256-bit key material。
      //    CryptoKey 不可结构化克隆，必须走 exportKey('raw') 拿原始字节。
      const masterKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", masterKey));
      // 2) 列出当前 vault 内已就绪 key 列表快照（仅公开字段）。
      //    keyCache 由 unlock 路径维护；unlocked 状态下必有值。
      const keySnapshot: UnlockRuntimeHandoff["keySnapshot"] = (keyCache ?? []).map((k) => ({
        id: k.id,
        label: k.label,
        publicKeyHex: k.publicKeyHex,
        identityStatus: k.identityStatus
      }));
      // 3) 当前 keyspace active key 公钥 hex（可选；keyspace 不存在时省略）。
      const activePublicKeyHex = deps.keyspace?.active().activePublicKeyHex;
      return {
        masterSalt: masterSalt.slice().buffer,
        masterKeyBytes: masterKeyBytes.buffer,
        keySnapshot,
        activePublicKeyHex,
        createdAt: Date.now()
      };
    },

    /**
     * 导入同源 launcher 一次性交接的 unlock runtime 包。
     *
     * 设计缘由（施工单 2026-06-29 001 硬切换）：
     *   - 必须仅在 `status === "locked"` 时允许；unlocked 状态下不重复导入。
     *   - 导入成功后当前 vault 进入 `unlocked` 态：masterKey / masterSalt /
     *     keyCache / keyspace.onVaultUnlocked 全部生效。
     *   - **不**对 launcher 内部对象保留任何活引用；导入后 Session Window
     *     独立运行。
     *   - 校验失败（包损坏 / masterKey 无法 restore / vault_meta 缺失）
     *     一律 fail-closed；状态回 `locked`，清空内存会话。
     *   - **不**写任何长期存储；handoff 仅存在于本次调用栈。
     *   - 关键不变量：与 `unlock()` 一致，必须**先**完成 identity backfill
     *     + keyspace.onVaultUnlocked，再 `setStatus("unlocked")` + emit。
     *     中间步骤失败按 `unlock()` 的回滚语义清理内存会话并抛错。
     */
    async importUnlockRuntimeFromLauncher(handoff: UnlockRuntimeHandoff): Promise<void> {
      if (status !== "locked") {
        throw new Error("Vault is not in locked state for bootstrap import");
      }
      if (!handoff) {
        throw new Error("Empty unlock runtime handoff");
      }
      if (!handoff.masterSalt || !handoff.masterKeyBytes) {
        throw new Error("Invalid unlock runtime handoff: missing key material");
      }
      // 1) 校验 meta 必须存在（uninitialized 状态拒掉导入）。
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      // 2) 校验 handoff.masterSalt 与 meta.saltB64 一致——这是防
      //    "launcher 把别处的 unlock runtime 灌到当前 vault" 的兜底。
      const handoffSaltHex = bytesToHex(new Uint8Array(handoff.masterSalt));
      if (handoffSaltHex !== meta.saltB64) {
        throw new Error("Unlock runtime handoff salt does not match vault meta");
      }
      // 3) 反向重建 CryptoKey：raw bytes → AES-GCM key。
      let restoredKey: CryptoKey;
      try {
        restoredKey = await aesGcmKeyFromRawBits(new Uint8Array(handoff.masterKeyBytes));
      } catch (err) {
        throw new Error(
          `Failed to restore master key from handoff: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      // 4) 校验 verifier：与 unlock() 一致，确认 raw bytes 确实对应
      //    当前 vault 的合法密码派生结果。
      const verifierOk = await verifyVerifier(restoredKey, {
        salt: hexToBytes(meta.verifierSaltB64),
        iv: hexToBytes(meta.verifierIvB64),
        ciphertext: hexToBytes(meta.verifierCipherB64)
      });
      if (!verifierOk) {
        throw new Error("Unlock runtime handoff does not match vault verifier");
      }
      // 5) 写入 masterKey / masterSalt / keyCache；走与 unlock() 一致的
      //    ready 边界：backfillIdentities -> keyspace.onVaultUnlocked ->
      //    setStatus("unlocked") + emit。中间步骤失败按 unlock() 的
      //    回滚语义清理并抛错。
      masterSalt = new Uint8Array(handoff.masterSalt);
      masterKey = restoredKey;
      // handoff 带 key 列表快照：仅作为"导入时已有 key"的快速路径；
      // backfillIdentities 仍按 DB 真值执行（DB 是真值；snapshot 只是
      // 一种 hint，本地 DB 才是 source of truth）。
      try {
        await backfillIdentities();
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
      } catch (err) {
        // ready 边界失败：清理内存会话，状态保持 locked。
        masterKey = null;
        masterSalt = null;
        keyCache = null;
        setStatus("locked");
        throw err;
      }
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
    },

    /**
     * 硬切换 002：仅校验锁屏密码，不改变 Vault 状态。
     *
     * 实现要点：
     *   1) 从 `vault_meta` 读 verifier。无 meta（uninitialized / booting）
     *      时直接抛 `Vault not initialized`——没有 verifier 可校验，
     *      fail closed。
     *   2) 用传入密码 + meta.salt 派生临时 key，仅用于比对 verifier；
     *      派生出的 key **不**写入 `masterKey` 内存槽，调用结束就丢。
     *   3) `verifyVerifier` 失败抛 `Invalid password`，与 `unlock` 错误
     *      文案一致以便 UI 统一处理。
     *   4) **不**调用 setStatus、**不**修改 `masterKey / masterSalt /
     *      keyCache`、**不**触发 backfill、**不**发任何 messageBus 事件。
     *      keyspace.deleteKey 调用本方法后再走 prepareDeleteKey / 删
     *      namespace DB / 删私钥材料的主流程。
     */
    async verifyPassword(password) {
      const meta = await vaultDb.getMeta();
      if (!meta) throw new Error("Vault not initialized");
      const salt = hexToBytes(meta.saltB64);
      const probe = await deriveKey(password, salt);
      const ok = await verifyVerifier(probe, {
        salt: hexToBytes(meta.verifierSaltB64),
        iv: hexToBytes(meta.verifierIvB64),
        ciphertext: hexToBytes(meta.verifierCipherB64)
      });
      if (!ok) throw new Error("Invalid password");
      // 不动 masterKey / masterSalt / keyCache / status / cache
      // / 不 emit 任何事件。
    },

    /**
     * 硬切换 002：删完最后一把 Key 后的"空 Vault 收尾"。
     *
     * 实现要点：
     *   1) **再次**确认 `vault_keys` 已空。这是 fail-closed 防御：
     *      keyspace 判断剩余 0 是基于自己的 listKeys，本方法直接查
     *      底层 vaultDb，避免任何中间层判断错误导致误删 meta。
     *      若仍有 key 抛 `Vault still has keys`，不动任何状态。
     *   2) 清理内存会话：`masterKey / masterSalt / keyCache` 必须先
     *      置空，避免后续异步路径还能解密私钥。
     *   3) 触发会话结束清理：现有插件（如 p2pkh）依赖 `vault.locked`
     *      事件释放 namespace 资源；删空最后一把 key 时这条链路必须
     *      被走一次。这里先 emit `vault.locked` 再 setStatus，确保
     *      订阅者还能看到"会话结束"语义。`keyspace.onVaultLocked()`
     *      也被调用一次，释放打开的 namespace DB。
     *   4) 删除 `vault_meta`——下次 bootstrap 必须读到
     *      `uninitialized`，回到首启欢迎页。
     *   5) `setStatus("uninitialized")`，订阅者会重新挂载 LockedShell
     *      欢迎页。
     *
     * 失败处理：
     *   - 步骤 1 fail closed：抛 `Vault still has keys`，状态不变；
     *     这一步在清理内存之前抛错，所以 in-memory 会话和 status 都
     *     不会被动到，调用方拿到原始错误即可。
     *   - 步骤 2-4 任一失败：必须把 status 收敛到 `uninitialized`——
     *     原因：步骤 2 已经把 `masterKey / masterSalt / keyCache` 清空，
     *     步骤 3 已经发了 `vault.locked`；如果状态仍停在 `unlocked`，
     *     App 不会切回欢迎页，但后续任何 withPrivateKey / sign 都会撞上
     *     `"Vault is locked"` 这种状态机错位错误。所以最终 setStatus
     *     必须在 `finally` 块中钉死，无论前面是否抛错。
     *     失败时 meta 可能仍在 DB 里（= 下次 bootstrap 读到 locked，
     *     与本次期望 uninitialized 不一致），错误文案必须明确说明
     *     `deleteMeta` 失败 + 状态已收敛 + 下次启动需诊断介入。
     */
    async finalizeEmptyVaultAfterLastKeyDeletion() {
      // 1) fail-closed：直接查底层 vaultDb 列表。listKeys 自身抛错时
      //    状态/内存都不动，原错沿错误栈冒泡。
      const remaining = await vaultDb.listKeys();
      if (remaining.length > 0) {
        throw new Error("Vault still has keys");
      }
      // 进入收尾流程后，无论后续步骤成功还是抛错，setStatus("uninitialized")
      // 都必须执行——避免 in-memory 已清空、status 仍 unlocked 的错位态。
      let finalizeError: unknown = null;
      try {
        // 2) 清理内存会话——必须在删 meta 之前，避免任何异步路径
        //    在 meta 已删但会话还在的情况下尝试 decryptMaterial。
        masterKey = null;
        masterSalt = null;
        keyCache = null;
        setPendingActivationNotice(null);
        if (activeChangeUnsub) {
          activeChangeUnsub();
          activeChangeUnsub = null;
        }
        // 3) 触发会话结束清理：让依赖 vault.locked 的业务插件释放
        //    namespace 资源；keyspace 自己也走一次 onVaultLocked 把
        //    打开的 namespace DB 关掉、active 清回 all。
        //
        // 硬切换 004：await keyspace.onVaultLocked()——平台级清理屏障，
        // resolve 时表示后台任务已退出、namespace DB 已关；之后再
        // publish `vault.locked`，让"会话结束"语义保持
        // "平台资源已停稳"的收紧含义。
        //
        // 硬切换 004 收尾：禁止在 finalize 里 catch keyspace.onVaultLocked()
        // 的错误后继续往下走。cancelByKey / namespace 关失败意味着
        // "平台资源没停稳"——继续 publish vault.locked + 删 meta 会
        // 把"清理失败"伪装成"会话成功结束"，留下旧 task 仍可能继续
        // 跑的风险，与施工单"锁屏清理屏障失败必须可见"的语义冲突。
        // 让错误冒泡到外层 catch：status 仍收敛到 uninitialized（finally），
        // 但调用方通过抛错看到 finalize 失败。
        if (deps.keyspace) {
          await deps.keyspace.onVaultLocked();
        }
        try {
          deps.messageBus.publish("vault.locked", { at: new Date().toISOString() });
        } catch (err) {
          console.error("publish vault.locked failed during finalize", err);
        }
        // 4) 删除 vault_meta。如果失败，错误将被外层 catch 捕获，
        //    finally 仍会把 status 收敛到 uninitialized。
        await vaultDb.deleteMeta();
      } catch (err) {
        // 收尾失败——记下原错，让 finally 块先做状态收敛，
        // 然后在 finally 之后把错包装成更明确的错误再抛给调用方。
        finalizeError = err;
      } finally {
        // 5) 状态收敛：必须放在 finally 中。如果不收这一步，App 会
        //    仍按 unlocked 处理，但 in-memory 已经清空，UI 后续会撞上
        //    "Vault is locked"——这种状态机错位比"meta 残留"更难诊断。
        //    收掉后 UI 至少能切回欢迎页、让用户重试创建 / 导入流程。
        setStatus("uninitialized");
      }
      if (finalizeError !== null) {
        // 重新包装：调用方需要明确知道 finalize 哪个阶段失败、状态已
        // 收敛到 uninitialized。错误可能来源：
        //   - keyspace.onVaultLocked() 抛错（cancelByKey / namespace 关失败）
        //   - publish vault.locked 抛错（业务订阅者异常，理论上不致命）
        //   - vaultDb.deleteMeta 抛错（meta 残留，下次 bootstrap 可能
        //     读到 locked）
        // 不区分阶段统一报"platform-level cleanup failed"——具体根因
        // 在 console.error / 调用方日志里能看到，UI 至少能切回欢迎页
        // 重新走流程。
        const reason =
          finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
        throw new Error(
          `Empty-vault finalize failed (platform-level cleanup incomplete; ` +
            `state collapsed to uninitialized; next bootstrap may re-read locked): ${reason}`
        );
      }
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

    async getKeyByPublicKeyHex(publicKeyHex) {
      const r = await vaultDb.getKeyByPublicKeyHex(publicKeyHex);
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
      console.info("[vault] exportPrivateKey", {
        keyId,
        publicKeyHex: record.publicKeyHex
      });
      return this.withPrivateKey(keyId, (material) =>
        encryptBsv8KeyEnvelope(material.hex, password)
      );
    },

    async withPrivateKey(id, fn) {
      console.info("[vault] withPrivateKey begin", { keyId: id });
      const record = await vaultDb.getKey(id);
      if (!record) throw new Error(`Unknown key ${id}`);
      const material = await decryptMaterial(record);
      try {
        const out = await fn(material);
        console.info("[vault] withPrivateKey success", {
          keyId: id,
          publicKeyHex: record.publicKeyHex
        });
        return out;
      } finally {
        // material 在闭包结束后不再可达，由 GC 回收。
        // 这里不显式 zero，避免额外开销且不真正安全。
      }
    }
  };
}
