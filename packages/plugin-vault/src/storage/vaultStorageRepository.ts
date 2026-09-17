// Vault 的存储边界（硬切换后）。
//
// 私钥密文只经由 Coordinator 注入的 VaultCatalogHoldAdapter 读写桶内
// `keys/<公钥>.keyhold`（KeyHold 一 Key 一文件）。密码域只有两个：
// 启动密码（仅保护 s3 桶连接参数）与每把 Key 自己的密码；没有钱包级
// 验密码元数据，也没有 Key 索引与生命周期日志（文件本身即真值）。

import type { VaultCatalogHoldAdapter } from "./holdTypes.js";

export type {
  VaultCatalogHoldAdapter,
  VaultCatalogHoldJsonValue,
  VaultCatalogHoldRecord,
  VaultCatalogHoldSnapshot,
} from "./holdTypes.js";

/** Host/Coordinator 注入的 Hold 适配器入口。 */
export interface VaultStorageRepository {
  readonly hold: VaultCatalogHoldAdapter;
}

export interface VaultStorageRepositoryInput {
  readonly hold: VaultCatalogHoldAdapter;
}

let current: VaultStorageRepository | undefined;

export function createVaultStorageRepository(input: VaultStorageRepositoryInput): VaultStorageRepository {
  return { hold: input.hold };
}

export function configureVaultStorageRepository(input: VaultStorageRepositoryInput): void {
  current = createVaultStorageRepository(input);
}

export function getVaultStorageRepository(): VaultStorageRepository {
  if (!current) throw new Error("Vault storage repository is not configured");
  return current;
}

/** Host 装配失败/切桶时丢弃句柄；Hold 适配器由调用方负责释放。 */
export function disposeVaultStorageRepository(): void {
  current = undefined;
}

/** 兼容旧调用点：直接读取已配置的 Hold 适配器。 */
export const vaultStorageRepository = {
  get hold(): VaultCatalogHoldAdapter { return getVaultStorageRepository().hold; },
};
