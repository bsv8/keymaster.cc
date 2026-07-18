// packages/plugin-token-bsv21/src/manifest.ts
// plugin-token-bsv21 清单：注册 BSV-21 TokenProvider + 后台同步任务。
//
// 依赖说明：
//   - p2pkh.service：BSV-21 的所有权仍然基于当前钱包 BSV 地址。
//   - woc.bsv21.service：BSV-21 的 WOC 查询入口。
//   - token.registry：注册 BSV-21 TokenProvider。
//   - keyspace.service：拿当前 active key。
//   - background.registry：注册 token-bsv21.sync 后台任务。
//   - asset.dataNotifier：发布数据变更通知。
//
// 缺失依赖时 plugin 被 host 标为 blocked，不会出现"半可用空页面"。

import type {
  AssetDataNotifier,
  BackgroundRegistry,
  I18nPluginResources,
  KeyspaceService,
  MessageBus,
  PluginManifest,
  TokenRegistry,
  VaultService,
  WocBsv21Service
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  BACKGROUND_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
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
import { createBsv21SyncTask } from "./bsv21Sync.js";

const bsv21Resources: I18nPluginResources = {
  namespace: "bsv21",
  resources: {
    en: { "bsv21.provider.name": "BSV-21" },
    "zh-CN": { "bsv21.provider.name": "BSV-21" }
  }
};

export const bsv21TokenPlugin: PluginManifest = {
  id: "token-bsv21",
  name: "BSV-21 tokens",
  description: "BSV-21 fungible token provider：通过 snapshot DB 读取当前 active key 的 BSV-21 持仓，注入 token.registry。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: bsv21Resources,
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 地址" },
    { capability: WOC_BSV21_CAPABILITY, reason: "BSV-21 WOC 查询入口" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化" },
    { capability: "token.registry", reason: "注册 BSV-21 TokenProvider" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册后台同步任务" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForBsv21>(P2PKH_CAPABILITY);
    const wocBsv21 = ctx.get<WocBsv21Service>(WOC_BSV21_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const messageBus = ctx.get<MessageBus>(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.has(ASSET_DATA_NOTIFIER_CAPABILITY)
      ? ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY)
      : undefined;

    // 创建 BSV-21 snapshot DB
    const db = createBsv21Db();

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createBsv21Service({ keyspace, p2pkh, wocBsv21 });

    // 创建 provider（只读 DB）
    const provider = createBsv21TokenProvider({ db, keyspace, assetDataNotifier });

    // 获取 vault service（sync task 的 canRun 门禁需要）
    const vault = ctx.get<VaultService>("vault.service");

    // 注册后台同步任务
    const syncTask = createBsv21SyncTask({ db, service, keyspace, vault, assetDataNotifier });
    backgroundRegistry.register(syncTask);

    tokenRegistry.register(provider);

    // 订阅生命周期事件，触发即时同步。
    // 设计缘由：解锁、切换账户、导入密钥时，后台定时可能还未触发，
    // 需要主动触发一次同步以满足"首次数据及时到达"的验收要求。
    const backgroundService = ctx.has("background.service")
      ? ctx.get<{ trigger(taskId: string, reason: string): void }>("background.service")
      : undefined;

    function triggerSync(reason: string) {
      backgroundService?.trigger("token-bsv21.sync", reason);
    }

    // 监听 active key 变化（切换账户、导入密钥）
    const offActiveChange = keyspace.onActiveChange(() => {
      triggerSync("active-change");
    });

    // 监听 vault 解锁（通过 messageBus，与 P2PKH 同构）
    const offUnlocked = messageBus.subscribe("vault.unlocked", () => {
      triggerSync("vault-unlocked");
    });

    // 监听 key 删除：清理该 key 的 BSV-21 快照
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