import { createVaultImporters } from "./VaultInternalContext.js";
import type { InternalVaultService } from "./internalVaultService.js";
import type { ComponentType } from "react";
import { I18N_SERVICE_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, VAULT_SERVICE_CAPABILITY, type PluginContext, type PluginSetup, type ResourceRegistry } from "@keymaster/contracts";
import type { PluginHost } from "@keymaster/runtime";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { bindVaultUi } from "./VaultResourceContext.js";
const implementations = new WeakMap<PluginHost, Map<string, PluginSetup>>();
export function createVaultTestHost(options: Parameters<typeof createFixtureHost>[0] = {}) {
  const setups = new Map<string, PluginSetup>();
  const host = createFixtureHost({ ...options,
    capabilities: [{ capability: PAGE_UI_RENDERER_CAPABILITY, value: { renderFrame: (_slot: string, children: unknown) => children, revision: () => 0, subscribe: () => () => {} } }, ...(options.capabilities ?? [])],
    runtimeUnitImplementationRegistry: { get: (id, unitId) => setups.get(id) ?? options.runtimeUnitImplementationRegistry?.get(id, unitId) },
  });
  implementations.set(host, setups); return host;
}
/** Behavior tests register their resources under a genuine Vault UI consumer. */
export async function bindTestVaultUi<P extends object>(host: PluginHost, Component: ComponentType<P>, register?: (registry: ResourceRegistry) => void) {
  let context!: PluginContext;
  implementations.get(host)!.set("vault-ui-fixture", ctx => { context = ctx; register?.(ctx.capability(RESOURCE_REGISTRY_CAPABILITY)); });
  await host.register({ id: "vault-ui-fixture", name: "Vault UI fixture", units: [{ id: "vault-ui-fixture.window", runtime: "window-main", scopeKind: "root", dependencies: [OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, I18N_SERVICE_CAPABILITY, VAULT_SERVICE_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY].map(capability => ({ capability, sourceRuntime: "window-main" as const, optional: false })) }] });
  if (host.state("vault-ui-fixture").kind !== "enabled") throw new Error(JSON.stringify(host.state("vault-ui-fixture")));
  return bindVaultUi(context, Component, host.capabilities.get(VAULT_SERVICE_CAPABILITY) as InternalVaultService, createVaultImporters());
}
