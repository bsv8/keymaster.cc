import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY, BACKGROUND_COORDINATOR_CLIENT_BINDING_CAPABILITY, P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY, WOC_COORDINATOR_CLIENT_BINDING_CAPABILITY, MSFILE_COORDINATOR_CLIENT_BINDING_CAPABILITY, SAT_COORDINATOR_CLIENT_BINDING_CAPABILITY, WINDOW_P2P_COORDINATOR_CLIENT_BINDING_CAPABILITY, PROTOCOL_COORDINATOR_CLIENT_BINDING_CAPABILITY, CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY, type CoordinatorClientBinding } from "@keymaster/contracts";
import { createScopedClientBinding } from "@keymaster/runtime";
import type { LocalCapability } from "webloom-framework";
import type { HostCapabilityRegistration } from "webloom-framework/advanced";
const contracts = [
  ["storage", STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["vault", VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["background", BACKGROUND_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["p2pkh", P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["woc", WOC_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["msfile", MSFILE_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["sat-subscription", SAT_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["window-p2p", WINDOW_P2P_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["protocol", PROTOCOL_COORDINATOR_CLIENT_BINDING_CAPABILITY],
  ["contacts", CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY],
] as const;
export function coordinatorClientBindings(clientForPlugin: (pluginId: string) => unknown): HostCapabilityRegistration[] {
  return contracts.map(([pluginId, capability]) => ({ capability, value: createScopedClientBinding(
    capability as LocalCapability<CoordinatorClientBinding<object>>, pluginId, () => clientForPlugin(pluginId) as object,
  ) }));
}
