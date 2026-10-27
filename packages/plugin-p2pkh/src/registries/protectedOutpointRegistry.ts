// 受保护 outpoint 注册表。
//
// 设计缘由：
//   - 协议 plugin 只需声明自己占用的 outpoint 集合；
//   - plain funding 选币前查询此 registry，排除 token / ordinal / 其它协议资产；
//   - registry 只负责聚合和查询，不解释协议细节。

import type { BsvNetwork, ProtectedOutpoint, ProtectedOutpointProvider, ProtectedOutpointStore as IProtectedOutpointRegistry } from "@keymaster/contracts";

function sameOutpoint(a: ProtectedOutpoint, b: { txid: string; vout: number; network: BsvNetwork; publicKeyHex?: string }): boolean {
  return a.txid === b.txid && a.vout === b.vout && a.network === b.network && (a.publicKeyHex === undefined || b.publicKeyHex === undefined || a.publicKeyHex === b.publicKeyHex);
}

function claimKey(input: { txid: string; vout: number; network: BsvNetwork }, ownerPluginId: string): string {
  return `${input.network}:${input.txid}:${input.vout}:${ownerPluginId}`;
}

export function createProtectedOutpointRegistry(): IProtectedOutpointRegistry {
  const providers = new Map<string, ProtectedOutpointProvider>();
  const cache = new Map<string, ProtectedOutpoint[]>();
  const offChange = new Map<string, (() => void) | undefined>();
  const claims = new Map<string, ProtectedOutpoint & { claimedByPluginId: string; claimedByPublicKeyHex?: string; claimedAt: number }>();
  const listeners = new Set<() => void>();

  function emitChange(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  async function refresh(provider: ProtectedOutpointProvider): Promise<void> {
    const list = await Promise.resolve(provider.listProtectedOutpoints());
    // 注销发生在 owner storage revoke 之后；迟到的旧结果不能重新把
    // 已撤销插件的 outpoint 写回 registry，否则会越过生命周期边界。
    if (providers.get(provider.id) !== provider) return;
    cache.set(provider.id, list.slice());
    pruneClaimsForOwner(provider.ownerPluginId ?? provider.id);
    // 缓存变了就要通知一次：claim 是否被回收只是这次通知的内容之一，
    // 分两次发会让订阅者看到中间状态。
    emitChange();
  }

  function scheduleRefresh(provider: ProtectedOutpointProvider): void {
    void refresh(provider).catch(() => {
      // provider 刷新是 detached 的观察任务。锁定/注销期间 owner storage
      // 被取消是正常生命周期结果；其它瞬时读取失败也保留最后一次成功快照，
      // 不能把失败误发布为空集合（那会让普通 funding 误选受保护输入）。
    });
  }

  /**
   * 只回收「已经没有任何 provider 保护」的 claim。
   *
   * 同一个插件可以登记多个 provider（Forum 的专用资金与自有 Forum 输出都属于
   * `forum`）。按插件粒度清理会让其中一个 provider 刷新或注销时把另一个的
   * 在途占用一并删掉，于是第二次 claim 意外成功——占用保护就形同虚设。
   * 因此判据是**所有仍存活的 provider 的输出并集**，而不是某一个 provider 的集合。
   */
  function pruneClaimsForOwner(ownerPluginId: string): boolean {
    let changed = false;
    for (const [key, claim] of claims.entries()) {
      if (claim.claimedByPluginId !== ownerPluginId) continue;
      if (stillProtected(claim)) continue;
      claims.delete(key);
      changed = true;
    }
    return changed;
  }

  /** 该 outpoint 是否还被任意一个已注册 provider 保护。 */
  function stillProtected(claim: ProtectedOutpoint & { claimedByPluginId: string }): boolean {
    for (const list of cache.values()) {
      if (list.some((item) => item.ownerPluginId === claim.claimedByPluginId && sameOutpoint(item, claim))) return true;
    }
    return false;
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
      scheduleRefresh(provider);
      const off = provider.onChange?.(() => {
        scheduleRefresh(provider);
      });
      offChange.set(provider.id, off);
    },
    unregister(id) {
      if (!providers.has(id)) {
        throw new Error(`Protected outpoint provider id "${id}" is not registered`);
      }
      const provider = providers.get(id);
      // 先把 provider 从存活集合里拿掉，再按「并集」回收 claim：
      // 反过来做的话它自己的缓存还在，claim 会因为「仍被自己保护」而被留下。
      providers.delete(id);
      cache.delete(id);
      if (provider) {
        disposeProvider(provider);
        // 同插件的其它 provider 仍可能保护着这些 outpoint，因此只回收不再被保护的。
        pruneClaimsForOwner(provider.ownerPluginId ?? provider.id);
      }
      emitChange();
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
        unique.set(claimKey(entry, input.ownerPluginId), entry);
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
      emitChange();
      return { claimIds };
    },
    async releaseClaims(claimIds) {
      for (const id of claimIds) {
        claims.delete(id);
      }
      if (claimIds.length > 0) {
        emitChange();
      }
    },
    _ids() {
      return [...providers.keys()];
    }
  };
}

export type { IProtectedOutpointRegistry as ProtectedOutpointRegistry };
