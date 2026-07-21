// packages/plugin-token-stas/src/manifest.ts
// plugin-token-stas 清单：注册 STAS TokenProvider + 后台同步任务。
//
// 依赖说明同 plugin-token-bsv21；只是 woc.* capability 与 provider id 不同。
// phase 1 只支持主网 STAS，stasService 强制走 main。

import type {
  AssetDataNotifier,
  BackgroundRegistry,
  BackgroundService,
  I18nPluginResources,
  KeyspaceService,
  MessageBus,
  PluginManifest,
  TokenRegistry,
  VaultService,
  WocStasService
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  BACKGROUND_TRIGGER_REASON,
  KEYSPACE_SERVICE_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  WOC_STAS_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createStasService,
  type P2pkhServiceForStas
} from "./stasService.js";
import { createStasTokenProvider } from "./stasTokenProvider.js";
import { createStasDb } from "./stasDb.js";
import { createStasSyncTask } from "./stasSync.js";

const stasResources: I18nPluginResources = {
  namespace: "stas",
  resources: {
    en: { "stas.provider.name": "STAS" },
    "zh-CN": { "stas.provider.name": "STAS" }
  }
};

export const stasTokenPlugin: PluginManifest = {
  id: "token-stas",
  name: "STAS tokens",
  description: "STAS fungible token provider：通过 snapshot DB 读取当前 active key 主网地址的 STAS 持仓，注入 token.registry。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: stasResources,
  keyScopedStorages: [
    { storageId: "snapshots", description: "STAS token snapshot DB" }
  ],
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 主网地址" },
    { capability: WOC_STAS_CAPABILITY, reason: "STAS WOC 查询入口" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化、打开 key-scoped DB" },
    { capability: "token.registry", reason: "注册 STAS TokenProvider" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册后台同步任务" },
    { capability: BACKGROUND_SERVICE_CAPABILITY, reason: "触发即时同步" },
    { capability: "vault.service", reason: "sync task canRun 门禁" },
    { capability: RUNTIME_MESSAGE_BUS, reason: "订阅 vault.unlocked / key.deleted" },
    { capability: ASSET_DATA_NOTIFIER_CAPABILITY, reason: "发布数据变更通知、订阅 P2PKH resource 事件" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForStas>(P2PKH_CAPABILITY);
    const wocStas = ctx.get<WocStasService>(WOC_STAS_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY);
    const vault = ctx.get<VaultService>("vault.service");
    const backgroundService = ctx.get<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY);

    // 创建 STAS snapshot DB（key-scoped：每个 active key 拥有独立 namespace）
    const db = createStasDb(keyspace);

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createStasService({ keyspace, p2pkh, wocStas });

    // 创建 provider（只读 DB）
    const provider = createStasTokenProvider({ db, keyspace, assetDataNotifier });

    // 注册后台同步任务
    const syncTask = createStasSyncTask({ db, service, keyspace, vault, assetDataNotifier });
    backgroundRegistry.register(syncTask);

    tokenRegistry.register(provider);

    function triggerSync(reason: string) {
      backgroundService.trigger("token-stas.sync", reason);
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
      void service;
      void provider;
    };
  }
};
