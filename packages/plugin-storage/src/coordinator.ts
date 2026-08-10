// Worker-safe Storage runtime exports. Keep this entrypoint free of the page
// manifest and React settings UI so it can be bundled into SharedWorker.
export { createStorageService, StorageServiceImpl, STORAGE_SECRET_SCOPE } from "./storageService.js";
export { openStorageDb, STORAGE_DB_NAME, STORAGE_DB_VERSION } from "./storageDb.js";
export type { StorageDb, StoredMultipartUploadRecord, StoredProviderConfigRecord } from "./storageDb.js";
export { StorageServiceError } from "./storageErrors.js";
