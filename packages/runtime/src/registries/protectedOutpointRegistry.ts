// 受保护 outpoint 注册表。
//
// 设计缘由：
//   - 协议 plugin 只需声明自己占用的 outpoint 集合；
//   - plain funding 选币前查询此 registry，排除 token / ordinal / 其它协议资产；
//   - registry 只负责聚合和查询，不解释协议细节。

import type { BsvNetwork, ProtectedOutpoint, ProtectedOutpointProvider, ProtectedOutpointRegistry as IProtectedOutpointRegistry } from "@keymaster/contracts";

function sameOutpoint(a: ProtectedOutpoint, b: { txid: string; vout: number; network: BsvNetwork; publicKeyHex?: string }): boolean {
  return a.txid === b.txid && a.vout === b.vout && a.network === b.network && (a.publicKeyHex === undefined || b.publicKeyHex === undefined || a.publicKeyHex === b.publicKeyHex);
}

function claimKey(input: { txid: string; vout: number; network: BsvNetwork }, ownerPluginId: string, publicKeyHex?: string): string {
  return `${input.network}:${input.txid}:${input.vout}:${ownerPluginId}:${publicKeyHex ?? "*"}`;
}

export function createProtectedOutpointRegistry(): IProtectedOutpointRegistry {
  const providers = new Map<string, ProtectedOutpointProvider>();
  const cache = new Map<string, ProtectedOutpoint[]>();
  const offChange = new Map<string, (() => void) | undefined>();
  const claims = new Map<string, ProtectedOutpoint & { claimedByPluginId: string; claimedByPublicKeyHex?: string; claimedAt: number }>();
  const listeners = new Set<() => void>();

  async function refresh(provider: ProtectedOutpointProvider): Promise<void> {
    const list = await Promise.resolve(provider.listProtectedOutpoints());
    cache.set(provider.id, list.slice());
    for (const listener of listeners) {
      listener();
    }
  }

  function disposeProvider(provider: ProtectedOutpointProvider): void {
    offChange.get(provider.id)?.();
    offChange.delete(provider.id);
    provider.dispose?.();
  }

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Protected outpoint provider id "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
      void refresh(provider);
      const off = provider.onChange?.(() => {
        void refresh(provider);
      });
      offChange.set(provider.id, off);
    },
    unregister(id) {
      if (!providers.has(id)) {
        throw new Error(`Protected outpoint provider id "${id}" is not registered`);
      }
      const provider = providers.get(id);
      if (provider) {
        disposeProvider(provider);
      }
      providers.delete(id);
      cache.delete(id);
    },
    unregisterByOwner(ownerPluginId) {
      for (const [id] of providers.entries()) {
        const provider = providers.get(id);
        if (provider?.ownerPluginId === ownerPluginId) {
          disposeProvider(provider);
          providers.delete(id);
          cache.delete(id);
        }
      }
    },
    list(filter) {
      const all: ProtectedOutpoint[] = [];
      for (const list of cache.values()) {
        for (const item of list) {
          if (filter?.publicKeyHex && item.publicKeyHex !== filter.publicKeyHex) continue;
          if (filter?.network && item.network !== filter.network) continue;
          all.push(item);
        }
      }
      return all;
    },
    isProtected(input) {
      for (const list of cache.values()) {
        if (list.some((item) => sameOutpoint(item, input))) return true;
      }
      return false;
    },
    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    async claimProtectedInputs(input) {
      const claimIds: string[] = [];
      const entries: ProtectedOutpoint[] = [];
      for (const item of cache.values()) {
        for (const protectedOutpoint of item) {
          if (protectedOutpoint.network !== input.network) continue;
          if (!input.inputs.some((u) => u.txid === protectedOutpoint.txid && u.vout === protectedOutpoint.vout)) continue;
          if (protectedOutpoint.ownerPluginId !== input.ownerPluginId) {
            throw new Error(`Protected outpoint belongs to ${protectedOutpoint.ownerPluginId}, not ${input.ownerPluginId}`);
          }
          if (protectedOutpoint.publicKeyHex && input.publicKeyHex && protectedOutpoint.publicKeyHex !== input.publicKeyHex) {
            throw new Error(`Protected outpoint publicKeyHex mismatch for ${protectedOutpoint.txid}:${protectedOutpoint.vout}`);
          }
          entries.push(protectedOutpoint);
        }
      }
      const unique = new Map<string, ProtectedOutpoint>();
      for (const entry of entries) {
        unique.set(claimKey(entry, input.ownerPluginId, input.publicKeyHex), entry);
      }
      for (const [key, entry] of unique) {
        if (claims.has(key)) {
          throw new Error(`Protected outpoint already claimed: ${entry.txid}:${entry.vout}`);
        }
        claims.set(key, {
          ...entry,
          claimedByPluginId: input.ownerPluginId,
          claimedByPublicKeyHex: input.publicKeyHex,
          claimedAt: Date.now()
        });
        claimIds.push(key);
      }
      for (const listener of listeners) {
        listener();
      }
      return { claimIds };
    },
    async releaseClaims(claimIds) {
      for (const id of claimIds) {
        claims.delete(id);
      }
      if (claimIds.length > 0) {
        for (const listener of listeners) {
          listener();
        }
      }
    },
    _ids() {
      return [...providers.keys()];
    }
  };
}

export type { IProtectedOutpointRegistry as ProtectedOutpointRegistry };
