// packages/runtime/src/registries/tokenRegistry.ts
// fungible token provider 注册表。
//
// 设计缘由：
//   - 与 assetRegistry 同形；分两个独立 registry 是为了硬切换：token
//     不允许注册进 asset.registry，contract 层明确禁止。
//   - 排序策略与 assetRegistry / transferRegistry 一致：先按 provider.order，
//     再按 name 的 I18nText key（业务稳定 code，避免语言切换时排序漂移）。
//   - unregister 走 owner diff / teardown 路径。

import type {
  I18nText,
  TokenProvider,
  TokenRegistry as ITokenRegistry
} from "@keymaster/contracts";

function i18nKey(text: I18nText): string {
  if (typeof text === "string") return text;
  return text.key;
}

export function createTokenRegistry(): ITokenRegistry {
  const providers = new Map<string, TokenProvider>();

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Token provider id "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    unregister(id) {
      if (!providers.has(id)) {
        throw new Error(`Token provider id "${id}" is not registered`);
      }
      providers.delete(id);
    },
    list() {
      return [...providers.values()].sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return i18nKey(a.name).localeCompare(i18nKey(b.name));
      });
    },
    get(id) {
      return providers.get(id);
    },
    _ids() {
      return [...providers.keys()];
    }
  };
}

export type { ITokenRegistry as TokenRegistry };