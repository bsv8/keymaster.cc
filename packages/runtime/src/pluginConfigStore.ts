// Runtime 插件配置的内存投影。
//
// 启停意图的持久化真相属于 Coordinator plugin-intent snapshot。这个对象
// 只为旧版 Keymaster Host API 和 WebLoom fallback 提供当前进程内的投影，
// 不接受任何存储句柄，也不执行隐式恢复或双写。

import type {
  PluginConfigSnapshot,
  PluginConfigStore,
  PluginConfigStoreListener,
} from "./pluginConfigStoreContract.js";

export interface CreatePluginConfigStoreOptions {
  /** 兼容测试调用；内存投影本身没有持久化开关。 */
  readOnly?: boolean;
  /** 测试或无远端存储场景使用的初始内存配置。 */
  initial?: Record<string, boolean>;
}

export function createPluginConfigStore(
  options: CreatePluginConfigStoreOptions = {},
): PluginConfigStore {
  void options.readOnly;
  const listeners = new Set<PluginConfigStoreListener>();
  let snapshot: PluginConfigSnapshot = { ...(options.initial ?? {}) };
  let requiredPluginIds = new Set<string>();
  let closed = false;

  const notify = () => {
    const next = { ...snapshot };
    for (const listener of listeners) listener(next);
  };

  const normalizeSnapshot = (notifyChanges = true): PluginConfigSnapshot => {
    if (closed) return { ...snapshot };
    const next = { ...snapshot };
    for (const pluginId of requiredPluginIds) next[pluginId] = true;
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next;
      if (notifyChanges) notify();
    }
    return { ...snapshot };
  };

  return {
    async hydrate() {
      // Persistence is intentionally owned by Coordinator plugin-intent.
    },
    read() {
      return { ...snapshot };
    },
    setEnabled(pluginId, enabled) {
      if (closed) throw new Error("Plugin config store is closed");
      if (snapshot[pluginId] === enabled) return;
      snapshot = { ...snapshot, [pluginId]: enabled };
      notify();
    },
    clear(pluginId) {
      if (closed || !(pluginId in snapshot)) return;
      const next = { ...snapshot };
      delete next[pluginId];
      snapshot = next;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolveEnabled(knownPluginIds, defaultEnabled) {
      const enabled = new Set<string>();
      const known = new Set(knownPluginIds);
      const ignored: string[] = [];
      for (const pluginId of known) {
        if (pluginId in snapshot) {
          if (snapshot[pluginId]) enabled.add(pluginId);
        } else if (defaultEnabled(pluginId)) {
          enabled.add(pluginId);
        }
      }
      for (const pluginId of Object.keys(snapshot)) {
        if (!known.has(pluginId)) ignored.push(pluginId);
      }
      return { enabled, ignored };
    },
    normalize(requiredPluginIdsInput) {
      requiredPluginIds = new Set(requiredPluginIdsInput);
      return normalizeSnapshot();
    },
    setRequiredPluginIds(pluginIds) {
      if (closed) return;
      requiredPluginIds = new Set(pluginIds);
      // Required ids are host bootstrap metadata. Updating this projection
      // must not trigger a re-entrant WebLoom reconcile while the host is
      // still registering the corresponding manifest.
      normalizeSnapshot(false);
    },
    schemaVersion() {
      // There is no persisted Runtime schema in V1.
      return 0;
    },
    diagnostics() {
      return [];
    },
    async flush() {
      // No asynchronous persistence queue exists in the runtime projection.
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
