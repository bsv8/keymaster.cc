// packages/plugin-assets/src/AssetsPage.tsx
// 统一持仓页：聚合 asset.registry + token.registry。
//
// 设计缘由：
//   - 单 provider 失败不影响其他 provider；通用资产页不展示 UTXO 等
//     具体字段。
//   - 排序不变量：asset 组整体在 token 组前；组内先按 provider 名称，
//     再按 label（platform 二次稳定排序）。
//   - 详情入口仍由各 provider 自行声明 detailRoute；未声明时表格
//     "详情" 列展示 "-"，引导用户回到 provider 自带详情页或 detail 平台。

import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { AppLink, useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import { ASSET_DATA_NOTIFIER_CAPABILITY, formatShortPublicKey } from "@keymaster/contracts";
import type { AssetDataNotifier, AssetProvider, AssetRegistry, KeyIdentity, KeyspaceService, TokenProvider, TokenRegistry } from "@keymaster/contracts";
import {
  loadSingleAssetProvider,
  loadSingleTokenProvider,
  toHoldingRows,
  type AssetProviderLoadResult,
  type HoldingRow,
  type HoldingsLoadResult,
  type TokenProviderLoadResult
} from "./holdingsFlow.js";

export function AssetsPage() {
  const assetsRegistry = useCapability<AssetRegistry>("asset.registry");
  const tokensRegistry = useCapability<TokenRegistry>("token.registry");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [rows, setRows] = useState<HoldingRow[] | null>(null);
  const [errors, setErrors] = useState<Array<{ provider: string; error: string; kind: "asset" | "token" }>>(
    []
  );
  const [activeContext, setActiveContext] = useState<{
    description: string;
  }>(() => ({ description: buildDescription(host, keyspace) }));

  // provider 级状态：按 provider.id 缓存各自的加载结果
  const assetResultsRef = useRef<Map<string, AssetProviderLoadResult>>(new Map());
  const tokenResultsRef = useRef<Map<string, TokenProviderLoadResult>>(new Map());
  // provider 级 revision：防止旧请求晚到覆盖新数据。
  // 设计缘由：同一 provider 的 onChange 可能快速连续触发多次请求，
  // 先发后到的请求不应覆盖后来写入的结果。
  const assetRevisionRef = useRef<Map<string, number>>(new Map());
  const tokenRevisionRef = useRef<Map<string, number>>(new Map());
  const aliveRef = useRef(true);

  /** 从当前 provider 级缓存重建 rows。 */
  const rebuildRows = useCallback(() => {
    const result: HoldingsLoadResult = {
      assets: [...assetResultsRef.current.values()],
      tokens: [...tokenResultsRef.current.values()],
    };
    const collected: typeof errors = [];
    for (const r of result.assets) {
      if (r.error) collected.push({ provider: r.provider.id, error: r.error, kind: "asset" });
    }
    for (const r of result.tokens) {
      if (r.error) collected.push({ provider: r.provider.id, error: r.error, kind: "token" });
    }
    setErrors(collected);
    setRows(toHoldingRows(host, result));
  }, [host]);

  /**
   * 渐进加载：每个 provider 独立请求，完成即写入 Map 并 rebuildRows。
   * 设计缘由：一个 provider 挂起时，已完成 provider 的资产仍先显示。
   * 每个 provider 请求前递增 revision，完成时仅在 revision 仍匹配时写入。
   */
  async function refreshAll() {
    assetResultsRef.current.clear();
    tokenResultsRef.current.clear();
    const assetProviders = assetsRegistry.list();
    const tokenProviders = tokensRegistry.list();
    const promises = [
      ...assetProviders.map(async (p) => {
        const rev = (assetRevisionRef.current.get(p.id) ?? 0) + 1;
        assetRevisionRef.current.set(p.id, rev);
        const result = await loadSingleAssetProvider(p);
        if (!aliveRef.current || assetRevisionRef.current.get(p.id) !== rev) return;
        assetResultsRef.current.set(p.id, result);
        rebuildRows();
      }),
      ...tokenProviders.map(async (p) => {
        const rev = (tokenRevisionRef.current.get(p.id) ?? 0) + 1;
        tokenRevisionRef.current.set(p.id, rev);
        const result = await loadSingleTokenProvider(p);
        if (!aliveRef.current || tokenRevisionRef.current.get(p.id) !== rev) return;
        tokenResultsRef.current.set(p.id, result);
        rebuildRows();
      }),
    ];
    await Promise.allSettled(promises);
  }

  /** 增量刷新单个 asset provider。 */
  async function refreshAssetProvider(provider: AssetProvider) {
    const rev = (assetRevisionRef.current.get(provider.id) ?? 0) + 1;
    assetRevisionRef.current.set(provider.id, rev);
    const result = await loadSingleAssetProvider(provider);
    if (!aliveRef.current || assetRevisionRef.current.get(provider.id) !== rev) return;
    assetResultsRef.current.set(provider.id, result);
    rebuildRows();
  }

  /** 增量刷新单个 token provider。 */
  async function refreshTokenProvider(provider: TokenProvider) {
    const rev = (tokenRevisionRef.current.get(provider.id) ?? 0) + 1;
    tokenRevisionRef.current.set(provider.id, rev);
    const result = await loadSingleTokenProvider(provider);
    if (!aliveRef.current || tokenRevisionRef.current.get(provider.id) !== rev) return;
    tokenResultsRef.current.set(provider.id, result);
    rebuildRows();
  }

  useEffect(() => {
    aliveRef.current = true;
    refreshAll();
    // 订阅每个 provider 的 onChange，只重读该 provider
    const unsubs = [
      ...assetsRegistry.list().map((p) => p.onChange(() => refreshAssetProvider(p))),
      ...tokensRegistry.list().map((p) => p.onChange(() => refreshTokenProvider(p)))
    ];
    return () => {
      aliveRef.current = false;
      for (const off of unsubs) off();
    };
  }, [assetsRegistry, tokensRegistry]);

  useEffect(() => {
    let cancelled = false;
    async function updateContext() {
      const desc = await buildDescriptionAsync(host, keyspace);
      if (!cancelled) setActiveContext({ description: desc });
    }
    void updateContext();
    const off = keyspace.onActiveChange(() => {
      void updateContext();
      void refreshAll();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [keyspace, host]);

  if (!rows) {
    return (
      <div className="assets-page">
        <PageHeader
          title={t("assets.page.title", { defaultValue: "资产" })}
          description={t("assets.page.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  if (rows.length === 0 && errors.length === 0) {
    const hasProviders = assetsRegistry.list().length > 0 || tokensRegistry.list().length > 0;
    if (!hasProviders) {
      return (
        <div className="assets-page">
          <PageHeader
            title={t("assets.page.title", { defaultValue: "资产" })}
            description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeContext.description}`}
          />
          <EmptyState
            title={t("assets.page.empty.providers.title", { defaultValue: "暂无资产 provider" })}
            description={t("assets.page.empty.providers.desc", {
              defaultValue: "安装至少一个资产或 token provider 后这里会出现选项。"
            })}
          />
        </div>
      );
    }
  }

  const columns: DataTableColumn<HoldingRow>[] = [
    { key: "label", header: t("assets.table.col.name", { defaultValue: "名称" }), render: (r) => r.label },
    {
      key: "kind",
      header: t("assets.table.col.kind", { defaultValue: "类别" }),
      // 显示 "coin" / "token"，对用户语义清晰；asset provider 的 kind 由
      // symbolOrKind 字段承载，token provider 透传 symbol。
      render: (r) => (r.kind === "asset" ? r.symbolOrKind : "token")
    },
    { key: "provider", header: t("assets.table.col.provider", { defaultValue: "Provider" }), render: (r) => r.providerName },
    { key: "network", header: t("assets.table.col.network", { defaultValue: "网络" }), render: (r) => r.network ?? "-" },
    {
      key: "balance",
      header: t("assets.table.col.balance", { defaultValue: "余额" }),
      render: (r) => r.balanceDisplay
    },
    { key: "status", header: t("assets.table.col.status", { defaultValue: "状态" }), render: (r) => r.status },
    {
      key: "detail",
      header: t("assets.table.col.detail", { defaultValue: "详情" }),
      render: (r) =>
        r.detailRoute ? <AppLink to={r.detailRoute}>{t("assets.table.open", { defaultValue: "进入" })}</AppLink> : "-"
    }
  ];

  return (
    <div className="assets-page">
      <PageHeader
        title={t("assets.page.title", { defaultValue: "资产" })}
        description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeContext.description}`}
      />
      {errors.length > 0 ? (
        <ul className="assets-page__errors">
          {errors.map((e) => (
            <li key={`${e.kind}:${e.provider}`}>
              {e.provider}
              {t("assets.page.error.load", { defaultValue: " 加载失败：" })}
              {e.error}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t("assets.page.empty.assets.title", { defaultValue: "暂无资产" })}
          description={t("assets.page.empty.assets.desc", { defaultValue: "导入或解锁钱包后这里会显示资产。" })}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.kind}:${r.providerId}:${r.itemId}`} />
      )}
    </div>
  );
}

function buildDescription(host: ReturnType<typeof usePluginHost>, keyspace: KeyspaceService): string {
  const state = keyspace.active();
  if (!state.activePublicKeyHex) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  return host.i18n.t("assets.context.loading", { defaultValue: "加载中…" });
}

async function buildDescriptionAsync(
  host: ReturnType<typeof usePluginHost>,
  keyspace: KeyspaceService
): Promise<string> {
  const state = keyspace.active();
  if (!state.activePublicKeyHex) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  const identity: KeyIdentity | undefined = await keyspace.getKey(state.activePublicKeyHex);
  if (!identity) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  const label = identity.label || host.i18n.t("assets.context.unnamed", { defaultValue: "未命名" });
  const shortPubkey = identity.publicKeyHex
    ? formatShortPublicKey(identity.publicKeyHex)
    : host.i18n.t("assets.context.identityMissing", { defaultValue: "身份不可用" });
  return `${label}（${shortPubkey}）`;
}