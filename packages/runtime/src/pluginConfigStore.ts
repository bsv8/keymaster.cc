// packages/runtime/src/pluginConfigStore.ts
// 插件启停全局配置存储。
// 设计缘由（硬切换 001）：
//   - 系统级启停必须是全局配置，不能存进 key-scoped storage。
//   - 存储位置：Host 注入的平台 settings K-V；
//     值为版本化 JSON `{ version: 2, enabled: { [pluginId]: boolean } }`。
//   - 没有记录的 pluginId 视为 `manifest.meta.defaultEnabled`；required plugin
//     永远规范化为 true。
//   - 残留 pluginId（manifest 已删除）被忽略，不影响启动。
//   - 多标签页由 Coordinator 平台 K-V 统一提供读取真值。

import type { KeyValueStore } from "@keymaster/contracts";
import type {
  PluginConfigDiagnostic,
  PluginConfigSnapshot,
  PluginConfigStore,
  PluginConfigStoreListener
} from "./pluginConfigStoreContract.js";

const STORAGE_KEY = "plugins";

interface StoredV2 {
  version: 2;
  enabled: Record<string, boolean>;
}

interface Stored {
  [pluginId: string]: boolean;
}

/** 远端配置不是当前契约版本时，启动必须停在配置不兼容，而不能覆盖原记录。 */
export class PluginConfigIncompatibleError extends Error {
  readonly code = "plugin_config_incompatible";

  constructor(message = "Plugin config schema is incompatible") {
    super(message);
    this.name = "PluginConfigIncompatibleError";
  }
}

export interface CreatePluginConfigStoreOptions {
  /** 测试用：禁止持久化。 */
  readOnly?: boolean;
  /** Host 已绑定的平台 settings K-V 句柄。 */
  storage?: KeyValueStore;
  /** 测试或无远端存储场景使用的初始内存配置。 */
  initial?: Stored;
}

export function createPluginConfigStore(
  options: CreatePluginConfigStoreOptions = {}
): PluginConfigStore {
  const listeners = new Set<PluginConfigStoreListener>();
  const diagnostics: PluginConfigDiagnostic[] = [];
  const recordDiagnostic = (diagnostic: PluginConfigDiagnostic) => diagnostics.push(diagnostic);
  let snapshot: Stored = { ...(options.initial ?? {}) };
  let schemaVersion = 2;
  // 有远端存储时，必须先 hydrate 再允许写入；否则 phase-one 注册插件
  // 触发的 required 规范化会把空配置覆盖到远端。
  // 明确提供 initial 时，调用方已经承担了恢复责任；生产 bootstrap 不传
  // initial，必须走 hydrate 读取平台 settings K-V。
  let hydrated = !options.storage || options.initial !== undefined;
  let writeEnabled = hydrated && !options.readOnly;
  let hydratePromise: Promise<void> | undefined;
  let writeQueue = Promise.resolve();
  let requiredPluginIds = new Set<string>();
  const persist = () => {
    if (!hydrated || !writeEnabled || !options.storage) return;
    const value: StoredV2 = { version: 2, enabled: { ...snapshot } };
    writeQueue = writeQueue
      .then(() => options.storage!.put(STORAGE_KEY, value, { partition: "settings" }).then(() => undefined))
      .catch(() => {
        recordDiagnostic({ kind: "write-failed", message: "Plugin config could not be persisted" });
      });
  };
  function normalizeSnapshot(requiredIds: Iterable<string>): PluginConfigSnapshot {
    const next = { ...snapshot };
    let changed = false;
    for (const id of requiredIds) {
      if (next[id] !== true) { next[id] = true; changed = true; }
    }
    if (changed || schemaVersion !== 2) {
      snapshot = next;
      schemaVersion = 2;
      persist();
    }
    return { ...snapshot };
  }
  const notify = () => {
    for (const l of listeners) l({ ...snapshot });
  };
  const parseStored = (value: unknown): { value: Stored; version: number } => {
    if (value === undefined || value === null) return { value: {}, version: 2 };
    if (typeof value !== "object" || Array.isArray(value)) {
      recordDiagnostic({ kind: "invalid-json", message: "Plugin config record has an invalid shape" });
      throw new PluginConfigIncompatibleError("Plugin config record has an invalid shape");
    }
    const record = value as { version?: unknown; enabled?: unknown };
    if (record.version !== 2) {
      schemaVersion = typeof record.version === "number" && Number.isSafeInteger(record.version) ? record.version : 0;
      recordDiagnostic({ kind: "incompatible", message: "Plugin config record is not schema v2" });
      throw new PluginConfigIncompatibleError("Plugin config record must use schema v2");
    }
    if (!record.enabled || typeof record.enabled !== "object" || Array.isArray(record.enabled)) {
      schemaVersion = 0;
      recordDiagnostic({ kind: "invalid-json", message: "Plugin config v2 enabled field has an invalid shape" });
      throw new PluginConfigIncompatibleError("Plugin config v2 enabled field has an invalid shape");
    }
    const booleanRecord = (input: object): Stored => {
      const result: Stored = {};
      for (const [pluginId, enabled] of Object.entries(input)) {
        if (typeof enabled !== "boolean") {
          schemaVersion = 0;
          recordDiagnostic({ kind: "invalid-json", message: "Plugin config v2 enabled values must be boolean" });
          throw new PluginConfigIncompatibleError("Plugin config v2 enabled values must be boolean");
        }
        result[pluginId] = enabled;
      }
      return result;
    };
    return { value: booleanRecord(record.enabled), version: 2 };
  };
  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      // 在远端读取成功前，writeEnabled 始终为 false；读取失败也不能
      // 自动打开写入，否则下一次重试前仍可能覆盖远端数据。
      writeEnabled = false;
      const entry = await options.storage!.get<unknown>(STORAGE_KEY, { partition: "settings" });
      const parsed = parseStored(entry?.value);
      snapshot = parsed.value;
      schemaVersion = parsed.version;
      hydrated = true;
      writeEnabled = !options.readOnly;
      normalizeSnapshot(requiredPluginIds);
      notify();
    })();
    try {
      await hydratePromise;
    } catch (error) {
      hydratePromise = undefined;
      throw error;
    }
  };
  return {
    hydrate,
    read() {
      return { ...snapshot };
    },
    setEnabled(pluginId, enabled) {
      if (snapshot[pluginId] === enabled) return;
      snapshot = { ...snapshot, [pluginId]: enabled };
      persist();
      notify();
    },
    clear(pluginId) {
      if (!(pluginId in snapshot)) return;
      const next = { ...snapshot };
      delete next[pluginId];
      snapshot = next;
      persist();
      notify();
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
