// packages/plugin-token-bsv21/src/manifest.ts
// plugin-token-bsv21 清单：注册 BSV-21 TokenProvider + 后台同步任务。
//
// 依赖说明：
//   - p2pkh.service：BSV-21 的所有权仍然基于当前钱包 BSV 地址。
//   - woc.bsv21.service：BSV-21 的 WOC 查询入口。
//   - token.registry：注册 BSV-21 TokenProvider。
//   - keyspace.service：拿当前 active key、打开 key-scoped DB。
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
  WOC_BSV21_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createBsv21Service,
  type P2pkhServiceForBsv21
} from "./bsv21Service.js";
import { createBsv21TokenProvider } from "./bsv21TokenProvider.js";
import { createBsv21Db } from "./bsv21Db.js";
import { createBsv21MintHistoryDb } from "./bsv21MintHistoryDb.js";
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
      "bsv21.mint.desc": "Prepare a BSV-21 deploy+mint transaction."
    },
    "zh-CN": {
      "bsv21.provider.name": "BSV-21",
      "bsv21.route.mint": "创建 BSV-21",
      "bsv21.menu.mint": "创建 BSV-21",
      "bsv21.mint.title": "创建 BSV-21 代币",
      "bsv21.mint.desc": "准备一笔 BSV-21 deploy+mint 交易。"
    }
  }
};

export const bsv21TokenPlugin: PluginManifest = {
  id: "token-bsv21",
  name: "BSV-21 tokens",
  description: "BSV-21 fungible token provider：通过 snapshot DB 读取当前 active key 的 BSV-21 持仓，注入 token.registry。",
  meta: {
    kind: "business",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: bsv21Resources,
  keyScopedStorages: [
    { storageId: "snapshots", description: "BSV-21 token snapshot DB" },
    { storageId: "mint-history", description: "BSV-21 mint history DB" }
  ],
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 地址" },
    { capability: WOC_BSV21_CAPABILITY, reason: "BSV-21 WOC 查询入口" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化、打开 key-scoped DB" },
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
    const protocolSpend = ctx.get<import("@keymaster/contracts").ProtocolSpendService>(P2PKH_PROTOCOL_SPEND_CAPABILITY);
    const routes = ctx.get<RouteRegistry>("route.registry");
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    const transferRegistry = ctx.get<TransferRegistry>("transfer.registry");
    const vault = ctx.get<VaultService>("vault.service");
    const backgroundService = ctx.get<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY);

    // 创建 BSV-21 snapshot DB（key-scoped：每个 active key 拥有独立 namespace）
    const db = createBsv21Db(keyspace);
    const historyDb = createBsv21MintHistoryDb(keyspace);

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createBsv21Service({ keyspace, p2pkh, wocBsv21 });

    // 创建 provider（只读 DB）
    const provider = createBsv21TokenProvider({ db, keyspace, assetDataNotifier });
    const spendProtection = createBsv21SpendProtectionProvider({ db, keyspace, assetDataNotifier });
    const mintService = createBsv21MintService({ db, historyDb, p2pkh, protocolSpend });
    const transferService = createBsv21TransferService({ service, p2pkh, protocolSpend });
    const transferProvider = createBsv21TransferProvider({ tokenRegistry, p2pkh });

    // 注册后台同步任务
    const syncTask = createBsv21SyncTask({ db, service, keyspace, vault, assetDataNotifier });
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
          const existing = await db.list();
          const reason = existing.length === 0
            ? BACKGROUND_TRIGGER_REASON.FIRST_SYNC
            : "p2pkh.resources-ready";
          triggerSync(reason);
        } catch {
          // DB 读取失败时降级为普通 reason
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
      db.close();
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
