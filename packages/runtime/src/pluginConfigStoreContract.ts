// packages/runtime/src/pluginConfigStoreContract.ts
// 插件全局启停配置的契约。

export interface PluginConfigSnapshot {
  /** pluginId -> 用户显式设置的启用值。 */
  [pluginId: string]: boolean;
}

export type PluginConfigStoreListener = (snapshot: PluginConfigSnapshot) => void;

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
}
