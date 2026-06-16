// packages/plugin-poker/src/pokerIdentityBinding.ts
// 稳定 poker identity 绑定管理器。
//
// 设计缘由：
//   - 硬切换 001 修订版 100 / 567 / 764 行：plugin-poker 的 presence /
//     桌主身份 / 聊天身份 / 断线重连身份必须独立于 keyspace.active() 漂移。
//     用户在 settings 显式挑一把 vault key 作为 poker identity，切换
//     active key 不会隐式改变它。
//   - 绑定信息存在"该被绑定 key 的 key-scoped storage"里：
//     `keymaster.key.<publicKeyHash>.plugin.plugin-poker.poker` →
//     identityBinding store。这样：
//       * 删除该 key 时 namespace DB 一起删除，绑定自然失效；
//       * Vault 锁定时 storage 无法打开，binding fail-closed 为 null。
//   - 业务方拿绑定走 `getCurrentBinding()`（内存缓存）；首次解锁后由
//     `loadFromVault()` 主动 hydrate。
//   - 解绑或换绑必须**先断 proxy 连接**，避免老 session 用旧身份继续
//     收发；这部分逻辑放在 pokerService 里调用本模块。
//
// 行为不变量：
//   1. vault.status() !== "unlocked" → 一律返回 null（fail-closed）。
//   2. keyspace 里找不到 binding 指向的 key → 自动 unbind 并返回 null。
//   3. 内存缓存与磁盘必须同步：每次 set/clear 都先写盘后更新缓存。

import type {
  KeyIdentity,
  KeyspaceService,
  PokerIdentityBinding,
  PokerIdentityBindingState,
  PokerIdentityCandidate,
  VaultService
} from "@keymaster/contracts";
import {
  POKER_KEY_STORAGE_ID,
  POKER_KEY_STORAGE_VERSION,
  clearIdentityBinding,
  readIdentityBinding,
  upgradePokerDb,
  writeIdentityBinding,
  type CachedIdentityBinding
} from "./pokerDb.js";

/** 绑定管理器的依赖。 */
export interface PokerIdentityBindingDeps {
  vault: VaultService;
  keyspace: KeyspaceService;
}

/** 绑定监听器签名。 */
export type PokerIdentityBindingHandler = (b: PokerIdentityBindingState) => void;

/** 单例：进程内持有一个绑定状态机。 */
export class PokerIdentityBindingManager {
  private readonly deps: PokerIdentityBindingDeps;
  private current: PokerIdentityBindingState = null;
  private handlers = new Set<PokerIdentityBindingHandler>();
  /** 一次 hydrate 用的状态，避免多次并发 open IndexedDB。 */
  private hydratePromise: Promise<void> | null = null;
  /** 标识"已尝试过 hydrate"，用于 unlock → 自动 load。 */
  private hydrated = false;

  constructor(deps: PokerIdentityBindingDeps) {
    this.deps = deps;
    // vault 锁定时立即清空绑定缓存（fail-closed）。
    deps.vault.onStatusChange((s) => {
      if (s !== "unlocked") {
        this.current = null;
        this.hydrated = false;
        this.notify();
      } else {
        // 解锁后异步 hydrate；UI 通过 onChange 拿结果。
        void this.loadFromVault().catch(() => undefined);
      }
    });
  }

  /** 当前绑定（fail-closed：vault 未解锁返回 null）。 */
  get(): PokerIdentityBindingState {
    if (this.deps.vault.status() !== "unlocked") return null;
    return this.current ? { ...this.current } : null;
  }

  /** 订阅绑定变化；订阅时立即推一次当前值（与 vault 状态对齐）。 */
  onChange(handler: PokerIdentityBindingHandler): () => void {
    this.handlers.add(handler);
    handler(this.get());
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * 从 key-scoped storage 中 hydrate 绑定（解锁后调用）。
   *
   * 设计缘由：绑定写在"被绑定 key 的 namespace"里，但本管理器在 hydrate
   * 时无法预先知道用户当年挑的是哪把 key。解决：逐把 ready 的 key 打开
   * 它的 namespace，只要任意一把 storage 里有 binding 记录，就视为
   * 当前绑定（约束："任何时刻只允许 0 或 1 个 binding"——bindIdentity
   * 时会清掉其它 namespace 的旧 binding）。
   */
  async loadFromVault(): Promise<void> {
    if (this.deps.vault.status() !== "unlocked") {
      this.current = null;
      this.hydrated = true;
      this.notify();
      return;
    }
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      try {
        const keys = await this.deps.keyspace.listKeys();
        let found: PokerIdentityBinding | null = null;
        for (const key of keys) {
          if (key.identityStatus && key.identityStatus !== "ready") continue;
          if (!key.publicKeyHash || !key.publicKeyHex) continue;
          let handle: { db: IDBDatabase; close(): void } | null = null;
          try {
            handle = await this.deps.keyspace.openKeyStorage({
              publicKeyHash: key.publicKeyHash,
              pluginId: "plugin-poker",
              storageId: POKER_KEY_STORAGE_ID,
              version: POKER_KEY_STORAGE_VERSION,
              upgrade: upgradePokerDb
            });
            const row = await readIdentityBinding(handle.db);
            if (row) {
              // 校验 row 与 key 元数据是否一致；不一致则修复或丢弃。
              if (row.publicKeyHash === key.publicKeyHash) {
                found = {
                  bound: true,
                  publicKeyHash: row.publicKeyHash,
                  publicKeyHex: row.publicKeyHex,
                  keyId: row.keyId,
                  label: row.label,
                  boundAt: row.boundAt
                };
                break;
              }
              // hash mismatch：异常数据，丢弃。
              await clearIdentityBinding(handle.db).catch(() => undefined);
            }
          } catch {
            // 打开该 key 的 storage 失败（fail-closed），跳到下一把。
            continue;
          } finally {
            try { handle?.close(); } catch { /* noop */ }
          }
        }
        this.current = found;
        this.hydrated = true;
        this.notify();
      } finally {
        this.hydratePromise = null;
      }
    })();
    return this.hydratePromise;
  }

  /** 列出可作为 poker identity 的候选 key（vault.unlocked 后调用）。 */
  async listCandidates(): Promise<PokerIdentityCandidate[]> {
    if (this.deps.vault.status() !== "unlocked") return [];
    const active = this.deps.keyspace.active();
    const keys = await this.deps.keyspace.listKeys();
    const out: PokerIdentityCandidate[] = [];
    for (const k of keys) {
      if (k.identityStatus && k.identityStatus !== "ready") continue;
      if (!k.publicKeyHash || !k.publicKeyHex) continue;
      out.push({
        keyId: k.keyId,
        publicKeyHash: k.publicKeyHash,
        publicKeyHex: k.publicKeyHex,
        label: k.label,
        isActive: active.mode === "single" && active.activePublicKeyHash === k.publicKeyHash
      });
    }
    return out;
  }

  /**
   * 显式绑定一把 vault key 作为 poker identity。
   *
   * 实现要点（fail-closed 链）：
   *   1. vault 必须 unlocked；否则抛错。
   *   2. publicKeyHash 必须在 keyspace 内可找到且 ready；否则抛错。
   *   3. 写入新 binding 之前，先清除"任何其它 namespace 里残留的 binding
   *      记录"（多 key 之间任意一把都不可能多份），保证不变量
   *      "0 or 1 binding"。
   *   4. 写盘成功后才更新内存缓存 + notify。
   */
  async bind(input: { publicKeyHash: string; label?: string }): Promise<PokerIdentityBinding> {
    if (this.deps.vault.status() !== "unlocked") {
      throw new Error("Cannot bind poker identity while vault is locked");
    }
    const target = await this.deps.keyspace.getKey(input.publicKeyHash);
    if (!target || !target.publicKeyHex || !target.publicKeyHash) {
      throw new Error(`No usable key for publicKeyHash ${input.publicKeyHash}`);
    }
    if (target.identityStatus && target.identityStatus !== "ready") {
      throw new Error(`Key ${input.publicKeyHash} is not ready (${target.identityStatus})`);
    }

    // 1) 清掉其它 namespace 里残留的 binding（不变量 "0 or 1 binding"）。
    const keys = await this.deps.keyspace.listKeys();
    for (const k of keys) {
      if (!k.publicKeyHash) continue;
      if (k.publicKeyHash === target.publicKeyHash) continue;
      try {
        const handle = await this.deps.keyspace.openKeyStorage({
          publicKeyHash: k.publicKeyHash,
          pluginId: "plugin-poker",
          storageId: POKER_KEY_STORAGE_ID,
          version: POKER_KEY_STORAGE_VERSION,
          upgrade: upgradePokerDb
        });
        try {
          await clearIdentityBinding(handle.db).catch(() => undefined);
        } finally {
          try { handle.close(); } catch { /* noop */ }
        }
      } catch {
        // 该 key 的 storage 打不开也不阻断 bind；不变量靠下次 hydrate 修复。
        continue;
      }
    }

    // 2) 写入新 binding。
    const cached: CachedIdentityBinding = {
      id: "binding",
      publicKeyHash: target.publicKeyHash,
      publicKeyHex: target.publicKeyHex,
      keyId: target.keyId,
      label: input.label ?? target.label ?? target.publicKeyHash,
      boundAt: nowMs()
    };
    const handle = await this.deps.keyspace.openKeyStorage({
      publicKeyHash: target.publicKeyHash,
      pluginId: "plugin-poker",
      storageId: POKER_KEY_STORAGE_ID,
      version: POKER_KEY_STORAGE_VERSION,
      upgrade: upgradePokerDb
    });
    try {
      await writeIdentityBinding(handle.db, cached);
    } finally {
      try { handle.close(); } catch { /* noop */ }
    }

    // 3) 更新内存缓存 + notify。
    this.current = {
      bound: true,
      publicKeyHash: cached.publicKeyHash,
      publicKeyHex: cached.publicKeyHex,
      keyId: cached.keyId,
      label: cached.label,
      boundAt: cached.boundAt
    };
    this.hydrated = true;
    this.notify();
    return { ...this.current };
  }

  /** 清除当前绑定；fail-safe，没有 binding 时也允许调用。 */
  async unbind(): Promise<void> {
    if (this.deps.vault.status() !== "unlocked") {
      // 锁定时直接清缓存即可。
      this.current = null;
      this.notify();
      return;
    }
    const cur = this.current;
    if (cur) {
      try {
        const handle = await this.deps.keyspace.openKeyStorage({
          publicKeyHash: cur.publicKeyHash,
          pluginId: "plugin-poker",
          storageId: POKER_KEY_STORAGE_ID,
          version: POKER_KEY_STORAGE_VERSION,
          upgrade: upgradePokerDb
        });
        try {
          await clearIdentityBinding(handle.db);
        } finally {
          try { handle.close(); } catch { /* noop */ }
        }
      } catch {
        // 即使 storage 打不开也要清掉内存缓存——下一次 hydrate 会兜底。
      }
    }
    this.current = null;
    this.notify();
  }

  /**
   * 解析 binding → KeyIdentity（签名前调用）。
   *
   * 设计缘由：vault.withPrivateKey 需要 keyId；binding 里就有，但额外
   * 校验当前 keyspace 仍能找到这把 key（用户中途删除时立即 fail）。
   */
  async resolveIdentity(): Promise<KeyIdentity | null> {
    const b = this.get();
    if (!b) return null;
    const id = await this.deps.keyspace.getKey(b.publicKeyHash);
    if (!id) {
      // 绑定 key 已被删除：自动 unbind 防止悬挂。
      await this.unbind().catch(() => undefined);
      return null;
    }
    if (id.identityStatus && id.identityStatus !== "ready") return null;
    return id;
  }

  /**
   * 以"当前绑定 key"为 namespace 打开 plugin-poker 的 key-scoped storage，
   * 把回调跑在 db 句柄上，结束后保证 close()。
   *
   * 设计缘由（修复"settings 不持久化"问题）：service 需要把 proxy endpoint
   * 等偏好写到当前 identity 的 namespace 里；这要求 service 不直接耦合
   * indexedDB 命名规则，由 binding 管理器提供"按当前 binding 打开 storage"
   * 这一原子动作。fail-closed：未绑定 / vault 锁定时 callback 不会被调，
   * 返回 null。
   */
  async withStorage<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
    const b = this.get();
    if (!b) return null;
    let handle: { db: IDBDatabase; close(): void } | null = null;
    try {
      handle = await this.deps.keyspace.openKeyStorage({
        publicKeyHash: b.publicKeyHash,
        pluginId: "plugin-poker",
        storageId: POKER_KEY_STORAGE_ID,
        version: POKER_KEY_STORAGE_VERSION,
        upgrade: upgradePokerDb
      });
      return await fn(handle.db);
    } catch {
      return null;
    } finally {
      try { handle?.close(); } catch { /* noop */ }
    }
  }

  /** 简化的迭代器：执行 handler 时若抛错只 swallow，不影响其它订阅者。 */
  private notify(): void {
    const snapshot = this.get();
    for (const h of this.handlers) {
      try { h(snapshot); } catch { /* noop */ }
    }
  }
}

/** 工厂方法。 */
export function createPokerIdentityBinding(deps: PokerIdentityBindingDeps): PokerIdentityBindingManager {
  return new PokerIdentityBindingManager(deps);
}

/**
 * 时间戳工具：把"现在毫秒数"集中到一个函数，便于测试 stub。
 * 设计缘由：本模块持久化字段含 boundAt；vitest 用 fake timers 时
 * 需要可拦截一次性 Date.now()。
 */
function nowMs(): number {
  return Date.now();
}
