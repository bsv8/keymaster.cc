import { type PluginHost } from "@keymaster/runtime";
import { PluginHostProvider as HostProvider } from "@keymaster/runtime/assembly";
import type { ReactNode } from "react";
import { VaultInternalProvider } from "../../VaultInternalContext.js";
import type { InternalVaultService } from "../../internalVaultService.js";
import type { ImporterRegistry } from "../types.js";
const contexts = new WeakMap<PluginHost, { service: InternalVaultService; importers: ImporterRegistry }>();
export function registerImportTestContext(host: PluginHost, service: InternalVaultService, importers: ImporterRegistry) { contexts.set(host, { service, importers }); }
export function PluginHostProvider({ host, children }: { host: PluginHost; children: ReactNode }) { const value = contexts.get(host)!; return <HostProvider host={host}><VaultInternalProvider {...value}>{children}</VaultInternalProvider></HostProvider>; }
