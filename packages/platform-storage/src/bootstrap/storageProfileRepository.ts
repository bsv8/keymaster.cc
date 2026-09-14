import type { StorageBootstrapState } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { STORAGE_CATALOG_KEY, validateStorageCatalog } from "./storageCatalogRepository.js";

/** 从 V1 多桶目录读取当前桶的最小启动快照。 */
export function readStorageBootstrap(storage: Storage = localStorage): StorageBootstrapState | null {
  const catalogRaw = storage.getItem(STORAGE_CATALOG_KEY);
  if (catalogRaw === null) return null;
  let catalog;
  try { catalog = validateStorageCatalog(JSON.parse(catalogRaw) as unknown); }
  catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    throw new StorageRuntimeError("storage_provider_error", "Storage catalog JSON is invalid");
  }
  const selected = catalog.selectedBucketId ? catalog.buckets.find((bucket) => bucket.bucketId === catalog.selectedBucketId) : undefined;
  if (!selected) return null;
  return {
    selectedBackend: selected.backend,
    selectedProfileId: selected.bucketId,
    selectedBucket: structuredClone(selected)
  };
}
