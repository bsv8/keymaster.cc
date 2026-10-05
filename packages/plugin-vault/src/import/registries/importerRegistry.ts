// packages/runtime/src/registries/importerRegistry.ts
// 导入器注册表：由 Vault 内部持有。
// 设计缘由：把"格式解析"与"导入流程"分离，importer 只输出标准材料。
// 硬切换 001：unregister 走 owner 回收。


import type { KeyImporter, KeyImportInput, ImporterRegistry } from "../types.js";

export function createImporterRegistry(): ImporterRegistry & {
  /** 硬切换 001：注销 importer。id 不存在时抛错。 */
  unregister(id: string): void;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
} {
  const map = new Map<string, KeyImporter>();

  return {
    register(importer) {
      if (map.has(importer.id)) {
        throw new Error(`Importer id "${importer.id}" is already registered`);
      }
      map.set(importer.id, importer);
    },
    unregister(id) {
      if (!map.has(id)) {
        throw new Error(`Importer id "${id}" is not registered`);
      }
      map.delete(id);
    },
    list() {
      return [...map.values()];
    },
    match(input: KeyImportInput) {
      for (const importer of map.values()) {
        if (importer.supports.includes(input.kind)) return importer;
      }
      return undefined;
    },
    get(id) {
      return map.get(id);
    },
    _ids() {
      return [...map.keys()];
    }
  };
}

// 显式重新导出类型，方便 runtime 内部使用。

