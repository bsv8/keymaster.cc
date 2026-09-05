import { useEffect, useState } from "react";
import { TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import { JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY, type P2pkhCoordinatorControl } from "@keymaster/contracts";
import { DEFAULT_JUNGLEBUS_CONFIG } from "../jungleBusClient.js";

type JungleBusDraft = { mainEndpoint: string; testEndpoint: string; requestsPerSecond: string; timeoutMs: string; maxRetries: string };

function toDraft(value: Record<string, unknown>): JungleBusDraft {
  return {
    mainEndpoint: typeof value.mainEndpoint === "string" ? value.mainEndpoint : typeof value.endpoint === "string" ? value.endpoint : DEFAULT_JUNGLEBUS_CONFIG.mainBaseUrl!,
    testEndpoint: typeof value.testEndpoint === "string" ? value.testEndpoint : DEFAULT_JUNGLEBUS_CONFIG.testBaseUrl!,
    requestsPerSecond: String(typeof value.requestsPerSecond === "number" ? value.requestsPerSecond : DEFAULT_JUNGLEBUS_CONFIG.requestsPerSecond),
    timeoutMs: String(typeof value.timeoutMs === "number" ? value.timeoutMs : DEFAULT_JUNGLEBUS_CONFIG.timeoutMs),
    maxRetries: String(typeof value.maxRetries === "number" ? value.maxRetries : DEFAULT_JUNGLEBUS_CONFIG.maxRetries)
  };
}

export function JungleBusSettingsPage() {
  const coordinator = useCapability<P2pkhCoordinatorControl>(JUNGLEBUS_COORDINATOR_CONTROL_CAPABILITY);
  const { t } = useI18n();
  const [draft, setDraft] = useState<JungleBusDraft>(() => toDraft({}));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void coordinator.p2pkhProviderConfigGet("junglebus").then((result) => {
      if (alive && result.status === "ok") setDraft(toDraft(result.value));
    });
    return () => { alive = false; };
  }, [coordinator]);

  async function save() {
    setError(null);
    const endpoints: URL[] = [];
    for (const value of [draft.mainEndpoint, draft.testEndpoint]) {
      let endpoint: URL;
      try { endpoint = new URL(value.trim()); } catch { setError("JungleBus endpoint is not a valid URL"); return; }
      if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1"))) { setError("JungleBus endpoint must use https"); return; }
      endpoints.push(endpoint);
    }
    const requestsPerSecond = Number(draft.requestsPerSecond);
    const timeoutMs = Number(draft.timeoutMs);
    const maxRetries = Number(draft.maxRetries);
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxRetries) || maxRetries < 0) { setError("Rate, timeout, and retry values are invalid"); return; }
    const result = await coordinator.p2pkhProviderConfigUpdate("junglebus", { mainEndpoint: endpoints[0]!.toString().replace(/\/$/, ""), testEndpoint: endpoints[1]!.toString().replace(/\/$/, ""), requestsPerSecond, timeoutMs, maxRetries });
    if (result.status !== "accepted" && result.status !== "ok") setError("message" in result ? result.message : "Coordinator configuration update failed");
  }

  return <div className="junglebus-settings">
    <TextInput label={t("junglebus.settings.mainEndpoint", { defaultValue: "JungleBus mainnet endpoint" })} value={draft.mainEndpoint} onChange={(event) => setDraft((current) => ({ ...current, mainEndpoint: event.currentTarget.value }))} onBlur={() => void save()} />
    <TextInput label={t("junglebus.settings.testEndpoint", { defaultValue: "JungleBus testnet endpoint" })} value={draft.testEndpoint} onChange={(event) => setDraft((current) => ({ ...current, testEndpoint: event.currentTarget.value }))} onBlur={() => void save()} />
    <TextInput label={t("junglebus.settings.rate", { defaultValue: "Requests per second" })} type="number" value={draft.requestsPerSecond} onChange={(event) => setDraft((current) => ({ ...current, requestsPerSecond: event.currentTarget.value }))} onBlur={() => void save()} />
    <TextInput label={t("junglebus.settings.timeout", { defaultValue: "Request timeout (ms)" })} type="number" value={draft.timeoutMs} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: event.currentTarget.value }))} onBlur={() => void save()} />
    <TextInput label={t("junglebus.settings.retries", { defaultValue: "429 retries" })} type="number" value={draft.maxRetries} onChange={(event) => setDraft((current) => ({ ...current, maxRetries: event.currentTarget.value }))} onBlur={() => void save()} />
    <p>{t("junglebus.settings.note", { defaultValue: "JungleBus is confirmed-sync only. Subscription, WebSocket, and broadcast settings are intentionally unavailable." })}</p>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
