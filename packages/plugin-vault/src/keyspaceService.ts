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
//   - 硬切换 005 收尾：active key 模型收窄为"single 模式唯一一把 ready key"；
//     `activePublicKeyHex` 缺省即"无 active key"。不再有 `mode: "all"`、
//     `setAll()`、所有模式持久化。`autoPickActive` 只在有 ready key 时返回具体
//     publicKeyHex；没有时返回 `{}`。
//   - 删除 active key 时由 `autoPickActive` 选下一把 ready key；没有 ready 时
//     active 清空，调用方（keyspace）发布新 state。仍有可能由壳层判断
//     `listKeys().length > 0 && !activePublicKeyHex` 进入"修复/管理态"阻断。
//   - 硬切换 004：active 切换、Vault 锁定、删除 key 三条路径统一收口到同
//     一条 namespace quiesce 语义——cancelByKey（await 旧实例退出）再
//     关闭 openDbs。"后台任务已收到 abort"不等于"已退出"；必须 await 到
//     旧实例真正结束，否则会出现 history-backfill 还在跑却已经撞上
//     `database connection is closing` 的竞态。该语义由内部 helper
//     `quiesceNamespace(publicKeyHex)` 提供；setActive / prepareDeleteKey
//     / onVaultLocked 都必须复用这一条路径，不能在调用方各自手写。
//   - 硬切换 001 收口：平台身份根字段统一为 publicKeyHex；DB name、
//     事件 payload、active state、localStorage 键全部按 publicKeyHex
//     走。旧 `publicKeyHash` 平台身份字段已从 contract / service 删
//     除；不再保留兼容 alias。

import type { MessageBus } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  BackgroundService,
  KeyIdentity,
  KeyScopedStorageHandle,
  KeyScopedStorageOpenInput,
  KeyspaceService,
  PluginLogger
} from "@keymaster/contracts";
import {
  EVENT_ACTIVE_KEY_CHANGED,
  EVENT_KEYSPACE_INITIALIZATION,
  KeyspaceService as KeyspaceServiceContract
} from "@keymaster/contracts";
import type { VaultService } from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY } from "@keymaster/contracts";

const ACTIVE_KEY_STORAGE_KEY = "keyspace.activePublicKeyHex";
/**
 * 旧 localStorage 键（activePublicKeyHash）——硬切换 001 收口后不再
 * 读取,只允许在 unlock / bootstrap 阶段 best-effort 清理一次,避免
 * 旧 keyspace active 状态被错误继承。
 */
const LEGACY_ACTIVE_KEY_STORAGE_KEY = "keyspace.activePublicKeyHash";
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
  /**
   * 硬切换 002：业务插件注入的 logger。
   * key.deleted / active.changed / identity.failed 走统一日志。
   * 不传时不记日志。
   */
  logger?: PluginLogger;
}

export interface KeyspaceHandle extends KeyspaceService {
  /** 在 Vault unlock 后调用，触发 identity backfill。 */
  onVaultUnlocked(): Promise<void>;
  /**
   * Vault 锁定时的平台级清理屏障（硬切换 004）。
   *
   * 语义：
   *   1) 若有 active key，先 await quiesceNamespace(active) 把它
   *      的后台任务停稳、DB handle 关掉；
   *   2) 再关闭可能残留的其它 openDbs；
   *   3) 再 setActiveInternal({}) 清空 active。
   *
   * resolve 时表示"当前 namespace 的后台任务已退出，相关 DB handle
   * 已关闭"。这是 `vault.locked` 事件发布之前必须先 await 的屏障：
   * 业务插件订阅 vault.locked 不再承担"正确性依赖于我先 cancel"
   * 的职责，顺序由 keyspace 统一掌控。错误必须冒泡；调用方不允许
   * catch 后伪装成成功锁屏。
   */
  onVaultLocked(): Promise<void>;
  /**
   * 通知 keyspace 一个 key 被创建（vault 在 importPrivateKey 成功后调用）。
   *
   * 硬切换 004 收尾：返回 Promise<void>，调用方必须 await——内部会先
   * await quiesceNamespace(prev.active) 把旧 key 的后台任务停稳、再
   * 切到新 key active；只有 await 走完才表示"新 key 已真正成为
   * active"。如果同步调用且不 await，等同于把旧 key 的 history-backfill
   * 留在内存里继续跑、和新 active 的 namespace DB 切换撞在一起。
   */
  notifyKeyCreated(identity: KeyIdentity): Promise<void>;
  /**
   * 显式"把某把 key 切为 active"。vault 在 importPrivateKey / generateKey
   * 成功后必须调用，确保新 key 进入 single 模式。
   *
   * 与 `setActive(publicKeyHex)` 的区别：本方法不依赖 identityStatus 过滤
   * ——keyspace 自己刚被通知了一把新 key（同一调用链），应无条件接受。
   * `setActive` 走 listActiveCandidates 过滤，是用户手动切 key 的入口。
   *
   * 硬切换 004 收尾：返回 Promise<void>，内部必须先 await quiesceNamespace
   * 旧 active 的 namespace（cancelByKey + await 旧 task 退出 + 关闭
   * openDbs），再 setActiveInternal。漏 await 等同于让 history-backfill
   * 在旧 key 仍在跑的情况下被新 active 顶走，复现 `database connection is
   * closing` 的同类竞态。
   */
  activateCreatedKey(identity: KeyIdentity): Promise<void>;
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
  /** 当前打开的 namespace db：key = `${publicKeyHex}::${dbName}`，用于共享与统一关闭。 */
  const openDbs = new Map<string, OpenDbEntry>();
  // 硬切换 008：保存 attach 进来的 background service 引用。
  // 初始可以是构造时直接传入的 deps.background（测试场景），也可以由
  // attachBackgroundService 在 background 插件装载后注入。
  let attachedBackground: BackgroundService | undefined = deps.background;

  // 硬切换 005 收尾：active state 只表达 `activePublicKeyHex`；不再有 mode。
  // 初值 `{}` = "无 active key"。构造期并不区分 vault 状态——vault bootstrap
  // 后由 `onVaultUnlocked` 收敛。
  let active: ActiveKeyState = {};
  let activeIdentity: KeyIdentity | undefined;
  let initializing = false;

  function persistActive(state: ActiveKeyState) {
    try {
      if (typeof localStorage === "undefined") return;
      if (state.activePublicKeyHex) {
        localStorage.setItem(ACTIVE_KEY_STORAGE_KEY, state.activePublicKeyHex);
      } else {
        localStorage.removeItem(ACTIVE_KEY_STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用时静默退化。
    }
  }

  function readPersistedActiveHex(): string | undefined {
    try {
      if (typeof localStorage === "undefined") return undefined;
      return localStorage.getItem(ACTIVE_KEY_STORAGE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 硬切换 001 收口：best-effort 清理旧 localStorage 键。旧
   * `keyspace.activePublicKeyHash` 不再被读取,这里只删一次避免脏数据。
   */
  function purgeLegacyActiveKeyStorage(): void {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.removeItem(LEGACY_ACTIVE_KEY_STORAGE_KEY);
    } catch {
      // 静默
    }
  }

  function setActiveInternal(next: ActiveKeyState, identity?: KeyIdentity) {
    const prev = active;
    active = next;
    activeIdentity = next.activePublicKeyHex ? identity : undefined;
    persistActive(next);
    // 硬切换 002：active 切换走统一日志；记录前后 publicKeyHex 摘要（不记私钥 / 不记 label 原文之外的内容）。
    if (prev.activePublicKeyHex !== next.activePublicKeyHex) {
      console.info("[keyspace] active.changed", {
        previousPublicKeyHex: prev.activePublicKeyHex,
        nextPublicKeyHex: next.activePublicKeyHex,
        nextKeyId: activeIdentity?.keyId
      });
      deps.logger?.info({
        scope: "vault.key",
        event: "active.changed",
        message: "Active key changed",
        data: {
          previousPublicKeyHex: prev.activePublicKeyHex,
          nextPublicKeyHex: next.activePublicKeyHex
        }
      });
    }
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
   * 返回所有可管理的 KeyIdentity（ready + failed + 无 hex）。
   * 设计缘由：硬切换 008 收尾——failed key 也必须能列出，用户需要看到
   * "这把 key 解密失败，只能删除"；listKeys 返回包含 failed 与无 hex。
   * `KeyIdentity` 的 publicKeyHex 在 identity 字段缺失
   * 时为 undefined，调用方需自行处理展示；短公钥由 UI 现算。
   *
   * 硬切换 003 收尾：本方法不再回填 `fingerprint` 字段——`KeyIdentity`
   * 也不再持有该字段。需要短公钥展示的调用方应拿 `publicKeyHex` 调
   * `formatShortPublicKey()` 现算。
   *
   * 硬切换 001 收口：旧 `publicKeyHash` 平台身份字段已删除。
   */
  async function listManageableKeys(): Promise<KeyIdentity[]> {
    const refs = await deps.vault.listKeys();
    return refs.map((r) => ({
      keyId: r.id,
      publicKeyHex: r.publicKeyHex,
      label: r.label,
      capabilities: r.capabilities,
      createdAt: r.createdAt,
      // 有 hex 的老记录 status 缺省按 "ready"；无 hex 的失败记录按
      // "uninitialized" 兜底（让 UI 显示"初始化中"），backfill 阶段
      // vaultService 会改写。
      identityStatus:
        r.identityStatus ?? (r.publicKeyHex ? "ready" : "uninitialized"),
      identityError: r.identityError
    }));
  }

  /**
   * 活跃候选：identityStatus === "ready" 且有 publicKeyHex。
   * setActive / autoPickActive / deleteKey / onVaultUnlocked 都用此函数，
   * 这样 failed key 不会成为 active，也不会被 deleteKey(publicKeyHex) 误删。
   */
  async function listActiveCandidates(): Promise<KeyIdentity[]> {
    return (await listManageableKeys()).filter(
      (k) => k.identityStatus === "ready" && Boolean(k.publicKeyHex)
    );
  }

  function dbNameFor(publicKeyHex: string, pluginId: string, storageId: string): string {
    return `${ALL_KEYS_DB_PREFIX}${publicKeyHex}.plugin.${pluginId}.${storageId}`;
  }

  /**
   * 自动选 active key：
   *   - 已持久化的 hex 仍存在 -> 用持久化 hex。
   *   - 否则取 createdAt 最近或列表第一把。
   *   - 没有 ready key -> `{}`（无 active key）。这对应"vault 内有 failed
   *     key 但没有 ready key"或"vault 内无 key 已被 finalize 到 uninitialized"
   *     两种情况，由调用方（壳层）区分。
   */
  async function autoPickActive(): Promise<KeyIdentity | undefined> {
    const ready = await listActiveCandidates();
    if (ready.length === 0) {
      return undefined;
    }
    const persistedHex = readPersistedActiveHex();
    if (persistedHex) {
      const found = ready.find((k) => k.publicKeyHex === persistedHex);
      if (found) return found;
    }
    // 取最近创建；并列时取列表第一把。
    const sorted = [...ready].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return sorted[0];
  }

  /**
   * 关闭指定 key 的 namespace db：业务插件可能缓存了旧 namespace 的
   * IDBDatabase，必须关闭后由它们重新 openKeyStorage 拿到新 namespace。
   * 设计缘由：active key 切换不应该把别的 key 的打开的 db 也关闭；只关闭当前
   * 即将离开的 active key 的 db。但因为 openKeyStorage 是按需打开的，未必已开，
   * 所以这里只关闭"旧 active"的 db。
   */
  function closeNamespaceHandles(publicKeyHex: string | undefined) {
    if (!publicKeyHex) return;
    const prefix = `${publicKeyHex}::`;
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
   * 硬切换 004：namespace quiesce——"停任务并等待退出再关 handle"的
   * 单一实现来源。setActive / prepareDeleteKey / onVaultLocked 必须
   * 共用这条路径，不能在调用方各自手写；只要一条路径忘记 await，
   * 就会重新长回 history-backfill 撞上 `database connection is closing`
   * 的同类 bug。
   *
   * 顺序（不可重排）：
   *   1) 若 attachedBackground 存在，await cancelByKey(publicKeyHex)——
   *      background 内部 cancelByKey 已经会 t.ctl?.abort() 再
   *      `await awaitIdle(t)` 等旧实例真正结束；这一句 resolve 时
   *      表示该 key 的 task 旧实例已退出。
   *   2) 关闭该 key 的 openDbs。
   *
   * 没有 attachedBackground 时按"最小语义退化"——直接关 handle。这
   * 表示"当前没有可等待的后台平台接入"，不新建第二套本地任务状态机。
   *
   * 错误必须冒泡：cancelByKey 失败或 close 异常不允许在这里 catch 成
   * 成功——调用方（setActive / prepareDeleteKey / vaultService.lock）
   * 需要正确性边界。
   */
  async function quiesceNamespace(publicKeyHex: string | undefined): Promise<void> {
    if (!publicKeyHex) return;
    if (attachedBackground) {
      await attachedBackground.cancelByKey(publicKeyHex);
    }
    closeNamespaceHandles(publicKeyHex);
  }

  /**
   * 内部删除路径：单一实现 deleteKey / deleteKeyById 的 namespace 清理。
   * 设计缘由：deleteKey(publicKeyHex) 已通过 listActiveCandidates 过滤
   * 掉 failed key，但 deleteKeyById 允许 failed+hex 也走这里——本函数
   * 不再做 status 检查，只负责按 (keyId, publicKeyHex) 把数据清干净。
   *
   * 硬切换 002：本函数假设密码校验**已经**在 deleteKey / deleteKeyById
   * 入口完成，自己不再重复校验；这样 verify 失败时连 prepareDeleteKey
   * 都不会被调到，符合"密码错误时完全不开始删除"的硬切换语义。
   *
   * 硬切换 005 收尾：active fallback 改为单 active 模型——删的是 active
   * key 时切到下一把 ready key；没有 ready key 时 active 清空（`{}`），
   * 由壳层判断 `listKeys().length > 0` 决定是否进入"修复/管理态"。
   *
   * 这是 createKeyspaceService 内部的闭包函数，**不**挂在 service 对象上，
   * 因此不会随 `keyspace.service` capability 暴露给插件作者；插件只能走
   * deleteKey / deleteKeyById 这两个 public 入口。
   */
  async function deleteKeyRecord({ keyId, publicKeyHex }: { keyId: string; publicKeyHex: string }) {
    // 1) prepare：cancel background + 关闭 handle + emit key.deleting。
    await service.prepareDeleteKey(publicKeyHex);
    // 2) 删除 namespace DB：必须全部成功才能继续删 Vault 私钥。
    for (const reg of registeredStorages) {
      const name = dbNameFor(publicKeyHex, reg.pluginId, reg.storageId);
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
    //    已经被删，必须通知调用方并保留 tombstone。
    try {
      await deps.vault.deleteKeyMaterial(keyId);
    } catch (err) {
      deps.messageBus.publish("key.delete.vault-failed", {
        publicKeyHex,
        keyId,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
    // 4) 通知业务插件 key 已删除（仅此处发一次，vault.deleteKeyMaterial 不再发）。
    deps.messageBus.publish("key.deleted", { publicKeyHex, keyId });
    deps.logger?.info({
      scope: "vault.key",
      event: "key.deleted",
      message: "Vault key deleted",
      data: { keyId, publicKeyHex }
    });
    // 5) 收尾：剩余 0 把 key 时走 vault.finalizeEmptyVaultAfterLastKeyDeletion
    //    把 Vault 收回 uninitialized；否则按 active fallback 处理。
    //
    // 硬切换 002 设计要点：
    //   - "是否删空"以 Vault 实际剩余 key 数量为准（包含 failed /
    //     uninitialized / no-hex key），不能用 listActiveCandidates
    //     的 ready key 数量，否则会在"还有 failed key"时错误地把
    //     Vault 销毁，丢失用户数据。
    //   - 仍有 key 时：删的是 active key 走 autoPickActive 选下一把
    //     ready；没有 ready 但有其它残留 key 时 active 清空（`{}`），
    //     Vault 保持 unlocked，由壳层识别"无 active key 但有 key"进入
    //     修复/管理态。
    //   - finalizeEmptyVaultAfterLastKeyDeletion 失败必须冒泡：UI
    //     不能在"meta 还在"的异常残留态显示成功（施工单情况 4）。
    //     `key.deleted` 已经发出，那是真的——但 Vault 收尾失败要让
    //     调用方知道。
    const remainingAll = await deps.vault.listKeys();
    if (remainingAll.length === 0) {
      await deps.vault.finalizeEmptyVaultAfterLastKeyDeletion();
      return;
    }
    if (active.activePublicKeyHex === publicKeyHex) {
      const next = await autoPickActive();
      closeNamespaceHandles(publicKeyHex);
      if (next) {
        setActiveInternal({ activePublicKeyHex: next.publicKeyHex }, next);
      } else {
        setActiveInternal({});
      }
    }
  }

  const service: KeyspaceHandle = {
    async listKeys() {
      // 硬切换 008 收尾：返回 ready + failed，让 UI 看到"解密失败"并允许删除。
      return listManageableKeys();
    },
    async getKey(publicKeyHex) {
      // 用 manageable 而非 candidates：UI 可能需要知道"该 hex 对应的 key
      // 是 failed"以便提示用户。
      const all = await listManageableKeys();
      return all.find((k) => k.publicKeyHex === publicKeyHex);
    },
    active() {
      return active;
    },
    async setActive(publicKeyHex) {
      // setActive 必须用 candidates：failed key 不能成为 active。
      const all = await listActiveCandidates();
      const target = all.find((k) => k.publicKeyHex === publicKeyHex);
      if (!target) {
        throw new Error("Key not found");
      }
      // 硬切换 004：重复切到当前 active key 时不做任何事——不 cancel、
      // 不 close、不重发 active.changed，避免打断正在跑的同步任务。
      if (active.activePublicKeyHex === publicKeyHex) {
        return;
      }
      // 顺序收紧：先 quiesce 旧 active 的 namespace（await 旧 task
      // 退出 + 关闭其 openDbs），再切 active。
      //
      // 设计缘由：active 一旦先变，background task 的 keyScope 延迟
      // 求值会指向新 key，此时再 cancelByKey(oldKey) 已无法正确匹配
      // 旧 task。必须"先停旧 key 任务，再切 active"。
      const prev = active;
      await quiesceNamespace(prev.activePublicKeyHex);
      setActiveInternal({ activePublicKeyHex: publicKeyHex }, target);
    },
    requireActiveKey() {
      if (!active.activePublicKeyHex) {
        throw new Error("Active key is required");
      }
      if (activeIdentity && activeIdentity.publicKeyHex === active.activePublicKeyHex) {
        console.info("[keyspace] requireActiveKey", {
          keyId: activeIdentity.keyId,
          publicKeyHex: activeIdentity.publicKeyHex,
          label: activeIdentity.label
        });
        return activeIdentity;
      }
      console.warn("[keyspace] requireActiveKey fallback without cached identity", {
        activePublicKeyHex: active.activePublicKeyHex
      });
      return {
        keyId: active.activePublicKeyHex,
        publicKeyHex: active.activePublicKeyHex,
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
      const cacheKey = `${input.publicKeyHex}::${input.pluginId}::${input.storageId}`;
      const existing = openDbs.get(cacheKey);
      if (existing) {
        existing.refCount += 1;
        return existing.handle;
      }
      const name = dbNameFor(input.publicKeyHex, input.pluginId, input.storageId);
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
      // namespace DB 打开成功后检查它是否仍然属于当前 active publicKeyHex。
      // 若 active 已切换走，关闭并要求调用方重新 open。
      if (active.activePublicKeyHex && active.activePublicKeyHex !== input.publicKeyHex) {
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
    async prepareDeleteKey(publicKeyHex) {
      // 硬切换 008 收尾 + 硬切换 004：严格顺序 + fail-closed。
      //   1) quiesceNamespace —— cancelByKey（await 旧 task 退出）+ 关闭
      //      该 key 的 openDbs。失败必须冒泡以阻止后续 namespace DB /
      //      Vault 私钥删除。
      //   2) emit key.deleting（emit 不可 await，作为日志/保险通知）
      //
      // 设计缘由：quiesceNamespace 是 active 切换 / 删除 key / Vault 锁定
      // 三条路径的唯一实现来源。prepareDeleteKey 必须复用，不能再手写
      // 一份"先 cancel 再关 handle"。
      await quiesceNamespace(publicKeyHex);
      deps.messageBus.publish("key.deleting", { publicKeyHex });
    },
    async deleteKey(input) {
      // 硬切换 002：删除主流程**第一步**必须是 vault.verifyPassword。
      // 密码错误时直接抛 Invalid password，**完全不开始**删除——不调
      // prepareDeleteKey、不取消 background、不动 namespace DB / 私钥。
      await deps.vault.verifyPassword(input.password);
      // 严格只允许 ready key 走 publicKeyHex 主路径。设计缘由：
      // deleteKey(publicKeyHex) 是平台身份查找的"已就绪"入口；如果
      // 调用方传一个 identityStatus="failed" 但仍有 hex 的 key，应改走
      // deleteKeyById(keyId) 走管理入口。
      const ready = await listActiveCandidates();
      const target = ready.find((k) => k.publicKeyHex === input.publicKeyHex);
      if (!target) {
        throw new Error("Key not found");
      }
      // 委托给 deleteKeyRecord：单一删除路径，避免重复实现。
      return deleteKeyRecord({ keyId: target.keyId, publicKeyHex: input.publicKeyHex });
    },
    async deleteKeyById(input) {
      // 硬切换 002：管理入口的密码校验同样收口在 service 层；UI 不能
      // 在外面"先校验、再删"——那会让密码授权语义散落在每个页面。
      await deps.vault.verifyPassword(input.password);
      // 管理入口：允许 ready / failed / 无 hex 的 key 走同一条路径。
      // 设计缘由：硬切换 008 收尾——failed key 也可能有 publicKeyHex
      // （vaultDb.putKeyIdentityFailed 只改 status、不动 identity 字段），
      // 因此 deleteKeyById 必须能处理 failed+hex 的情况，走完整 namespace
      // 清理（cancelByKey + 删 namespace DB + 删私钥材料）。
      const ref = await deps.vault.getKey(input.keyId);
      if (!ref) {
        throw new Error("Key not found");
      }
      if (ref.publicKeyHex) {
        // 有 hex：走完整 namespace 清理路径——不依赖 listActiveCandidates。
        return deleteKeyRecord({ keyId: input.keyId, publicKeyHex: ref.publicKeyHex });
      }
      // 无 hex：没有 namespace DB 可删，只删私钥材料。
      await deps.vault.deleteKeyMaterial(input.keyId);
      // keyspace 统一发一次 key.deleted（payload 不带 publicKeyHex）。
      deps.messageBus.publish("key.deleted", { keyId: input.keyId });
      // 硬切换 002：剩余 0 把 key 时同样走 finalize empty vault 收尾；
      // 否则继续保留 active fallback（无 hex key 天然不可能是 active）。
      const remaining = await deps.vault.listKeys();
      if (remaining.length === 0) {
        await deps.vault.finalizeEmptyVaultAfterLastKeyDeletion();
        return;
      }
      // 硬切换 005：active 仍指向这把被删 key 的 hex 时（极少出现：active
      // 缓存与 deleteById 之前已经不一致），把 active 清空让壳层按
      // listKeys() > 0 决定走修复/管理态。
      if (active.activePublicKeyHex) {
        setActiveInternal({});
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
      // 硬切换 001 收口：解锁后先 best-effort 清理旧 localStorage
      // activePublicKeyHash 键,避免脏数据被错误继承。
      purgeLegacyActiveKeyStorage();
      // 解锁后 backfill 阶段由 vaultService 触发；keyspace 只需等。
      // 若 keyspace 没有 ready key（首次解锁或 backfill 全部失败），active 清空。
      const ready = await listActiveCandidates();
      if (ready.length === 0) {
        setActiveInternal({});
        return;
      }
      const next = await autoPickActive();
      if (next) {
        setActiveInternal({ activePublicKeyHex: next.publicKeyHex }, next);
      } else {
        setActiveInternal({});
      }
    },
    async onVaultLocked() {
      // 硬切换 004：锁屏清理屏障。顺序：
      //   1) 若当前有 active key，先 await quiesceNamespace(active)
      //      —— cancelByKey（await 旧 task 退出）+ 关闭该 namespace 的
      //      openDbs；
      //   2) 关闭可能残留的其它 openDbs（其它 hex 的）；
      //   3) setActiveInternal({})。
      //
      // resolve 时表示"当前 active key 的后台任务已退出、相关 DB handle
      // 已关闭"。vaultService.lock() 必须先 await 本方法再 publish
      // `vault.locked`——业务插件订阅 vault.locked 不再承担"我必须先
      // cancel 才安全"的职责。
      await quiesceNamespace(active.activePublicKeyHex);
      // 步骤 2：清理其它残留 namespace db。
      for (const [, entry] of [...openDbs.entries()]) {
        try {
          entry.handle.close();
        } catch {
          // 静默
        }
      }
      openDbs.clear();
      setActiveInternal({});
    },
    async notifyKeyCreated(identity) {
      // 硬切换 002 收尾 + 硬切换 004 收尾：新建 / 导入后**始终**把新 key
      // 切为 active。
      // 设计缘由：用户导入或新建一把 key 的预期就是用这把新 key；
      // 之前"已有 active 时不切换"会让用户点完按钮看不到效果，反而
      // 需要再去顶栏手动切一次，违反最小惊讶原则。
      //
      // 实现委托给 activateCreatedKey 统一收口；调用方必须 await 本方法，
      // 直到旧 key 的后台任务退出 + 旧 namespace DB 关掉之后，新 key
      // 才成为 active——否则旧 key 的 history-backfill 仍在跑却撞上
      // 旧 namespace DB 被关闭，与手动 setActive 的竞态同源。
      //
      // 如果调用方需要更精细的语义（例如批量导入时只激活最后一把），
      // 由调用方直接调 activateCreatedKey 而不是 notifyKeyCreated。
      await this.activateCreatedKey(identity);
    },
    async activateCreatedKey(identity) {
      if (!identity.publicKeyHex) {
        // 兜底：identity 缺 hex 时无法切到 single 模式，保持现状。
        return;
      }
      const prev = active;
      // 硬切换 004 收尾：与 setActive(B) 共用同一条 namespace quiesce
      // 语义——先 await cancelByKey + await 旧 task 退出 + 关闭
      // openDbs，再 setActiveInternal。新 key 此时尚不存在，没有 task
      // 跑在它身上；旧的 recent-sync / history-backfill 必须真正退出
      // 后才能被"踢出"旧 namespace，否则会撞上 `database connection
      // is closing`。
      await quiesceNamespace(prev.activePublicKeyHex);
      setActiveInternal({ activePublicKeyHex: identity.publicKeyHex }, identity);
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
