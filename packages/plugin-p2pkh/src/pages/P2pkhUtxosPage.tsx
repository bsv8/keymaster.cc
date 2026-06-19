// packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx
// P2PKH UTXO 页面（硬切换 001）：展示 WOC UTXO 真值与本地输入占用覆盖层。
// testnet 切换按钮受 `includeTestnet` 控制；WOC 状态列只作为观察信息。
// 直链 URL 上的 `assetId=bsvtest` 在 includeTestnet=false 时被夹回 undefined。

import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { P2pkhAssetId, P2pkhLocalInputClaim, P2pkhService, P2pkhUtxo } from "../p2pkhContracts.js";

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

interface UtxoRow extends P2pkhUtxo {
  inputClaim?: P2pkhLocalInputClaim;
  spendable: boolean;
}

export function P2pkhUtxosPage() {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  useI18n().language();
  const [includeTestnet, setIncludeTestnet] = useState<boolean>(() => service.getGlobalSettings().includeTestnet);
  const [assetId, setAssetId] = useState<P2pkhAssetId | undefined>(
    () => clampAssetIdBySettings(readAssetIdFromLocation(), service.getGlobalSettings().includeTestnet)
  );
  const [utxos, setUtxos] = useState<P2pkhUtxo[]>([]);
  const [inputClaims, setInputClaims] = useState<P2pkhLocalInputClaim[]>([]);

  useEffect(() => {
    service.listUtxos(assetId ? { assetId } : undefined).then(setUtxos);
    service.listLocalInputClaims().then(setInputClaims);
  }, [service, assetId, includeTestnet]);

  // 硬切换 001：订阅 service 的 settings 变化；service 内部已统一处理
  // 同 tab 与跨 tab 通知。
  useEffect(() => {
    const off = service.onGlobalSettingsChange((s) => {
      setIncludeTestnet(s.includeTestnet);
      setAssetId((prev) => clampAssetIdBySettings(prev, s.includeTestnet));
    });
    return off;
  }, [service]);

  const rows: UtxoRow[] = useMemo(() => {
    const byOutpoint = new Map<string, P2pkhLocalInputClaim>();
    for (const r of inputClaims) {
      byOutpoint.set(`${r.txid}:${r.vout}`, r);
    }
    return utxos.map((u) => {
      const r = byOutpoint.get(`${u.txid}:${u.vout}`);
      return {
        ...u,
        inputClaim: r,
        spendable: !r || r.state !== "claimed"
      };
    });
  }, [utxos, inputClaims]);

  const columns: DataTableColumn<UtxoRow>[] = [
    { key: "txid", header: t("p2pkh.col.txidVout", { defaultValue: "txid:vout" }), render: (r) => <code>{r.txid}:{r.vout}</code> },
    { key: "value", header: t("p2pkh.col.value", { defaultValue: "金额" }), render: (r) => formatSats(r.value) },
    { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (r) => r.network },
    { key: "address", header: t("p2pkh.col.address", { defaultValue: "地址" }), render: (r) => <code>{r.address}</code> },
    { key: "status", header: t("p2pkh.col.wocStatus", { defaultValue: "WOC 状态" }), render: (r) => r.status },
    {
      key: "inputClaim",
      header: t("p2pkh.col.inputClaim", { defaultValue: "本地输入占用" }),
      render: (r) =>
        r.inputClaim
          ? `${r.inputClaim.state}${t("p2pkh.col.inputClaim.submission", { defaultValue: " (submission " })}${r.inputClaim.submissionId.slice(0, 8)}${t("p2pkh.col.inputClaim.ellipsis", { defaultValue: "…)" })}`
          : t("p2pkh.col.inputClaim.empty", { defaultValue: "无" })
    },
    {
      key: "spendable",
      header: t("p2pkh.col.spendable", { defaultValue: "可花费" }),
      render: (r) => (r.spendable ? t("p2pkh.col.spendable.yes", { defaultValue: "是" }) : t("p2pkh.col.spendable.no", { defaultValue: "否" }))
    }
  ];

  return (
    <div className="p2pkh-utxos">
      <PageHeader
        title={t("p2pkh.utxos.title", { defaultValue: "P2PKH UTXO" })}
        description={t("p2pkh.utxos.desc", {
          defaultValue: "WOC UTXO 真值快照 + 本地输入占用覆盖层。已占用的 UTXO 不会参与分配。"
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
                service.triggerRecentSync();
              }}
            >
              {t("p2pkh.action.refresh", { defaultValue: "刷新" })}
            </Button>
          </>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title={t("p2pkh.empty.noUtxo", { defaultValue: "暂无 UTXO" })} />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      )}
    </div>
  );
}
