// packages/plugin-vault/src/vaultCoordinator.ts
// Vault 协调层只保留与 Key 材料相关的纯类型。
//
// 硬切换后没有钱包级密码：启动密码只保护 s3 桶连接参数（KDF 参数存
// session）,每把 Key 有自己的密码（KeyHold 文档）。原 verifier/meta
// 组装与校验逻辑全部删除。

/** 导入的 Key 材料（hex 或 WIF）。 */
export interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}
