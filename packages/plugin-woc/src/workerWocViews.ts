import type { WocService, WocServiceHandle, WocWorkerBroadcastService } from "@keymaster/contracts";

/** Publish exact Worker query and broadcast views; lifecycle methods stay private. */
export function createWorkerWocViews(service: WocServiceHandle, assertActive: () => void) {
  function bind<K extends keyof WocService>(name: K): WocService[K] {
    const method = service[name];
    return ((...args: unknown[]) => {
      assertActive();
      if (typeof method !== "function") throw new Error(`WOC method is unavailable: ${name}`);
      const result = Reflect.apply(method, service, args);
      if (result && typeof result.then === "function") return Promise.resolve(result).then(value => { assertActive(); return value; });
      assertActive();
      return result;
    }) as WocService[K];
  }
  const subscriptions = new Set<() => void>();
  function subscribe<T>(register: (listener: (event: T) => void) => () => void, listener: (event: T) => void): () => void {
    assertActive();
    const remove = register(event => {
      try { assertActive(); } catch { return; }
      listener(event);
    });
    let closed = false;
    const off = () => { if (closed) return; closed = true; subscriptions.delete(off); remove(); };
    try { assertActive(); } catch (error) { off(); throw error; }
    subscriptions.add(off);
    return off;
  }
  const query: WocService = Object.freeze({
    getConfig: bind("getConfig"),
    updateConfig: bind("updateConfig"),
    onConfigChange: (listener: Parameters<WocService["onConfigChange"]>[0]) => subscribe(service.onConfigChange.bind(service), listener),
    getQueueSnapshot: bind("getQueueSnapshot"),
    onQueueChange: (listener: Parameters<WocService["onQueueChange"]>[0]) => subscribe(service.onQueueChange.bind(service), listener),
    getAddressConfirmedBalance: bind("getAddressConfirmedBalance"),
    getAddressUnconfirmedBalance: bind("getAddressUnconfirmedBalance"),
    getAddressUnspentAll: bind("getAddressUnspentAll"),
    getAddressesConfirmedBalances: bind("getAddressesConfirmedBalances"),
    getAddressesUnconfirmedBalances: bind("getAddressesUnconfirmedBalances"),
    listAddressConfirmedHistory: bind("listAddressConfirmedHistory"),
    listAddressUnconfirmedHistory: bind("listAddressUnconfirmedHistory"),
    listAddressesHistory: bind("listAddressesHistory"),
    getTransactionObservation: bind("getTransactionObservation"),
    getChainHeight: bind("getChainHeight"),
    getSpentOutput: bind("getSpentOutput"),
    getRawTransaction: bind("getRawTransaction"),
  });
  const broadcast: WocWorkerBroadcastService = Object.freeze({
    async broadcast(...args: Parameters<WocWorkerBroadcastService["broadcast"]>) { assertActive(); const result = await service.broadcast(...args); assertActive(); return result; },
  });
  return { query, broadcast, dispose: () => { for (const off of [...subscriptions]) off(); } };
}
