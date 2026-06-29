// packages/plugin-assets/src/holdingsFlow.ts
// 统一持仓聚合 flow：跨 asset.registry + token.registry 并发加载，单个
// provider 失败不影响其它 provider / 另一类对象。
//
// 设计缘由：
//   - /assets 页面同时展示 coin（asset.registry）与 fungible token
//     （token.registry）。两类对象分别来自两套独立 registry，互不污染。
//   - 单个 asset provider 失败不能拖死 token 列表；单个 token provider
//     失败也不能拖死 coin 列表。两边各自隔离。
//   - 平台排序不变量：asset 组永远整体排在 token 组前面；组内顺序
//     沿用各自 registry.list() 已经按 order / name i18n key 排好的结果。
//   - HoldingRow 是本包 view-model，不导出到 contracts。

import type {
  AssetProvider,
  AssetRegistry,
  AssetSummary,
  I18nText,
  TokenProvider,
  TokenRegistry,
  TokenSummary
} from "@keymaster/contracts";

/** 持仓行 kind：UI 表格用。 */
export type HoldingKind = "asset" | "token";

/**
 * 统一持仓行 view-model。
 * 设计缘由：把 asset / token 两类对象的差异（balance 字段 shape、
 * I18nText 类型）屏蔽到 HoldingRow 内；UI 表格只看 HoldingRow，不
 * 直接判断来源 registry。
 */
export interface HoldingRow {
  kind: HoldingKind;
  groupOrder: 0 | 1; // asset = 0, token = 1
  providerId: string;
  itemId: string;
  label: string;
  /** 余额展示文本；例如 "0.1234 BSV" / "100 XUSD"。 */
  balanceDisplay: string;
  status: string;
  detailRoute?: string;
  /** provider 名；UI 表格用它。 */
  providerName: string;
  network?: string;
  /** 业务侧辅助标记；可选。 */
  tags?: string[];
  /** kind="token" 时使用的 symbol / kind="asset" 时使用的 asset kind。 */
  symbolOrKind: string;
}

/** 单个 asset provider 加载结果。 */
export interface AssetProviderLoadResult {
  provider: AssetProvider;
  assets: AssetSummary[];
  error?: string;
}

/** 单个 token provider 加载结果。 */
export interface TokenProviderLoadResult {
  provider: TokenProvider;
  tokens: TokenSummary[];
  error?: string;
}

/** loadAllHoldings 的整体结果。 */
export interface HoldingsLoadResult {
  assets: AssetProviderLoadResult[];
  tokens: TokenProviderLoadResult[];
}

/** 并发加载 asset registry 全部 provider，单 provider 失败隔离。 */
export async function loadAllAssets(registry: AssetRegistry): Promise<AssetProviderLoadResult[]> {
  const providers = registry.list();
  return Promise.all(
    providers.map(async (provider): Promise<AssetProviderLoadResult> => {
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
}

/** 并发加载 token registry 全部 provider，单 provider 失败隔离。 */
export async function loadAllTokens(registry: TokenRegistry): Promise<TokenProviderLoadResult[]> {
  const providers = registry.list();
  return Promise.all(
    providers.map(async (provider): Promise<TokenProviderLoadResult> => {
      try {
        const tokens = await provider.listTokens();
        return { provider, tokens };
      } catch (err) {
        return {
          provider,
          tokens: [],
          error: err instanceof Error ? err.message : String(err)
        };
      }
    })
  );
}

/** 一次性加载 asset + token，供 /assets 页面用。 */
export async function loadAllHoldings(
  assets: AssetRegistry,
  tokens: TokenRegistry
): Promise<HoldingsLoadResult> {
  const [assetResults, tokenResults] = await Promise.all([
    loadAllAssets(assets),
    loadAllTokens(tokens)
  ]);
  return { assets: assetResults, tokens: tokenResults };
}

function i18nText(text: I18nText | undefined, fallback: string): string {
  if (text === undefined) return fallback;
  if (typeof text === "string") return text;
  return text.fallback;
}

/**
 * 把 loadAllHoldings 结果转成排序后的 HoldingRow 列表。
 *
 * 排序不变量（施工单 004）：
 *   1. asset 组永远整体排在 token 组前面（groupOrder 0 < 1）。
 *   2. 组内顺序：先按 provider.order 升序；同 order 再按 provider 的
 *      I18nText 业务 code（fallback）稳定排序；同 provider 再按
 *      entry 的 label / symbol 业务 code 升序。
 *   3. 平台不改变 provider 自身 listAssets() / listTokens() 的业务顺序
 *      语义——本函数只做"跨 provider + 跨 entry"的最终稳定排序。
 *   4. I18nText 在排序前用 fallback 解析成可比较字符串：避免语言切换
 *     时排序结果漂移（与 assetRegistry / tokenRegistry 的内部 i18nKey
 *     排序策略一致）。
 */
export function toHoldingRows(
  host: { i18n: { text: (t: I18nText | string | undefined, fallback?: string) => string } },
  result: HoldingsLoadResult
): HoldingRow[] {
  type Entry = {
    row: HoldingRow;
    providerOrder: number;
    providerI18nKey: string;
  };

  const entries: Entry[] = [];

  for (const r of result.assets) {
    const providerOrder = r.provider.order ?? 0;
    const providerI18nKey = i18nText(r.provider.name, r.provider.id);
    for (const a of r.assets) {
      entries.push({
        providerOrder,
        providerI18nKey,
        row: {
          kind: "asset",
          groupOrder: 0,
          providerId: r.provider.id,
          itemId: a.assetId,
          label: i18nText(a.label, a.assetId),
          balanceDisplay: a.balance
            ? a.balance.display ?? `${a.balance.amount} ${a.balance.unit}`
            : "-",
          status: a.status,
          detailRoute: a.detailRoute?.path,
          providerName: providerI18nKey,
          network: a.network,
          tags: a.tags,
          symbolOrKind: a.kind
        }
      });
    }
  }

  for (const r of result.tokens) {
    const providerOrder = r.provider.order ?? 0;
    const providerI18nKey = i18nText(r.provider.name, r.provider.id);
    for (const t of r.tokens) {
      entries.push({
        providerOrder,
        providerI18nKey,
        row: {
          kind: "token",
          groupOrder: 1,
          providerId: r.provider.id,
          itemId: t.tokenId,
          label: i18nText(t.label, t.tokenId),
          balanceDisplay: t.balance
            ? t.balance.display ?? `${t.balance.amount} ${t.balance.unit}`
            : "-",
          status: t.status,
          detailRoute: t.detailRoute?.path,
          providerName: providerI18nKey,
          network: t.network,
          tags: t.tags,
          symbolOrKind: t.symbol
        }
      });
    }
  }

  entries.sort((a, b) => {
    if (a.row.groupOrder !== b.row.groupOrder) return a.row.groupOrder - b.row.groupOrder;
    if (a.providerOrder !== b.providerOrder) return a.providerOrder - b.providerOrder;
    if (a.providerI18nKey !== b.providerI18nKey) return a.providerI18nKey.localeCompare(b.providerI18nKey);
    return a.row.label.localeCompare(b.row.label);
  });

  // host 参数占位：当前 i18n 文案已经在 i18nText() 内解析完成，host 仅
  // 留作 future-proof 字段；保持函数签名稳定便于未来扩展（如 locale
  // 切换时重新解析）。
  void host;

  return entries.map((e) => e.row);
}