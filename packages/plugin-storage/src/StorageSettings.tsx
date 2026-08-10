import { useEffect, useState } from "react";
import type { StorageConditionalCapabilityView, StorageProviderConfigDraft, StorageProviderId, StorageProviderSummary, StorageService } from "@keymaster/contracts";
import { useCapability, useI18n, usePluginHost, useResourceSelector, useRuntimeStatus } from "@keymaster/runtime";
import type { StorageResourceSnapshot } from "./storageService.js";

function defaultConnection(provider: StorageProviderId): StorageProviderConfigDraft["connection"] {
  if (provider === "aws-s3") return { region: "us-east-1", bucket: "", prefix: "" };
  if (provider === "cloudflare-r2") return { accountId: "", endpointVariant: "default", bucket: "", prefix: "" };
  return { endpoint: "", region: "us-east-1", bucket: "", prefix: "", forcePathStyle: false };
}

export function StorageSettings() {
  const { t } = useI18n();
  const { vault } = useRuntimeStatus();
  const host = usePluginHost();
  const service = useCapability<StorageService>("storage.service");
  const resource = useResourceSelector<StorageResourceSnapshot, StorageResourceSnapshot>(
    host.resourceStore,
    "storage.status",
    [],
    (snapshot) => snapshot.data ?? { status: service.status(), summary: null, capabilities: service.getConditionalCapabilities() },
    (a, b) => a.status === b.status && JSON.stringify(a.summary) === JSON.stringify(b.summary) && JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities)
  );
  const [providerId, setProviderId] = useState<StorageProviderId>("aws-s3");
  const [connection, setConnection] = useState<StorageProviderConfigDraft["connection"]>(defaultConnection("aws-s3"));
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [summary, setSummary] = useState<StorageProviderSummary | null>(resource.summary);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"probe" | "capability" | "save" | "clear" | null>(null);
  const [corsCopied, setCorsCopied] = useState(false);
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "https://your-keymaster-origin.example";
  const corsTemplate = JSON.stringify({
    CORSRules: [{
      AllowedOrigins: [appOrigin],
      AllowedMethods: ["GET", "PUT", "DELETE", "POST", "HEAD"],
      AllowedHeaders: ["Content-Type", "If-Match", "If-None-Match", "Range", "x-amz-*"],
      ExposeHeaders: ["ETag", "Last-Modified", "Content-Range", "Content-Length", "x-amz-request-id"],
      MaxAgeSeconds: 3600
    }]
  }, null, 2);
  const canResetStorage = Boolean(summary) || resource.status === "degraded" || resource.status === "reconfiguring";

  useEffect(() => {
    let cancelled = false;
    setSummary(resource.summary);
    void service.getProviderConnection().then((view) => {
      if (cancelled || !view) return;
      setProviderId(view.providerId);
      setConnection(view.connection);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [resource.status, resource.summary, service]);

  function updateProvider(next: StorageProviderId) {
    setProviderId(next);
    setConnection(defaultConnection(next));
    setReplaceCredentials(true);
    setAccessKeyId("");
    setSecretAccessKey("");
    setMessage(null);
  }

  function field(name: string): string {
    return String((connection as unknown as Record<string, unknown>)[name] ?? "");
  }
  function setField(name: string, value: string | boolean) {
    setConnection((current) => ({ ...current, [name]: value } as StorageProviderConfigDraft["connection"]));
    setMessage(null);
  }
  function draft(): StorageProviderConfigDraft {
    return { providerId, connection, credentials: replaceCredentials || !summary ? { mode: "replace", accessKeyId, secretAccessKey } : { mode: "retain" } };
  }
  async function probe(save: boolean) {
    setBusy(save ? "save" : "probe"); setMessage(null);
    try {
      const result = save ? await service.activateProvider(draft()) : await service.probeProvider(draft());
      if (!result.ok) throw new Error(result.diagnostic ?? "probe failed");
      setSummary(await service.getProviderSummary());
      setReplaceCredentials(false); setAccessKeyId(""); setSecretAccessKey(""); setMessage(save ? t("storage.settings.saved") : t("storage.settings.probeOk"));
    } catch (error) { setMessage(error instanceof Error ? error.message : t("storage.settings.failed")); }
    finally { setBusy(null); }
  }
  async function detectCapabilities() {
    setBusy("capability"); setMessage(null);
    try {
      const result = await service.probeConditionalCapabilities();
      const inconclusive = result.put === "inconclusive" || result.complete === "inconclusive";
      setMessage(inconclusive ? `${t("storage.settings.capabilityInconclusive")}${result.cleanupWarning ? `; ${t("storage.settings.capabilityCleanupWarning")}` : ""}` : result.cleanupWarning ? t("storage.settings.capabilityCleanupWarning") : t("storage.settings.capabilityDone"));
    } catch (error) { setMessage(error instanceof Error ? error.message : t("storage.settings.failed")); }
    finally { setBusy(null); }
  }
  async function clear() {
    if (!window.confirm(t("storage.settings.clearConfirm"))) return;
    setBusy("clear"); setMessage(null);
    try {
      // Only degraded recovery uses the destructive journal escape hatch.
      // A live reconfiguration must go through the guarded Clear path and fail
      // closed instead of erasing an in-progress password-rotation journal.
      if (resource.status === "degraded") await service.resetStorage();
      else await service.clearProviderConfig();
      setSummary(null); setMessage(t("storage.settings.cleared"));
    }
    catch (error) { setMessage(error instanceof Error ? error.message : t("storage.settings.failed")); }
    finally { setBusy(null); }
  }
  async function copyCorsTemplate() {
    try {
      await navigator.clipboard.writeText(corsTemplate);
      setCorsCopied(true);
      window.setTimeout(() => setCorsCopied(false), 2000);
    } catch {
      setMessage(t("storage.settings.failed"));
    }
  }

  if (vault !== "unlocked") return <p>{t("storage.settings.locked")}</p>;
  const capabilities = resource.capabilities;
  const capabilityDisabled = resource.status !== "ready" || (busy !== null && busy !== "capability");
  const modeLabel = (mode: "unknown" | "native" | "best-effort") => mode === "native" ? t("storage.settings.capabilityNative") : mode === "best-effort" ? t("storage.settings.capabilityBestEffort") : t("storage.settings.capabilityUnknown");
  const capabilityRow = (label: string, value: StorageConditionalCapabilityView | undefined, testId: string) => (
    <div data-testid={testId}><span>{label}: </span><span>{modeLabel(value?.mode ?? "unknown")}</span>{value?.source ? <span> ({value.source === "manual" ? t("storage.settings.capabilityManual") : t("storage.settings.capabilityAutomatic")})</span> : null}{value?.updatedAt ? <time dateTime={new Date(value.updatedAt).toISOString()}> — {new Date(value.updatedAt).toLocaleString()}</time> : null}</div>
  );
  return (
    <div className="storage-settings">
      <label>{t("storage.settings.provider")}
        <select value={providerId} onChange={(event) => updateProvider(event.target.value as StorageProviderId)} disabled={busy !== null}>
          <option value="aws-s3">AWS S3</option><option value="cloudflare-r2">Cloudflare R2</option><option value="s3-compatible">S3-compatible</option>
        </select>
      </label>
      {providerId === "cloudflare-r2" ? <>
        <label>{t("storage.settings.accountId")}<input value={field("accountId")} onChange={(event) => setField("accountId", event.target.value)} disabled={busy !== null} /></label>
        <label>{t("storage.settings.endpointVariant")}<select value={field("endpointVariant")} onChange={(event) => setField("endpointVariant", event.target.value)} disabled={busy !== null}><option value="default">default</option><option value="eu">EU</option><option value="fedramp">FedRAMP</option></select></label>
      </> : null}
      {providerId === "s3-compatible" ? <>
        <label>{t("storage.settings.endpoint")}<input type="url" value={field("endpoint")} onChange={(event) => setField("endpoint", event.target.value)} disabled={busy !== null} /></label>
        <label>{t("storage.settings.forcePathStyle")}<input type="checkbox" checked={Boolean((connection as unknown as Record<string, unknown>).forcePathStyle)} onChange={(event) => setField("forcePathStyle", event.target.checked)} disabled={busy !== null} /></label>
      </> : null}
      <label>{t("storage.settings.bucket")}<input value={field("bucket")} onChange={(event) => setField("bucket", event.target.value)} disabled={busy !== null} /></label>
      <label>{t("storage.settings.region")}<input value={field("region")} onChange={(event) => setField("region", event.target.value)} disabled={busy !== null || providerId === "cloudflare-r2"} /></label>
      <label>{t("storage.settings.prefix")}<input value={field("prefix")} onChange={(event) => setField("prefix", event.target.value)} disabled={busy !== null} /></label>
      <p>{summary ? t("storage.settings.credentialsConfigured") : t("storage.settings.credentialsRequired")}</p>
      {summary ? <label><input type="checkbox" checked={replaceCredentials} onChange={(event) => setReplaceCredentials(event.target.checked)} disabled={busy !== null} />{t("storage.settings.replaceCredentials")}</label> : null}
      {replaceCredentials || !summary ? <>
        <label>{t("storage.settings.accessKeyId")}<input type="password" autoComplete="new-password" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} disabled={busy !== null} /></label>
        <label>{t("storage.settings.secretAccessKey")}<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} disabled={busy !== null} /></label>
      </> : null}
      <p>{t("storage.settings.status")}: {resource.status}</p>
      <p>{t("storage.settings.capabilityWarning")}</p>
      <p>{t("storage.settings.capabilityScope")}</p>
      {capabilityRow(t("storage.settings.capabilityPut"), capabilities?.put, "storage-capability-put")}
      {capabilityRow(t("storage.settings.capabilityComplete"), capabilities?.complete, "storage-capability-complete")}
      <p>{t("storage.settings.cors")}</p>
      <p>{t("storage.settings.probeScope")}</p>
      <pre data-testid="storage-cors-template">{corsTemplate}</pre>
      <button type="button" onClick={() => void copyCorsTemplate()} disabled={busy !== null}>{corsCopied ? t("storage.settings.corsCopied") : t("storage.settings.copyCors")}</button>
      {message ? <p role="status">{message}</p> : null}
      <div><button type="button" onClick={() => busy === "probe" ? service.cancelProbe() : void probe(false)} disabled={busy !== null && busy !== "probe"}>{busy === "probe" ? t("storage.settings.cancel") : t("storage.settings.test")}</button><button type="button" onClick={() => busy === "capability" ? service.cancelProbe() : void detectCapabilities()} disabled={capabilityDisabled}>{busy === "capability" ? t("storage.settings.cancel") : t("storage.settings.capability")}</button><button type="button" onClick={() => void probe(true)} disabled={busy !== null}>{t("storage.settings.save")}</button>{canResetStorage ? <button type="button" onClick={() => void clear()} disabled={busy !== null}>{t("storage.settings.clear")}</button> : null}</div>
    </div>
  );
}
