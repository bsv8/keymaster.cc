import type { bindWalletIdentity, WocService, WocQueryTransport, WocServiceHandle, WocWorkerBroadcastService } from "@keymaster/contracts";

/** A captured wallet owns business queries; transport routing stays private. */
export function createWorkerWocViews(service: WocServiceHandle, wallet: ReturnType<typeof bindWalletIdentity>) {
  const assertActive = () => wallet.assertActive();
  assertActive();
  const network = wallet.identity.bsvNetwork;
  const identity = Object.freeze({ publicKeyHex: wallet.identity.publicKeyHex, bsvNetwork: network });
  const controls = new Set(["getConfig", "updateConfig", "getQueueSnapshot"]);
  function bind<K extends keyof WocQueryTransport>(name: K): WocService[K] {
    const method = service[name];
    return ((...args: unknown[]) => {
      assertActive();
      if (typeof method !== "function") throw new Error(`WOC method is unavailable: ${name}`);
      if (!controls.has(name) && (args[0] === "main" || args[0] === "test")) throw new TypeError("WOC queries do not accept wallet selectors");
      const result = Reflect.apply(method, service, controls.has(name) ? args : [network, ...args]);
      if (result && typeof result.then === "function") return Promise.resolve(result).then(value => { assertActive(); return value; });
      assertActive(); return result;
    }) as WocService[K];
  }
  const subscriptions = new Set<() => void>();
  function subscribe<T>(register: (listener: (event: T) => void) => () => void, listener: (event: T) => void): () => void {
    assertActive();
    const remove = register(event => { try { assertActive(); } catch { return; } listener(event); });
    let closed = false;
    const off = () => { if (closed) return; closed = true; subscriptions.delete(off); remove(); };
    try { assertActive(); } catch (error) { off(); throw error; }
    subscriptions.add(off); return off;
  }
  const query: WocService = Object.freeze({
    identity,
    getConfig: bind("getConfig"), updateConfig: bind("updateConfig"),
    onConfigChange: (listener: Parameters<WocService["onConfigChange"]>[0]) => subscribe(service.onConfigChange.bind(service), listener),
    getQueueSnapshot: bind("getQueueSnapshot"),
    onQueueChange: (listener: Parameters<WocService["onQueueChange"]>[0]) => subscribe(service.onQueueChange.bind(service), listener),
    getAddressConfirmedBalance: bind("getAddressConfirmedBalance"), getAddressUnconfirmedBalance: bind("getAddressUnconfirmedBalance"),
    getAddressUnspentAll: bind("getAddressUnspentAll"), getAddressesConfirmedBalances: bind("getAddressesConfirmedBalances"),
    getAddressesUnconfirmedBalances: bind("getAddressesUnconfirmedBalances"), listAddressConfirmedHistory: bind("listAddressConfirmedHistory"),
    listAddressUnconfirmedHistory: bind("listAddressUnconfirmedHistory"), listAddressesHistory: bind("listAddressesHistory"),
    getTransactionObservation: bind("getTransactionObservation"), getChainHeight: bind("getChainHeight"), getFeeRecommendation: bind("getFeeRecommendation"),
    getSpentOutput: bind("getSpentOutput"), getSpentOutputs: bind("getSpentOutputs"), getRawTransaction: bind("getRawTransaction"),
  });
  const broadcast: WocWorkerBroadcastService = Object.freeze({
    async broadcast(...args: Parameters<WocWorkerBroadcastService["broadcast"]>) {
      assertActive();
      if (args[0] !== network) throw new Error("Broadcast evidence network differs from bound wallet");
      const result = await service.broadcast(...args); assertActive(); return result;
    },
  });
  return { query, broadcast, dispose: () => { for (const off of [...subscriptions]) off(); } };
}
