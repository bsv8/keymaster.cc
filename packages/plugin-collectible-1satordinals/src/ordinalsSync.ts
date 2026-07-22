// packages/plugin-collectible-1satordinals/src/ordinalsSync.ts
// 1Sat Ordinals 后台同步任务。
//
// 设计缘由：
//   - 与 BSV-21 / STAS 保持同样的后台任务形态，进入 asset-holdings 分组；
//   - 由后台定时复扫当前 active key 的 1Sat outpoint；
//   - 复扫完成后发布 collectible 变更通知，驱动 provider / 页面刷新；
//   - 取消后不向外发通知；
//   - 只在钱包解锁、keyspace ready、存在 active key 时运行。

import type {
  AssetDataNotifier,
  BackgroundRunEligibility,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

export interface CreateOrdinalsSyncTaskOptions {
  service: OrdinalsServiceHandle;
  keyspace: KeyspaceService;
  vault: VaultService;
  assetDataNotifier?: AssetDataNotifier;
}

export function createOrdinalsSyncTask(options: CreateOrdinalsSyncTaskOptions): BackgroundTaskDefinition {
  const { service, keyspace, vault, assetDataNotifier } = options;

  return {
    id: "collectible-1satordinals.sync",
    pluginId: "plugin-collectible-1satordinals",
    label: { key: "oneSat.task.sync", fallback: "1Sat Ordinals 同步" },
    description: { key: "oneSat.task.sync.description", fallback: "同步 1Sat Ordinals collectible 持仓。" },
    schedule: {
      group: "asset-holdings",
      defaultIntervalMs: 900_000,
      minIntervalMs: 300_000
    },
    keyScope: () => {
      const state = keyspace.active();
      return state.activePublicKeyHex ? { publicKeyHex: state.activePublicKeyHex } : undefined;
    },
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
      const startedKeyHex = state.activePublicKeyHex;

      await service.sync(ctx.signal);
      if (ctx.signal.aborted) return;
      ctx.assertSessionFresh?.();

      if (keyspace.active().activePublicKeyHex !== startedKeyHex) return;

      assetDataNotifier?.emit({
        providerId: "1satordinals",
        publicKeyHex: startedKeyHex,
        revision: Date.now(),
        kinds: ["holding"]
      });
    }
  };
}
