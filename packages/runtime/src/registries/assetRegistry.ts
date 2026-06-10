// packages/runtime/src/registries/assetRegistry.ts
// 资产 provider 注册表。
// 设计缘由：资产平台（plugin-assets）只通过 capability "asset.registry" 拿到这个表，
// 它本身不创建 registry；具体资产（plugin-p2pkh 等）通过 ctx.provide 注册 provider。
// 关键不变量：
//  - provider id 重复必须抛错（不允许后注册的 provider 覆盖先注册的）。
//  - registry 不缓存 provider 返回的资产数据，数据刷新由 provider 自己处理。

import type { AssetProvider, AssetRegistry as IAssetRegistry, I18nText } from "@keymaster/contracts";

/** 把 I18nText 降级为可比较的字符串。设计缘由：I18nText 在这里是稳定
 * 排序键——registry 在 bootstrap 时按当前语言解析会导致语言切换时排序
 * 变化；改用 fallback 作为业务 code（plugin 自行保证 fallback 稳定）。 */
function i18nKey(text: I18nText): string {
  if (typeof text === "string") return text;
  return text.key;
}

export function createAssetRegistry(): IAssetRegistry {
  const providers = new Map<string, AssetProvider>();

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Asset provider id "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    list() {
      // 排序优先按 provider order，再按 name 的 I18nText key（业务稳定 code）。
      return [...providers.values()].sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return i18nKey(a.name).localeCompare(i18nKey(b.name));
      });
    },
    get(id) {
      return providers.get(id);
    }
  };
}

export type { IAssetRegistry as AssetRegistry };
