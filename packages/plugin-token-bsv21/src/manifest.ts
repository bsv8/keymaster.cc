// packages/plugin-token-bsv21/src/manifest.ts
// plugin-token-bsv21 清单：注册 BSV-21 TokenProvider。
//
// 依赖说明：
//   - p2pkh.service：BSV-21 的所有权仍然基于当前钱包 BSV 地址；当前
//     系统里这些地址资源由 p2pkh.service 管理。
//   - woc.bsv21.service：BSV-21 的 WOC 查询入口。
//   - token.registry：注册 BSV-21 TokenProvider。
//   - keyspace.service：拿当前 active key。
//
// 缺失依赖时 plugin 被 host 标为 blocked，不会出现"半可用空页面"。

import type {
  I18nPluginResources,
  KeyspaceService,
  PluginManifest,
  TokenRegistry,
  WocBsv21Service
} from "@keymaster/contracts";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  WOC_BSV21_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createBsv21Service,
  type P2pkhServiceForBsv21
} from "./bsv21Service.js";
import { createBsv21TokenProvider } from "./bsv21TokenProvider.js";

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
  description: "BSV-21 fungible token provider：通过 WOC 读取当前 active key 的 BSV-21 持仓，注入 token.registry。",
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
    { capability: "token.registry", reason: "注册 BSV-21 TokenProvider" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForBsv21>(P2PKH_CAPABILITY);
    const wocBsv21 = ctx.get<WocBsv21Service>(WOC_BSV21_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");

    const service = createBsv21Service({ keyspace, p2pkh, wocBsv21 });
    const provider = createBsv21TokenProvider({ service });

    tokenRegistry.register(provider);
    return () => {
      // host 通过 owner diff 回收 tokenProviders，本 plugin teardown 仅
      // 做最小副作用：释放本 service 句柄（service 不持有长生命周期资源）。
      void service;
      void provider;
    };
  }
};