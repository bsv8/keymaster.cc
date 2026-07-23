// packages/plugin-collectible-1satordinals/src/manifest.ts
// plugin-collectible-1satordinals 清单：注册 1Sat Ordinals CollectibleProvider。
//
// 依赖说明：
//   - p2pkh.service：1Sat collectible 的所有权仍然基于当前 active key
//     的 BSV 地址未花费 UTXO 集合；plugin-p2pkh 内部维护 UTXO 真值。
//   - woc.1satordinals.service：按 outpoint 反查 inscription 的入口。
//   - collectible.registry：注册 1Sat CollectibleProvider。
//   - keyspace.service：拿当前 active key。
//
// 缺失依赖时 plugin 被 host 标为 blocked。

import type {
  AssetDataNotifier,
  BackgroundRegistry,
  BackgroundService,
  BusinessFeatureRegistry,
  CollectibleRegistry,
  I18nPluginResources,
  KeyspaceService,
  MessageBus,
  PluginManifest,
  ProtectedOutpointRegistry,
  RouteRegistry,
  CollectibleTransferRegistry,
  VaultService,
  WocService,
  Woc1SatOrdinalsService
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
  WOC_1SAT_ORDINALS_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createOrdinalsService,
  type P2pkhServiceFor1Sat
} from "./ordinalsService.js";
import { createOrdinalsCollectibleProvider } from "./ordinalsCollectibleProvider.js";
import { createOrdinalsSyncTask } from "./ordinalsSync.js";
import { createOrdinalsSpendProtectionProvider } from "./ordinalsSpendProtection.js";
import { createOrdinalMintHistoryDb } from "./ordinalMintHistoryDb.js";
import { createOrdinalMintService, ORDINAL_MINT_SERVICE_CAPABILITY } from "./ordinalMintService.js";
import { createOrdinalTransferService, ORDINAL_TRANSFER_SERVICE_CAPABILITY } from "./ordinalTransferService.js";
import { createOrdinalTransferHandler } from "./OrdinalTransferWidget.js";
import { OrdinalMintPage } from "./OrdinalMintPage.js";

const oneSatResources: I18nPluginResources = {
  namespace: "oneSat",
  resources: {
    en: {
      "oneSat.provider.name": "1Sat Ordinals",
      "oneSat.route.mint": "Create 1Sat Ordinal",
      "oneSat.menu.mint": "Create 1Sat Ordinal",
      "oneSat.mint.title": "Create 1Sat Ordinal",
      "oneSat.mint.desc": "Prepare a single-sat ordinal mint transaction."
    },
    "zh-CN": {
      "oneSat.provider.name": "1Sat Ordinals",
      "oneSat.route.mint": "创建 1Sat Ordinal",
      "oneSat.menu.mint": "创建 1Sat Ordinal",
      "oneSat.mint.title": "创建 1Sat Ordinal",
      "oneSat.mint.desc": "准备一笔单 sat ordinal 铸造交易。"
    }
  }
};

export const oneSatOrdinalsCollectiblePlugin: PluginManifest = {
  id: "collectible-1satordinals",
  name: "1Sat Ordinals",
  description: "1Sat Ordinals collectible provider：通过当前 active key 的 P2PKH 未花费 UTXO 反查 WOC 1Sat endpoint，把命中的 outpoint 注入 collectible.registry。",
  meta: {
    kind: "business",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: oneSatResources,
  keyScopedStorages: [
    { storageId: "mint-history", description: "1Sat Ordinals mint history DB" }
  ],
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的未花费 UTXO 集合" },
    { capability: WOC_1SAT_ORDINALS_CAPABILITY, reason: "按 outpoint 反查 1Sat inscription" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化" },
    { capability: "collectible.registry", reason: "注册 1Sat CollectibleProvider" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册 1Sat 后台同步任务" },
    { capability: BACKGROUND_SERVICE_CAPABILITY, reason: "触发 1Sat 即时同步" },
    { capability: "vault.service", reason: "1Sat sync task canRun 门禁" },
    { capability: RUNTIME_MESSAGE_BUS, reason: "订阅 vault.unlocked / key.deleted" },
    { capability: ASSET_DATA_NOTIFIER_CAPABILITY, reason: "发布 1Sat 数据变更通知" },
    { capability: PROTECTED_OUTPOINT_REGISTRY_CAPABILITY, reason: "注册 1Sat 受保护 outpoint" },
    { capability: P2PKH_PROTOCOL_SPEND_CAPABILITY, reason: "签名 1Sat mint / transfer 交易" },
    { capability: "collectible-transfer.registry", reason: "注册 1Sat collectible transfer handler" },
    { capability: "route.registry", reason: "注册 1Sat 创建页" },
    { capability: "business.registry", reason: "注册 1Sat 业务入口" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceFor1Sat>(P2PKH_CAPABILITY);
    const wocOneSat = ctx.get<Woc1SatOrdinalsService>(WOC_1SAT_ORDINALS_CAPABILITY);
    const woc = ctx.get<WocService>(WOC_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const collectibleRegistry = ctx.get<CollectibleRegistry>("collectible.registry");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const backgroundService = ctx.get<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY);
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY);
    const vault = ctx.get<VaultService>("vault.service");
    const protectedOutpoints = ctx.get<ProtectedOutpointRegistry>(PROTECTED_OUTPOINT_REGISTRY_CAPABILITY);
    const protocolSpend = ctx.get<import("@keymaster/contracts").ProtocolSpendService>(P2PKH_PROTOCOL_SPEND_CAPABILITY);
    const collectibleTransferRegistry = ctx.get<CollectibleTransferRegistry>("collectible-transfer.registry");
    const routes = ctx.get<RouteRegistry>("route.registry");
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");

    const service = createOrdinalsService({ keyspace, p2pkh, wocOneSat });
    const provider = createOrdinalsCollectibleProvider({ service });
    const spendProtection = createOrdinalsSpendProtectionProvider({ service });
    const historyDb = createOrdinalMintHistoryDb(keyspace);
    const syncTask = createOrdinalsSyncTask({ service, woc, historyDb, keyspace, vault, assetDataNotifier });
    const mintService = createOrdinalMintService({
      p2pkh,
      protocolSpend,
      getActiveOwnerPublicKeyHex: () => keyspace.active().activePublicKeyHex,
      historyDb
    });
    const transferService = createOrdinalTransferService({
      ordinals: service,
      p2pkh,
      protocolSpend,
      getActiveOwnerPublicKeyHex: () => keyspace.active().activePublicKeyHex
    });
    const transferHandler = createOrdinalTransferHandler();
    collectibleRegistry.register(provider);
    backgroundRegistry.register(syncTask);
    protectedOutpoints.register(spendProtection);
    collectibleTransferRegistry.register(transferHandler);
    ctx.provide(ORDINAL_MINT_SERVICE_CAPABILITY, mintService);
    ctx.provide(ORDINAL_TRANSFER_SERVICE_CAPABILITY, transferService);

    function triggerSync(reason: string) {
      backgroundService.trigger("collectible-1satordinals.sync", reason);
    }

    const offActiveChange = keyspace.onActiveKeyChanged(() => {
      // 不直接触发：由 P2PKH resource-ready 统一驱动。
    });

    const offUnlocked = messageBus.subscribe("vault.unlocked", () => {
      // 不直接触发：由 P2PKH resource-ready 统一驱动。
    });

    const offP2pkhResource = assetDataNotifier.subscribe((event) => {
      if (event.providerId !== "p2pkh") return;
      if (!event.kinds.includes("resource")) return;
      const activeHex = keyspace.active().activePublicKeyHex;
      if (!activeHex || event.publicKeyHex !== activeHex) return;
      triggerSync(BACKGROUND_TRIGGER_REASON.FIRST_SYNC);
    });

    const offSettingsChange = ctx.has("p2pkh.service")
      ? ctx.get<{ onGlobalSettingsChange?(handler: () => void): () => void }>("p2pkh.service")?.onGlobalSettingsChange?.(() => {
          triggerSync("settings-change");
        })
      : undefined;

    routes.register({
      id: "oneSat.mint",
      path: "/collectibles/1satordinals/mint",
      label: { key: "oneSat.route.mint", fallback: "Create 1Sat Ordinal" },
      component: OrdinalMintPage
    });

    business.registerFeature("collectible-1satordinals", "assets", {
      id: "assets.oneSat.mint",
      label: { key: "oneSat.menu.mint", fallback: "Create 1Sat Ordinal" },
      order: 26,
      icon: "ImagePlus",
      entry: {
        path: "/collectibles/1satordinals/mint",
        routeId: "oneSat.mint",
        visibleWhen: ({ unlocked }) => unlocked
      }
    });

    return () => {
      offActiveChange();
      offUnlocked();
      offP2pkhResource();
      offSettingsChange?.();
      protectedOutpoints.unregisterByOwner("collectible-1satordinals");
      service.dispose();
      void service;
      void provider;
      void spendProtection;
      void mintService;
      void transferService;
      void transferHandler;
    };
  }
};
