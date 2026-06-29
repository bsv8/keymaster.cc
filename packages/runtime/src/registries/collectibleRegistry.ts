// packages/runtime/src/registries/collectibleRegistry.ts
// collectible provider 注册表。
//
// 设计缘由：
//   - 与 tokenRegistry 同形；collectible 不允许注册进 token.registry /
//     asset.registry，contract 层明确禁止。
//   - 排序策略同 assetRegistry / tokenRegistry：先 order，再 name i18n key。
//   - unregister 走 owner diff / teardown 路径。

import type {
  CollectibleProvider,
  CollectibleRegistry as ICollectibleRegistry,
  I18nText
} from "@keymaster/contracts";

function i18nKey(text: I18nText): string {
  if (typeof text === "string") return text;
  return text.key;
}

export function createCollectibleRegistry(): ICollectibleRegistry {
  const providers = new Map<string, CollectibleProvider>();

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Collectible provider id "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    unregister(id) {
      if (!providers.has(id)) {
        throw new Error(`Collectible provider id "${id}" is not registered`);
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

export type { ICollectibleRegistry as CollectibleRegistry };