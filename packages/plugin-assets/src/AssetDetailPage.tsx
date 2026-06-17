// packages/plugin-assets/src/AssetDetailPage.tsx
// 通用资产详情页：作为转发页，查找 provider 的 detailRoute 并跳过去。
// 设计缘由：通用资产详情页不展示 UTXO 等具体字段；具体资产 UI 由该资产插件自己提供。
// 如果没有声明 detailRoute，则展示平台级摘要与活动。

import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { router, useCapability, useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type { AssetActivity, AssetDetail, AssetProvider, AssetRegistry } from "@keymaster/contracts";

export interface AssetDetailPageProps {
  providerId: string;
  assetId: string;
}

export function AssetDetailPage({ providerId, assetId }: AssetDetailPageProps) {
  const registry = useCapability<AssetRegistry>("asset.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const [provider, setProvider] = useState<AssetProvider | undefined>(undefined);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [activities, setActivities] = useState<AssetActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = registry.get(providerId);
    if (!p) {
      setError(`Unknown asset provider "${providerId}"`);
      return;
    }
    setProvider(p);
    p.getAsset(assetId)
      .then((d) => {
        if (!d) {
          setError(`Asset "${assetId}" not found in provider "${providerId}"`);
          return;
        }
        setDetail(d);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    p.listActivity(assetId)
      .then(setActivities)
      .catch(() => setActivities([]));
  }, [registry, providerId, assetId]);

  if (error) {
    return (
      <div className="asset-detail">
        <PageHeader title={t("assets.detail.title", { defaultValue: "资产详情" })} />
        <EmptyState
          title={t("assets.detail.notFound", { defaultValue: "无法显示资产" })}
          description={error}
        />
      </div>
    );
  }

  if (!provider || !detail) {
    return (
      <div className="asset-detail">
        <PageHeader
          title={t("assets.detail.title", { defaultValue: "资产详情" })}
          description={t("assets.detail.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  const columns: DataTableColumn<AssetActivity>[] = [
    { key: "title", header: t("assets.detail.table.title", { defaultValue: "标题" }), render: (a) => host.i18n.text(a.title) },
    { key: "txid", header: t("assets.detail.table.txid", { defaultValue: "txid" }), render: (a) => (a.txid ? <code>{a.txid}</code> : "-") },
    {
      key: "amount",
      header: t("assets.detail.table.amount", { defaultValue: "金额" }),
      render: (a) => (a.amount ? a.amount.display ?? `${a.amount.amount} ${a.amount.unit}` : "-")
    },
    { key: "direction", header: t("assets.detail.table.direction", { defaultValue: "方向" }), render: (a) => a.direction ?? "-" },
    { key: "status", header: t("assets.detail.table.status", { defaultValue: "状态" }), render: (a) => a.status ?? "-" },
    { key: "time", header: t("assets.detail.table.time", { defaultValue: "时间" }), render: (a) => (a.occurredAt ? dateFmt.format(new Date(a.occurredAt)) : "-") }
  ];

  return (
    <div className="asset-detail">
      <PageHeader
        title={host.i18n.text(detail.summary.label)}
        description={`${host.i18n.text(provider.name)} · ${detail.summary.kind} · ${detail.summary.status}`}
        actions={
          detail.summary.detailRoute?.path ? (
            <Button onClick={() => router.push(detail.summary.detailRoute!.path!)}>
              {t("assets.detail.openSpecific", { defaultValue: "打开专属详情" })}
            </Button>
          ) : null
        }
      />
      <p>
        {t("assets.detail.assetId", { defaultValue: "资产 id：" })}
        <code>{detail.summary.assetId}</code>
      </p>
      {detail.summary.balance ? (
        <p>
          {t("assets.detail.balance", { defaultValue: "余额：" })}
          {detail.summary.balance.display ?? `${detail.summary.balance.amount} ${detail.summary.balance.unit}`}
        </p>
      ) : null}
      {activities.length === 0 ? (
        <EmptyState title={t("assets.detail.empty.activities", { defaultValue: "暂无活动" })} />
      ) : (
        <DataTable columns={columns} rows={activities} rowKey={(a) => a.id} />
      )}
    </div>
  );
}
