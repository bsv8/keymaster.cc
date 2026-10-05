import { createContext, useContext, type ReactNode } from "react";
import type { InternalVaultService } from "./internalVaultService.js";
import type { ImporterRegistry } from "./import/types.js";
import { createImporterRegistry } from "./import/registries/importerRegistry.js";
import { hexImporter } from "./import/hexImporter.js";
import { wifImporter } from "./import/wifImporter.js";
import { jsonFileImporter } from "./import/jsonFileImporter.js";
const Internal = createContext<{ service: InternalVaultService; importers: ImporterRegistry } | undefined>(undefined);
export function createVaultImporters(): ImporterRegistry {
 const registry = createImporterRegistry();
 for (const importer of [wifImporter, hexImporter, jsonFileImporter]) registry.register(importer);
 return registry;
}
export function VaultInternalProvider({ service, importers, children }: { service: InternalVaultService; importers: ImporterRegistry; children: ReactNode }) {
 return <Internal.Provider value={{ service, importers }}>{children}</Internal.Provider>;
}
function useInternal() { const value = useContext(Internal); if (!value) throw new Error("Vault internal UI requires its owning instance"); return value; }
export function useInternalVault() { return useInternal().service; }
export function useVaultImporters() { return useInternal().importers; }
