// packages/plugin-assets/src/assetsFlow.ts
// 资产聚合辅助：跨 provider 并发加载，单个 provider 失败不影响其他。
// 设计缘由：资产列表不能因为一个 provider 同步失败而整体不可用。
// 资产平台只负责聚合结果，不拥有 provider 的内部状态。

import type { AssetProvider, AssetRegistry, AssetSummary } from "@keymaster/contracts";

/** 单个 provider 加载结果。 */
export interface ProviderLoadResult {
  provider: AssetProvider;
  assets: AssetSummary[];
  /** provider 加载失败时的错误信息（英文原文，UI 自行映射）。 */
  error?: string;
}

/** 全部 provider 的加载结果。 */
export interface AssetsLoadResult {
  results: ProviderLoadResult[];
  /** 全部 provider 是否都失败。 */
  allFailed: boolean;
  /** 是否有任意 provider 成功。 */
  anySucceeded: boolean;
}

/** 加载全部 provider 的资产摘要。 */
export async function loadAllAssets(registry: AssetRegistry): Promise<AssetsLoadResult> {
  const providers = registry.list();
  const results = await Promise.all(
    providers.map(async (provider): Promise<ProviderLoadResult> => {
      try {
        const assets = await provider.listAssets();
        return { provider, assets };
      } catch (err) {
        return {
          provider,
          assets: [],
          error: err instanceof Error ? err.message : String(err)
        };
      }
    })
  );
  const anySucceeded = results.some((r) => !r.error);
  const allFailed = results.length > 0 && !anySucceeded;
  return { results, allFailed, anySucceeded };
}
