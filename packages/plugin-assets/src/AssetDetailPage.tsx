// packages/plugin-assets/src/AssetDetailPage.tsx
// 通用持仓详情页：先在 asset.registry 查找，未命中再在 token.registry
// 查找。collectible 由 plugin-collectibles 单独承接，本页面不处理。
//
// 设计缘由：
//   - 统一持仓页（/assets）的 detail 入口是 holding 的通用详情：
//     asset / token provider 各自声明 detailRoute；未声明 detailRoute
//     时链接到本页面提供通用摘要 + 活动列表。
//   - collectible 不进入这里：详情页结构（preview / attributes / media）
//     与 coin / token 完全不同，硬塞会污染通用页面。

import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { router, useCapability, useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type {
  AssetRegistry,
  I18nText,
  TokenRegistry
} from "@keymaster/contracts";

export interface AssetDetailPageProps {
  providerId: string;
  assetId: string;
}

interface HoldingResolution {
  kind: "asset" | "token";
  provider: { id: string; name: I18nText };
  detail: { summary: unknown; activities?: unknown[] };
  detailRoute?: { id?: string; path?: string };
}

export function AssetDetailPage({ providerId, assetId }: AssetDetailPageProps) {
  const assetsRegistry = useCapability<AssetRegistry>("asset.registry");
  const tokensRegistry = useCapability<TokenRegistry>("token.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const [resolved, setResolved] = useState<HoldingResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // asset 先查：保持 asset 组在前的语义与详情页 lookup 顺序一致。
      const assetProvider = assetsRegistry.get(providerId);
      if (assetProvider) {
        try {
          const detail = await assetProvider.getAsset(assetId);
          if (!detail) {
            setError(`Asset "${assetId}" not found in provider "${providerId}"`);
            return;
          }
          if (cancelled) return;
          setResolved({
            kind: "asset",
            provider: { id: assetProvider.id, name: assetProvider.name },
            detail: detail as unknown as HoldingResolution["detail"],
            detailRoute: detail.summary.detailRoute
          });
          return;
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      const tokenProvider = tokensRegistry.get(providerId);
      if (tokenProvider) {
        try {
          const detail = await tokenProvider.getToken(assetId);
          if (!detail) {
            setError(`Token "${assetId}" not found in provider "${providerId}"`);
            return;
          }
          if (cancelled) return;
          setResolved({
            kind: "token",
            provider: { id: tokenProvider.id, name: tokenProvider.name },
            detail: detail as unknown as HoldingResolution["detail"],
            detailRoute: detail.summary.detailRoute
          });
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      setError(`Unknown holding provider "${providerId}"`);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [assetsRegistry, tokensRegistry, providerId, assetId]);

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

  if (!resolved) {
    return (
      <div className="asset-detail">
        <PageHeader
          title={t("assets.detail.title", { defaultValue: "资产详情" })}
          description={t("assets.detail.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  // activities 走同一张表；asset 与 token 字段名一致（id / title / txid /
  // direction / status / occurredAt；token 的 amount 使用 TokenBalance，
  // UI 文本直接走 amount.display ?? `${amount} ${unit}`）。
  const activities = (resolved.detail.activities ?? []) as Array<{
    id: string;
    title: I18nText;
    txid?: string;
    amount?: { amount: number; unit: string; display?: string };
    direction?: string;
    status?: string;
    occurredAt?: string;
  }>;
  const columns: DataTableColumn<(typeof activities)[number]>[] = [
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

  const summaryAny = resolved.detail.summary as { label?: I18nText; kind?: string; status?: string };

  return (
    <div className="asset-detail">
      <PageHeader
        title={summaryAny?.label ? host.i18n.text(summaryAny.label) : t("assets.detail.title", { defaultValue: "资产详情" })}
        description={`${host.i18n.text(resolved.provider.name)} · ${resolved.kind} · ${summaryAny?.status ?? ""}`}
        actions={
          resolved.detailRoute?.path ? (
            <Button onClick={() => router.push(resolved.detailRoute!.path!)}>
              {t("assets.detail.openSpecific", { defaultValue: "打开专属详情" })}
            </Button>
          ) : null
        }
      />
      <p>
        {t("assets.detail.assetId", { defaultValue: "资产 id：" })}
        <code>{assetId}</code>
      </p>
      {activities.length === 0 ? (
        <EmptyState title={t("assets.detail.empty.activities", { defaultValue: "暂无活动" })} />
      ) : (
        <DataTable columns={columns} rows={activities} rowKey={(a) => a.id} />
      )}
    </div>
  );
}