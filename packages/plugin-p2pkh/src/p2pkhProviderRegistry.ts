import type {
  BsvNetwork,
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

/**
 * Coordinator-owned in-memory registry；只剩广播 Provider。
 *
 * 确认同步供应商选择层已删除：P2PKH 历史与 UTXO 只有 WoC 一个来源，
 * 直接调用 WocService，不再经过 registry。
 */
export function createP2pkhProviderRegistry(): P2pkhProviderRegistry {
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
    registerBroadcastProvider(provider) { register(broadcast, provider, "broadcast"); },
    unregisterBroadcastProvider(providerId) { broadcast.delete(providerId); },
    listBroadcastProviders(network) {
      return [...broadcast.values()].filter((p) => supports(p.descriptor, network)).map((p) => cloneDescriptor(p.descriptor));
    },
    getBroadcastProvider(id, network) {
      const provider = broadcast.get(id);
      return provider && supports(provider.descriptor, network) ? provider : undefined;
    },
  };
}
