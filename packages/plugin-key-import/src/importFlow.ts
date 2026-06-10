// packages/plugin-key-import/src/importFlow.ts
// 导入流程：把 importer 解析结果交给 vault 持久化。
// 设计缘由：流程归平台，格式解析归 importer-*，vault 仅负责加密保存。

import type { KeyImportResult, VaultService } from "@keymaster/contracts";

export interface ImportOptions {
  /** 用户填写的标签。 */
  label: string;
  /** 推断能力，默认 p2pkh。 */
  capabilities?: string[];
  /** 来源标记，例如 "wif"、"hex"、"json-file"。 */
  source?: string;
}

export async function persistImport(
  vault: VaultService,
  result: KeyImportResult,
  options: ImportOptions
) {
  if (!options.label) throw new Error("Label is required");
  const ref = await vault.importPrivateKey({
    label: options.label,
    material: result.material,
    format: result.detectedFormat,
    capabilities: options.capabilities ?? ["p2pkh"],
    source: options.source
  });
  return ref;
}
