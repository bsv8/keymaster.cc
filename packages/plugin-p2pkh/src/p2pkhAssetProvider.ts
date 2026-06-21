// packages/plugin-p2pkh/src/p2pkhAssetProvider.ts
// P2PKH 资产 provider（硬切换 007 / 008 收尾 + 硬切换 001）。
// 设计缘由：
//   - single 模式：每个 asset 行只代表当前 active key 的余额。
//   - AssetProvider 必须是通用资产协议，不允许把 UTXO / keyId 塞进 AssetSummary。
//   - 资产网络由 assetId 决定。
//   - onChange 内部订阅 P2PKH 同步事件、active key 变化、keyspace 初始化、global settings。
//
// 硬切换 008 收尾：keyspace 未就绪时直接返回 `[]`（listAssets / listActivity）。
// 设计缘由：旧实现返回 `emptySummary` 时虽然 display 文本是 `— BSV`，
// 但 `balance.amount: 0` 会被上游做数值聚合——把"未就绪"误当成"链上 0 余额"。
// 数值层是上游资产协议约定的语义，扩展协议表达 unknown balance 需要
// 改 contract；本次施工单内改用推荐方案"未就绪返回空列表"，让
// keyspace ready 后通过 onChange 通知重拉。
//
// 硬切换 001：
//   - balance 展示改为 `{ total }`（不再用 confirmed）。
//   - assets 列表受 `includeTestnet` 控制：false 时只暴露 bsv。
//   - includeTestnet 通过 service.onGlobalSettingsChange 订阅——同 tab 写入
//     由 settings 页调用 service.applyGlobalSettings 主动通知；跨 tab 由
//     service 内部 storage 监听回灌。

import type { AssetActivity, AssetProvider, AssetSummary, AssetStatus, KeyspaceService, MessageBus } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhService,
  P2pkhSyncStatus
} from "./p2pkhContracts.js";
import { P2PKH_ASSETS, assetIdToNetwork } from "./p2pkhContracts.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhAssetProviderDeps {
  service: P2pkhService;
  messageBus: MessageBus;
  keyspace: KeyspaceService;
}

const ASSET_IDS: P2pkhAssetId[] = ["bsv", "bsvtest"];

export interface P2pkhAssetProviderHandle extends AssetProvider {
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose(): void;
}

export function createP2pkhAssetProvider(deps: P2pkhAssetProviderDeps): P2pkhAssetProviderHandle {
  const listeners = new Set<() => void>();
  // 硬切换 001：所有挂载的"外部订阅"必须保存取消句柄，dispose 时统一释放。
  // 否则 plugin disable 后旧 provider 仍会被 service / messageBus / keyspace 持续回调，
  // 与"真正热卸载"语义冲突。
  const unsubs: Array<() => void> = [];
  function trackSubscribe<T>(type: string, handler: (p: T) => void) {
    const off = deps.messageBus.subscribe<T>(type, handler);
    unsubs.push(off);
    return off;
  }
  unsubs.push(deps.service.onSyncStatusChange(() => notify()));
  trackSubscribe<{ status: P2pkhSyncStatus }>(P2PKH_MSG.SYNC, () => notify());
  trackSubscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => notify());
  unsubs.push(deps.keyspace.onActiveChange(() => notify()));
  // 硬切换 008 收尾：额外订阅初始化变化——keyspace 初始化结束后资产平台
  // 必须重拉，否则"未就绪"期间返回的空列表会一直显示。
  unsubs.push(deps.keyspace.onInitializationChange(() => notify()));
  // 硬切换 001：global settings 变化也要触发重拉（testnet asset 显隐切换）。
  unsubs.push(deps.service.onGlobalSettingsChange(() => notify()));

  function notify() {
    for (const l of [...listeners]) l();
  }

  function mapStatus(s: P2pkhSyncStatus): AssetStatus {
    if (s === "syncing") return "syncing";
    if (s === "failed" || s === "rate-limited") return "stale";
    return "ready";
  }

  /**
   * 平台未就绪时（isInitializing === true 或无 active key）直接返回 true。
   * 这是 listAssets / getAsset / listActivity / sync 的统一闸门。
   *
   * 硬切换 005 收尾：active key 模型收窄为"single 模式唯一一把 ready key"，
   * 不再有 `mode === "all"` 分支；"未就绪"只看 activePublicKeyHex 缺省。
   */
  function isNotReady(): boolean {
    if (deps.keyspace.isInitializing()) return true;
    return !deps.keyspace.active().activePublicKeyHex;
  }

  /**
   * 硬切换 001：根据 includeTestnet 决定哪些 asset 进入 assets 列表。
   */
  function visibleAssetIds(): P2pkhAssetId[] {
    const settings = deps.service.getGlobalSettings();
    if (settings.includeTestnet) return ASSET_IDS;
    return ASSET_IDS.filter((id) => id !== "bsvtest");
  }

  async function toSummary(assetId: P2pkhAssetId): Promise<AssetSummary> {
    const def = P2PKH_ASSETS[assetId];
    const balance = await deps.service.getAssetBalance(assetId);
    return {
      assetId,
      providerId: "p2pkh",
      kind: "coin",
      // label 走 I18nText 形态：基名用 i18n key 翻译，不再追加"（全部 key）"后缀。
      label: { key: `p2pkh.asset.${assetId}`, fallback: def.label },
      network: def.network,
      balance: {
        amount: balance.total,
        unit: def.unit,
        display: `${balance.total} ${def.unit}`
      },
      status: mapStatus(deps.service.syncStatus()),
      detailRoute: { id: "p2pkh.overview", path: `/p2pkh?assetId=${encodeURIComponent(assetId)}` },
      tags: def.tags
    };
  }

  async function listNetworkHistory(assetId: P2pkhAssetId) {
    if (isNotReady()) return [];
    const all = await deps.service.listHistory({ assetId });
    const network = assetIdToNetwork(assetId);
    return all.filter((h) => h.network === network);
  }

  const handle: P2pkhAssetProviderHandle = {
    id: "p2pkh",
    name: { key: "p2pkh.provider.name", fallback: "P2PKH" },
    kind: "coin",
    order: 10,
    async listAssets() {
      // 硬切换 008 收尾：未就绪返回空列表；onChange 在 ready 后通知重拉。
      if (isNotReady()) {
        return [];
      }
      return Promise.all(visibleAssetIds().map(toSummary));
    },
    async getAsset(assetId) {
      if (!isP2pkhAssetId(assetId)) return undefined;
      // includeTestnet=false 时不暴露 testnet。
      if (!visibleAssetIds().includes(assetId)) return undefined;
      // 未就绪时 getAsset 返回 undefined：调用方应展示空态而不是 0 余额。
      if (isNotReady()) return undefined;
      const summary = await toSummary(assetId);
      const network = assetIdToNetwork(assetId);
      const history = await listNetworkHistory(assetId);
      const activities: AssetActivity[] = history.map((h) => ({
        id: h.id,
        assetId,
        txid: h.txid,
        title: statusTitle(h.status, h.source),
        direction: "info",
        status: h.status === "pending" ? "pending" : h.status === "confirmed" ? "confirmed" : "unconfirmed",
        occurredAt: h.syncedAt
      }));
      return {
        summary,
        activities,
        extras: { network }
      };
    },
    async listActivity(assetId) {
      if (!isP2pkhAssetId(assetId)) return [];
      if (!visibleAssetIds().includes(assetId)) return [];
      if (isNotReady()) return [];
      return listNetworkHistory(assetId).then((history) =>
        history.map<AssetActivity>((h) => ({
          id: h.id,
          assetId,
          txid: h.txid,
          title: statusTitle(h.status, h.source),
          direction: "info",
          status: h.status === "pending" ? "pending" : h.status === "confirmed" ? "confirmed" : "unconfirmed",
          occurredAt: h.syncedAt
        }))
      );
    },
    async sync(assetId) {
      // sync 是写操作：未就绪时不能触发 recent sync（避免触发后端错误）。
      if (isNotReady()) return;
      await deps.service.triggerRecentSync();
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

function isP2pkhAssetId(id: string): id is P2pkhAssetId {
  return id === "bsv" || id === "bsvtest";
}

function statusTitle(status: string, source: string): { key: string; fallback: string } {
  if (status === "confirmed") return { key: "p2pkh.activity.confirmed", fallback: "链上交易" };
  if (status === "unconfirmed") return { key: "p2pkh.activity.unconfirmed", fallback: "未确认交易" };
  if (status === "pending") return source === "local-submission"
    ? { key: "p2pkh.activity.localSubmission", fallback: "本地提交" }
    : { key: "p2pkh.activity.unconfirmed", fallback: "未确认交易" };
  if (status === "dropped") return { key: "p2pkh.activity.dropped", fallback: "已丢弃" };
  return { key: "p2pkh.activity.info", fallback: "链上事件" };
}
