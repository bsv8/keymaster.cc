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
  CollectibleRegistry,
  I18nPluginResources,
  KeyspaceService,
  PluginManifest,
  Woc1SatOrdinalsService
} from "@keymaster/contracts";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  WOC_1SAT_ORDINALS_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createOrdinalsService,
  type P2pkhServiceFor1Sat
} from "./ordinalsService.js";
import { createOrdinalsCollectibleProvider } from "./ordinalsCollectibleProvider.js";

const oneSatResources: I18nPluginResources = {
  namespace: "oneSat",
  resources: {
    en: { "oneSat.provider.name": "1Sat Ordinals" },
    "zh-CN": { "oneSat.provider.name": "1Sat Ordinals" }
  }
};

export const oneSatOrdinalsCollectiblePlugin: PluginManifest = {
  id: "collectible-1satordinals",
  name: "1Sat Ordinals",
  description: "1Sat Ordinals collectible provider：通过当前 active key 的 P2PKH 未花费 UTXO 反查 WOC 1Sat endpoint，把命中的 outpoint 注入 collectible.registry。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "business"
  },
  i18n: oneSatResources,
  dependencies: [
    { capability: P2PKH_CAPABILITY, reason: "读取当前 active key 的未花费 UTXO 集合" },
    { capability: WOC_1SAT_ORDINALS_CAPABILITY, reason: "按 outpoint 反查 1Sat inscription" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "监听 active key 变化" },
    { capability: "collectible.registry", reason: "注册 1Sat CollectibleProvider" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceFor1Sat>(P2PKH_CAPABILITY);
    const wocOneSat = ctx.get<Woc1SatOrdinalsService>(WOC_1SAT_ORDINALS_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const collectibleRegistry = ctx.get<CollectibleRegistry>("collectible.registry");

    const service = createOrdinalsService({ keyspace, p2pkh, wocOneSat });
    const provider = createOrdinalsCollectibleProvider({ service });
    collectibleRegistry.register(provider);

    return () => {
      void service;
      void provider;
    };
  }
};