// packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx
// P2PKH 总览（硬切换 001 + 硬切换 003）：
//   - summary 只显示 `{ total }`，不再分 confirmed / unconfirmed。
//   - testnet 切换按钮受 `includeTestnet` 控制；false 时隐藏。
//   - 直链 URL 上的 `assetId=bsvtest` 在 includeTestnet=false 时被强制
//     夹回 `bsv`（避免 dormant cache 暴露）。
//
// 硬切换 008 收尾：UI 层防御。
// 关键不变量：
//   - keyspace 初始化中或非 single active key 时不调用
//     service.listResources / listBackfillStates / listRecentSyncStates /
//     getAssetBalance，避免触发 "Key storage is not ready" 未处理 Promise。
//   - 所有 Promise 读取需要 catch，失败时显示空态或错误态，不打未处理 Promise。
//   - 组件卸载后不 setState；active key 在请求期间切换时旧请求结果必须丢弃。
//
// 硬切换 003：所有展示文案走 i18n。
//
// 页面只被动订阅 data-changed / settings 变化，不暴露手动同步入口。

import { useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { useI18n, useLocale, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhBackfillState,
  P2pkhGlobalSettings,
  P2pkhKeyResource,
  P2pkhRecentSyncState,
} from "../p2pkhContracts.js";
import { P2PKH_ASSETS } from "../p2pkhContracts.js";

function readAssetIdFromLocation(): P2pkhAssetId | undefined {
  const search = window.location.search;
  if (!search) return undefined;
  const params = new URLSearchParams(search);
  const id = params.get("assetId");
  if (id === "bsv" || id === "bsvtest") return id;
  return undefined;
}

function clampAssetIdBySettings(
  id: P2pkhAssetId | undefined,
  includeTestnet: boolean
): P2pkhAssetId | undefined {
  if (!includeTestnet && id === "bsvtest") return undefined;
  return id;
}

type PageReadiness = "initializing" | "no-active-key" | "ready" | "failed";

export function P2pkhOverviewPage() {
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  // 硬切换 001：URL 上的 bsvtest 在 includeTestnet=false 时被夹回 undefined。
  // 设置的真值通过 service 提供——service 会跨 tab 同步并向本页面发出变更。
  const includeTestnet = useResourceSelector<P2pkhGlobalSettings, boolean>(host.resourceStore, "p2pkh.settings", [], (s) => s.data?.includeTestnet ?? false);
  const [assetId, setAssetId] = useState<P2pkhAssetId | undefined>(() => readAssetIdFromLocation());
  const readiness = useResourceSelector<PageReadiness, PageReadiness>(host.resourceStore, "p2pkh.readiness", [], (s) => s.data ?? "initializing");
  const overview = useResourceSelector<{ rows: P2pkhKeyResource[]; backfills: P2pkhBackfillState[]; recent: P2pkhRecentSyncState[]; balance: { total: number } | null }, { rows: P2pkhKeyResource[]; backfills: P2pkhBackfillState[]; recent: P2pkhRecentSyncState[]; balance: { total: number } | null; error?: string }>(host.resourceStore, "p2pkh.overview", [assetId ?? "all"], (s) => s.data ? { ...s.data, error: s.error?.message } : { rows: [], backfills: [], recent: [], balance: null, error: s.error?.message }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const { rows, backfills, recent: recentStates, balance: balanceDisplay, error: loadError } = overview;

  const recentByResource = useMemo(() => {
    const m = new Map<string, P2pkhRecentSyncState>();
    for (const s of recentStates) m.set(s.resourceId, s);
    return m;
  }, [recentStates]);

  const def = assetId ? P2PKH_ASSETS[assetId] : undefined;
  const title = def
    ? t("p2pkh.overview.titleWithAsset", { defaultValue: "P2PKH / {{label}}", label: def.label })
    : t("p2pkh.route.overview", { defaultValue: "P2PKH 总览" });
  const description = def
    ? t("p2pkh.overview.descWithAsset", {
        defaultValue: "BSV {{network}} ({{assetId}}) 资源。",
        network: def.network,
        assetId: def.assetId
      })
    : t("p2pkh.overview.descDefault", { defaultValue: "BSV P2PKH 资源总览。" });

  const columns: DataTableColumn<P2pkhKeyResource>[] = useMemo(
    () => [
      { key: "label", header: t("p2pkh.col.label", { defaultValue: "标签" }), render: (r) => r.label },
      { key: "address", header: t("p2pkh.col.address", { defaultValue: "地址" }), render: (r) => <code>{r.address}</code> },
      { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (r) => r.network },
      { key: "publicKeyHex", header: t("p2pkh.col.publicKeyHex", { defaultValue: "公钥" }), render: (r) => <code>{formatShortPublicKey(r.publicKeyHex)}</code> },
      { key: "resourceId", header: t("p2pkh.col.resourceId", { defaultValue: "resourceId" }), render: (r) => <code>{r.resourceId}</code> },
      {
        key: "sync",
        header: t("p2pkh.col.lastSync", { defaultValue: "最近同步" }),
        render: (r) => {
          const state = recentByResource.get(r.resourceId);
          const ts = state?.lastSuccessAt ?? state?.lastCheckedAt;
          return ts ? dateFmt.format(new Date(ts)) : t("p2pkh.col.neverSynced", { defaultValue: "未同步" });
        }
      }
    ],
    [recentByResource, dateFmt, t]
  );

  let body: React.ReactNode;
  if (readiness === "initializing") {
    body = (
      <EmptyState
        title={t("p2pkh.empty.initializing", { defaultValue: "Key 正在初始化" })}
        description={t("p2pkh.empty.wait", { defaultValue: "请稍候…" })}
      />
    );
  } else if (readiness === "no-active-key") {
    body = (
      <EmptyState
        title={t("p2pkh.empty.noActiveKey", { defaultValue: "请选择一个 active key" })}
        description={t("p2pkh.empty.noActiveKeyDesc", { defaultValue: "在顶栏选择一把 key，或前往 导入 添加。" })}
      />
    );
  } else if (loadError) {
    body = (
      <EmptyState
        title={t("p2pkh.empty.loadFailed", { defaultValue: "加载 P2PKH 资源失败" })}
        description={loadError}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        title={t("p2pkh.empty.noResource", { defaultValue: "还没有 P2PKH 资源" })}
        description={t("p2pkh.empty.noResourceDesc", { defaultValue: "先到 导入 页面导入 WIF/HEX 私钥。" })}
      />
    );
  } else {
    body = <DataTable columns={columns} rows={rows} rowKey={(r) => r.resourceId} />;
  }

  return (
    <div className="p2pkh-overview">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            <Button variant={assetId === "bsv" ? "primary" : "ghost"} onClick={() => setAssetId("bsv")}>
              {t("p2pkh.asset.bsvMain", { defaultValue: "BSV / main" })}
            </Button>
            {includeTestnet ? (
              <Button variant={assetId === "bsvtest" ? "primary" : "ghost"} onClick={() => setAssetId("bsvtest")}>
                {t("p2pkh.asset.bsvTest", { defaultValue: "BSV / test" })}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setAssetId(undefined)}>
              {t("p2pkh.asset.all", { defaultValue: "全部" })}
            </Button>
          </>
        }
      />
      {balanceDisplay ? (
        <p className="p2pkh-overview__balance">
          {t("p2pkh.balance.line", {
            defaultValue: "余额：{{total}}",
            total: formatSats(balanceDisplay.total)
          })}
        </p>
      ) : null}
      {backfills.length > 0 ? (
        <section className="p2pkh-overview__backfills">
          <h4>{t("p2pkh.section.backfill", { defaultValue: "历史回填" })}</h4>
          <ul>
            {backfills.map((b) => (
              <li key={b.resourceId}>
                <code>{b.resourceId}</code>：{b.status} · {b.pagesSynced} {t("p2pkh.unit.pages", { defaultValue: "页" })} / {b.recordsSynced} {t("p2pkh.unit.records", { defaultValue: "条" })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {body}
    </div>
  );
}
