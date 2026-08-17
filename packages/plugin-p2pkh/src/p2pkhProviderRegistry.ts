import type {
  BsvNetwork,
  P2pkhConfirmedDataProvider,
  P2pkhProviderDescriptor,
  P2pkhProviderRegistry,
  P2pkhTransactionBroadcastProvider,
} from "@keymaster/contracts";

function cloneDescriptor(descriptor: P2pkhProviderDescriptor): P2pkhProviderDescriptor {
  return { ...descriptor, supportedNetworks: [...descriptor.supportedNetworks] };
}

function assertDescriptor(descriptor: P2pkhProviderDescriptor): void {
  if (!descriptor.id || !descriptor.label || descriptor.supportedNetworks.length === 0) {
    throw new Error("Invalid P2PKH provider descriptor");
  }
  if (new Set(descriptor.supportedNetworks).size !== descriptor.supportedNetworks.length) {
    throw new Error(`Duplicate network in provider descriptor: ${descriptor.id}`);
  }
}

/** Coordinator-owned in-memory registry. A duplicate id is always fatal. */
export function createP2pkhProviderRegistry(): P2pkhProviderRegistry {
  const confirmed = new Map<string, P2pkhConfirmedDataProvider>();
  const broadcast = new Map<string, P2pkhTransactionBroadcastProvider>();

  function register<T extends { descriptor: P2pkhProviderDescriptor }>(
    map: Map<string, T>,
    provider: T,
    capability: string
  ): void {
    assertDescriptor(provider.descriptor);
    if (map.has(provider.descriptor.id)) {
      throw new Error(`Duplicate P2PKH ${capability} provider id: ${provider.descriptor.id}`);
    }
    map.set(provider.descriptor.id, provider);
  }

  const supports = (descriptor: P2pkhProviderDescriptor, network?: BsvNetwork) =>
    network === undefined || descriptor.supportedNetworks.includes(network);

  return {
    registerConfirmedProvider(provider) { register(confirmed, provider, "confirmed"); },
    unregisterConfirmedProvider(providerId) { confirmed.delete(providerId); },
    registerBroadcastProvider(provider) { register(broadcast, provider, "broadcast"); },
    listConfirmedProviders(network) {
      return [...confirmed.values()].filter((p) => supports(p.descriptor, network)).map((p) => cloneDescriptor(p.descriptor));
    },
    listBroadcastProviders(network) {
      return [...broadcast.values()].filter((p) => supports(p.descriptor, network)).map((p) => cloneDescriptor(p.descriptor));
    },
    getConfirmedProvider(id, network) {
      const provider = confirmed.get(id);
      return provider && supports(provider.descriptor, network) ? provider : undefined;
    },
    getBroadcastProvider(id, network) {
      const provider = broadcast.get(id);
      return provider && supports(provider.descriptor, network) ? provider : undefined;
    },
  };
}
