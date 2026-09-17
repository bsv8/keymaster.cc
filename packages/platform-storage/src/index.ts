export { storagePlatformPlugin, storagePlatformSetup, STORAGE_PLATFORM_PLUGIN_ID } from "./manifest.js";
export { StorageOnboardingPage } from "./ui/StorageOnboardingPage.js";
export { StorageBucketManagerPage } from "./ui/StorageBucketManagerPage.js";
export { BucketConnectionFields } from "./ui/BucketConnectionFields.js";
export type { BucketConnectionFieldsProps } from "./ui/BucketConnectionFields.js";
export {
  EMPTY_BUCKET_DRAFT,
  S3_CONFIG_MODES,
  bucketDraftFingerprint,
  connectionFromBucketDraft,
  createBucketProvider,
  normalizedProviderConfigFromBucketDraft,
  providerConfigFromBucketDraft,
  updateBucketDraft,
  validateBucketDraft
} from "./ui/bucketConnectionDraft.js";
export type { BucketBackend, BucketDraft, BucketDraftValidationCode, BucketDraftValidationError, BucketProviderInput, S3ConfigMode } from "./ui/bucketConnectionDraft.js";
export { StorageUnavailableGuard } from "./ui/StorageUnavailableGuard.js";
export { StorageRuntimeControllerImpl, createStorageRuntimeController } from "./runtime/storageController.js";
export type { StorageRuntimeSnapshot } from "./runtime/storageController.js";
export { openMultipartUploadRepository, MULTIPART_REPOSITORY_NAME, MULTIPART_REPOSITORY_VERSION } from "./bootstrap/multipartUploadRepository.js";
export type { MultipartUploadRepository, StoredMultipartUploadRecord } from "./bootstrap/multipartUploadRepository.js";
export { createBucketObjectStoreCapabilityState, setBucketObjectStoreCapabilityMode, commitAutomaticBucketObjectStoreCapability } from "./bucket-providers/bucketObjectStore.js";
export type { BucketObjectStore, BucketListOutput, BucketGetOutput, BucketObjectStoreCapabilityState, BucketConditionalCapability, BucketConditionalWriteMode, BucketConditionalCapabilitySource } from "./bucket-providers/bucketObjectStore.js";
export * from "./bucket-providers/bucketPath.js";
export * from "./storage-access/owner-app/ownerAppNamespace.js";
export * from "./bucket-providers/s3/s3ClientFactory.js";
export { StorageRuntimeError } from "./runtime/storageError.js";
export { browserStorageLocks, browserStorageLockMode } from "./runtime/browserLocks.js";
export { StorageHealthController } from "./runtime/storageHealthController.js";
export type { StorageHealthSnapshot, StorageProbeOptions } from "./runtime/storageHealthController.js";
export { StorageRpcProxy } from "./coordinator/storageRpcProxy.js";
export type { BucketProvider, BucketObject, BucketListPage, BucketProbeResult } from "./bucket-providers/bucketProvider.js";
export { createLocalStorageBucketProvider } from "./bucket-providers/local/localStorageBucketProvider.js";
export type { LocalStorageLike, LocalStorageLocks, LocalStorageBucketProviderOptions, LocalStorageBridgeRequest, LocalStorageBridgeResponse } from "./bucket-providers/local/localStorageBucketProvider.js";
export { createProviderBackedBucketObjectStore } from "./bucket-providers/providerBackedBucketObjectStore.js";
export { createS3BucketProvider } from "./bucket-providers/s3/s3BucketProvider.js";
export { createS3BucketObjectStore } from "./bucket-providers/s3/s3BucketObjectStore.js";
export type { S3BucketProviderOptions } from "./bucket-providers/s3/s3BucketProvider.js";
export { createKeyValueStore } from "./kv-engine/partitionedKvEngine.js";
export type { KeyValueStoreOptions, KeyValueStoreMaintenance, KeyValueGarbageCollectionResult } from "./kv-engine/partitionedKvEngine.js";
export { createFixedCasSnapshotStore } from "./snapshot/fixedCasSnapshotStore.js";
export type { FixedCasSnapshotStoreOptions } from "./snapshot/fixedCasSnapshotStore.js";
export { createPlatformRootStore } from "./storage-access/platform-root/platformRootStore.js";
export type { PlatformRootStoreOptions } from "./storage-access/platform-root/platformRootStore.js";
export { createOwnerAppStore } from "./storage-access/owner-app/ownerAppStore.js";
export type { OwnerAppStoreOptions } from "./storage-access/owner-app/ownerAppStore.js";
export { createOwnerFileStore } from "./storage-access/owner-app/ownerFileStore.js";
export type { OwnerFileStoreOptions } from "./storage-access/owner-app/ownerFileStore.js";
export { createKeyHoldDocument, decryptKeyHoldDocument, parseKeyHoldDocument, serializeKeyHoldDocument } from "./keys/keyholdDocument.js";
export { createKeyHoldRepository, KEYHOLD_KEYS_PREFIX, KEYHOLD_FILE_EXTENSION, KEYHOLD_LIST_LIMIT } from "./keys/keyholdRepository.js";
export type { KeyHoldRepository, KeyHoldFile, KeyHoldFileSummary, KeyHoldInvalidFile, KeyHoldListResult, UnlockedKeyHold } from "./keys/keyholdRepository.js";
export { defaultDeviceStorage, listStorageKeys } from "./bootstrap/deviceStorage.js";
export type { DeviceLocalStorage } from "./bootstrap/deviceStorage.js";
export { createDeviceRecordRepository } from "./bootstrap/deviceRecordRepository.js";
export type { DeviceRecordEntry, DeviceRecordListResult, DeviceRecordRepository } from "./bootstrap/deviceRecordRepository.js";
export { readSession, writeSession, ensureSessionId, updateSession, setActiveBucket, setActiveKey, setSessionKeyDerivation, clearSession, generateSessionId, isValidSessionId } from "./bootstrap/sessionRecord.js";
export { encryptDeviceConfig, decryptDeviceConfig } from "./bootstrap/deviceConfigCrypto.js";
export type { DeviceS3LocationV1 } from "./bootstrap/deviceConfigCrypto.js";
export { createKeyLock } from "./bootstrap/keyLock.js";
export type { KeyLock, KeyLockOptions, KeyLockReadResult } from "./bootstrap/keyLock.js";
