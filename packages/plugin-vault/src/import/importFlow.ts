import type { InternalVaultService } from "../internalVaultService.js";
// packages/plugin-vault/src/import/importFlow.ts
// 导入流程：把 importer 解析结果交给 vault 持久化。
// 设计缘由：流程、格式解析和加密保存均归 Vault 内部。
//
// 单 Key 本地存储（docs/存储.md）之后，导入只有一种用途：**首次**初始化
// 钱包。系统里不会再有第二把 Key，因此不存在"向已有钱包追加一把 Key"的
// 路径；`persistImport` 直接走 `vault.initialize()` 的原子提交。

import type { WalletInitializePlan, WalletKeySummary } from "@keymaster/contracts";
import type { KeyImportResult } from "./types.js";

export interface ImportOptions {
  /** 用户填写的标签。 */
  label: string;
  /** 当前 Vault 密码。 */
  password: string;
  /** 推断能力，默认 p2pkh。 */
  capabilities?: string[];
  /** 来源标记，例如 "wif"、"hex"、"json-file"。 */
  source?: string;
}

export async function persistImport(
  vault: InternalVaultService,
  result: KeyImportResult,
  options: ImportOptions
): Promise<WalletKeySummary> {
  if (!options.label) throw new Error("Label is required");
  const plan: WalletInitializePlan = {
    transactionId: `import-${crypto.randomUUID()}`,
    firstKey: {
      kind: "import",
      label: options.label,
      material: result.material,
      format: result.detectedFormat,
      ...(options.source === undefined ? {} : { source: options.source }),
      capabilities: options.capabilities ?? ["p2pkh"],
      password: options.password
    }
  };
  return vault.initialize(plan);
}
