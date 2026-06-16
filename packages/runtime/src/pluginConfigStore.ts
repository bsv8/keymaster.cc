// packages/runtime/src/pluginConfigStore.ts
// 插件启停全局配置存储。
// 设计缘由（硬切换 001）：
//   - 系统级启停必须是全局配置，不能存进 key-scoped storage。
//   - 存储位置：localStorage key "keymaster.plugins.runtime"；
//     值为 JSON `{ [pluginId]: true|false }`，只记录"用户曾显式改过"的项。
//   - 没有记录的 pluginId 视为 `manifest.meta.defaultEnabled`。
//   - 残留 pluginId（manifest 已删除）被忽略，不影响启动。
//   - 多标签页通过 storage 事件广播，其他 host 实例收到后同步。

import type { PluginConfigStore, PluginConfigStoreListener } from "./pluginConfigStoreContract.js";

const STORAGE_KEY = "keymaster.plugins.runtime";

interface Stored {
  [pluginId: string]: boolean;
}

function safeRead(): Stored {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Stored;
    return {};
  } catch {
    return {};
  }
}

function safeWrite(value: Stored): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // quota / privacy mode：忽略
  }
}

export interface CreatePluginConfigStoreOptions {
  /** 测试用：禁止 setItem。 */
  readOnly?: boolean;
}

export function createPluginConfigStore(
  options: CreatePluginConfigStoreOptions = {}
): PluginConfigStore {
  const listeners = new Set<PluginConfigStoreListener>();
  let snapshot = safeRead();
  let writeEnabled = !options.readOnly;

  // 多标签页同步：监听 storage 事件。
  function onStorage(ev: StorageEvent) {
    if (ev.key !== STORAGE_KEY) return;
    snapshot = safeRead();
    for (const l of listeners) l({ ...snapshot });
  }
  if (typeof window !== "undefined" && !options.readOnly) {
    window.addEventListener("storage", onStorage);
  }

  return {
    read() {
      return { ...snapshot };
    },
    setEnabled(pluginId, enabled) {
      if (snapshot[pluginId] === enabled) return;
      snapshot = { ...snapshot, [pluginId]: enabled };
      if (writeEnabled) safeWrite(snapshot);
      for (const l of listeners) l({ ...snapshot });
    },
    clear(pluginId) {
      if (!(pluginId in snapshot)) return;
      const next = { ...snapshot };
      delete next[pluginId];
      snapshot = next;
      if (writeEnabled) safeWrite(snapshot);
      for (const l of listeners) l({ ...snapshot });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * 解析"哪些 pluginId 应该 enabled"。
     * 设计缘由：与 manifest list 合并：未记录项用 manifest.meta.defaultEnabled；
     * 残留项（manifest 中不存在）忽略。
     */
    resolveEnabled(knownPluginIds: string[], defaultEnabled: (id: string) => boolean): {
      enabled: Set<string>;
      ignored: string[];
    } {
      const enabled = new Set<string>();
      const known = new Set(knownPluginIds);
      const ignored: string[] = [];
      for (const id of known) {
        if (id in snapshot) {
          if (snapshot[id]) enabled.add(id);
        } else if (defaultEnabled(id)) {
          enabled.add(id);
        }
      }
      for (const id of Object.keys(snapshot)) {
        if (!known.has(id)) ignored.push(id);
      }
      return { enabled, ignored };
    }
  };
}
