// packages/runtime/src/pluginConfigStoreContract.ts
// 插件全局启停配置的契约。

export interface PluginConfigSnapshot {
  /** pluginId -> 规范化后的启用值；不暴露持久化格式。 */
  [pluginId: string]: boolean;
}

export type PluginConfigStoreListener = (snapshot: PluginConfigSnapshot) => void;

export interface PluginConfigDiagnostic {
  kind: "invalid-json" | "unknown-version" | "migrated-v1" | "write-failed";
  message: string;
}

export interface PluginConfigStore {
  read(): PluginConfigSnapshot;
  setEnabled(pluginId: string, enabled: boolean): void;
  clear(pluginId: string): void;
  subscribe(listener: PluginConfigStoreListener): () => void;
  /**
   * 与已知 manifest 集合合并：未记录项用 defaultEnabled；
   * 残留 pluginId（manifest 中不存在）忽略。
   */
  resolveEnabled(
    knownPluginIds: string[],
    defaultEnabled: (id: string) => boolean
  ): { enabled: Set<string>; ignored: string[] };
  /** 按 manifest 语义规范化并持久化配置。 */
  normalize(requiredPluginIds: string[]): PluginConfigSnapshot;
  /** 设置 manifest 驱动的 required 集合，storage 事件也据此规范化。 */
  setRequiredPluginIds(pluginIds: string[]): void;
  /** 只读诊断：当前持久化 schema 版本。 */
  schemaVersion(): number;
  diagnostics(): readonly PluginConfigDiagnostic[];
}
