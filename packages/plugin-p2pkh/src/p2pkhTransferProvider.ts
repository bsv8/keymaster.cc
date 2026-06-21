// packages/plugin-p2pkh/src/p2pkhTransferProvider.ts
// P2PKH 业务的 TransferProvider（硬切换 007 / 008 收尾 + 硬切换 005 收尾 + 硬切换 001）。
// 设计缘由：
//   - Offer 总是面向当前 active key；prepare/submit 由 Widget 内部校验。
//   - 平台只负责列出 Offer 与挂载 Widget；危险动作在 Widget 内部校验。
//
// 硬切换 005 收尾：删掉 all-mode 兼容。`mode: "all"` 不再是真值。
//
// 硬切换 008 收尾：keyspace 未就绪时**不提供** Offer。
// 设计缘由：未就绪时给 offer 会让用户看到一个假的"可转账"入口，
// 一旦用户点进去，Widget 校验时 keyspace 仍可能未就绪导致未定义行为。
// 业务上 keyspace 没就绪等同于"今天不能转账"，所以 listOffers 返回空。
//
// 硬切换 001：listOffers 受 `includeTestnet` 控制。includeTestnet=false
// 时不暴露 bsvtest offer。balance 显示改为 `{ total }`，不再用 confirmed。
// includeTestnet 通过 service.onGlobalSettingsChange 订阅——同 tab 写入
// 由 settings 页调用 service.applyGlobalSettings 主动通知；跨 tab 由
// service 内部 storage 监听回灌。

import type { KeyspaceService, MessageBus, TransferOffer, TransferOfferStatus, TransferProvider } from "@keymaster/contracts";
import type { P2pkhAssetId, P2pkhService, P2pkhSyncStatus } from "./p2pkhContracts.js";
import { P2PKH_ASSETS } from "./p2pkhContracts.js";
import { P2pkhTransferWidget } from "./widgets/P2pkhTransferWidget.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhTransferProviderDeps {
  service: P2pkhService;
  messageBus: MessageBus;
  keyspace: KeyspaceService;
}

const ASSET_IDS: P2pkhAssetId[] = ["bsv", "bsvtest"];

export interface P2pkhTransferProviderHandle extends TransferProvider {
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose(): void;
}

export function createP2pkhTransferProvider(deps: P2pkhTransferProviderDeps): P2pkhTransferProviderHandle {
  const listeners = new Set<() => void>();
  // 硬切换 001：保存所有"外部订阅"取消句柄，dispose 时统一释放。
  const unsubs: Array<() => void> = [];
  function trackSubscribe<T>(type: string, handler: (p: T) => void) {
    const off = deps.messageBus.subscribe<T>(type, handler);
    unsubs.push(off);
    return off;
  }

  unsubs.push(deps.service.onSyncStatusChange(() => notify()));
  trackSubscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => notify());
  trackSubscribe(P2PKH_MSG.SYNC, () => notify());
  trackSubscribe(P2PKH_MSG.BACKFILL_ERROR, () => notify());
  unsubs.push(deps.keyspace.onActiveChange(() => notify()));
  // 硬切换 008 收尾：初始化结束也触发重拉。
  unsubs.push(deps.keyspace.onInitializationChange(() => notify()));
  // 硬切换 001：global settings 变化也要触发重拉（testnet offer 显隐切换）。
  unsubs.push(deps.service.onGlobalSettingsChange(() => notify()));

  function notify() {
    for (const l of [...listeners]) l();
  }

  function mapStatus(s: P2pkhSyncStatus): TransferOfferStatus {
    if (s === "syncing") return "syncing";
    if (s === "failed" || s === "rate-limited") return "stale";
    return "ready";
  }

  /**
   * 是否可以提供转账 offer：必须有 active key 且 keyspace 已就绪。
   * 硬切换 005 收尾：不再有 "all 模式" 兜底——`activePublicKeyHex` 缺失
   * 唯一指"无 active key"，由壳层守卫收敛到修复/管理态；本函数仍作为
   * listOffers 的 fail-closed 防御。
   */
  function isTransferable(): boolean {
    if (deps.keyspace.isInitializing()) return false;
    return Boolean(deps.keyspace.active().activePublicKeyHex);
  }

  /**
   * 硬切换 001：根据 includeTestnet 决定哪些 asset 进入 offer 列表。
   */
  function visibleAssetIds(): P2pkhAssetId[] {
    const settings = deps.service.getGlobalSettings();
    if (settings.includeTestnet) return ASSET_IDS;
    return ASSET_IDS.filter((id) => id !== "bsvtest");
  }

  async function toOffer(assetId: P2pkhAssetId): Promise<TransferOffer> {
    const def = P2PKH_ASSETS[assetId];
    const balance = await deps.service.getAssetBalance(assetId);
      return {
        id: `p2pkh:${assetId}`,
        providerId: "p2pkh",
        assetProviderId: "p2pkh",
        assetId,
        // label 不再追加"（全部 key）"后缀。
        label: { key: `p2pkh.asset.${assetId}`, fallback: def.label },
        description: {
          key: `p2pkh.transfer.description.${assetId}`,
          fallback: `BSV P2PKH (${def.network})`
        },
        balance: {
          amount: balance.total,
          unit: def.unit,
          display: `${balance.total} ${def.unit}`
      },
      status: mapStatus(deps.service.syncStatus()),
      order: assetId === "bsv" ? 10 : 11
    };
  }

  const handle: P2pkhTransferProviderHandle = {
    id: "p2pkh",
    name: { key: "p2pkh.provider.name", fallback: "P2PKH" },
    description: { key: "p2pkh.provider.description", fallback: "BSV P2PKH 转移：bsv / bsvtest 两个网络。" },
    order: 10,
    component: P2pkhTransferWidget,
    async listOffers() {
      if (!isTransferable()) {
        return [];
      }
      return Promise.all(visibleAssetIds().map(toOffer));
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispose() {
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      unsubs.length = 0;
      listeners.clear();
    }
  };
  return handle;
}
