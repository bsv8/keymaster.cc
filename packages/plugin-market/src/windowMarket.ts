import { traceDev, type PluginContext } from "@keymaster/contracts";
import { MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS, type MarketWorkerSnapshot, type MarketWorkerCommand } from "./marketWorkerContract.js";
/** Market 设置页的 Window 客户端：订阅 Worker 状态，提交市场配置与手工来源命令。 */
export function createWindowMarket(ctx: PluginContext) {
  function waitForEndpoints() {
    return new Promise<{ rpc: ReturnType<typeof commandClient>; events: ReturnType<typeof eventClient> }>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: { rpc: ReturnType<typeof commandClient>; events: ReturnType<typeof eventClient> }) => {
        if (settled) return; settled = true; clearTimeout(timer); clearInterval(probe); off(); ctx.scope.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(new Error("Market page scope revoked"));
      const timer = setTimeout(() => finish(new Error("Market Worker private endpoints did not become ready")), 30_000);
      const check = () => {
        try {
          if (stopped) throw new Error("Market page closed");
          ctx.scope.assertActive(); finish(undefined, { rpc: commandClient(), events: eventClient() });
        } catch (error) { if ((error as { code?: string }).code !== "capability_unavailable") finish(error); }
      };
      ctx.scope.signal.addEventListener("abort", abort, { once: true });
      const probe = setInterval(check, 100);
      const off = ctx.consumer.subscribe(check); check(); if (settled) off();
    });
  }
  let rpc: ReturnType<typeof commandClient>;
  let subscription: ReturnType<ReturnType<typeof eventClient>["subscribe"]> | undefined;
  function commandClient() { return ctx.privateCapability(MARKET_PRIVATE_COMMAND); }
  function eventClient() { return ctx.privateCapability(MARKET_PRIVATE_EVENTS); }
  const listeners = new Set<() => void>();
  let state: MarketWorkerSnapshot = { revision: -1, markets: [], pending: [], manual: [], appliedMarketCount: 0 };
  let stopped = false;
  let unavailableReason: string | undefined;
  function apply(snapshot: MarketWorkerSnapshot) {
    if (stopped || (state && snapshot.revision < state.revision)) return;
    state = snapshot; unavailableReason = undefined;
    listeners.forEach(listener => listener());
  }
  const ready = Promise.resolve().then(async () => {
    const endpoints = await waitForEndpoints();
    if (stopped) throw new Error("Market page closed");
    rpc = endpoints.rpc;
    subscription = endpoints.events.subscribe({}, {
      signal: ctx.scope.signal, onNext: event => { if (event.type === "state") apply(event.snapshot); },
    });
    void subscription.closed.catch(error => {
      if (stopped) return;
      unavailableReason = "Market Worker 已断开，请刷新钱包。";
      listeners.forEach(listener => listener());
      traceDev("market.relay", "stream.failed", () => ({ error }));
    });
    await subscription.ready;
    const response = await rpc.call({ type: "snapshot" }, { signal: ctx.scope.signal });
    apply(response.snapshot);
  });
  void ready.catch(error => {
    if (stopped) return;
    unavailableReason = error instanceof Error ? error.message : String(error);
    listeners.forEach(listener => listener());
  });
  const call = async <T>(command: MarketWorkerCommand): Promise<T> => {
    await ready; ctx.scope.assertActive();
    const response = await rpc.call(command, { signal: ctx.scope.signal, timeoutMs: 120_000 });
    ctx.scope.assertActive(); apply(response.snapshot);
    return response.value as T;
  };
  function dispose() {
    if (stopped) return;
    stopped = true;
    subscription?.cancel("wallet-page-closed");
    listeners.clear();
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    get unavailableReason() { return unavailableReason; },
    ready,
    syncNow: (marketId?: string) => call<unknown>({ type: "sync-now", ...(marketId === undefined ? {} : { marketId }) }).then(() => undefined),
    configureMarket: (input: { name: string; directoryUrl: string }) => call<{ marketId: string }>({ type: "configure-market", ...input }),
    discardMarket: (marketId: string) => call<unknown>({ type: "discard-market", marketId }).then(() => undefined),
    addManual: (input: { url: string }) => call<{ pendingId: string }>({ type: "add-manual", ...input }),
    updateManual: (pendingId: string, input: { url: string }) => call<unknown>({ type: "update-manual", pendingId, ...input }).then(() => undefined),
    retry: (pendingId: string) => call<unknown>({ type: "retry", pendingId }).then(() => undefined),
    remove: (pendingId: string) => call<unknown>({ type: "remove", pendingId }).then(() => undefined),
    dispose,
  };
}
export type WindowMarketClient = ReturnType<typeof createWindowMarket>;
