import type { ProtectedOutpointRegistry, ProtectedOutpointStore } from "@keymaster/contracts";

type Binding = { readonly identity: { publicKeyHex: string; bsvNetwork: "main" | "test" }; assertActive(): void };

/** Only wallet assembly can query the multi-coordinate responsibility store. */
export function createWalletProtectedOutpoints(store: ProtectedOutpointStore, wallet: Binding): ProtectedOutpointRegistry {
  wallet.assertActive();
  const identity = { publicKeyHex: wallet.identity.publicKeyHex, network: wallet.identity.bsvNetwork };
  const bind = <T extends object>(input: T) => {
    wallet.assertActive();
    if ("publicKeyHex" in input || "network" in input || "ownerPublicKeyHex" in input) throw new TypeError("Protection requests do not accept wallet selectors");
    return { ...structuredClone(input), ...identity };
  };
  return Object.freeze({
    register(provider) { wallet.assertActive(); store.register(provider); },
    // Removal is cleanup, and must remain possible after revocation.
    unregister: id => store.unregister(id),
    list(...args: []) { wallet.assertActive(); if (args.length) throw new TypeError("Protection lists do not accept wallet selectors"); return store.list(identity); },
    isProtected: input => store.isProtected(bind(input)),
    onChange(handler) { wallet.assertActive(); return store.onChange(() => { try { wallet.assertActive(); } catch { return; } handler(); }); },
    async claimProtectedInputs(input) { const result = await store.claimProtectedInputs(bind(input)); wallet.assertActive(); return result; },
    async releaseClaims(ids) { wallet.assertActive(); await store.releaseClaims([...ids]); wallet.assertActive(); },
  } satisfies ProtectedOutpointRegistry);
}
