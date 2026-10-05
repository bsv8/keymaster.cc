import type { AssetRegistry, AssetSummary, I18nText, TokenRegistry, TokenSummary } from "@keymaster/contracts";

export interface HoldingRowsResult {
  assets: Array<{ provider: { id: string; name: I18nText }; assets: AssetSummary[]; error?: string }>;
  tokens: Array<{ provider: { id: string; name: I18nText }; tokens: TokenSummary[]; error?: string }>;
}

export async function loadAllHoldings(assets: AssetRegistry, tokens: TokenRegistry): Promise<HoldingRowsResult> {
  const assetProviders = assets.list();
  const tokenProviders = tokens.list();
  const assetRows = await Promise.all(assetProviders.map(async (provider) => {
    try {
      return { provider: { id: provider.id, name: provider.name }, assets: await provider.listAssets() };
    } catch (error) {
      return { provider: { id: provider.id, name: provider.name }, assets: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const tokenRows = await Promise.all(tokenProviders.map(async (provider) => {
    try {
      return { provider: { id: provider.id, name: provider.name }, tokens: await provider.listTokens() };
    } catch (error) {
      return { provider: { id: provider.id, name: provider.name }, tokens: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { assets: assetRows, tokens: tokenRows };
}
