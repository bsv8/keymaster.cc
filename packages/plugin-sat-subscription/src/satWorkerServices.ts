import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { createSatSubscriptionRepository } from "./storage/satRepository.js";
import { createSatSubscriptionState } from "./satState.js";
import { applyDefaultSatSupplier, type SatDefaultNetwork } from "./defaults.js";
import { createSatSubscriptionProvider, type SatSubscriptionTransport, type SatSubscriptionHandle } from "./satProvider.js";
import { createSatSpiService, type SatSpiServiceConfig } from "./satSpi.js";

export interface SatWorkerServicesDependencies {
  storage: BorrowedModuleFileStore;
  ownerPublicKeyHex: string;
  ownerGeneration: number;
  ownerSessionEpoch: string;
  signal: AbortSignal;
  network: SatDefaultNetwork;
  transport: SatSubscriptionTransport;
  assertFresh(): void;
  getOwnerPublicKeyHex: SatSpiServiceConfig["getOwnerPublicKeyHex"];
  getOwnerGeneration: SatSpiServiceConfig["getOwnerGeneration"];
  getP2pkh: SatSpiServiceConfig["getP2pkh"];
  deriveP2pkhAddress: SatSpiServiceConfig["deriveP2pkhAddress"];
}

/** Owns the repository, provider binding and SPI service, including failed-start cleanup. */
export async function createSatWorkerServices(deps: SatWorkerServicesDependencies) {
  const repository = createSatSubscriptionRepository(deps.storage, deps.ownerPublicKeyHex);
  let provider: ReturnType<typeof createSatSubscriptionProvider> | undefined;
  let handle: SatSubscriptionHandle | undefined;
  try {
    const loaded = await repository.load();
    deps.assertFresh();
    const state = createSatSubscriptionState({ ownerPublicKeyHex: deps.ownerPublicKeyHex, initial: applyDefaultSatSupplier(loaded, deps.network), persistence: repository });
    const stateForOwner = async (owner: string) => {
      deps.assertFresh();
      if (owner !== deps.ownerPublicKeyHex || owner !== deps.getOwnerPublicKeyHex()) throw new Error("SatSubscription owner changed");
      return state;
    };
    provider = createSatSubscriptionProvider({ stateForOwner, transport: deps.transport, signal: deps.signal, ownerGeneration: deps.ownerGeneration, ownerSessionEpoch: deps.ownerSessionEpoch, logger: { warn: (event, data) => console.warn("[sat-subscription]", event, data) } });
    handle = await provider.bind({ ownerPublicKeyHex: deps.ownerPublicKeyHex });
    deps.assertFresh();
    const boundProvider = provider;
    const service = boundProvider.service();
    const admin = boundProvider.adminService();
    if (!service || !admin) throw new Error("SatSubscription provider did not expose its trusted services");
    const spi = createSatSpiService({ getRuntime: () => boundProvider.spiRuntime(), getOwnerPublicKeyHex: deps.getOwnerPublicKeyHex, getOwnerGeneration: deps.getOwnerGeneration, stateForOwner, getP2pkh: deps.getP2pkh, deriveP2pkhAddress: deps.deriveP2pkhAddress });
    return { repository, state, provider: boundProvider, handle, service, admin, spi };
  } catch (error) {
    try { handle?.close(); } catch { /* keep the start failure */ }
    await provider?.shutdown().catch(() => undefined);
    repository.close();
    throw error;
  }
}
