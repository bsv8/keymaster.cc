import type { P2pkhConfirmedDataProvider } from "@keymaster/contracts";
import { createJungleBusClient, type JungleBusClient, type JungleBusClientConfig } from "./jungleBusClient.js";
import { createJungleBusP2pkhConfirmedProvider } from "./p2pkhConfirmedProvider.js";

export function registerJungleBusP2pkhProvider(input: { registry: { registerConfirmedProvider(provider: P2pkhConfirmedDataProvider): void }; client?: JungleBusClient; config?: Partial<JungleBusClientConfig> }): void {
  input.registry.registerConfirmedProvider(createJungleBusP2pkhConfirmedProvider({ client: input.client ?? createJungleBusClient(input.config) }));
}

export { createJungleBusClient } from "./jungleBusClient.js";
export { createJungleBusP2pkhConfirmedProvider } from "./p2pkhConfirmedProvider.js";
