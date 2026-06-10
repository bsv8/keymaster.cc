// packages/plugin-vault/src/keyspaceService.ts
// KeyspaceService 实现：active key 状态 + key-scoped IndexedDB + key 删除。
// 设计缘由：
//   - KeyspaceService 是平台级状态；业务插件只能通过该服务查询 / 切换 active key。
//   - 注册 plugin storage：plugin setup 时通过 manifest.keyScopedStorages 或
//     显式 registerPluginStorage 注入；keyspace 在 deleteKey 时按注册清单逐个
//     indexedDB.deleteDatabase。
//   - 删除顺序：prepare -> cancel background -> close handles -> delete namespace
//     DBs -> delete Vault key。namespace DB 删除失败时拒绝继续，避免留下归属
//     丢失的业务数据。
//   - active key 自动选择规则：unlock 后若上次 active key 仍存在则恢复；否则
//     取最近创建或列表第一把；没有 key 时进入无 key 状态。

import type { MessageBus } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  BackgroundService,
  KeyIdentity,
  KeyScopedStorageHandle,
  KeyScopedStorageOpenInput,
  KeyspaceService
} from "@keymaster/contracts";
import {
  EVENT_ACTIVE_KEY_CHANGED,
  EVENT_KEYSPACE_INITIALIZATION,
  KeyspaceService as KeyspaceServiceContract
} from "@keymaster/contracts";
import type { VaultService } from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY } from "@keymaster/contracts";

const ACTIVE_KEY_STORAGE_KEY = "keyspace.activePublicKeyHash";
const ACTIVE_KEY_MODE_KEY = "keyspace.activeMode";
const ALL_KEYS_DB_PREFIX = "keymaster.key.";

export interface KeyspaceServiceDeps {
  messageBus: MessageBus;
  vault: VaultService;
  /**
   * 硬切换 008：可选 background service 引用。
   * keyspace 创建时 background 插件可能尚未装载；通过 attachBackgroundService
   * 在 background 启动后再注入。deleteKey 时如果未注入，prepareDeleteKey
   * 跳过 background.cancelByKey（仍会关闭 handle + emit）。
   */
  background?: BackgroundService;
}

export interface KeyspaceHandle extends KeyspaceService {
  /** 在 Vault unlock 后调用，触发 identity backfill。 */
  onVaultUnlocked(): Promise<void>;
  /** Vault 锁定时调用：清空 active key 状态。 */
  onVaultLocked(): void;
  /** 通知 keyspace 一个 key 被创建（vault 在 importPrivateKey 成功后调用）。 */
  notifyKeyCreated(identity: KeyIdentity): void;
  /**
   * 显式"把某把 key 切为 active"。vault 在 importPrivateKey / generateKey
   * 成功后必须调用，确保新 key 进入 single 模式。
   *
   * 与 `setActive(publicKeyHash)` 的区别：本方法不依赖 identityStatus 过滤
   * ——keyspace 自己刚被通知了一把新 key（同一调用链），应无条件接受。
   * `setActive` 走 listActiveCandidates 过滤，是用户手动切 key 的入口。
   */
  activateCreatedKey(identity: KeyIdentity): void;
  /**
   * 设置 identity backfill 阶段状态。vault 在 backfillIdentities 前后
   * 调用，触发 EVENT_KEYSPACE_INITIALIZATION 事件。
   */
  setInitializing(initializing: boolean): void;
}

interface RegisteredStorage {
  pluginId: string;
  storageId: string;
}

interface OpenDbEntry {
  handle: KeyScopedStorageHandle;
  /** 业务插件可以多次 openKeyStorage 拿到不同 IDBDatabase；这里缓存避免重复打开。 */
  refCount: number;
}

export function createKeyspaceService(deps: KeyspaceServiceDeps): KeyspaceHandle {
  const activeListeners = new Set<(s: ActiveKeyState) => void>();
  const initListeners = new Set<(initializing: boolean) => void>();
  const registeredStorages: RegisteredStorage[] = [];
  /** 当前打开的 namespace db：key = `${publicKeyHash}::${dbName}`，用于共享与统一关闭。 */
  const openDbs = new Map<string, OpenDbEntry>();
  // 硬切换 008：保存 attach 进来的 background service 引用。
  // 初始可以是构造时直接传入的 deps.background（测试场景），也可以由
  // attachBackgroundService 在 background 插件装载后注入。
  let attachedBackground: BackgroundService | undefined = deps.background;

  let active: ActiveKeyState = { mode: "all" };
  let initializing = false;

  function persistActive(state: ActiveKeyState) {
    try {
      if (typeof localStorage === "undefined") return;
      if (state.mode === "single" && state.activePublicKeyHash) {
        localStorage.setItem(ACTIVE_KEY_STORAGE_KEY, state.activePublicKeyHash);
        localStorage.setItem(ACTIVE_KEY_MODE_KEY, "single");
      } else {
        localStorage.removeItem(ACTIVE_KEY_STORAGE_KEY);
        localStorage.setItem(ACTIVE_KEY_MODE_KEY, "all");
      }
    } catch {
      // localStorage 不可用时静默退化。
    }
  }

  function readPersistedActive(): { hash?: string; mode: ActiveKeyState["mode"] } {
    try {
      if (typeof localStorage === "undefined") return { mode: "all" };
      const mode = localStorage.getItem(ACTIVE_KEY_MODE_KEY);
      const hash = localStorage.getItem(ACTIVE_KEY_STORAGE_KEY) ?? undefined;
      return { hash, mode: mode === "single" ? "single" : "all" };
    } catch {
      return { mode: "all" };
    }
  }

  function setActiveInternal(next: ActiveKeyState) {
    active = next;
    persistActive(next);
    // active 状态和 localStorage 写入已完成；逐个通知 listener。
    // 隔离每个 listener 的异常：active listener 是通知，任意一个
    // 抛错都不应回灌给调用方（特别是 `notifyKeyCreated` / `activateCreatedKey`），
    // 把"通知失败"扩大为"active 写入失败"，造成"已切 active 但调用方以为
    // 失败"的语义错位。隔离后，仅记录 console.error 让 dev 可见，业务语义
    // 仍是"active 已写入"。
    for (const l of activeListeners) {
      try {
        l(next);
      } catch (err) {
        console.error("keyspace active listener threw", err);
      }
    }
    try {
      deps.messageBus.publish(EVENT_ACTIVE_KEY_CHANGED, next);
    } catch (err) {
      console.error("keyspace active bus publish threw", err);
    }
  }

  function setInitializingInternal(next: boolean) {
    if (initializing === next) return;
    initializing = next;
    for (const l of initListeners) l(next);
    deps.messageBus.publish(EVENT_KEYSPACE_INITIALIZATION, { initializing: next });
  }

  /**
   * 返回所有可管理的 KeyIdentity（ready + failed + 无 hash）。
   * 设计缘由：硬切换 008 收尾——failed key 也必须能列出，用户需要看到
   * "这把 key 解密失败，只能删除"；listKeys 返回包含 failed 与无 hash。
   * `KeyIdentity` 的 publicKeyHex / publicKeyHash / fingerprint 在
   * identity 字段缺失时为 undefined，调用方需自行处理展示。
   */
  async function listManageableKeys(): Promise<KeyIdentity[]> {
    const refs = await deps.vault.listKeys();
    return refs.map((r) => ({
      keyId: r.id,
      publicKeyHex: r.publicKeyHex,
      publicKeyHash: r.publicKeyHash,
      fingerprint: r.fingerprint,
      label: r.label,
      capabilities: r.capabilities,
      createdAt: r.createdAt,
      // 有 hash 的老记录 status 缺省按 "ready"；无 hash 的失败记录按
      // "uninitialized" 兜底（让 UI 显示"初始化中"），backfill 阶段
      // vaultService 会改写。
      identityStatus:
        r.identityStatus ?? (r.publicKeyHash ? "ready" : "uninitialized"),
      identityError: r.identityError
    }));
  }

  /**
   * 活跃候选：identityStatus === "ready" 且有 publicKeyHash。
   * setActive / autoPickActive / deleteKey / onVaultUnlocked 都用此函数，
   * 这样 failed key 不会成为 active，也不会被 deleteKey(publicKeyHash) 误删。
   */
  async function listActiveCandidates(): Promise<KeyIdentity[]> {
    return (await listManageableKeys()).filter(
      (k) => k.identityStatus === "ready" && Boolean(k.publicKeyHash) && Boolean(k.publicKeyHex)
    );
  }

  function dbNameFor(publicKeyHash: string, pluginId: string, storageId: string): string {
    return `${ALL_KEYS_DB_PREFIX}${publicKeyHash}.plugin.${pluginId}.${storageId}`;
  }

  /**
   * 自动选 active key：
   *   - 已持久化的 hash 仍存在 -> 用持久化 hash。
   *   - 否则取 createdAt 最近或第一把。
   *   - 没有 key -> active = { mode: "all" }（实际为"无 key"状态，UI 通过 listKeys 渲染空）。
   */
  async function autoPickActive(): Promise<ActiveKeyState> {
    const ready = await listActiveCandidates();
    if (ready.length === 0) {
      return { mode: "all" };
    }
    const persisted = readPersistedActive();
    if (persisted.mode === "single" && persisted.hash) {
      const found = ready.find((k) => k.publicKeyHash === persisted.hash);
      if (found) return { mode: "single", activePublicKeyHash: found.publicKeyHash };
    }
    // 取最近创建；并列时取列表第一把。
    const sorted = [...ready].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { mode: "single", activePublicKeyHash: sorted[0]!.publicKeyHash };
  }

  /**
   * 切换 active key 时清空打开的 namespace db：业务插件可能缓存了旧 namespace 的
   * IDBDatabase，必须关闭后由它们重新 openKeyStorage 拿到新 namespace。
   * 设计缘由：active key 切换不应该把别的 key 的打开的 db 也关闭；只关闭当前
   * 即将离开的 active key 的 db。但因为 openKeyStorage 是按需打开的，未必已开，
   * 所以这里只关闭"旧 active"的 db。
   */
  function closeActiveNamespace(oldPublicKeyHash: string | undefined) {
    if (!oldPublicKeyHash) return;
    const prefix = `${oldPublicKeyHash}::`;
    for (const [key, entry] of openDbs.entries()) {
      if (!key.startsWith(prefix)) continue;
      try {
        entry.handle.close();
      } catch {
        // 静默
      }
      openDbs.delete(key);
    }
  }

  /**
   * 内部删除路径：单一实现 deleteKey / deleteKeyById 的 namespace 清理。
   * 设计缘由：deleteKey(publicKeyHash) 已通过 listActiveCandidates 过滤
   * 掉 failed key，但 deleteKeyById 允许 failed+hash 也走这里——本函数
   * 不再做 status 检查，只负责按 (keyId, publicKeyHash) 把数据清干净。
   *
   * 这是 createKeyspaceService 内部的闭包函数，**不**挂在 service 对象上，
   * 因此不会随 `keyspace.service` capability 暴露给插件作者；插件只能走
   * deleteKey / deleteKeyById 这两个 public 入口。
   */
  async function deleteKeyRecord({ keyId, publicKeyHash }: { keyId: string; publicKeyHash: string }) {
    // 1) prepare：cancel background + 关闭 handle + emit key.deleting。
    await service.prepareDeleteKey(publicKeyHash);
    // 2) 删除 namespace DB：必须全部成功才能继续删 Vault 私钥。
    for (const reg of registeredStorages) {
      const name = dbNameFor(publicKeyHash, reg.pluginId, reg.storageId);
      try {
        await deleteDatabaseWithTimeout(name, 3000);
      } catch (err) {
        // 阻止 Vault 私钥删除：必须先解决 blocked / timeout 才能继续。
        throw new Error(
          `Failed to delete namespace DB "${name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // 3) 删 Vault 私钥材料。deleteKeyMaterial 不发事件；失败时 namespace
    // 已经被删，必须通知调用方并保留 tombstone。
    try {
      await deps.vault.deleteKeyMaterial(keyId);
    } catch (err) {
      deps.messageBus.publish("key.delete.vault-failed", {
        publicKeyHash,
        keyId,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
    // 4) 通知业务插件 key 已删除（仅此处发一次，vault.deleteKeyMaterial 不再发）。
    deps.messageBus.publish("key.deleted", { publicKeyHash, keyId });
    // 5) active fallback：删的是 active key 时切到下一把；非 active 不动。
    if (active.mode === "single" && active.activePublicKeyHash === publicKeyHash) {
      const next = await autoPickActive();
      closeActiveNamespace(publicKeyHash);
      setActiveInternal(next);
    }
  }

  const service: KeyspaceHandle = {
    async listKeys() {
      // 硬切换 008 收尾：返回 ready + failed，让 UI 看到"解密失败"并允许删除。
      return listManageableKeys();
    },
    async getKey(publicKeyHash) {
      // 用 manageable 而非 candidates：UI 可能需要知道"该 hash 对应的 key
      // 是 failed"以便提示用户。
      const all = await listManageableKeys();
      return all.find((k) => k.publicKeyHash === publicKeyHash);
    },
    active() {
      return active;
    },
    async setActive(publicKeyHash) {
      // setActive 必须用 candidates：failed key 不能成为 active。
      const all = await listActiveCandidates();
      const target = all.find((k) => k.publicKeyHash === publicKeyHash);
      if (!target) {
        throw new Error("Key not found");
      }
      const prev = active;
      closeActiveNamespace(prev.mode === "single" ? prev.activePublicKeyHash : undefined);
      setActiveInternal({ mode: "single", activePublicKeyHash: publicKeyHash });
    },
    async setAll() {
      const prev = active;
      closeActiveNamespace(prev.mode === "single" ? prev.activePublicKeyHash : undefined);
      setActiveInternal({ mode: "all" });
    },
    requireActiveKey() {
      if (active.mode !== "single" || !active.activePublicKeyHash) {
        throw new Error("Active key is required");
      }
      // 同步取：active 状态是 in-memory，但 publicKeyHash 必须对应到 KeyIdentity；
      // 业务插件同步调用时，我们用缓存的 active 状态构造最小可用对象。
      return {
        keyId: "",
        publicKeyHex: "",
        publicKeyHash: active.activePublicKeyHash,
        fingerprint: "",
        label: "",
        capabilities: [],
        createdAt: "",
        identityStatus: "ready"
      };
    },
    onActiveChange(handler) {
      activeListeners.add(handler);
      handler(active);
      return () => activeListeners.delete(handler);
    },
    async openKeyStorage(input: KeyScopedStorageOpenInput) {
      const cacheKey = `${input.publicKeyHash}::${input.pluginId}::${input.storageId}`;
      const existing = openDbs.get(cacheKey);
      if (existing) {
        existing.refCount += 1;
        return existing.handle;
      }
      const name = dbNameFor(input.publicKeyHash, input.pluginId, input.storageId);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, input.version);
        req.onupgradeneeded = (event) => {
          const ev = event as IDBVersionChangeEvent;
          input.upgrade(req.result, ev.oldVersion, ev.newVersion ?? null);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("Key storage open blocked"));
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close() {
          try {
            db.close();
          } catch {
            // 静默
          }
          openDbs.delete(cacheKey);
        }
      };
      openDbs.set(cacheKey, { handle, refCount: 1 });
      // namespace DB 打开成功后检查它是否仍然属于当前 active publicKeyHash。
      // 若 active 已切换走，关闭并要求调用方重新 open。
      if (active.mode === "single" && active.activePublicKeyHash !== input.publicKeyHash) {
        handle.close();
        throw new Error("Key storage is not ready");
      }
      return handle;
    },
    registerPluginStorage(input) {
      if (registeredStorages.some((r) => r.pluginId === input.pluginId && r.storageId === input.storageId)) {
        return;
      }
      registeredStorages.push({ pluginId: input.pluginId, storageId: input.storageId });
    },
    listPluginStorages() {
      return [...registeredStorages];
    },
    async prepareDeleteKey(publicKeyHash) {
      // 硬切换 008 收尾：严格顺序 + fail-closed。
      //   1) background.cancelByKey —— 等所有该 key 的 task 旧实例退出；
      //      失败必须冒泡以阻止后续 namespace DB / Vault 私钥删除。
      //   2) 关闭该 key 的 openDbs
      //   3) emit key.deleting（emit 不可 await，作为日志/保险通知）
      if (attachedBackground) {
        await attachedBackground.cancelByKey(publicKeyHash);
      }
      const prefix = `${publicKeyHash}::`;
      for (const [key, entry] of [...openDbs.entries()]) {
        if (!key.startsWith(prefix)) continue;
        try {
          entry.handle.close();
        } catch {
          // 静默
        }
        openDbs.delete(key);
      }
      deps.messageBus.publish("key.deleting", { publicKeyHash });
    },
    async deleteKey(publicKeyHash) {
      // 严格只允许 ready key 走 publicKeyHash 主路径。设计缘由：
      // deleteKey(publicKeyHash) 是平台身份查找的"已就绪"入口；如果
      // 调用方传一个 identityStatus="failed" 但仍有 hash 的 key，应改走
      // deleteKeyById(keyId) 走管理入口。
      const ready = await listActiveCandidates();
      const target = ready.find((k) => k.publicKeyHash === publicKeyHash);
      if (!target) {
        throw new Error("Key not found");
      }
      // 委托给 deleteKeyRecord：单一删除路径，避免重复实现。
      return deleteKeyRecord({ keyId: target.keyId, publicKeyHash });
    },
    async deleteKeyById(keyId) {
      // 管理入口：允许 ready / failed / 无 hash 的 key 走同一条路径。
      // 设计缘由：硬切换 008 收尾——failed key 也可能有 publicKeyHash
      // （vaultDb.putKeyIdentityFailed 只改 status、不动 identity 字段），
      // 因此 deleteKeyById 必须能处理 failed+hash 的情况，走完整 namespace
      // 清理（cancelByKey + 删 namespace DB + 删私钥材料）。
      const ref = await deps.vault.getKey(keyId);
      if (!ref) {
        throw new Error("Key not found");
      }
      if (ref.publicKeyHash) {
        // 有 hash：走完整 namespace 清理路径——不依赖 listActiveCandidates。
        return deleteKeyRecord({ keyId, publicKeyHash: ref.publicKeyHash });
      }
      // 无 hash：没有 namespace DB 可删，只删私钥材料。
      await deps.vault.deleteKeyMaterial(keyId);
      // keyspace 统一发一次 key.deleted（payload 不带 publicKeyHash）。
      deps.messageBus.publish("key.deleted", { keyId });
      // active fallback：失败 key 不可能成为 active（没有 hash）；保险清理。
      if (active.mode === "single" && !active.activePublicKeyHash) {
        setActiveInternal({ mode: "all" });
      }
    },
    isInitializing() {
      return initializing;
    },
    onInitializationChange(handler) {
      initListeners.add(handler);
      handler(initializing);
      return () => initListeners.delete(handler);
    },
    async onVaultUnlocked() {
      // 解锁后 backfill 阶段由 vaultService 触发；keyspace 只需等。
      // 若 keyspace 没有 ready key（首次解锁或 backfill 全部失败），进入无 key 状态。
      const ready = await listActiveCandidates();
      if (ready.length === 0) {
        setActiveInternal({ mode: "all" });
        return;
      }
      const next = await autoPickActive();
      setActiveInternal(next);
    },
    onVaultLocked() {
      // 锁定时关闭所有 namespace db：业务插件不应该再持有明文 DB。
      for (const [, entry] of openDbs) {
        try {
          entry.handle.close();
        } catch {
          // 静默
        }
      }
      openDbs.clear();
      setActiveInternal({ mode: "all" });
    },
    notifyKeyCreated(identity) {
      // 硬切换 002 收尾：新建 / 导入后**始终**把新 key 切为 active。
      // 设计缘由：用户导入或新建一把 key 的预期就是用这把新 key；
      // 之前"已有 active 时不切换"会让用户点完按钮看不到效果，反而
      // 需要再去顶栏手动切一次，违反最小惊讶原则。
      //
      // 实现委托给 activateCreatedKey 统一收口；如果调用方需要更精细
      // 的语义（例如批量导入时只激活最后一把），由调用方直接调
      // activateCreatedKey 而不是 notifyKeyCreated。
      this.activateCreatedKey(identity);
    },
    activateCreatedKey(identity) {
      if (!identity.publicKeyHash) {
        // 兜底：identity 缺 hash 时无法切到 single 模式，保持现状。
        return;
      }
      const prev = active;
      // 关闭旧 active 的 namespace db（如果存在），与 setActive 行为一致。
      closeActiveNamespace(prev.mode === "single" ? prev.activePublicKeyHash : undefined);
      setActiveInternal({ mode: "single", activePublicKeyHash: identity.publicKeyHash });
    },
    setInitializing(next) {
      setInitializingInternal(next);
    },
    attachBackgroundService(service) {
      // 硬切换 008：background 插件在 setup 后调用。幂等。
      attachedBackground = service;
    }
  };

  return service;
}

function eventOldVersion(_req: IDBOpenDBRequest): number {
  // 保留作为 type-level 占位；旧版 DOM lib 中 IDBTransaction 没有 oldVersion。
  return 0;
}

/**
 * indexedDB.deleteDatabase 在被其他标签页/同标签页打开的 db 持有时会进入 onblocked。
 * 这里用超时 + onblocked 转 reject 的方式保证不让 deleteKey 永久卡住。
 */
function deleteDatabaseWithTimeout(name: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Delete database "${name}" timed out`));
    }, timeoutMs);
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error ?? new Error("deleteDatabase failed"));
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Delete database "${name}" is blocked by another connection`));
    };
  });
}

// 抑制未使用告警：导出类型供测试断言；通过 cast 维持类型完整。
void (null as unknown as KeyspaceServiceContract);
void KEYSPACE_SERVICE_CAPABILITY;
void (null as unknown as VaultService);
