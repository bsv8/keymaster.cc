// packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx
// P2PKH 历史页面（硬切换 001）：展示 source/status、backfill 状态、
// pending/unconfirmed/confirmed；testnet 切换按钮受 `includeTestnet` 控制。
// 直链 URL 上的 `assetId=bsvtest` 在 includeTestnet=false 时被夹回 undefined。

import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n, useLocale } from "@keymaster/runtime";
import type { P2pkhAssetId, P2pkhBackfillState, P2pkhHistoryItem, P2pkhService } from "../p2pkhContracts.js";

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

export function P2pkhHistoryPage() {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const [includeTestnet, setIncludeTestnet] = useState<boolean>(() => service.getGlobalSettings().includeTestnet);
  const [assetId, setAssetId] = useState<P2pkhAssetId | undefined>(
    () => clampAssetIdBySettings(readAssetIdFromLocation(), service.getGlobalSettings().includeTestnet)
  );
  const [rows, setRows] = useState<P2pkhHistoryItem[]>([]);
  const [backfills, setBackfills] = useState<P2pkhBackfillState[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    service.listHistory(assetId ? { assetId } : undefined).then(setRows);
    service.listBackfillStates().then(setBackfills);
  }, [service, assetId, version]);

  // 硬切换 001：订阅 service 的 settings 变化；service 内部已统一处理
  // 同 tab 与跨 tab 通知。
  useEffect(() => {
    const off = service.onGlobalSettingsChange((s) => {
      setIncludeTestnet(s.includeTestnet);
      setAssetId((prev) => clampAssetIdBySettings(prev, s.includeTestnet));
      setVersion((v) => v + 1);
    });
    return off;
  }, [service]);

  const columns: DataTableColumn<P2pkhHistoryItem>[] = [
    { key: "txid", header: t("p2pkh.col.txid", { defaultValue: "txid" }), render: (r) => <code>{r.txid}</code> },
    { key: "height", header: t("p2pkh.col.height", { defaultValue: "区块高度" }), render: (r) => r.height ?? "-" },
    { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (r) => r.network },
    { key: "status", header: t("p2pkh.col.status", { defaultValue: "状态" }), render: (r) => r.status },
    { key: "source", header: t("p2pkh.col.source", { defaultValue: "来源" }), render: (r) => r.source },
    { key: "synced", header: t("p2pkh.col.syncedAt", { defaultValue: "同步时间" }), render: (r) => dateFmt.format(new Date(r.syncedAt)) }
  ];

  return (
    <div className="p2pkh-history">
      <PageHeader
        title={t("p2pkh.history.title", { defaultValue: "P2PKH 历史" })}
        description={t("p2pkh.history.desc", {
          defaultValue: "按地址汇总的链上交易记录。syncedAt 表示最近一次观察到该记录的时间，不是交易发生时间。"
        })}
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
            <Button
              onClick={() => {
                service.triggerHistoryBackfill();
                setVersion((v) => v + 1);
              }}
            >
              {t("p2pkh.action.refillBackfill", { defaultValue: "重新回填" })}
            </Button>
          </>
        }
      />
      {backfills.length > 0 ? (
        <section className="p2pkh-history__backfill">
          <h4>{t("p2pkh.history.backfillStatus", { defaultValue: "历史回填状态" })}</h4>
          <ul>
            {backfills.map((b) => (
              <li key={b.resourceId}>
                <code>{b.resourceId}</code>：{b.status}
                {t("p2pkh.history.backfillLine", {
                  defaultValue: " · 已同步 {{pages}} 页 / {{records}} 条",
                  pages: b.pagesSynced,
                  records: b.recordsSynced
                })}
                {b.lastError
                  ? t("p2pkh.history.backfillErr", { defaultValue: " · 错误：{{err}}", err: b.lastError })
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t("p2pkh.empty.noHistory", { defaultValue: "暂无历史" })}
          description={t("p2pkh.empty.noHistoryDesc", { defaultValue: "执行一次同步或等待 history-backfill 完成后这里会显示交易记录。" })}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      )}
    </div>
  );
}
