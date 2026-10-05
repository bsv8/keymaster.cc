import type { WalletStore } from "../local/indexedDbWalletStore.js";

/**
 * 0.6 只移除旧启停意图的专用固定快照。不扫描目录、不解析钱包业务对象，
 * 不触碰 Coordinator 业务设置、KeyHold、恢复记录及模块/App 文件。
 * 调用方必须在 Coordinator 最终写入 lease 内执行。
 */
export async function removeRetiredPluginIntent(store: WalletStore): Promise<void> {
  await store.delete(".keymaster/system/coordinator/plugin-intent/current");
}
