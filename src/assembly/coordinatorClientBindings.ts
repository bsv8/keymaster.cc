import { STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY, VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY, BACKGROUND_COORDINATOR_CLIENT_BINDING_CAPABILITY, P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY, WOC_COORDINATOR_CLIENT_BINDING_CAPABILITY, MSFILE_COORDINATOR_CLIENT_BINDING_CAPABILITY, SAT_COORDINATOR_CLIENT_BINDING_CAPABILITY, WINDOW_P2P_COORDINATOR_CLIENT_BINDING_CAPABILITY, CONNECT_COORDINATOR_CLIENT_BINDING_CAPABILITY, type CoordinatorClientBinding } from "@keymaster/contracts";
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
  // 兼容说明（A 方案硬切换）：显示名已统一为 Connect，但 pluginId 仍保留 "protocol"，
  // 对应持久身份与存储 moduleId；Coordinator 绑定键保留 "protocol"，不做迁移。
  ["protocol", CONNECT_COORDINATOR_CLIENT_BINDING_CAPABILITY],
] as const;
export function coordinatorClientBindings(clientForPlugin: (pluginId: string) => unknown): HostCapabilityRegistration[] {
  return contracts.map(([pluginId, capability]) => ({ capability, value: createScopedClientBinding(
    capability as LocalCapability<CoordinatorClientBinding<object>>, () => clientForPlugin(pluginId) as object,
  ) }));
}
