import { sameWalletSession } from "@keymaster/contracts";
// packages/plugin-collectible-1satordinals/src/ordinalsSync.ts
// 1Sat Ordinals 后台同步任务。
//
// 设计缘由：
//   - 与 BSV-21 / STAS 保持同样的后台任务形态，进入 asset-holdings 分组；
//   - 由后台定时复扫当前 active key 的 1Sat outpoint；
//   - 复扫完成后发布 collectible 变更通知，驱动 provider / 页面刷新；
//   - 取消后不向外发通知；
//   - 只在钱包解锁、walletState ready、存在 active key 时运行。

import type {
  AssetDataNotifier,
  BackgroundRunEligibility,
  BackgroundTaskContext,
  BackgroundTaskDefinition,
  VaultWalletState,
  WocService,
  VaultService
} from "@keymaster/contracts";
import type { OrdinalMintHistoryRepository } from "./storage/ordinalMintHistoryRepository.js";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

export interface CreateOrdinalsSyncTaskOptions {
  service: OrdinalsServiceHandle;
  woc: WocService;
  historyRepository?: OrdinalMintHistoryRepository;
  walletState: VaultWalletState;
  vault: Pick<VaultService, "status">;
  assetDataNotifier?: AssetDataNotifier;
}

export function createOrdinalsSyncTask(options: CreateOrdinalsSyncTaskOptions): BackgroundTaskDefinition {
  const { service, woc, historyRepository, walletState, vault, assetDataNotifier } = options;

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
      const state = walletState.snapshot();
      return state.activePublicKeyHex ? { publicKeyHex: state.activePublicKeyHex } : undefined;
    },
    canRun: (): BackgroundRunEligibility => {
      if (vault.status() !== "unlocked") {
        return { ready: false, reason: { key: "background.blocked.unlock", fallback: "等待解锁" }, retryOn: "unlock" };
      }
      const state = walletState.snapshot();
      if (!Boolean(state.activePublicKeyHex)) {
        return { ready: false, reason: { key: "background.blocked.noActiveKey", fallback: "没有活跃密钥" }, retryOn: "key-ready" };
      }
      return { ready: true };
    },
    async run(ctx: BackgroundTaskContext) {
      const state = walletState.snapshot();
      if (!state.activePublicKeyHex) return;
      const startedKeyHex = state.activePublicKeyHex;

      await service.sync(ctx.signal);
      if (!sameWalletSession(state, walletState.snapshot()) || ctx.signal.aborted) return;
      await reconcileHistory(historyRepository, woc, () => !ctx.signal.aborted && sameWalletSession(state, walletState.snapshot()));
      if (ctx.signal.aborted) return;
      ctx.assertSessionFresh?.();

      if (!sameWalletSession(state, walletState.snapshot())) return;

      assetDataNotifier?.emit({
        providerId: "1satordinals",
        publicKeyHex: startedKeyHex,
        revision: Date.now(),
        kinds: ["holding"]
      });
    }
  };
}

async function reconcileHistory(historyRepository: OrdinalMintHistoryRepository | undefined, woc: WocService, isCurrent: () => boolean): Promise<void> {
  if (!historyRepository) return;
  const current = await historyRepository.list().catch(() => []);
  if (current.length === 0) return;
  for (const record of current) {
    const canonicalTxid = record.submit?.spend.canonicalTxid;
    if (!canonicalTxid) continue;
    const hit = await woc.getTransactionObservation(record.request.network, canonicalTxid).catch(() => undefined);
    const observation = hit?.observation;
    if (observation) {
      const nextStatus = observationToStatus(observation);
      if (record.status === nextStatus && record.submit?.spend.observation === observation) continue;
      if (!isCurrent()) return;
      await historyRepository.put({
        ...record,
        updatedAt: new Date().toISOString(),
        status: nextStatus,
        submit: {
          ...record.submit!,
          spend: {
            ...record.submit!.spend,
            observation,
            droppedReason: undefined
          }
        }
      });
      continue;
    }
    const wasObservedUnconfirmed = record.status === "woc-observed-unconfirmed" || record.submit?.spend.observation === "unconfirmed";
    if (wasObservedUnconfirmed) {
      if (!isCurrent()) return;
      await historyRepository.put({
        ...record,
        updatedAt: new Date().toISOString(),
        status: "woc-dropped",
        submit: {
          ...record.submit!,
          spend: {
            ...record.submit!.spend,
            observation: undefined,
            droppedReason: "woc-dropped"
          }
        }
      });
    }
  }
}

function observationToStatus(observation: "unconfirmed" | "confirmed"): "woc-observed-unconfirmed" | "woc-confirmed" {
  return observation === "confirmed" ? "woc-confirmed" : "woc-observed-unconfirmed";
}
