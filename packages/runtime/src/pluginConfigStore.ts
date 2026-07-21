// packages/runtime/src/pluginConfigStore.ts
// 插件启停全局配置存储。
// 设计缘由（硬切换 001）：
//   - 系统级启停必须是全局配置，不能存进 key-scoped storage。
//   - 存储位置：localStorage key "keymaster.plugins.runtime"；
//     值为版本化 JSON `{ version: 2, enabled: { [pluginId]: boolean } }`。
//   - 没有记录的 pluginId 视为 `manifest.meta.defaultEnabled`；required plugin
//     永远规范化为 true。
//   - 残留 pluginId（manifest 已删除）被忽略，不影响启动。
//   - 多标签页通过 storage 事件广播，其他 host 实例收到后同步。

import type {
  PluginConfigDiagnostic,
  PluginConfigSnapshot,
  PluginConfigStore,
  PluginConfigStoreListener
} from "./pluginConfigStoreContract.js";

const STORAGE_KEY = "keymaster.plugins.runtime";

interface StoredV2 {
  version: 2;
  enabled: Record<string, boolean>;
}

interface Stored {
  [pluginId: string]: boolean;
}

function safeRead(onDiagnostic: (diagnostic: PluginConfigDiagnostic) => void): { value: Stored; version: number; needsWrite: boolean } {
  if (typeof localStorage === "undefined") return { value: {}, version: 2, needsWrite: false };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { value: {}, version: 2, needsWrite: false };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 2 && parsed.enabled && typeof parsed.enabled === "object") {
      return { value: parsed.enabled as Stored, version: 2, needsWrite: false };
    }
    if (parsed && typeof parsed === "object" && !("version" in parsed)) {
      onDiagnostic({ kind: "migrated-v1", message: "Migrated legacy plugin config to schema v2" });
      return { value: parsed as Stored, version: 1, needsWrite: true };
    }
    onDiagnostic({ kind: "unknown-version", message: "Unknown plugin config schema; using empty configuration" });
    return { value: {}, version: 0, needsWrite: true };
  } catch {
    onDiagnostic({ kind: "invalid-json", message: "Invalid plugin config JSON; using empty configuration" });
    return { value: {}, version: 0, needsWrite: true };
  }
}

function safeWrite(value: Stored, onDiagnostic?: (diagnostic: PluginConfigDiagnostic) => void): void {
  if (typeof localStorage === "undefined") return;
  try {
    const v2: StoredV2 = { version: 2, enabled: value };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v2));
  } catch {
    onDiagnostic?.({ kind: "write-failed", message: "Plugin config could not be persisted" });
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
  const diagnostics: PluginConfigDiagnostic[] = [];
  const recordDiagnostic = (diagnostic: PluginConfigDiagnostic) => diagnostics.push(diagnostic);
  const initial = safeRead(recordDiagnostic);
  let snapshot = initial.value;
  let schemaVersion = initial.version;
  let writeEnabled = !options.readOnly;
  let requiredPluginIds = new Set<string>();
  function normalizeSnapshot(requiredIds: Iterable<string>): PluginConfigSnapshot {
    const next = { ...snapshot };
    let changed = false;
    for (const id of requiredIds) {
      if (next[id] !== true) { next[id] = true; changed = true; }
    }
    if (changed || schemaVersion !== 2) {
      snapshot = next;
      schemaVersion = 2;
      if (writeEnabled) safeWrite(snapshot, recordDiagnostic);
    }
    return { ...snapshot };
  }
  if (writeEnabled && initial.needsWrite) safeWrite(snapshot, recordDiagnostic);

  // 多标签页同步：监听 storage 事件。
  function onStorage(ev: StorageEvent) {
    if (ev.key !== STORAGE_KEY) return;
    const next = safeRead(recordDiagnostic);
    snapshot = next.value;
    schemaVersion = next.version;
    normalizeSnapshot(requiredPluginIds);
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
      if (writeEnabled) safeWrite(snapshot, recordDiagnostic);
      for (const l of listeners) l({ ...snapshot });
    },
    clear(pluginId) {
      if (!(pluginId in snapshot)) return;
      const next = { ...snapshot };
      delete next[pluginId];
      snapshot = next;
      if (writeEnabled) safeWrite(snapshot, recordDiagnostic);
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
    },
    normalize(requiredPluginIds) {
      return normalizeSnapshot(requiredPluginIds);
    },
    setRequiredPluginIds(pluginIds) {
      requiredPluginIds = new Set(pluginIds);
      normalizeSnapshot(requiredPluginIds);
    },
    schemaVersion() {
      return schemaVersion;
    },
    diagnostics() {
      return [...diagnostics];
    }
  };
}
