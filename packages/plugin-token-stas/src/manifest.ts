// packages/plugin-token-stas/src/manifest.ts
// plugin-token-stas 清单：注册 STAS TokenProvider + 后台同步任务。
//
// 依赖说明同 plugin-token-bsv21；只是 woc.* capability 与 provider id 不同。
// phase 1 只支持主网 STAS，stasService 强制走 main。

import type {
  AssetDataNotifier,
  BackgroundRegistry,
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
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 主网地址" },
    { capability: WOC_STAS_CAPABILITY, reason: "STAS WOC 查询入口" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化" },
    { capability: "token.registry", reason: "注册 STAS TokenProvider" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册后台同步任务" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForStas>(P2PKH_CAPABILITY);
    const wocStas = ctx.get<WocStasService>(WOC_STAS_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.has(ASSET_DATA_NOTIFIER_CAPABILITY)
      ? ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY)
      : undefined;

    // 创建 STAS snapshot DB
    const db = createStasDb();

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createStasService({ keyspace, p2pkh, wocStas });

    // 创建 provider（只读 DB）
    const provider = createStasTokenProvider({ db, keyspace, assetDataNotifier });

    // 获取 vault service（sync task 的 canRun 门禁需要）
    const vault = ctx.get<VaultService>("vault.service");

    // 注册后台同步任务
    const syncTask = createStasSyncTask({ db, service, keyspace, vault, assetDataNotifier });
    backgroundRegistry.register(syncTask);

    tokenRegistry.register(provider);

    // 订阅生命周期事件，触发即时同步。
    // 设计缘由：解锁、切换账户、导入密钥时，后台定时可能还未触发，
    // 需要主动触发一次同步以满足"首次数据及时到达"的验收要求。
    const backgroundService = ctx.has("background.service")
      ? ctx.get<{ trigger(taskId: string, reason: string): void }>("background.service")
      : undefined;

    function triggerSync(reason: string) {
      backgroundService?.trigger("token-stas.sync", reason);
    }

    // 监听 active key 变化（切换账户、导入密钥）
    const offActiveChange = keyspace.onActiveChange(() => {
      triggerSync("active-change");
    });

    // 监听 vault 解锁（通过 messageBus，与 P2PKH 同构）
    const offUnlocked = messageBus.subscribe("vault.unlocked", () => {
      triggerSync("vault-unlocked");
    });

    // 监听 key 删除：清理该 key 的 STAS 快照
    const offKeyDeleted = messageBus.subscribe<{ publicKeyHex: string }>("key.deleted", (payload) => {
      void db.deleteByPublicKey(payload.publicKeyHex);
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
      offKeyDeleted();
      offSettingsChange?.();
      void service;
      void provider;
    };
  }
};