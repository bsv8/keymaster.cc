// packages/plugin-assets/src/AssetsPage.tsx
// 资产列表页：聚合所有 provider 的资产摘要。
// 设计缘由：单 provider 失败不影响其他 provider；通用资产页不展示 UTXO 等具体字段。
// 硬切换 008：description 显示当前 key 上下文（label / 短公钥 / 无 key）；
// 切 key 时重新拉取资产。
//
// 硬切换 005 收尾：删掉 "all 模式" 文案。无 active key 时本页面在壳层守卫
// 拦截下不会渲染——"无 key"只会以"加载中"过渡态短暂出现，壳层 AppShell
// 已经把"无 active key"收敛到 uninitialized 或修复/管理态，业务页不再
// 自己处理该空态。

import { useEffect, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { AssetRegistry, AssetSummary, KeyIdentity, KeyspaceService } from "@keymaster/contracts";
import { loadAllAssets, type ProviderLoadResult } from "./assetsFlow.js";

interface Row extends AssetSummary {
  providerName: string;
  providerId: string;
}

export function AssetsPage() {
  const registry = useCapability<AssetRegistry>("asset.registry");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [results, setResults] = useState<ProviderLoadResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeContext, setActiveContext] = useState<{
    description: string;
  }>(() => ({ description: buildDescription(host, keyspace) }));

  async function refresh() {
    setBusy(true);
    try {
      const r = await loadAllAssets(registry);
      setResults(r.results);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
    const unsubs = registry.list().map((p) => p.onChange(() => refresh()));
    return () => {
      for (const off of unsubs) off();
    };
  }, [registry]);

  useEffect(() => {
    let cancelled = false;
    async function updateContext() {
      const desc = await buildDescriptionAsync(host, keyspace);
      if (!cancelled) setActiveContext({ description: desc });
    }
    void updateContext();
    const off = keyspace.onActiveChange(() => {
      void updateContext();
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [keyspace, host]);

  if (!results) {
    return (
      <div className="assets-page">
        <PageHeader
          title={t("assets.page.title", { defaultValue: "资产" })}
          description={t("assets.page.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="assets-page">
        <PageHeader
          title={t("assets.page.title", { defaultValue: "资产" })}
          description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeContext.description}`}
        />
        <EmptyState
          title={t("assets.page.empty.providers.title", { defaultValue: "暂无资产 provider" })}
          description={t("assets.page.empty.providers.desc", { defaultValue: "安装至少一个资产 provider（例如 plugin-p2pkh）后这里会出现选项。" })}
        />
      </div>
    );
  }

  const rows: Row[] = [];
  for (const r of results) {
    for (const a of r.assets) {
      rows.push({ ...a, providerName: host.i18n.text(r.provider.name), providerId: r.provider.id });
    }
  }

  const columns: DataTableColumn<Row>[] = [
    { key: "label", header: t("assets.table.col.name", { defaultValue: "名称" }), render: (r) => host.i18n.text(r.label) },
    { key: "kind", header: t("assets.table.col.kind", { defaultValue: "类别" }), render: (r) => r.kind },
    { key: "provider", header: t("assets.table.col.provider", { defaultValue: "Provider" }), render: (r) => r.providerName },
    { key: "network", header: t("assets.table.col.network", { defaultValue: "网络" }), render: (r) => r.network ?? "-" },
    {
      key: "balance",
      header: t("assets.table.col.balance", { defaultValue: "余额" }),
      render: (r) => (r.balance ? r.balance.display ?? `${r.balance.amount} ${r.balance.unit}` : "-")
    },
    { key: "status", header: t("assets.table.col.status", { defaultValue: "状态" }), render: (r) => r.status },
    {
      key: "detail",
      header: t("assets.table.col.detail", { defaultValue: "详情" }),
      render: (r) => (r.detailRoute?.path ? <a href={r.detailRoute.path}>{t("assets.table.open", { defaultValue: "进入" })}</a> : "-")
    }
  ];

  return (
    <div className="assets-page">
      <PageHeader
        title={t("assets.page.title", { defaultValue: "资产" })}
        description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeContext.description}`}
        actions={
          <Button onClick={refresh} loading={busy}>
            {t("assets.page.refresh", { defaultValue: "刷新" })}
          </Button>
        }
      />
      {results.some((r) => r.error) ? (
        <ul className="assets-page__errors">
          {results
            .filter((r) => r.error)
            .map((r) => (
              <li key={r.provider.id}>
                {host.i18n.text(r.provider.name)}
                {t("assets.page.error.load", { defaultValue: " 加载失败：" })}
                {r.error}
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
        <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.providerId}:${r.assetId}`} />
      )}
    </div>
  );
}

function buildDescription(host: ReturnType<typeof usePluginHost>, keyspace: KeyspaceService): string {
  const state = keyspace.active();
  if (!state.activePublicKeyHash) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  return host.i18n.t("assets.context.loading", { defaultValue: "加载中…" });
}

async function buildDescriptionAsync(
  host: ReturnType<typeof usePluginHost>,
  keyspace: KeyspaceService
): Promise<string> {
  const state = keyspace.active();
  if (!state.activePublicKeyHash) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  const identity: KeyIdentity | undefined = await keyspace.getKey(state.activePublicKeyHash);
  if (!identity) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
  const label = identity.label || host.i18n.t("assets.context.unnamed", { defaultValue: "未命名" });
  // 硬切换 003 收尾：短公钥由 publicKeyHex 现算；缺 publicKeyHex 时显示
  // "身份不可用"，不再读 identity.fingerprint，也不从 publicKeyHash 反向
  // 伪造短串。
  const shortPubkey = identity.publicKeyHex
    ? formatShortPublicKey(identity.publicKeyHex)
    : host.i18n.t("assets.context.identityMissing", { defaultValue: "身份不可用" });
  return `${label}（${shortPubkey}）`;
}
