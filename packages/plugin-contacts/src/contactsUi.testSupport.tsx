import type { ComponentType } from "react";
import { CONTACTS_SERVICE_CAPABILITY, CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY,
  I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type ResourceRegistry, type PluginManifest, type PluginSetup,
} from "@keymaster/contracts";
import type { PluginHost } from "@keymaster/runtime";
import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { bindContactsUi } from "./ContactsResourceContext.js";

const implementations = new WeakMap<PluginHost, Map<string, PluginSetup>>();
export function createContactsTestHost(options: Parameters<typeof createKeymasterPluginHost>[0] = {}) {
  const setups = new Map<string, PluginSetup>();
  const host = createKeymasterPluginHost({ ...options,
    runtimeUnitImplementationRegistry: { get: (id, ...args) => setups.get(id) ?? options.runtimeUnitImplementationRegistry?.get(id, ...args) },
  });
  implementations.set(host, setups);
  return host;
}

/** Tests obtain a framework-issued consumer and register resources under that same instance. */
export async function bindTestContactsUi<P extends object>(host: PluginHost, Component: ComponentType<P>, register?: (resources: ResourceRegistry) => void) {
  let Bound!: ReturnType<typeof bindContactsUi<P>>;
  const manifest: PluginManifest = { id: "contacts-ui-fixture", name: "Contacts UI fixture",
    units: [{ id: "contacts-ui-fixture.window", runtime: "window-main", scopeKind: "root",
      dependencies: defineRuntimeUnitDependencies([
        { capability: OWNED_RESOURCE_ACCESS_CAPABILITY }, { capability: RESOURCE_REGISTRY_CAPABILITY },
        { capability: I18N_SERVICE_CAPABILITY }, { capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY },
        { capability: CONTACTS_SERVICE_CAPABILITY, optional: true }, { capability: VAULT_WALLET_STATE_CAPABILITY },
      ]),
    }],
  };
  implementations.get(host)!.set(manifest.id, ctx => {
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    register?.(resources);
    const actions = ctx.capability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
    resources.register({ id: "contacts.public-key-actions", scope: "active-key", key: () => ["actions"],
      load: async () => actions.list(), subscribe: (_args, _context, invalidate) => actions.subscribe(invalidate), invalidation: "immediate" });
    Bound = bindContactsUi(ctx, Component);
  });
  await host.register(manifest);
  return Bound;
}
