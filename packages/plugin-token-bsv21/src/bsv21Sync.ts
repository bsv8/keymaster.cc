// packages/plugin-token-bsv21/src/bsv21Sync.ts
// BSV-21 后台同步任务。
//
// 设计缘由：
//   - 唯一 WOC / 外网调用者；写自己的 key-scoped snapshot DB。
//   - 归入 asset-holdings schedule group，由 BackgroundService 统一调度。
//   - 成功后发布 data-changed 通知。
//   - 取消后不提交 DB，也不发 data-changed。
//   - 施工单 001：canRun 返回结构化 BackgroundRunEligibility。

import type {
  AssetDataNotifier,
  BackgroundRunEligibility,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";
import type { Bsv21Db } from "./bsv21Db.js";
import type { Bsv21ServiceHandle } from "./bsv21Service.js";

export interface CreateBsv21SyncTaskOptions {
  db: Bsv21Db;
  service: Bsv21ServiceHandle;
  keyspace: KeyspaceService;
  vault: VaultService;
  assetDataNotifier?: AssetDataNotifier;
}

/**
 * 创建 BSV-21 后台同步任务。
 * 设计缘由：
 *   - 从 P2PKH 本地 resource DB 读取当前 active key 地址；
 *   - 通过 WOC 拉 token list / balance；
 *   - 以一次原子提交替换 BSV-21 snapshot；
 *   - 成功后发 data-changed。
 *   - 取消后不提交 DB、不发 data-changed。
 */
export function createBsv21SyncTask(options: CreateBsv21SyncTaskOptions): BackgroundTaskDefinition {
  const { db, service, keyspace, vault, assetDataNotifier } = options;

  return {
    id: "token-bsv21.sync",
    pluginId: "plugin-token-bsv21",
    label: { key: "bsv21.task.sync", fallback: "BSV-21 同步" },
    description: { key: "bsv21.task.sync.description", fallback: "同步 BSV-21 token 持仓快照。" },
    schedule: {
      group: "asset-holdings",
      defaultIntervalMs: 900_000,
      minIntervalMs: 300_000,
    },
    // 施工单 001：删除 defaultEnabled，所有任务默认持续启用
    keyScope: () => {
      const state = keyspace.active();
      return state.activePublicKeyHex ? { publicKeyHex: state.activePublicKeyHex } : undefined;
    },
    // 施工单 001：canRun 返回结构化 BackgroundRunEligibility
    canRun: (): BackgroundRunEligibility => {
      if (vault.status() !== "unlocked") {
        return { ready: false, reason: { key: "background.blocked.unlock", fallback: "等待解锁" }, retryOn: "unlock" };
      }
      if (keyspace.isInitializing()) {
        return { ready: false, reason: { key: "background.blocked.keyReady", fallback: "密钥空间初始化中" }, retryOn: "key-ready" };
      }
      const state = keyspace.active();
      if (!Boolean(state.activePublicKeyHex)) {
        return { ready: false, reason: { key: "background.blocked.noActiveKey", fallback: "没有活跃密钥" }, retryOn: "key-ready" };
      }
      return { ready: true };
    },
    async run(ctx: BackgroundTaskContext) {
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return;
      // 保存本轮开始时的 active key，提交/通知前确认未变化；
      // 否则旧 key 的任务可能向新 key 的页面发通知。
      const startedKeyHex = state.activePublicKeyHex;

      // 通过 service 获取当前 active key 的 BSV-21 tokens
      // service 内部会从 P2PKH resource DB 读取地址并通过 WOC 拉取
      // 传递 signal 以便取消时中止网络请求
      const tokens = await service.listActiveKeyTokens(ctx.signal);

      // 检查取消信号：取消后不提交 DB，不发 data-changed
      if (ctx.signal.aborted) return;

      const snapshots = tokens.map((t) => ({
        origin: t.meta.origin,
        network: t.network,
        address: t.address,
        balance: t.balance,
        meta: {
          origin: t.meta.origin,
          symbol: t.meta.symbol,
          issuer: t.meta.issuer,
          decimals: t.meta.decimals,
        },
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
        providerId: "bsv21",
        publicKeyHex: startedKeyHex,
        revision: Date.now(),
        kinds: ["holding"],
      });
    },
  };
}
