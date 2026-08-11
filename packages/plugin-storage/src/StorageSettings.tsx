import { useCallback, useEffect, useRef, useState } from "react";
import type { StorageConditionalCapabilityView, StorageProviderConfigDraft, StorageProviderId, StorageProviderSummary, StorageService } from "@keymaster/contracts";
import { useCapability, useI18n, usePluginHost, useResourceSelector, useRuntimeStatus } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import type { StorageResourceSnapshot } from "./storageService.js";

function defaultConnection(provider: StorageProviderId): StorageProviderConfigDraft["connection"] {
  if (provider === "aws-s3") return { region: "us-east-1", bucket: "" };
  if (provider === "cloudflare-r2") return { accountId: "", endpointVariant: "default", bucket: "" };
  return { endpoint: "", region: "us-east-1", bucket: "", forcePathStyle: false };
}

function providerName(provider: StorageProviderId): string {
  if (provider === "cloudflare-r2") return "Cloudflare R2";
  if (provider === "s3-compatible") return "S3-compatible";
  return "AWS S3";
}

type ActivationRequest = {
  revision: number;
  config: StorageProviderConfigDraft;
};

function connectionSignature(providerId: StorageProviderId, connection: StorageProviderConfigDraft["connection"], credentialMode: "retain" | "replace"): string {
  return `${providerId}:${JSON.stringify(connection)}:${credentialMode}`;
}

function isConnectionComplete(providerId: StorageProviderId, connection: StorageProviderConfigDraft["connection"]): boolean {
  const value = connection as unknown as Record<string, unknown>;
  const bucket = typeof value.bucket === "string" ? value.bucket : "";
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61})[a-z0-9]$/u.test(bucket)) return false;
  if (providerId === "cloudflare-r2") return typeof value.accountId === "string" && /^[a-f0-9]{32}$/iu.test(value.accountId) && ["default", "eu", "fedramp"].includes(String(value.endpointVariant));
  if (providerId === "aws-s3") return typeof value.region === "string" && value.region.trim().length > 0;
  if (typeof value.endpoint !== "string" || typeof value.region !== "string" || !value.region.trim()) return false;
  try { return new URL(value.endpoint).protocol === "https:"; } catch { return false; }
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
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState<"probe" | "capability" | "activate" | "clear" | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
  const [corsCopied, setCorsCopied] = useState(false);
  const mountedRef = useRef(true);
  const editRevisionRef = useRef(0);
  const lastAppliedSignatureRef = useRef<string | null>(null);
  const pendingActivationRef = useRef<ActivationRequest | null>(null);
  const activationRunningRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "https://your-keymaster-origin.example";
  const corsRule = {
    AllowedOrigins: [appOrigin],
    AllowedMethods: ["GET", "PUT", "DELETE", "POST", "HEAD"],
    // SigV4 browser requests include Authorization plus SDK and x-amz headers.
    AllowedHeaders: ["Authorization", "Content-Type", "If-Match", "If-None-Match", "Range", "amz-sdk-*", "x-amz-*"],
    ExposeHeaders: ["ETag", "Last-Modified", "Content-Range", "Content-Length", "x-amz-request-id"],
    MaxAgeSeconds: 3600
  };
  // Cloudflare's dashboard accepts a bare rule array. AWS and most S3 admin
  // APIs use the PutBucketCors request shape with a CORSRules property.
  const corsTemplate = JSON.stringify(providerId === "cloudflare-r2" ? [corsRule] : { CORSRules: [corsRule] }, null, 2);
  const canResetStorage = Boolean(summary) || resource.status === "degraded" || resource.status === "reconfiguring";
  const knownUnconfigured = !resource.summary && resource.status === "unconfigured";

  useEffect(() => {
    // React Strict Mode intentionally runs setup → cleanup → setup again in
    // development. Restore the live flag in setup so the simulated cleanup
    // cannot permanently suppress auto-save status updates.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingActivationRef.current = null;
      if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  useEffect(() => { setSummary(resource.summary); }, [resource.summary]);

  // The first Storage snapshot may still say "locked" while the unlocked
  // Coordinator snapshot is arriving. Once it becomes definitively
  // unconfigured, release first-time editing even if the earlier connection
  // read is still pending.
  useEffect(() => {
    if (!knownUnconfigured) return;
    lastAppliedSignatureRef.current = null;
    setHydrated(true);
  }, [knownUnconfigured]);

  useEffect(() => {
    // There is nothing to hydrate for a provider that is known to be
    // unconfigured. Do not make first-time auto-save wait on a Coordinator
    // round trip that may itself be recovering or reconnecting.
    if (knownUnconfigured) {
      lastAppliedSignatureRef.current = null;
      setHydrated(true);
      return;
    }
    let cancelled = false;
    const revisionAtStart = editRevisionRef.current;
    void service.getProviderConnection().then((view) => {
      if (cancelled) return;
      if (view) {
        // Never replace fields the user edited while the Coordinator request
        // was in flight. The stored signature is still useful for dirty-state
        // comparison once the response arrives.
        if (editRevisionRef.current === revisionAtStart) {
          setProviderId(view.providerId);
          setConnection(view.connection);
        }
        lastAppliedSignatureRef.current = connectionSignature(view.providerId, view.connection, "retain");
      } else {
        lastAppliedSignatureRef.current = null;
      }
      setHydrated(true);
    }).catch(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [resource.summary?.generation, service]);

  function markEdited() {
    const revision = editRevisionRef.current + 1;
    editRevisionRef.current = revision;
    setEditRevision(revision);
    setAutoSaveState("waiting");
    setMessage(null);
  }

  function updateProvider(next: StorageProviderId) {
    setProviderId(next);
    setConnection(defaultConnection(next));
    setReplaceCredentials(true);
    setAccessKeyId("");
    setSecretAccessKey("");
    markEdited();
  }

  function field(name: string): string {
    return String((connection as unknown as Record<string, unknown>)[name] ?? "");
  }
  function setField(name: string, value: string | boolean) {
    setConnection((current) => ({ ...current, [name]: value } as StorageProviderConfigDraft["connection"]));
    markEdited();
  }
  function updateCredentialReplacement(checked: boolean) {
    setReplaceCredentials(checked);
    if (!checked) { setAccessKeyId(""); setSecretAccessKey(""); }
    markEdited();
  }
  function updateAccessKeyId(value: string) { setAccessKeyId(value); markEdited(); }
  function updateSecretAccessKey(value: string) { setSecretAccessKey(value); markEdited(); }
  function draft(): StorageProviderConfigDraft {
    return { providerId, connection, credentials: replaceCredentials || !summary ? { mode: "replace", accessKeyId, secretAccessKey } : { mode: "retain" } };
  }
  function isDraftComplete(config = draft()): boolean {
    return isConnectionComplete(config.providerId, config.connection)
      && (config.credentials.mode === "retain" || (config.credentials.accessKeyId.trim().length > 0 && config.credentials.secretAccessKey.trim().length > 0));
  }
  const showError = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : t("storage.settings.failed");
    const normalized = text.trim().toLowerCase();
    const isBrowserNetworkFailure = normalized === "network" || normalized === "cors" || /network.*request failed|cors request failed|failed to fetch/iu.test(text);
    const translated = isBrowserNetworkFailure
      ? t("storage.settings.networkOrCors", { origin: appOrigin })
      : normalized === "authentication"
        ? t("storage.settings.authenticationFailed")
        : normalized === "forbidden"
          ? t("storage.settings.forbidden")
          : text;
    setMessage(translated);
    setMessageTone("error");
  }, [appOrigin, t]);

  const drainActivationQueue = useCallback(async () => {
    if (activationRunningRef.current) return;
    activationRunningRef.current = true;
    if (mountedRef.current) { setBusy("activate"); setAutoSaveState("saving"); }
    try {
      while (pendingActivationRef.current) {
        const request = pendingActivationRef.current;
        pendingActivationRef.current = null;
        try {
          const result = await service.activateProvider(request.config);
          if (!result.ok) throw new Error(result.diagnostic ?? "activation failed");
          const nextSummary = await service.getProviderSummary();
          if (!mountedRef.current) continue;
          // A newer edit supersedes this result. Keep its credentials and let
          // the loop activate only the latest coalesced draft.
          if (pendingActivationRef.current || editRevisionRef.current !== request.revision) continue;
          setSummary(nextSummary);
          lastAppliedSignatureRef.current = connectionSignature(request.config.providerId, request.config.connection, "retain");
          setReplaceCredentials(false);
          setAccessKeyId("");
          setSecretAccessKey("");
          setMessage(null);
          setAutoSaveState("saved");
        } catch (error) {
          if (!mountedRef.current) continue;
          if (pendingActivationRef.current || editRevisionRef.current !== request.revision) continue;
          setAutoSaveState("error");
          showError(error);
        }
      }
    } finally {
      activationRunningRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [service, showError]);

  const enqueueActivation = useCallback((request: ActivationRequest) => {
    // Last-write-wins: one in-flight request plus at most one latest draft.
    pendingActivationRef.current = request;
    void drainActivationQueue();
  }, [drainActivationQueue]);
  const enqueueActivationRef = useRef(enqueueActivation);
  enqueueActivationRef.current = enqueueActivation;

  useEffect(() => {
    if (!hydrated || editRevision === 0) return;
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    const config = draft();
    if (!isDraftComplete(config)) {
      setAutoSaveState("waiting");
      autoSaveTimerRef.current = null;
      return;
    }
    const signature = connectionSignature(config.providerId, config.connection, config.credentials.mode);
    if (config.credentials.mode === "retain" && signature === lastAppliedSignatureRef.current) {
      setAutoSaveState("saved");
      return;
    }
    setAutoSaveState("waiting");
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      enqueueActivationRef.current({ revision: editRevision, config });
    }, 700);
    return () => {
      if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    };
    // Every user mutation increments editRevision, so the captured draft is
    // always the matching render without coupling the timer to status renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRevision, hydrated]);

  async function testConnection() {
    if (autoSaveTimerRef.current !== null) { window.clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    const config = draft();
    if (!isDraftComplete(config)) {
      setAutoSaveState("waiting");
      setMessage(t("storage.settings.autoSaveIncomplete"));
      setMessageTone("error");
      return;
    }
    const signature = connectionSignature(config.providerId, config.connection, config.credentials.mode);
    if (resource.status !== "ready" || config.credentials.mode === "replace" || signature !== lastAppliedSignatureRef.current) {
      enqueueActivation({ revision: editRevisionRef.current, config });
      return;
    }
    setBusy("probe"); setMessage(null);
    try {
      const result = await service.probeProvider(config);
      if (!result.ok) throw new Error(result.diagnostic ?? "probe failed");
      setMessage(t("storage.settings.probeOk")); setMessageTone("success");
    } catch (error) { showError(error); }
    finally { setBusy(null); }
  }
  async function detectCapabilities() {
    setBusy("capability"); setMessage(null);
    try {
      const result = await service.probeConditionalCapabilities();
      const inconclusive = result.put === "inconclusive" || result.complete === "inconclusive";
      setMessage(inconclusive ? `${t("storage.settings.capabilityInconclusive")}${result.cleanupWarning ? `; ${t("storage.settings.capabilityCleanupWarning")}` : ""}` : result.cleanupWarning ? t("storage.settings.capabilityCleanupWarning") : t("storage.settings.capabilityDone"));
      setMessageTone(inconclusive || result.cleanupWarning ? "error" : "success");
    } catch (error) { showError(error); }
    finally { setBusy(null); }
  }
  async function clear() {
    if (!window.confirm(t("storage.settings.clearConfirm"))) return;
    if (autoSaveTimerRef.current !== null) { window.clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    pendingActivationRef.current = null;
    setBusy("clear"); setMessage(null);
    try {
      // Only degraded recovery uses the destructive journal escape hatch.
      // A live reconfiguration must go through the guarded Clear path and fail
      // closed instead of erasing an in-progress password-rotation journal.
      if (resource.status === "degraded") await service.resetStorage();
      else await service.clearProviderConfig();
      setSummary(null); lastAppliedSignatureRef.current = null; setAutoSaveState("idle"); setMessage(t("storage.settings.cleared")); setMessageTone("success");
    }
    catch (error) { showError(error); }
    finally { setBusy(null); }
  }
  async function copyCorsTemplate() {
    try {
      await navigator.clipboard.writeText(corsTemplate);
      setCorsCopied(true);
      window.setTimeout(() => setCorsCopied(false), 2000);
    } catch {
      setMessage(t("storage.settings.failed"));
      setMessageTone("error");
    }
  }

  if (vault !== "unlocked") return <p>{t("storage.settings.locked")}</p>;
  const capabilities = resource.capabilities;
  const editingDisabled = busy !== null && busy !== "activate";
  const draftComplete = isDraftComplete();
  const hasUnsavedDraft = autoSaveState === "waiting" || autoSaveState === "saving" || autoSaveState === "error";
  const capabilityDisabled = resource.status !== "ready" || hasUnsavedDraft || (busy !== null && busy !== "capability");
  const testDisabled = busy === "probe" ? false : !hydrated || !draftComplete || busy !== null;
  const autoSaveTone = autoSaveState === "waiting" && !draftComplete ? "incomplete" : autoSaveState;
  const autoSaveLabel = autoSaveState === "saving"
    ? t("storage.settings.autoSaveSaving")
    : autoSaveState === "saved"
      ? t("storage.settings.autoSaveSaved")
      : autoSaveState === "error"
        ? t("storage.settings.autoSaveError")
        : autoSaveState === "waiting"
          ? (draftComplete ? t("storage.settings.autoSaveWaiting") : t("storage.settings.autoSaveIncomplete"))
          : t("storage.settings.autoSaveIdle");
  const modeLabel = (mode: "unknown" | "native" | "best-effort") => mode === "native" ? t("storage.settings.capabilityNative") : mode === "best-effort" ? t("storage.settings.capabilityBestEffort") : t("storage.settings.capabilityUnknown");
  const statusLabel = resource.status === "ready" ? t("storage.settings.statusReady") : resource.status === "unconfigured" ? t("storage.settings.statusUnconfigured") : resource.status === "degraded" ? t("storage.settings.statusDegraded") : resource.status === "reconfiguring" ? t("storage.settings.statusReconfiguring") : resource.status;
  const capabilityRow = (label: string, value: StorageConditionalCapabilityView | undefined, testId: string) => (
    <div className="storage-settings__capability" data-testid={testId}>
      <span>{label}</span>
      <strong className={`storage-settings__capability-value is-${value?.mode ?? "unknown"}`}>{modeLabel(value?.mode ?? "unknown")}</strong>
      {value?.source ? <small>{value.source === "manual" ? t("storage.settings.capabilityManual") : t("storage.settings.capabilityAutomatic")}</small> : null}
      {value?.updatedAt ? <time dateTime={new Date(value.updatedAt).toISOString()}>{new Date(value.updatedAt).toLocaleString()}</time> : null}
    </div>
  );
  const endpointPreview = providerId === "cloudflare-r2" && field("accountId")
    ? `https://${field("accountId")}${field("endpointVariant") === "default" ? "" : `.${field("endpointVariant")}`}.r2.cloudflarestorage.com`
    : null;

  return (
    <div className="storage-settings">
      <div className="storage-settings__masthead">
        <div className="storage-settings__identity" aria-hidden="true">S3</div>
        <div className="storage-settings__masthead-copy">
          <span>{t("storage.settings.backend")}</span>
          <strong>{providerName(providerId)}</strong>
          <small>{summary ? summary.bucketHint : t("storage.settings.notActivated")}</small>
        </div>
        <div className={`storage-settings__status is-${resource.status}`}>
          <span aria-hidden="true" />
          {statusLabel}
        </div>
      </div>

      <section className="storage-settings__section">
        <header className="storage-settings__section-header">
          <span>01</span>
          <div><h3>{t("storage.settings.providerTitle")}</h3><p>{t("storage.settings.providerDescription")}</p></div>
        </header>
        <div className="storage-settings__fields storage-settings__provider-picker">
          <label className="storage-settings__field storage-settings__field--full">{t("storage.settings.provider")}
            <select value={providerId} onChange={(event) => updateProvider(event.target.value as StorageProviderId)} disabled={editingDisabled}>
              <option value="aws-s3">AWS S3</option><option value="cloudflare-r2">Cloudflare R2</option><option value="s3-compatible">S3-compatible</option>
            </select>
          </label>
        </div>
      </section>

      <section className="storage-settings__section">
        <header className="storage-settings__section-header">
          <span>02</span>
          <div><h3>{t("storage.settings.parametersTitle")}</h3><p>{t("storage.settings.parametersDescription")}</p></div>
        </header>
        <div className="storage-settings__fields" key={providerId}>
          {providerId === "cloudflare-r2" ? <>
            <label className="storage-settings__field storage-settings__field--wide">{t("storage.settings.accountId")}<input value={field("accountId")} onChange={(event) => setField("accountId", event.target.value)} disabled={editingDisabled} placeholder="32-character account ID" /></label>
            <label className="storage-settings__field">{t("storage.settings.endpointVariant")}<select value={field("endpointVariant")} onChange={(event) => setField("endpointVariant", event.target.value)} disabled={editingDisabled}><option value="default">Default</option><option value="eu">EU</option><option value="fedramp">FedRAMP</option></select></label>
          </> : null}
          {providerId === "s3-compatible" ? <>
            <label className="storage-settings__field storage-settings__field--wide">{t("storage.settings.endpoint")}<input type="url" value={field("endpoint")} onChange={(event) => setField("endpoint", event.target.value)} disabled={editingDisabled} placeholder="https://s3.example.com" /></label>
            <label className="storage-settings__check"><input type="checkbox" checked={Boolean((connection as unknown as Record<string, unknown>).forcePathStyle)} onChange={(event) => setField("forcePathStyle", event.target.checked)} disabled={editingDisabled} /><span>{t("storage.settings.forcePathStyle")}</span></label>
          </> : null}
          <label className="storage-settings__field">{t("storage.settings.bucket")}<input value={field("bucket")} onChange={(event) => setField("bucket", event.target.value)} disabled={editingDisabled} /></label>
          {providerId !== "cloudflare-r2" ? <label className="storage-settings__field">{t("storage.settings.region")}<input value={field("region")} onChange={(event) => setField("region", event.target.value)} disabled={editingDisabled} /></label> : null}
          {endpointPreview ? <p className="storage-settings__endpoint storage-settings__field--full"><span>{t("storage.settings.endpointPreview")}</span><code>{endpointPreview}</code></p> : null}
        </div>
        <div className="storage-settings__inline-header">
          <div><h4>{t("storage.settings.credentialsTitle")}</h4><p>{summary ? t("storage.settings.credentialsConfigured") : t("storage.settings.credentialsRequired")}</p></div>
          {summary ? <label className="storage-settings__replace"><input type="checkbox" checked={replaceCredentials} onChange={(event) => updateCredentialReplacement(event.target.checked)} disabled={editingDisabled} /><span>{t("storage.settings.replaceCredentials")}</span></label> : null}
        </div>
        {replaceCredentials || !summary ? <div className="storage-settings__fields storage-settings__fields--credentials">
          <label className="storage-settings__field">{t("storage.settings.accessKeyId")}<input type="password" autoComplete="new-password" value={accessKeyId} onChange={(event) => updateAccessKeyId(event.target.value)} disabled={editingDisabled} /></label>
          <label className="storage-settings__field">{t("storage.settings.secretAccessKey")}<input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => updateSecretAccessKey(event.target.value)} disabled={editingDisabled} /></label>
        </div> : <div className="storage-settings__secret-sealed"><span aria-hidden="true">••••••••</span><p>{t("storage.settings.credentialsSealed")}</p></div>}
      </section>

      <section className="storage-settings__section">
        <header className="storage-settings__section-header">
          <span>CORS</span>
          <div><h3>{t("storage.settings.browserAccessTitle")}</h3><p>{providerId === "cloudflare-r2" ? t("storage.settings.r2Cors") : t("storage.settings.cors")}</p></div>
        </header>
        <div className="storage-settings__cors-note">
          <span>{appOrigin}</span>
          <p>{t("storage.settings.corsOriginExact")}</p>
        </div>
        <details className="storage-settings__cors">
          <summary>{t("storage.settings.showCors")}</summary>
          <div className="storage-settings__code-wrap">
            <pre data-testid="storage-cors-template">{corsTemplate}</pre>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copyCorsTemplate()} disabled={busy !== null}>{corsCopied ? t("storage.settings.corsCopied") : t("storage.settings.copyCors")}</Button>
          </div>
          {providerId === "cloudflare-r2" ? <a href="https://developers.cloudflare.com/r2/buckets/cors/" target="_blank" rel="noreferrer">{t("storage.settings.r2CorsDocs")} ↗</a> : null}
        </details>
      </section>

      <section className="storage-settings__section storage-settings__section--verify">
        <header className="storage-settings__section-header">
          <span>TEST</span>
          <div><h3>{t("storage.settings.verificationTitle")}</h3><p>{t("storage.settings.probeScope")}</p></div>
        </header>
        <div className="storage-settings__capabilities">
          {capabilityRow(t("storage.settings.capabilityPut"), capabilities?.put, "storage-capability-put")}
          {capabilityRow(t("storage.settings.capabilityComplete"), capabilities?.complete, "storage-capability-complete")}
        </div>
        <p className="storage-settings__capability-scope">{t("storage.settings.capabilityScope")}</p>
        {resource.status !== "ready" ? <p className="storage-settings__disabled-reason">{t("storage.settings.capabilityRequiresReady")}</p> : <p className="storage-settings__warning">{t("storage.settings.capabilityWarning")}</p>}
      </section>

      {message ? <p className={`storage-settings__message is-${messageTone}`} role="status">{message}</p> : null}

      <div className="storage-settings__actions">
        <div>
          <Button type="button" variant="secondary" onClick={() => busy === "probe" ? service.cancelProbe() : void testConnection()} disabled={testDisabled}>{busy === "probe" ? t("storage.settings.cancel") : t("storage.settings.test")}</Button>
          <Button type="button" variant="secondary" onClick={() => busy === "capability" ? service.cancelProbe() : void detectCapabilities()} disabled={capabilityDisabled}>{busy === "capability" ? t("storage.settings.cancel") : t("storage.settings.capability")}</Button>
        </div>
        <div className="storage-settings__action-status">
          <p className={`storage-settings__autosave is-${autoSaveTone}`} aria-live="polite"><span aria-hidden="true" />{autoSaveLabel}</p>
          {canResetStorage ? <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy !== null}>{t("storage.settings.clear")}</Button> : null}
        </div>
      </div>
    </div>
  );
}
