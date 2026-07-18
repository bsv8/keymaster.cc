// packages/plugin-token-stas/src/stasSync.ts
// STAS 后台同步任务。
//
// 设计缘由：
//   - 唯一 WOC / 外网调用者；写自己的 key-scoped snapshot DB。
//   - 归入 asset-holdings schedule group，由 BackgroundService 统一调度。
//   - 成功后发布 data-changed 通知。
//   - 取消后不提交 DB，也不发 data-changed。

import type {
  AssetDataNotifier,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";
import type { StasDb } from "./stasDb.js";
import type { StasServiceHandle } from "./stasService.js";

export interface CreateStasSyncTaskOptions {
  db: StasDb;
  service: StasServiceHandle;
  keyspace: KeyspaceService;
  vault: VaultService;
  assetDataNotifier?: AssetDataNotifier;
}

/**
 * 创建 STAS 后台同步任务。
 * 设计缘由：
 *   - 从 P2PKH 本地 resource DB 读取当前 active key 地址；
 *   - 通过 WOC 拉 token list / balance；
 *   - 以一次原子提交替换 STAS snapshot；
 *   - 成功后发 data-changed。
 *   - 取消后不提交 DB、不发 data-changed。
 */
export function createStasSyncTask(options: CreateStasSyncTaskOptions): BackgroundTaskDefinition {
  const { db, service, keyspace, vault, assetDataNotifier } = options;

  return {
    id: "token-stas.sync",
    pluginId: "plugin-token-stas",
    label: { key: "stas.task.sync", fallback: "STAS 同步" },
    description: { key: "stas.task.sync.description", fallback: "同步 STAS token 持仓快照。" },
    schedule: {
      group: "asset-holdings",
      defaultIntervalMs: 900_000,
      minIntervalMs: 300_000,
    },
    defaultEnabled: true,
    keyScope: () => {
      const state = keyspace.active();
      return state.activePublicKeyHex ? { publicKeyHex: state.activePublicKeyHex } : undefined;
    },
    canRun: () => {
      // 与 P2PKH 同构：vault 已解锁 + keyspace 非初始化中 + 有 active key
      if (vault.status() !== "unlocked") return false;
      if (keyspace.isInitializing()) return false;
      const state = keyspace.active();
      return Boolean(state.activePublicKeyHex);
    },
    async run(ctx: BackgroundTaskContext) {
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return;
      // 保存本轮开始时的 active key，提交/通知前确认未变化；
      // 否则旧 key 的任务可能向新 key 的页面发通知。
      const startedKeyHex = state.activePublicKeyHex;

      // 通过 service 获取当前 active key 的 STAS tokens
      // 传递 signal 以便取消时中止网络请求
      const tokens = await service.listActiveKeyTokens(ctx.signal);

      // 检查取消信号：取消后不提交 DB，不发 data-changed
      if (ctx.signal.aborted) return;

      const snapshots = tokens
        .filter((t) => Number.isFinite(t.entry.balance) && t.entry.balance > 0)
        .map((t) => ({
          symbol: t.entry.symbol,
          network: t.network,
          address: t.address,
          balance: t.entry.balance,
          // 规范化 issuer：undefined/null → 空字符串，与 DB 主键和
          // tokenId（makeStasTokenId）使用同一规则。
          issuer: t.entry.issuer ?? "",
          syncedAt: new Date().toISOString(),
        }));

      // 原子替换：在同一事务中删除旧数据并写入新数据
      // DB 操作隐式使用当前 active key 的 namespace
      await db.replaceAll(snapshots);

      // 关键修复：replaceAll 完成后、发送通知前再检查一次取消信号；
      // 同时确认 active key 未变化——旧 key 的任务不应向新 key 发通知。
      if (ctx.signal.aborted) return;
      const currentKeyHex = keyspace.active().activePublicKeyHex;
      if (currentKeyHex !== startedKeyHex) return;

      // 发布 data-changed
      assetDataNotifier?.emit({
        providerId: "stas",
        publicKeyHex: startedKeyHex,
        revision: Date.now(),
        kinds: ["holding"],
      });
    },
  };
}
