// packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx
// P2PKH UTXO 页面：展示 WOC UTXO 真值与本地 reservation 覆盖层。

import { useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { P2pkhAssetId, P2pkhService, P2pkhUtxo, P2pkhUtxoReservation } from "../p2pkhContracts.js";

function readAssetIdFromLocation(): P2pkhAssetId | undefined {
  const search = window.location.search;
  if (!search) return undefined;
  const params = new URLSearchParams(search);
  const id = params.get("assetId");
  if (id === "bsv" || id === "bsvtest") return id;
  return undefined;
}

interface UtxoRow extends P2pkhUtxo {
  reservation?: P2pkhUtxoReservation;
  spendable: boolean;
}

export function P2pkhUtxosPage() {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  useI18n().language();
  const [assetId, setAssetId] = useState<P2pkhAssetId | undefined>(() => readAssetIdFromLocation());
  const [utxos, setUtxos] = useState<P2pkhUtxo[]>([]);
  const [reservations, setReservations] = useState<P2pkhUtxoReservation[]>([]);

  useEffect(() => {
    service.listUtxos(assetId ? { assetId } : undefined).then(setUtxos);
    service.listReservations().then(setReservations);
  }, [service, assetId]);

  const rows: UtxoRow[] = useMemo(() => {
    const byOutpoint = new Map<string, P2pkhUtxoReservation>();
    for (const r of reservations) {
      byOutpoint.set(`${r.txid}:${r.vout}`, r);
    }
    return utxos.map((u) => {
      const r = byOutpoint.get(`${u.txid}:${u.vout}`);
      return {
        ...u,
        reservation: r,
        spendable: !r || r.state !== "reserved"
      };
    });
  }, [utxos, reservations]);

  const columns: DataTableColumn<UtxoRow>[] = [
    { key: "txid", header: t("p2pkh.col.txidVout", { defaultValue: "txid:vout" }), render: (r) => <code>{r.txid}:{r.vout}</code> },
    { key: "value", header: t("p2pkh.col.value", { defaultValue: "金额" }), render: (r) => formatSats(r.value) },
    { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (r) => r.network },
    { key: "address", header: t("p2pkh.col.address", { defaultValue: "地址" }), render: (r) => <code>{r.address}</code> },
    { key: "status", header: t("p2pkh.col.wocStatus", { defaultValue: "WOC 状态" }), render: (r) => r.status },
    {
      key: "reservation",
      header: t("p2pkh.col.reservation", { defaultValue: "本地 reservation" }),
      render: (r) =>
        r.reservation
          ? `${r.reservation.state}${t("p2pkh.col.reservation.spending", { defaultValue: " (spending " })}${r.reservation.spendingTxid.slice(0, 8)}${t("p2pkh.col.reservation.ellipsis", { defaultValue: "…)" })}`
          : t("p2pkh.col.reservation.empty", { defaultValue: "无" })
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
          defaultValue: "WOC UTXO 真值快照 + 本地 reservation 覆盖层。已 reservation 的 UTXO 不会参与分配。"
        })}
        actions={
          <>
            <Button variant={assetId === "bsv" ? "primary" : "ghost"} onClick={() => setAssetId("bsv")}>
              {t("p2pkh.asset.bsvMain", { defaultValue: "BSV / main" })}
            </Button>
            <Button variant={assetId === "bsvtest" ? "primary" : "ghost"} onClick={() => setAssetId("bsvtest")}>
              {t("p2pkh.asset.bsvTest", { defaultValue: "BSV / test" })}
            </Button>
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
