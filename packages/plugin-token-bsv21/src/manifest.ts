// packages/plugin-token-bsv21/src/manifest.ts
// plugin-token-bsv21 清单：注册 BSV-21 TokenProvider + 后台同步任务。
//
// 依赖说明：
//   - p2pkh.service：BSV-21 的所有权仍然基于当前钱包 BSV 地址。
//   - woc.bsv21.service：BSV-21 的 WOC 查询入口。
//   - token.registry：注册 BSV-21 TokenProvider。
//   - keyspace.service：拿当前 active key、打开 key-scoped K-V。
//   - background.registry：注册 token-bsv21.sync 后台任务。
//   - background.service：触发即时同步。
//   - vault.service：sync task canRun 门禁。
//   - runtime.messageBus：订阅 vault.unlocked / key.deleted。
//   - asset.dataNotifier：发布数据变更通知、订阅 P2PKH resource 事件。
//
// 缺失依赖时 plugin 被 host 标为 blocked，不会出现"半可用空页面"。

import type {
  AssetDataNotifier,
  BackgroundRegistry,
  BackgroundService,
  BusinessFeatureRegistry,
  I18nPluginResources,
  KeyspaceService,
  MessageBus,
  PluginManifest,
  ProtectedOutpointRegistry,
  TokenRegistry,
  VaultService,
  RouteRegistry,
  TransferRegistry,
  WocService,
  WocBsv21Service
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  BACKGROUND_TRIGGER_REASON,
  KEYSPACE_SERVICE_CAPABILITY,
  P2PKH_PROTOCOL_SPEND_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  WOC_CAPABILITY,
  WOC_BSV21_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createBsv21Service,
  type P2pkhServiceForBsv21
} from "./bsv21Service.js";
import { createBsv21TokenProvider } from "./bsv21TokenProvider.js";
import { createBsv21StateRepository, BSV21_SCHEMA_VERSION, BSV21_STORAGE_ID } from "./storage/bsv21StateRepository.js";
import { createBsv21MintHistoryRepository } from "./storage/bsv21MintHistoryRepository.js";
import { createBsv21SyncTask } from "./bsv21Sync.js";
import { createBsv21SpendProtectionProvider } from "./bsv21SpendProtection.js";
import { createBsv21MintService, BSV21_MINT_SERVICE_CAPABILITY } from "./bsv21MintService.js";
import { createBsv21TransferService, BSV21_TRANSFER_SERVICE_CAPABILITY } from "./bsv21TransferService.js";
import { createBsv21TransferProvider } from "./bsv21TransferProvider.js";
import { Bsv21MintPage } from "./Bsv21MintPage.js";

const bsv21Resources: I18nPluginResources = {
  namespace: "bsv21",
  resources: {
    en: {
      "bsv21.provider.name": "BSV-21",
      "bsv21.route.mint": "Create BSV-21",
      "bsv21.menu.mint": "Create BSV-21",
      "bsv21.mint.title": "Create BSV-21 token",
      "bsv21.mint.desc": "Prepare a BSV-21 deploy+mint transaction.",
      "bsv21.mint.network": "Network",
      "bsv21.mint.amount": "Amount",
      "bsv21.mint.symbol": "Symbol",
      "bsv21.mint.decimals": "Decimals",
      "bsv21.mint.feeRate": "Fee rate",
      "bsv21.mint.changeAddress": "Change address",
      "bsv21.mint.completed": "Token created",
      "bsv21.mint.history": "Recent history",
      "bsv21.mint.prepare": "Preview",
      "bsv21.mint.submit": "Submit",
      "bsv21.mint.status.prepared": "Prepared",
      "bsv21.mint.status.broadcastPendingWoc": "Broadcast, waiting for WOC",
      "bsv21.mint.status.observedUnconfirmed": "Observed by WOC (unconfirmed)",
      "bsv21.mint.status.confirmed": "Confirmed by WOC",
      "bsv21.mint.status.dropped": "Dropped by WOC",
      "bsv21.mint.status.providerInconsistent": "Provider inconsistent",
      "bsv21.mint.status.rejected": "Rejected",
      "bsv21.mint.status.unknown": "Unknown",
      "bsv21.transfer.description": "Transfer BSV-21 tokens",
      "bsv21.transfer.empty.title": "No BSV-21 tokens yet",
      "bsv21.transfer.empty.desc": "Mint or sync tokens first.",
      "bsv21.transfer.form.token": "Token",
      "bsv21.transfer.form.recipient": "Recipient address",
      "bsv21.transfer.form.amount": "Amount",
      "bsv21.transfer.form.feeRate": "Fee rate",
      "bsv21.transfer.form.prepare": "Preview",
      "bsv21.transfer.form.submit": "Submit",
      "bsv21.transfer.status.broadcastPendingWoc": "Broadcast, waiting for WOC",
      "bsv21.transfer.status.observedUnconfirmed": "Observed by WOC (unconfirmed)",
      "bsv21.transfer.status.confirmed": "Confirmed by WOC",
      "bsv21.transfer.status.dropped": "Dropped by WOC",
      "bsv21.transfer.status.providerInconsistent": "Provider inconsistent",
      "bsv21.transfer.status.rejected": "Rejected",
      "bsv21.transfer.status.unknown": "Unknown",
      "bsv21.task.sync": "BSV-21 sync",
      "bsv21.task.sync.description": "Sync BSV-21 token holdings."
    },
    "zh-CN": {
      "bsv21.provider.name": "BSV-21",
      "bsv21.route.mint": "创建 BSV-21",
      "bsv21.menu.mint": "创建 BSV-21",
      "bsv21.mint.title": "创建 BSV-21 代币",
      "bsv21.mint.desc": "准备一笔 BSV-21 deploy+mint 交易。",
      "bsv21.mint.network": "网络",
      "bsv21.mint.amount": "数量",
      "bsv21.mint.symbol": "符号",
      "bsv21.mint.decimals": "小数位",
      "bsv21.mint.feeRate": "费率",
      "bsv21.mint.changeAddress": "找零地址",
      "bsv21.mint.completed": "代币已创建",
      "bsv21.mint.history": "最近记录",
      "bsv21.mint.prepare": "预览",
      "bsv21.mint.submit": "提交",
      "bsv21.mint.status.prepared": "已准备",
      "bsv21.mint.status.broadcastPendingWoc": "广播成功，等待 WOC",
      "bsv21.mint.status.observedUnconfirmed": "WOC 已观察（未确认）",
      "bsv21.mint.status.confirmed": "WOC 已确认",
      "bsv21.mint.status.dropped": "WOC 已放弃",
      "bsv21.mint.status.providerInconsistent": "提供方不一致",
      "bsv21.mint.status.rejected": "已拒绝",
      "bsv21.mint.status.unknown": "未知",
      "bsv21.transfer.description": "转账 BSV-21 代币",
      "bsv21.transfer.empty.title": "暂无 BSV-21 代币",
      "bsv21.transfer.empty.desc": "请先铸造或同步代币。",
      "bsv21.transfer.form.token": "代币",
      "bsv21.transfer.form.recipient": "收款地址",
      "bsv21.transfer.form.amount": "数量",
      "bsv21.transfer.form.feeRate": "费率",
      "bsv21.transfer.form.prepare": "预览",
      "bsv21.transfer.form.submit": "提交",
      "bsv21.transfer.status.broadcastPendingWoc": "广播成功，等待 WOC",
      "bsv21.transfer.status.observedUnconfirmed": "WOC 已观察（未确认）",
      "bsv21.transfer.status.confirmed": "WOC 已确认",
      "bsv21.transfer.status.dropped": "WOC 已放弃",
      "bsv21.transfer.status.providerInconsistent": "提供方不一致",
      "bsv21.transfer.status.rejected": "已拒绝",
      "bsv21.transfer.status.unknown": "未知",
      "bsv21.task.sync": "BSV-21 同步",
      "bsv21.task.sync.description": "同步 BSV-21 代币持仓。"
    }
  }
};

export const bsv21TokenPlugin: PluginManifest = {
  id: "token-bsv21",
  name: "BSV-21 tokens",
  description: "BSV-21 fungible token provider：通过 snapshot K-V 读取当前 active key 的 BSV-21 持仓，注入 token.registry。",
  meta: {
    kind: "business",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: bsv21Resources,
  storage: { scope: "key", applicationStorageId: BSV21_STORAGE_ID, schemaVersion: BSV21_SCHEMA_VERSION },
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 地址" },
    { capability: WOC_BSV21_CAPABILITY, reason: "BSV-21 WOC 查询入口" },
    { capability: WOC_CAPABILITY, reason: "读取交易与费率等通用 WOC 数据" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化、打开 key-scoped K-V" },
    { capability: "token.registry", reason: "注册 BSV-21 TokenProvider" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册后台同步任务" },
    { capability: BACKGROUND_SERVICE_CAPABILITY, reason: "触发即时同步" },
    { capability: "vault.service", reason: "sync task canRun 门禁" },
    { capability: RUNTIME_MESSAGE_BUS, reason: "订阅 vault.unlocked / key.deleted" },
    { capability: ASSET_DATA_NOTIFIER_CAPABILITY, reason: "发布数据变更通知、订阅 P2PKH resource 事件" },
    { capability: PROTECTED_OUTPOINT_REGISTRY_CAPABILITY, reason: "注册 BSV-21 受保护 outpoint" },
    { capability: P2PKH_PROTOCOL_SPEND_CAPABILITY, reason: "签名 BSV-21 mint / transfer 交易" },
    { capability: "route.registry", reason: "注册 BSV-21 创建页" },
    { capability: "business.registry", reason: "注册 BSV-21 业务入口" },
    { capability: "transfer.registry", reason: "注册 BSV-21 transfer provider" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForBsv21>(P2PKH_CAPABILITY);
    const wocBsv21 = ctx.get<WocBsv21Service>(WOC_BSV21_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY);
    const protectedOutpoints = ctx.get<ProtectedOutpointRegistry>(PROTECTED_OUTPOINT_REGISTRY_CAPABILITY);
    const woc = ctx.get<WocService>(WOC_CAPABILITY);
    const protocolSpend = ctx.get<import("@keymaster/contracts").ProtocolSpendService>(P2PKH_PROTOCOL_SPEND_CAPABILITY);
    const routes = ctx.get<RouteRegistry>("route.registry");
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    const transferRegistry = ctx.get<TransferRegistry>("transfer.registry");
    const vault = ctx.get<VaultService>("vault.service");
    const backgroundService = ctx.get<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY);

    // Host 已完成声明校验并注入 owner/App K-V 句柄；Repository 不再接收 Keyspace。
    if (!ctx.storage) throw new Error("BSV21 owner storage binding is unavailable");
    const stateRepository = createBsv21StateRepository(ctx.storage);
    const historyRepository = createBsv21MintHistoryRepository(ctx.storage);

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createBsv21Service({ keyspace, p2pkh, wocBsv21 });

    // 创建 provider（只读 K-V）
    const provider = createBsv21TokenProvider({ stateRepository, keyspace, assetDataNotifier });
    const spendProtection = createBsv21SpendProtectionProvider({ stateRepository, keyspace, assetDataNotifier });
    const mintService = createBsv21MintService({ stateRepository, historyRepository, p2pkh, protocolSpend });
    const transferService = createBsv21TransferService({ service, p2pkh, protocolSpend });
    const transferProvider = createBsv21TransferProvider({ tokenRegistry, p2pkh });

    // 注册后台同步任务
    const syncTask = createBsv21SyncTask({ stateRepository, service, woc, historyRepository, keyspace, vault, assetDataNotifier });
    backgroundRegistry.register(syncTask);

    tokenRegistry.register(provider);
    protectedOutpoints.register(spendProtection);
    transferRegistry.register(transferProvider);
    ctx.provide(BSV21_MINT_SERVICE_CAPABILITY, mintService);
    ctx.provide(BSV21_TRANSFER_SERVICE_CAPABILITY, transferService);

    routes.register({
      id: "bsv21.mint",
      path: "/assets/bsv21/create",
      label: { key: "bsv21.route.mint", fallback: "Create BSV-21" },
      component: Bsv21MintPage
    });

    business.registerFeature("token-bsv21", "assets", {
      id: "assets.bsv21",
      label: { key: "bsv21.menu.mint", fallback: "Create BSV-21" },
      order: 25,
      icon: "Coins",
      entry: {
        path: "/assets/bsv21/create",
        routeId: "bsv21.mint",
        visibleWhen: ({ unlocked }) => unlocked
      }
    });

    function triggerSync(reason: string) {
      backgroundService.trigger("token-bsv21.sync", reason);
    }

    // 监听 active key 变化（保留订阅用于状态管理，不触发网络任务）
    const offActiveChange = keyspace.onActiveKeyChanged(() => {
      // 不触发 sync：由 P2PKH resource-ready 统一驱动。
    });

    // 监听 vault 解锁（保留订阅用于状态管理，不触发网络任务）
    const offUnlocked = messageBus.subscribe("vault.unlocked", () => {
      // 不触发 sync：由 P2PKH resource-ready 统一驱动。
    });

    // 监听 P2PKH resource data-changed：地址就绪后触发同步。
    // 设计缘由：这是 Token 同步的唯一触发入口。
    // vault.unlocked / active-change 不直接触发，避免抢在 P2PKH rehydrate 前。
    // 按"是否已有该 key 的 snapshot"选择 reason：
    //   - 首次无 snapshot → "first-sync"（跳过 2 分钟冷却）
    //   - 已有 snapshot → 普通 "p2pkh.resources-ready"（受后台冷却合并）
    const offP2pkhResource = assetDataNotifier.subscribe((event) => {
      if (event.providerId !== "p2pkh") return;
      if (!event.kinds.includes("resource")) return;
      // 仅当事件属于当前 active key 时触发
      const activeHex = keyspace.active().activePublicKeyHex;
      if (!activeHex || event.publicKeyHex !== activeHex) return;
      // 异步检查 snapshot 以决定 reason
      void (async () => {
        try {
          const existing = await stateRepository.list();
          const reason = existing.length === 0
            ? BACKGROUND_TRIGGER_REASON.FIRST_SYNC
            : "p2pkh.resources-ready";
          triggerSync(reason);
        } catch {
          // K-V 读取失败时降级为普通 reason
          triggerSync("p2pkh.resources-ready");
        }
      })();
    });

    // 监听 testnet 设置变化（通过 P2PKH settings 变化）
    const offSettingsChange = ctx.has("p2pkh.service")
      ? ctx.get<{ onGlobalSettingsChange?(handler: () => void): () => void }>("p2pkh.service")?.onGlobalSettingsChange?.(() => {
          triggerSync("settings-change");
        })
      : undefined;

    return () => {
      offActiveChange();
      offUnlocked();
      offP2pkhResource();
      offSettingsChange?.();
      stateRepository.close();
      protectedOutpoints.unregisterByOwner("token-bsv21");
      void service;
      provider.dispose?.();
      spendProtection.dispose?.();
      void spendProtection;
      void mintService;
      void transferService;
    };
  }
};
