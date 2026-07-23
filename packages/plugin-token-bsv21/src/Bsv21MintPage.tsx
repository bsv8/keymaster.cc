import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, Select, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { BsvNetwork } from "@keymaster/contracts";
import type { Bsv21MintPreview, Bsv21MintService } from "./bsv21MintService.js";
import { BSV21_MINT_SERVICE_CAPABILITY } from "./bsv21MintService.js";

const NETWORK_OPTIONS: Array<{ label: string; value: BsvNetwork }> = [
  { label: "mainnet", value: "main" },
  { label: "testnet", value: "test" }
];

function statusLabel(status: string, t: (key: string, values?: { defaultValue?: string }) => string): string {
  switch (status) {
    case "prepared":
      return t("bsv21.mint.status.prepared", { defaultValue: "已准备" });
    case "broadcast-pending-woc":
      return t("bsv21.mint.status.broadcastPendingWoc", { defaultValue: "广播成功，等待 WOC" });
    case "woc-observed-unconfirmed":
      return t("bsv21.mint.status.observedUnconfirmed", { defaultValue: "WOC 已观察（未确认）" });
    case "woc-confirmed":
      return t("bsv21.mint.status.confirmed", { defaultValue: "WOC 已确认" });
    case "woc-dropped":
      return t("bsv21.mint.status.dropped", { defaultValue: "WOC 已放弃" });
    case "provider-inconsistent":
      return t("bsv21.mint.status.providerInconsistent", { defaultValue: "提供方不一致" });
    case "rejected":
      return t("bsv21.mint.status.rejected", { defaultValue: "已拒绝" });
    case "unknown":
      return t("bsv21.mint.status.unknown", { defaultValue: "未知" });
    default:
      return status;
  }
}

export function Bsv21MintPage() {
  const { t } = useI18n();
  const service = useCapability<Bsv21MintService>(BSV21_MINT_SERVICE_CAPABILITY);
  const [network, setNetwork] = useState<BsvNetwork>("main");
  const [amount, setAmount] = useState("1");
  const [sym, setSym] = useState("TOK");
  const [dec, setDec] = useState("0");
  const [feeRate, setFeeRate] = useState("1000");
  const [changeAddress, setChangeAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Bsv21MintPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<Bsv21MintService["listHistory"]>>>([]);

  useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [network]);

  useEffect(() => {
    void (async () => {
      try {
        setHistory(await service.listHistory());
      } catch {
        setHistory([]);
      }
    })();
  }, [service]);

  async function prepare() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = await service.prepare({
        network,
        amount,
        sym: sym.trim() || undefined,
        dec: dec.trim() === "" ? undefined : Number(dec),
        feeRateSatoshisPerKb: Number(feeRate) || 1000,
        changeAddress: changeAddress.trim() || undefined
      });
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await service.submit(preview);
      setResult(r.tokenId);
      setHistory(await service.listHistory());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bsv21-mint-page">
      <PageHeader
        title={t("bsv21.mint.title", { defaultValue: "Create BSV-21 token" })}
        description={t("bsv21.mint.desc", { defaultValue: "Prepare a BSV-21 deploy+mint transaction." })}
      />
      <div className="bsv21-mint-page__form">
        <Select label={t("bsv21.mint.network", { defaultValue: "Network" })} options={NETWORK_OPTIONS} value={network} onChange={(e) => setNetwork(e.currentTarget.value as BsvNetwork)} />
        <TextInput label={t("bsv21.mint.amount", { defaultValue: "Amount" })} value={amount} onChange={(e) => setAmount(e.currentTarget.value)} />
        <TextInput label={t("bsv21.mint.symbol", { defaultValue: "Symbol" })} value={sym} onChange={(e) => setSym(e.currentTarget.value)} />
        <TextInput label={t("bsv21.mint.decimals", { defaultValue: "Decimals" })} value={dec} onChange={(e) => setDec(e.currentTarget.value)} />
        <TextInput label={t("bsv21.mint.feeRate", { defaultValue: "Fee rate" })} value={feeRate} onChange={(e) => setFeeRate(e.currentTarget.value)} />
        <TextInput label={t("bsv21.mint.changeAddress", { defaultValue: "Change address" })} value={changeAddress} onChange={(e) => setChangeAddress(e.currentTarget.value)} />
        {error ? <p>{error}</p> : null}
        {preview ? <pre>{preview.spend.rawTxHex.slice(0, 120)}…</pre> : null}
        {result ? <p>{result}</p> : null}
        {result === null ? null : <EmptyState title={t("bsv21.mint.completed", { defaultValue: "Token created" })} description={result} />}
        {history.length > 0 ? (
          <section className="bsv21-mint-page__history">
            <h3>{t("bsv21.mint.history", { defaultValue: "Recent history" })}</h3>
            <ul>
              {history.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <strong>{statusLabel(item.status, t)}</strong>
                  <span>{item.preview.tokenId}</span>
                  {item.submit?.spend.canonicalTxid ? <code>{item.submit.spend.canonicalTxid}</code> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div>
          <Button onClick={() => void prepare()} disabled={busy}>{t("bsv21.mint.prepare", { defaultValue: "Preview" })}</Button>
          <Button onClick={() => void submit()} disabled={!preview || busy}>{t("bsv21.mint.submit", { defaultValue: "Submit" })}</Button>
        </div>
      </div>
    </div>
  );
}
