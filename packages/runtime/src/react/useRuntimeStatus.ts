import { useCallback, useSyncExternalStore } from "react";
import { usePluginHost, useHostVersion } from "./PluginHostProvider.js";
import { VAULT_WALLET_STATE_CAPABILITY, type VaultStatus } from "@keymaster/contracts";
export interface RuntimeStatus { vault: VaultStatus; ready: boolean }
/** Trusted shell reads the Vault-owned resource; plugin contributions use their consumer. */
export function useRuntimeStatus(): RuntimeStatus {
  const host = usePluginHost();
  useHostVersion();
  const ready = host.capabilities.has(VAULT_WALLET_STATE_CAPABILITY);
  const read = useCallback(() => ready ? host.resourceStore.ensure<{ status: VaultStatus }>("vault.key-state", []).data?.status ?? "booting" : "booting", [host, ready]);
  const subscribe = useCallback((listener: () => void) => {
    if (!ready) return () => {};
    let offRecord = host.resourceStore.subscribe("vault.key-state", [], listener);
    const offContext = host.resourceStore.subscribeContext(() => {
      offRecord();
      offRecord = host.resourceStore.subscribe("vault.key-state", [], listener);
      listener();
    });
    return () => { offContext(); offRecord(); };
  }, [host, ready]);
  return { vault: useSyncExternalStore(subscribe, read, read), ready };
}
