import type { WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import { createWindowP2pMsFileTransport } from "./executorTransport.js";
import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { createMsFileWorkerService } from "./msfileWorkerService.js";
import type { MsFileServiceImpl } from "./msfileService.js";

export interface MsFileWorkerStores {
  ownerPublicKeyHex: string;
  settings: BorrowedModuleFileStore;
  appSettings: BorrowedModuleFileStore;
}

export interface MsFileWorkerLifecyclePorts {
  arbitrationServices?(): readonly import("@keymaster/contracts").MsFileArbitrationService[];
  assertAvailable(): void;
  session(): { unlocked: boolean; owner?: string; epoch: string };
  fixtureTransport?(): Parameters<typeof createMsFileWorkerService>[0]["transport"] | undefined;
  configureSeller: NonNullable<Parameters<typeof createMsFileWorkerService>[0]["onSellerSettingsChanged"]> extends (...args: infer A) => unknown
  ? (service: MsFileServiceImpl, owner: string, settings: A[0]) => Promise<import("@keymaster/contracts").MsFileSellerRuntimeStatus> : never;
  changed(): void;
  revokeOperations(): void;
}

/** single-flight 与候选实例隔离属于 MSFile；Host 不持有 service/stores。 */
export function createMsFileWorkerLifecycle(ports: MsFileWorkerLifecyclePorts) {
  let bridge: (() => WindowP2pExecutorBridge | undefined) | undefined;
  function bindBridge(value: () => WindowP2pExecutorBridge | undefined) { bridge = value; return () => { if (bridge === value) bridge = undefined; }; }
  function executor(...args: Parameters<WindowP2pExecutorBridge["request"]>) { const current = bridge?.(); if (!current) throw new Error("MSFile Worker bridge is unavailable"); return current.request(...args); }
  let chainAccess: (() => import("@keymaster/contracts").WocServiceHandle | undefined) | undefined;
  function bindChain(access: () => import("@keymaster/contracts").WocServiceHandle | undefined) { chainAccess = access; return () => { if (chainAccess === access) chainAccess = undefined; }; }
  let service: MsFileServiceImpl | undefined;
  let stores: MsFileWorkerStores | undefined;
  let starting: Promise<MsFileServiceImpl> | undefined;
  let generation = 0;
  function revoke() {
    generation += 1;
    ports.revokeOperations();
    const old = service;
    service = undefined;
    stores = undefined;
    old?.dispose();
  }
  async function dispose() {
    const pending = starting;
    revoke();
    await pending?.catch(() => undefined);
  }
  async function disposeInstance(candidate: MsFileServiceImpl) {
    // Host 的晚到 disposal 只能处理自己创建的服务，不能撤销新实例。
    if (service === candidate) await dispose();
    else candidate.dispose();
  }
  async function ensure(boundStores?: MsFileWorkerStores, assertActive: () => void = () => undefined) {
    ports.assertAvailable();
    assertActive();
    if (service) return service;
    if (starting) {
      const candidate = await starting;
      assertActive();
      ports.assertAvailable();
      if (service !== candidate) throw new Error("MSFile runtime startup was superseded");
      return candidate;
    }
    const identity = ports.session();
    const owner = identity.owner?.trim().toLowerCase();
    if (!owner || !identity.unlocked || !boundStores || boundStores.ownerPublicKeyHex !== owner) throw new Error("MSFile requires current owner storage");
    const token = generation;
    const assertFresh = () => {
      assertActive(); ports.assertAvailable();
      const now = ports.session();
      if (token !== generation || !now.unlocked || now.owner?.trim().toLowerCase() !== owner || now.epoch !== identity.epoch) throw new Error("MSFile runtime startup was superseded");
    };
    const pending = (async () => {
      let candidate: MsFileServiceImpl | undefined;
      try {
        candidate = await createMsFileWorkerService({
          arbitrationServices: ports.arbitrationServices?.(),
          stores: boundStores, transport: ports.fixtureTransport?.() ?? createWindowP2pMsFileTransport({ get available() { return bridge?.()?.available ?? false; }, request: executor }), assertFresh,
          onSellerSettingsChanged: settings => ports.configureSeller(candidate!, owner, settings), notifyStateChange: ports.changed,
        });
        assertFresh();
        stores = boundStores;
        service = candidate;
        const sellerStatus = await ports.configureSeller(candidate, owner, candidate.describeState().sellerSettings);
        assertFresh();
        candidate.setSellerRuntimeStatus(sellerStatus);
        ports.changed();
        return candidate;
      } catch (error) {
        if (service === candidate) { service = undefined; stores = undefined; }
        candidate?.dispose();
        throw error;
      }
    })();
    starting = pending;
    try { return await pending; } finally { if (starting === pending) starting = undefined; }
  }
  return { disposeInstance, bindBridge, executor, bindChain, chain: () => chainAccess?.(), ensure, revoke, dispose, service: () => service, stores: () => stores };
}
