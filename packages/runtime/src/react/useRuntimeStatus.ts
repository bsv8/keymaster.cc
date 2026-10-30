import { useCallback, useSyncExternalStore } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import { VAULT_SERVICE_CAPABILITY, type VaultStatus } from "@keymaster/contracts";
export interface RuntimeStatus { vault: VaultStatus; ready: boolean }
/** The trusted shell observes Vault directly, including immediate local lock.
 * An asynchronously reloaded resource must not leave revoked business UI up. */
export function useRuntimeStatus(): RuntimeStatus {
  const service = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const read = useCallback(() => service?.status() ?? "booting", [service]);
  const subscribe = useCallback((listener: () => void) => service?.subscribeStatus(listener) ?? (() => {}), [service]);
  return { vault: useSyncExternalStore(subscribe, read, read), ready: service !== undefined };
}
