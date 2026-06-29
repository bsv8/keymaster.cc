// packages/plugin-collectibles/src/CollectiblesPage.tsx
// collectible 列表页：聚合所有 CollectibleProvider。
//
// 设计缘由：
//   - 列表默认走 gallery / list 混合布局：缩略图 / collection / name /
//     owner / status；不是复刻统一持仓表（持仓表围绕余额，列表围绕单件
//     对象）。
//   - 单 provider 失败不影响其他 provider：通用列表页必须仍能展示其它
//     provider 的结果。

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { AppLink, useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type {
  CollectibleProvider,
  CollectibleRegistry,
  CollectibleSummary
} from "@keymaster/contracts";

interface ProviderLoadResult {
  provider: CollectibleProvider;
  items: CollectibleSummary[];
  error?: string;
}

export function CollectiblesPage() {
  const registry = useCapability<CollectibleRegistry>("collectible.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const [results, setResults] = useState<ProviderLoadResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const providers = registry.list();
      const loaded = await Promise.all(
        providers.map(async (provider): Promise<ProviderLoadResult> => {
          try {
            const items = await provider.listCollectibles();
            return { provider, items };
          } catch (err) {
            return {
              provider,
              items: [],
              error: err instanceof Error ? err.message : String(err)
            };
          }
        })
      );
      setResults(loaded);
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

  if (!results) {
    return (
      <div className="collectibles-page">
        <PageHeader
          title={t("collectibles.page.title", { defaultValue: "藏品" })}
          description={t("collectibles.page.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="collectibles-page">
        <PageHeader
          title={t("collectibles.page.title", { defaultValue: "藏品" })}
          description={t("collectibles.page.description", { defaultValue: "" })}
        />
        <EmptyState
          title={t("collectibles.page.empty.providers.title", { defaultValue: "暂无 collectible provider" })}
          description={t("collectibles.page.empty.providers.desc", {
            defaultValue: "安装至少一个 collectible provider 后这里会出现选项。"
          })}
        />
      </div>
    );
  }

  const flat: Array<{ p: CollectibleProvider; s: CollectibleSummary }> = [];
  for (const r of results) for (const s of r.items) flat.push({ p: r.provider, s });

  return (
    <div className="collectibles-page">
      <PageHeader
        title={t("collectibles.page.title", { defaultValue: "藏品" })}
        actions={
          <Button onClick={refresh} loading={busy}>
            {t("collectibles.page.refresh", { defaultValue: "刷新" })}
          </Button>
        }
      />
      {results.some((r) => r.error) ? (
        <ul className="collectibles-page__errors">
          {results
            .filter((r) => r.error)
            .map((r) => (
              <li key={r.provider.id}>
                {host.i18n.text(r.provider.name)}
                {t("collectibles.page.error.load", { defaultValue: " 加载失败：" })}
                {r.error}
              </li>
            ))}
        </ul>
      ) : null}
      {flat.length === 0 ? (
        <EmptyState
          title={t("collectibles.page.empty.items.title", { defaultValue: "暂无藏品" })}
          description={t("collectibles.page.empty.items.desc", {
            defaultValue: "导入或解锁钱包后，当前 key 持有的藏品会出现在这里。"
          })}
        />
      ) : (
        <ul className="collectibles-page__grid">
          {flat.map(({ p, s }) => (
            <li key={`${p.id}:${s.collectibleId}`} className="collectibles-page__card">
              <div className="collectibles-page__preview">
                {s.preview?.url ? (
                  s.preview.contentType?.startsWith("image/") ? (
                    <img src={s.preview.url} alt={host.i18n.text(s.name)} loading="lazy" />
                  ) : (
                    <span className="collectibles-page__preview-fallback">
                      {s.preview.text ?? s.preview.contentType ?? t("collectibles.card.previewMissing", { defaultValue: "暂无预览" })}
                    </span>
                  )
                ) : (
                  <span className="collectibles-page__preview-fallback">
                    {s.preview?.text ?? t("collectibles.card.previewMissing", { defaultValue: "暂无预览" })}
                  </span>
                )}
              </div>
              <div className="collectibles-page__meta">
                <strong>{host.i18n.text(s.name)}</strong>
                {s.collection ? <span className="collectibles-page__collection">{s.collection}</span> : null}
                {s.ownerRef ? <span className="collectibles-page__owner">{s.ownerRef}</span> : null}
                <span className="collectibles-page__status">{s.status}</span>
                <AppLink to={`/collectibles/detail?providerId=${encodeURIComponent(p.id)}&collectibleId=${encodeURIComponent(s.collectibleId)}`}>
                  {t("assets.table.open", { defaultValue: "进入" })}
                </AppLink>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}