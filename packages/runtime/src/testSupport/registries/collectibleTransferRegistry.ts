// packages/runtime/src/registries/collectibleTransferRegistry.ts
// collectible transfer handler 注册表。
//
// 设计缘由：
//   - collectible transfer 不复用 transfer.registry：现有 transfer 是
//     "coin/offer 平台"语义（金额/单位/矿工费）；collectible transfer
//     是"item + widget"语义，语义不同。
//   - 选择规则（硬切换）：
//       0 个 supports：listSupporting 返回空数组，平台页面显示空态。
//       1 个 supports：直接挂载。
//       多个 supports + order 唯一：选最小 order。
//       多个 supports + order 冲突：listSupporting 仍按 order 升序返回，
//         平台页面负责抛英文错误并记日志。
//   - 注册 / 注销抛错由 registry 自己负责；冲突决策交由平台层处理。

import type {
  CollectibleRef,
  CollectibleTransferHandler,
  CollectibleTransferRegistry as ICollectibleTransferRegistry,
  I18nText
} from "@keymaster/contracts";

function i18nKey(text: I18nText): string {
  if (typeof text === "string") return text;
  return text.key;
}

export function createCollectibleTransferRegistry(): ICollectibleTransferRegistry {
  const handlers = new Map<string, CollectibleTransferHandler>();

  return {
    register(handler) {
      if (handlers.has(handler.id)) {
        throw new Error(`Collectible transfer handler id "${handler.id}" is already registered`);
      }
      handlers.set(handler.id, handler);
    },
    unregister(id) {
      if (!handlers.has(id)) {
        throw new Error(`Collectible transfer handler id "${id}" is not registered`);
      }
      handlers.delete(id);
    },
    list() {
      return [...handlers.values()].sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return i18nKey(a.name).localeCompare(i18nKey(b.name));
      });
    },
    get(id) {
      return handlers.get(id);
    },
    listSupporting(ref: CollectibleRef) {
      const supporting = [...handlers.values()].filter((h) => {
        try {
          return h.supports(ref);
        } catch {
          // handler.supports 抛错视为不支持；registry 不向上抛。
          return false;
        }
      });
      // order 升序，order 相同再按 i18n key 二级稳定排序；
      // 真正的"order 冲突"由平台页面在拿到候选集后做最终判定。
      supporting.sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return i18nKey(a.name).localeCompare(i18nKey(b.name));
      });
      return supporting;
    },
    _ids() {
      return [...handlers.keys()];
    }
  };
}

export type { ICollectibleTransferRegistry as CollectibleTransferRegistry };