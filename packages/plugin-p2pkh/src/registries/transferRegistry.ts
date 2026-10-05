// packages/runtime/src/registries/transferRegistry.ts
// 转账 provider 注册表：由 plugin-transfer 提供。
// 设计缘由：转账平台不直接实现 P2PKH/1Sat 等业务，业务插件通过 TransferProvider 接入。
// 硬切换 001：unregister 走 owner 回收。

import type { TransferProvider, TransferRegistry as ITransferRegistry, I18nText } from "@keymaster/contracts";

function i18nKey(text: I18nText): string {
  if (typeof text === "string") return text;
  return text.key;
}

export function createTransferRegistry(): ITransferRegistry & {
  /** 硬切换 001：注销 provider。id 不存在时抛错。 */
  unregister(id: string): void;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
} {
  const map = new Map<string, TransferProvider>();

  return {
    register(provider) {
      if (map.has(provider.id)) {
        throw new Error(`Transfer provider id "${provider.id}" is already registered`);
      }
      map.set(provider.id, provider);
    },
    unregister(id) {
      if (!map.has(id)) {
        throw new Error(`Transfer provider id "${id}" is not registered`);
      }
      map.delete(id);
    },
    list() {
      // 与 assetRegistry 保持一致：先按 provider order，再按 name 的 i18n key。
      return [...map.values()].sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        if (ao !== bo) return ao - bo;
        return i18nKey(a.name).localeCompare(i18nKey(b.name));
      });
    },
    get(id) {
      return map.get(id);
    },
    _ids() {
      return [...map.keys()];
    }
  };
}

export type { ITransferRegistry as TransferRegistry };
