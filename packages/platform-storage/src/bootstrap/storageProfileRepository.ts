import type { StorageBootstrapState, StorageBucketCatalogEntryV2 } from "@keymaster/contracts";
import { defaultDeviceBootstrapStorage, readDeviceBootstrap, type DeviceBootstrapStorage } from "./deviceBootstrapRepository.js";

function bootstrapEntryFromDeviceConnection(connection: import("@keymaster/contracts").DeviceRemoteConnectionV1): StorageBucketCatalogEntryV2 {
  return {
    bucketId: connection.remoteStorageId,
    label: connection.displayName,
    backend: connection.providerId,
    configRevision: 0,
    keyDerivation: structuredClone(connection.keyDerivation),
    encryptedConfig: structuredClone(connection.encryptedConfig),
    // The device layer intentionally has no remote revision/cache fields. The
    // Worker must read the authenticated remote head and treat this projection
    // as a bootstrap hint only.
    snapshotRevision: 0,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/** 从 V1 多桶目录读取当前桶的最小启动快照。 */
export function readStorageBootstrap(storage: DeviceBootstrapStorage = defaultDeviceBootstrapStorage()): StorageBootstrapState | null {
  const deviceBootstrap = readDeviceBootstrap(storage);
  if (deviceBootstrap?.selectedRemoteStorageId) {
    const selected = deviceBootstrap.connections.find((connection) => connection.remoteStorageId === deviceBootstrap.selectedRemoteStorageId);
    if (selected) {
      const selectedBucket = bootstrapEntryFromDeviceConnection(selected);
      return {
        selectedBackend: selected.providerId,
        selectedProfileId: selected.remoteStorageId,
        selectedBucket,
      };
    }
  }
  return null;
}
