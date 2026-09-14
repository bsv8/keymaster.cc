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
  PluginManifest,
  PluginSetup,
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
  TOKEN_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  WOC_STAS_CAPABILITY,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createStasService,
  type P2pkhServiceForStas
} from "./stasService.js";
import { createStasTokenProvider } from "./stasTokenProvider.js";
import { createStasRepository } from "./storage/stasRepository.js";
import { createStasSyncTask } from "./stasSync.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

const stasResources: I18nPluginResources = {
  namespace: "stas",
  resources: {
    en: {
      "stas.provider.name": "STAS",
      "stas.task.sync": "STAS sync",
      "stas.task.sync.description": "Sync STAS token holdings."
    },
    "zh-CN": {
      "stas.provider.name": "STAS",
      "stas.task.sync": "STAS 同步",
      "stas.task.sync.description": "同步 STAS 代币持仓快照。"
    }
  }
};

const stasTokenPluginDefinition = {
  id: "token-stas",
  name: "STAS tokens",
  description: "STAS fungible token provider：通过 snapshot K-V 读取当前 active key 主网地址的 STAS 持仓，注入 token.registry。",
  kind: "business",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "business",
  units: [
    {
      id: "token-stas.window",
      runtime: "window-main",
      scopeKind: "owner-session",
      storage: CENTRAL_STORAGE_DECLARATIONS.tokenStasState,
      dependencies: defineRuntimeUnitDependencies([
        { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的 BSV 主网地址" },
        { capability: WOC_STAS_CAPABILITY, reason: "STAS WOC 查询入口" },
        { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化、打开 key-scoped K-V" },
        { capability: TOKEN_REGISTRY_CAPABILITY, reason: "注册 STAS TokenProvider" },
        { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册后台同步任务" },
        { capability: BACKGROUND_SERVICE_CAPABILITY, reason: "触发即时同步" },
        { capability: VAULT_SERVICE_CAPABILITY, reason: "sync task canRun 门禁" },
        { capability: RUNTIME_MESSAGE_BUS, reason: "订阅 vault.unlocked / key.deleted" },
        { capability: ASSET_DATA_NOTIFIER_CAPABILITY, reason: "发布数据变更通知、订阅 P2PKH resource 事件" },
      ]),
    },
    {
      id: "token-stas.coordinator-worker",
      runtime: "shared-worker",
      scopeKind: "owner-session",
      storage: CENTRAL_STORAGE_DECLARATIONS.tokenStasState,
    },
  ],
  i18n: stasResources,
  setup(ctx) {
    const p2pkh = ctx.capability(P2PKH_CAPABILITY);
    const wocStas = ctx.capability(WOC_STAS_CAPABILITY);
    const keyspace = ctx.capability(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.capability(TOKEN_REGISTRY_CAPABILITY);
    const backgroundRegistry = ctx.capability(BACKGROUND_REGISTRY_CAPABILITY);
    const messageBus = ctx.capability(RUNTIME_MESSAGE_BUS);
    const assetDataNotifier = ctx.capability(ASSET_DATA_NOTIFIER_CAPABILITY);
    const vault = ctx.capability(VAULT_SERVICE_CAPABILITY);
    const backgroundService = ctx.capability(BACKGROUND_SERVICE_CAPABILITY);

    // Host 已完成声明校验并注入 owner/App K-V 句柄；Repository 不再接收 Keyspace。
    const stateRepository = createStasRepository(ctx.storageFor("token-state"));

    // 创建 service（保留 WOC 能力，供 sync task 使用）
    const service = createStasService({ keyspace, p2pkh, wocStas });

    // 创建 provider（只读 K-V）
    const provider = createStasTokenProvider({ stateRepository, keyspace, assetDataNotifier });

    // 注册后台同步任务
    const syncTask = createStasSyncTask({ stateRepository, service, keyspace, vault, assetDataNotifier });
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
    const offSettingsChange = p2pkh.onGlobalSettingsChange?.(() => {
      triggerSync("settings-change");
    });

    return () => {
      offActiveChange();
      offUnlocked();
      offP2pkhResource();
      offSettingsChange?.();
      stateRepository.close();
      void service;
      void provider;
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: stasTokenSetup, ...stasTokenPlugin } = stasTokenPluginDefinition;
export { stasTokenSetup, stasTokenPlugin };
