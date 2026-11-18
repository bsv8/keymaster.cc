import type { AppSourceEntry, AppSourceUrl, AppSourceFiles } from "@keymaster/contracts";
/** User-added channels are application settings, not independent source entities. */
export interface AppDirectoryUrl extends AppSourceUrl { userAdded?: true; marketListed?: true }
export interface AppDirectoryFiles extends AppSourceFiles { userAdded?: true; marketListed?: true }
export interface AppDirectoryEntry extends AppSourceEntry {
  urls: AppDirectoryUrl[];
  files: AppDirectoryFiles[];
  favorite: boolean;
  marketListed: boolean;
  local: boolean;
  selected?: { url?: string; indexseedhashhex?: string };
}
export interface AppLocalInput { url?: string; indexseedhashhex?: string; name?: string; description?: string; icon?: string }
export interface AppPendingEntry extends AppLocalInput { pendingId: string; error?: string }
export interface AppDirectoryDocument {
  version: 3;
  apps: Record<string, AppDirectoryEntry>;
  pending: AppPendingEntry[];
  deletedKeys: string[];
  lastSuccessfulFetchAt: number | null;
}
/** Internal repository: deleting management material and the directory is one policy CAS. */
export interface AppDirectoryRepository {
  read(): Promise<{ document: AppDirectoryDocument; revision: number } | null>;
  write(document: AppDirectoryDocument, options: { ifRevision?: number; forgetKey?: string }): Promise<number>;
}
