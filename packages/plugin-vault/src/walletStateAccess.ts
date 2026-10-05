import { VAULT_WALLET_STATE_CAPABILITY, type VaultWalletState, type VaultWalletStateAccess, type VaultLifecycleSnapshot } from "@keymaster/contracts";
import { isIssuedKeymasterConsumer } from "@keymaster/runtime/storage";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";

/** A provider instance owns every view and subscription; no view can rebind. */
export function createWalletStateAccess(
  source: VaultWalletState,
  providerScope: LifecycleScope,
  // The trusted assembly supplies its realm's issuer; public callers cannot choose it.
  isIssuedConsumer: (consumer: PluginConsumer, scope: LifecycleScope) => boolean = isIssuedKeymasterConsumer,
): VaultWalletStateAccess {
  const views = new WeakMap<PluginConsumer, VaultWalletState>();
  const check = (consumer: PluginConsumer, scope: LifecycleScope) => {
    providerScope.assertActive(); scope.assertActive();
    if (!isIssuedConsumer(consumer, scope) || consumer.status !== "active") throw new Error("Wallet state requires its live issued consumer and Scope");
    if (consumer.capability(VAULT_WALLET_STATE_CAPABILITY) !== access) throw new Error("Wallet state provider instance has changed");
  };
  const access: VaultWalletStateAccess = Object.freeze({ bind(consumer: PluginConsumer, scope: LifecycleScope) {
    check(consumer, scope);
    const cached = views.get(consumer); if (cached) return cached;
    const view: VaultWalletState = Object.freeze({
      snapshot() { check(consumer, scope); return immutableWalletSnapshot(source.snapshot()); },
      subscribe(handler: (snapshot: Readonly<VaultLifecycleSnapshot>) => void) {
        check(consumer, scope);
        let closed = false;
        let offSource = () => {};
        const cleanups: (() => void)[] = [];
        const close = () => { if (closed) return; closed = true; offSource(); for (const off of cleanups.splice(0)) off(); };
        cleanups.push(providerScope.onRevoke(close), scope.onRevoke(close), consumer.subscribe(() => {
          try { check(consumer, scope); } catch { close(); }
        }));
        // Source registers before its synchronous baseline, so reentrant commits cannot be lost.
        const off = source.subscribe(snapshot => {
          if (closed) return;
          try { check(consumer, scope); } catch { close(); return; }
          try { handler(immutableWalletSnapshot(snapshot)); } catch { /* An observer cannot interrupt a committed transition. */ }
        });
        offSource = off; if (closed) off();
        return close;
      },
    });
    views.set(consumer, view); return view;
  } });
  return access;
}

export function immutableWalletSnapshot(snapshot: Readonly<VaultLifecycleSnapshot>): Readonly<VaultLifecycleSnapshot> {
  const { activePublicKeyHex, activeKeyIdentity, ...state } = snapshot;
  return Object.freeze({ ...state,
    ...(state.status === "unlocked" && activePublicKeyHex ? { activePublicKeyHex,
      ...(activeKeyIdentity ? { activeKeyIdentity: Object.freeze({ ...activeKeyIdentity, capabilities: Object.freeze([...activeKeyIdentity.capabilities]) as unknown as string[] }) } : {}) } : {}),
  });
}

/** Projection only: generations and revision are supplied by the committed authority. */
export function createWalletStateSource(read: () => Readonly<VaultLifecycleSnapshot>) {
  const subscribers = new Set<{ handler: (snapshot: Readonly<VaultLifecycleSnapshot>) => void; delivered: number }>();
  let commitSequence = 0;
  let last = immutableWalletSnapshot(read());
  let lastKey = JSON.stringify(last);
  const pending: { snapshot: Readonly<VaultLifecycleSnapshot>; sequence: number }[] = [];
  let delivering = false;
  return {
    snapshot: () => immutableWalletSnapshot(last),
    subscribe(handler: (snapshot: Readonly<VaultLifecycleSnapshot>) => void) {
      const observer = { handler, delivered: commitSequence };
      subscribers.add(observer);
      try { handler(immutableWalletSnapshot(last)); } catch { /* observer isolation */ }
      return () => { subscribers.delete(observer); };
    },
    publish() {
      const next = immutableWalletSnapshot(read()); const key = JSON.stringify(next);
      if (key === lastKey) return;
      last = next; lastKey = key;
      pending.push({ snapshot: next, sequence: ++commitSequence });
      if (delivering) return;
      delivering = true;
      try {
        while (pending.length) {
          const committed = pending.shift()!;
          for (const observer of [...subscribers]) {
            // A reentrant subscriber already saw its baseline's committed sequence.
            if (!subscribers.has(observer) || observer.delivered >= committed.sequence) continue;
            observer.delivered = committed.sequence;
            try { observer.handler(committed.snapshot); } catch { /* observer isolation */ }
          }
        }
      } finally { delivering = false; }
    },
    dispose() { subscribers.clear(); pending.length = 0; },
  };
}
