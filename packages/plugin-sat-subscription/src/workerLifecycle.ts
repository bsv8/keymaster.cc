import type { WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { createSatWorkerServices } from "./satWorkerServices.js";

type Services = Awaited<ReturnType<typeof createSatWorkerServices>>;
export type SatWorkerRuntimeState = Services & {
  ownerPublicKeyHex: string; ownerGeneration: number; signal: AbortSignal; offIncoming(): void;
};
export interface SatCleanupPhase { label: string; run(): Promise<void>; pending?: Promise<void>; done?: boolean }
export interface SatWorkerLifecyclePorts {
  assertAvailable(): void;
  session(): { unlocked: boolean; owner?: string; epoch: string };
  transport(): Parameters<typeof createSatWorkerServices>[0]["transport"];
  network(): Parameters<typeof createSatWorkerServices>[0]["network"];
  devSupplierJson?(): string | undefined;
  getP2pkh: Parameters<typeof createSatWorkerServices>[0]["getP2pkh"];
  deriveAddress(owner: string, network: "main" | "test", epoch: string): Promise<string>;
  incoming: Parameters<Services["service"]["subscribeEvents"]>[0];
  releaseRelated(reason: string): SatCleanupPhase[];
}

/** 供应商实例、启动世代、退出阶段及重试由 SatSubscription 所有。 */
export function createSatWorkerLifecycle(ports: SatWorkerLifecyclePorts) {
  let bridge: (() => WindowP2pExecutorBridge | undefined) | undefined;
  function bindBridge(value: () => WindowP2pExecutorBridge | undefined) { bridge = value; return () => { if (bridge === value) bridge = undefined; }; }
  function executor(...args: Parameters<WindowP2pExecutorBridge["request"]>) { const current = bridge?.(); if (!current) throw new Error("Sat Worker bridge is unavailable"); return current.request(...args); }
  let p2pkhAccess: SatWorkerLifecyclePorts["getP2pkh"] | undefined;
  function bindP2pkh(access: SatWorkerLifecyclePorts["getP2pkh"]) { p2pkhAccess = access; return () => { if (p2pkhAccess === access) p2pkhAccess = undefined; }; }
  let current: SatWorkerRuntimeState | undefined;
  let starting: Promise<SatWorkerRuntimeState> | undefined;
  let startingGeneration: number | undefined;
  let startController: AbortController | undefined;
  let generation = 0;
  let released = Promise.resolve();
  let retryCleanup: (() => Promise<void>) | undefined;
  async function ensure(storage?: BorrowedModuleFileStore, assertActive: () => void = () => undefined): Promise<SatWorkerRuntimeState> {
    ports.assertAvailable();
    await released;
    await retryCleanup?.();
    ports.assertAvailable(); assertActive();
    if (current) return current;
    if (starting) {
      const pending = starting;
      if (startingGeneration === generation) {
        const candidate = await pending;
        assertActive(); ports.assertAvailable();
        if (current !== candidate) throw new Error("SatSubscription startup was superseded");
        return candidate;
      }
      await pending.catch(() => undefined);
      assertActive();
      if (current) return current;
    }
    const identity = ports.session();
    const owner = identity.owner;
    if (!identity.unlocked || !owner || !storage) throw new Error("SatSubscription requires current owner storage");
    const token = generation;
    const ownerGeneration = Math.max(1, token + 1);
    const controller = new AbortController();
    startController = controller;
    const assertFresh = () => {
      assertActive(); ports.assertAvailable();
      const now = ports.session();
      if (token !== generation || !now.unlocked || now.epoch !== identity.epoch || now.owner !== owner) throw new Error("SatSubscription runtime became stale while starting");
    };
    const pending = (async () => {
      const owned = await createSatWorkerServices({
        storage, ownerPublicKeyHex: owner, ownerGeneration, ownerSessionEpoch: identity.epoch,
        signal: controller.signal, network: ports.network(), devSupplierJson: ports.devSupplierJson?.(), transport: ports.transport(), assertFresh,
        getOwnerPublicKeyHex: () => ports.session().owner ?? null,
        getOwnerGeneration: () => ports.session().owner === owner ? Math.max(1, generation + 1) : null,
        getP2pkh: () => p2pkhAccess ? p2pkhAccess() : ports.getP2pkh(),
        deriveP2pkhAddress: async (requestedOwner, network) => {
          assertFresh();
          if (requestedOwner !== owner) throw new Error("SPI owner changed before address derivation");
          return ports.deriveAddress(owner, network, identity.epoch);
        },
      });
      try {
        assertFresh();
        const runtime: SatWorkerRuntimeState = {
          ...owned, ownerPublicKeyHex: owner, ownerGeneration,
          signal: controller.signal, offIncoming: owned.service.subscribeEvents(ports.incoming),
        };
        current = runtime;
        return runtime;
      } catch (error) {
        owned.handle.close();
        await owned.provider.shutdown().catch(() => undefined);
        owned.repository.close();
        throw error;
      }
    })();
    starting = pending; startingGeneration = token;
    try { return await pending; } finally {
      if (starting === pending) { starting = undefined; startingGeneration = undefined; }
      if (startController === controller) startController = undefined;
    }
  }
  function release(reason: string): Promise<void> {
    const previousRelease = released;
    const previousRetry = retryCleanup;
    generation += 1;
    startController?.abort(new Error(`Sat runtime released: ${reason}`));
    startController = undefined;
    const runtime = current;
    const pending = starting?.catch(() => undefined);
    current = undefined; starting = undefined; startingGeneration = undefined;
    let owned = runtime;
    const phases: SatCleanupPhase[] = [
      { label: "stale runtime start", run: async () => { owned = runtime ?? await pending; } },
      ...ports.releaseRelated(reason),
      { label: "close runtime handle", run: async () => { owned?.offIncoming(); owned?.handle.close(); } },
      { label: "Sat provider shutdown", run: async () => { await owned?.provider.shutdown(); } },
      { label: "close repository", run: async () => { owned?.repository.close(); } },
    ];
    let completed = false;
    let inFlight: Promise<void> | undefined;
    const retry = () => {
      if (completed) return Promise.resolve();
      if (inFlight) return inFlight;
      const run = (async () => {
        await previousRelease;
        await previousRetry?.();
        for (const phase of phases) {
          if (phase.done) continue;
          phase.pending ??= Promise.resolve().then(phase.run).then(() => { phase.done = true; }, error => { phase.pending = undefined; throw error; });
          await waitForCleanup(phase.pending, phase.label);
        }
        completed = true;
        if (retryCleanup === retry) retryCleanup = undefined;
      })().finally(() => { if (inFlight === run) inFlight = undefined; });
      inFlight = run;
      return run;
    };
    retryCleanup = retry;
    const cleanup = retry();
    // release 的调用方收到失败；后续 ensure 必须先成功重试，不能绕过旧退出。
    released = cleanup.catch(() => undefined);
    return cleanup;
  }
  return { bindBridge, executor, bindP2pkh, ensure, release, current: () => current, waitReleased: () => released, retryCleanup: () => retryCleanup?.(), resetRetry: () => { retryCleanup = undefined; } };
}

async function waitForCleanup(operation: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sat runtime cleanup timed out: ${label}`)), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
