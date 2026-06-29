// packages/plugin-token-stas/src/manifest.ts
// plugin-token-stas 清单：注册 STAS TokenProvider。
//
// 依赖说明同 plugin-token-bsv21；只是 woc.* capability 与 provider id 不同。
// phase 1 只支持主网 STAS，stasService 强制走 main。

import type {
  I18nPluginResources,
  KeyspaceService,
  PluginManifest,
  TokenRegistry,
  WocStasService
} from "@keymaster/contracts";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  WOC_STAS_CAPABILITY
} from "@keymaster/contracts";
import {
  P2PKH_CAPABILITY,
  createStasService,
  type P2pkhServiceForStas
} from "./stasService.js";
import { createStasTokenProvider } from "./stasTokenProvider.js";

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
  description: "STAS fungible token provider：通过 WOC 读取当前 active key 主网地址的 STAS 持仓，注入 token.registry。",
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
    { capability: "token.registry", reason: "注册 STAS TokenProvider" }
  ],
  setup(ctx) {
    const p2pkh = ctx.get<P2pkhServiceForStas>(P2PKH_CAPABILITY);
    const wocStas = ctx.get<WocStasService>(WOC_STAS_CAPABILITY);
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const tokenRegistry = ctx.get<TokenRegistry>("token.registry");

    const service = createStasService({ keyspace, p2pkh, wocStas });
    const provider = createStasTokenProvider({ service });
    tokenRegistry.register(provider);

    return () => {
      void service;
      void provider;
    };
  }
};