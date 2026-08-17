import type { BsvNetwork } from "@keymaster/contracts";

export interface JungleBusClientConfig {
  /** Legacy alias; when supplied it updates both network endpoints. */
  baseUrl: string;
  mainBaseUrl?: string;
  testBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  requestsPerSecond?: number;
}
export interface JungleBusClient {
  getAddressTransactions(network: BsvNetwork, address: string, signal: AbortSignal): Promise<unknown>;
  getTransaction(network: BsvNetwork, txid: string, signal: AbortSignal): Promise<unknown>;
  getConfig?(): JungleBusClientConfig;
  updateConfig?(config: Partial<JungleBusClientConfig>): void;
}

export const DEFAULT_JUNGLEBUS_CONFIG: JungleBusClientConfig = {
  baseUrl: "https://junglebus.gorillapool.io/v1",
  mainBaseUrl: "https://junglebus.gorillapool.io/v1",
  testBaseUrl: "https://testnet.junglebus.gorillapool.io/v1",
  timeoutMs: 15_000,
  maxRetries: 2,
  requestsPerSecond: 2
};

export function createJungleBusClient(config: Partial<JungleBusClientConfig> = {}, fetchImpl: typeof fetch = fetch): JungleBusClient {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  const initialBase = normalize(config.baseUrl ?? DEFAULT_JUNGLEBUS_CONFIG.baseUrl);
  let resolved = {
    ...DEFAULT_JUNGLEBUS_CONFIG,
    ...config,
    baseUrl: initialBase,
    mainBaseUrl: normalize(config.mainBaseUrl ?? config.baseUrl ?? DEFAULT_JUNGLEBUS_CONFIG.mainBaseUrl!),
    testBaseUrl: normalize(config.testBaseUrl ?? DEFAULT_JUNGLEBUS_CONFIG.testBaseUrl!)
  };
  let nextRequestAt = 0;
  let rateTail = Promise.resolve();
  async function waitForRateLimit(signal: AbortSignal): Promise<void> {
    let release!: () => void;
    const previous = rateTail;
    rateTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const rate = resolved.requestsPerSecond ?? DEFAULT_JUNGLEBUS_CONFIG.requestsPerSecond!;
      const interval = rate > 0 ? 1_000 / rate : 0;
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("Aborted")); };
        timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, waitMs);
        if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      });
      if (signal.aborted) throw signal.reason ?? new Error("Aborted");
      nextRequestAt = Date.now() + interval;
    } finally {
      release();
    }
  }
  async function get(network: BsvNetwork, path: string, signal: AbortSignal): Promise<unknown> {
    let attempt = 0;
    while (true) {
      await waitForRateLimit(signal);
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("JungleBus request timeout")), resolved.timeoutMs);
      try {
        const baseUrl = network === "main" ? resolved.mainBaseUrl : resolved.testBaseUrl;
        const response = await fetchImpl(`${baseUrl ?? resolved.baseUrl}${path}`, { method: "GET", signal: controller.signal });
        if (response.status === 429 && attempt < (resolved.maxRetries ?? 0)) { attempt += 1; await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000))); continue; }
        if (!response.ok) throw new Error(`JungleBus ${response.status} ${response.statusText}`);
        return await response.json();
      } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
    }
  }
  return {
    getConfig: () => ({ ...resolved }),
    updateConfig: (next) => {
      const legacyBase = next.baseUrl ? normalize(next.baseUrl) : undefined;
      resolved = {
        ...resolved,
        ...next,
        baseUrl: legacyBase ?? resolved.baseUrl,
        mainBaseUrl: normalize(next.mainBaseUrl ?? legacyBase ?? resolved.mainBaseUrl ?? resolved.baseUrl),
        testBaseUrl: normalize(next.testBaseUrl ?? legacyBase ?? resolved.testBaseUrl ?? resolved.baseUrl)
      };
    },
    getAddressTransactions: (network, address, signal) => get(network, `/address/get/${encodeURIComponent(address)}`, signal),
    getTransaction: (network, txid, signal) => get(network, `/transaction/get/${encodeURIComponent(txid)}`, signal)
  };
}
