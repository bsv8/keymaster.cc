import { useEffect, useState } from "react";
import type { CapabilityClient } from "webloom-framework";
import { usePluginI18n } from "@keymaster/runtime";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { STORAGE_PRIVATE_S3_CAPABILITY, type ConnectS3Config, type ConnectS3Request, type ConnectS3Response, type ConnectS3Failure } from "../connect-s3/protocol.js";

const blank: ConnectS3Config = { endpoint: "", region: "auto", bucket: "", forcePathStyle: true, accessKeyId: "", secretAccessKey: "" };
export function ConnectS3SettingsPage({ client, epoch }: { client: () => CapabilityClient<typeof STORAGE_PRIVATE_S3_CAPABILITY>; epoch: () => string }) {
  const { t } = usePluginI18n();
  const [config, setConfig] = useState({ ...blank });
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ConnectS3Failure>();
  const [saving, setSaving] = useState(false);
  const call = (request: Omit<Extract<ConnectS3Request, { type: "get" | "clear" | "probe" }>, "expectedSessionEpoch"> | { type: "save"; config: ConnectS3Config }) => client().call({ ...request, expectedSessionEpoch: epoch() }, { timeoutMs: 60_000 });
  const apply = (result: ConnectS3Response) => { setConfigured(result.configured); setConfig({ ...blank, ...result.config }); };
  useEffect(() => {
    let live = true;
    void call({ type: "get" }).then(result => { if (live) apply(result); }).catch(() => { if (live) setMessage(t("storage.s3.failed")); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);
  async function execute(type: "save" | "clear" | "probe") {
    setBusy(true); setSaving(type === "save"); setMessage(""); setFailure(undefined);
    try {
      const result = await call(type === "save" ? { type, config: { ...config } } : { type });
      if (result.failure) {
        setFailure(result.failure);
        setMessage(t(`storage.s3.failed.${result.failure.stage}`));
        return;
      }
      if (type !== "probe") apply(result);
      setMessage(t(type === "probe" ? "storage.s3.probeOk" : type === "clear" ? "storage.s3.cleared" : "storage.s3.saved"));
    } catch { setMessage(t("storage.s3.failed")); }
    finally { setBusy(false); setSaving(false); }
  }
  const field = (name: "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey" | "sessionToken", wide = false) => (
    <TextInput key={name} className={wide ? "km-connect-s3__field is-wide" : "km-connect-s3__field"}
      label={t(`storage.s3.${name}`)} name={name} value={config[name] ?? ""}
      required={name !== "sessionToken"}
      type={name === "accessKeyId" || name === "secretAccessKey" || name === "sessionToken" ? "password" : "text"}
      placeholder={name === "endpoint" ? "https://s3.example.com" : undefined}
      autoComplete="off" spellCheck={false} onChange={event => setConfig(value => ({ ...value, [name]: event.target.value }))} />
  );
  return <div className="km-connect-s3" aria-busy={busy}>
    <PageHeader title={t("storage.s3.pageTitle")} description={t("storage.s3.description")} />
    <div className={`km-connect-s3__status${configured ? " is-configured" : ""}`}>
      <span className="km-connect-s3__status-dot" aria-hidden="true" />
      <p>{t(configured ? "storage.s3.configured" : "storage.s3.missing")}</p>
    </div>
    <form onSubmit={event => { event.preventDefault(); void execute("save"); }}>
      <fieldset className="km-connect-s3__controls" disabled={busy}>
        <section className="km-connect-s3__section" aria-labelledby="s3-location-title">
          <header className="km-connect-s3__section-header">
            <h2 id="s3-location-title">{t("storage.s3.locationTitle")}</h2>
            <p>{t("storage.s3.locationHint")}</p>
          </header>
          <div className="km-connect-s3__grid">
            {field("endpoint", true)}
            {field("region")}
            {field("bucket")}
          </div>
          <label className="km-connect-s3__addressing">
            <input name="forcePathStyle" type="checkbox" checked={config.forcePathStyle} onChange={event => setConfig(value => ({ ...value, forcePathStyle: event.target.checked }))} />
            <span><strong>{t("storage.s3.forcePathStyle")}</strong><span>{t("storage.s3.addressingHint")}</span></span>
          </label>
        </section>
        <section className="km-connect-s3__section" aria-labelledby="s3-auth-title">
          <header className="km-connect-s3__section-header">
            <h2 id="s3-auth-title">{t("storage.s3.authenticationTitle")}</h2>
            <p>{t("storage.s3.credentialsHint")}</p>
          </header>
          <div className="km-connect-s3__grid">
            {field("accessKeyId", true)}
            {field("secretAccessKey", true)}
            {field("sessionToken", true)}
          </div>
        </section>
        <div className="km-connect-s3__actions">
          <div className="km-connect-s3__primary-actions">
            <Button type="submit">{t(saving ? "storage.s3.testing" : "storage.s3.save")}</Button>
            <Button type="button" variant="secondary" disabled={!configured} onClick={() => { void execute("probe"); }}>{t("storage.s3.probe")}</Button>
          </div>
          <Button type="button" variant="ghost" disabled={!configured} onClick={() => { void execute("clear"); }}>{t("storage.s3.clear")}</Button>
        </div>
      </fieldset>
    </form>
    {message && <div className="km-connect-s3__message" role="status">
      <p>{message}</p>
      {failure?.httpStatus && <p>{t("storage.s3.httpStatus", { status: failure.httpStatus })}</p>}
      {failure?.cleanupFailed && <p>{t("storage.s3.cleanupFailed")} <code>{failure.objectKey}</code></p>}
    </div>}
    <details className="km-connect-s3__notes">
      <summary>{t("storage.s3.connectionNotes")}</summary>
      <p>{t("storage.s3.corsHint")}</p>
      <p>{t("storage.s3.dataHint")}</p>
    </details>
  </div>;
}
