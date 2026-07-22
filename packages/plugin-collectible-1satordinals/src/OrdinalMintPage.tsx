import { useEffect, useState } from "react";
import { Button, PageHeader, Select, TextArea, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { BsvNetwork } from "@keymaster/contracts";
import type { OrdinalEnvelopeEntry } from "./ordinalScript.js";
import type { OrdinalMintPreview, OrdinalMintService } from "./ordinalMintService.js";
import { ORDINAL_MINT_SERVICE_CAPABILITY } from "./ordinalMintService.js";

const NETWORK_OPTIONS: Array<{ label: string; value: BsvNetwork }> = [
  { label: "mainnet", value: "main" },
  { label: "testnet", value: "test" }
];

const CONTENT_TYPE_OPTIONS = [
  { label: "image/png", value: "image/png" },
  { label: "image/jpeg", value: "image/jpeg" },
  { label: "image/webp", value: "image/webp" },
  { label: "image/gif", value: "image/gif" },
  { label: "text/plain", value: "text/plain" },
  { label: "application/json", value: "application/json" }
];

export function OrdinalMintPage() {
  const { t } = useI18n();
  const service = useCapability<OrdinalMintService>(ORDINAL_MINT_SERVICE_CAPABILITY);
  const [network, setNetwork] = useState<BsvNetwork>("main");
  const [contentType, setContentType] = useState("image/png");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [textData, setTextData] = useState("");
  const [changeAddress, setChangeAddress] = useState("");
  const [feeRate, setFeeRate] = useState("1000");
  const [fileName, setFileName] = useState("");
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OrdinalMintPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [network]);

  async function onPickFile(file: File | null) {
    if (!file) {
      setFileName("");
      setFileBytes(null);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFileName(file.name);
    setFileBytes(bytes);
    if (file.type) {
      setContentType(file.type);
    }
  }

  async function prepare() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = fileBytes ?? new TextEncoder().encode(textData);
      const metadata: OrdinalEnvelopeEntry[] = [];
      if (name.trim()) metadata.push({ key: "name", value: name.trim() });
      if (description.trim()) metadata.push({ key: "description", value: description.trim() });
      if (tags.trim()) metadata.push({ key: "tags", value: tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(",") });
      if (fileName.trim()) metadata.push({ key: "filename", value: fileName.trim() });
      const p = await service.prepare({
        network,
        contentType,
        data,
        metadata: metadata.length > 0 ? metadata : undefined,
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
      setResult(r.inscriptionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ordinal-mint-page">
      <PageHeader
        title={t("oneSat.mint.title", { defaultValue: "Create 1Sat Ordinal" })}
        description={t("oneSat.mint.desc", { defaultValue: "Prepare a single-sat ordinal mint transaction." })}
      />
      <div className="ordinal-mint-page__form">
        <Select label={t("oneSat.mint.network", { defaultValue: "Network" })} options={NETWORK_OPTIONS} value={network} onChange={(e) => setNetwork(e.currentTarget.value as BsvNetwork)} />
        <Select label={t("oneSat.mint.contentType", { defaultValue: "Content type" })} options={CONTENT_TYPE_OPTIONS} value={contentType} onChange={(e) => setContentType(e.currentTarget.value)} />
        <TextInput label={t("oneSat.mint.name", { defaultValue: "Name" })} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <TextInput label={t("oneSat.mint.description", { defaultValue: "Description" })} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <TextInput label={t("oneSat.mint.tags", { defaultValue: "Tags" })} value={tags} onChange={(e) => setTags(e.currentTarget.value)} />
        <TextInput label={t("oneSat.mint.feeRate", { defaultValue: "Fee rate" })} value={feeRate} onChange={(e) => setFeeRate(e.currentTarget.value)} />
        <TextInput label={t("oneSat.mint.changeAddress", { defaultValue: "Change address" })} value={changeAddress} onChange={(e) => setChangeAddress(e.currentTarget.value)} />
        <label className="ui-field">
          <span className="ui-field__label">{t("oneSat.mint.file", { defaultValue: "File" })}</span>
          <input type="file" accept={CONTENT_TYPE_OPTIONS.map((opt) => opt.value).join(",")} onChange={(e) => void onPickFile(e.currentTarget.files?.[0] ?? null)} />
        </label>
        <TextArea label={t("oneSat.mint.text", { defaultValue: "Text content" })} value={textData} onChange={(e) => setTextData(e.currentTarget.value)} />
        {error ? <p>{error}</p> : null}
        {preview ? <pre>{preview.spend.rawTxHex.slice(0, 120)}…</pre> : null}
        {result ? <p>{result}</p> : null}
        <div>
          <Button onClick={() => void prepare()} disabled={busy}>{t("oneSat.mint.prepare", { defaultValue: "Preview" })}</Button>
          <Button onClick={() => void submit()} disabled={!preview || busy}>{t("oneSat.mint.submit", { defaultValue: "Submit" })}</Button>
        </div>
      </div>
    </div>
  );
}
