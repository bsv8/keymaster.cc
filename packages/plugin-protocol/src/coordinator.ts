// Worker-safe protocol storage access. No UI/runtime barrels are imported.
import { configureProtocolStorageRepository as configureRawProtocolStorageRepository, openProtocolStorageRepository as openRawProtocolStorageRepository } from "./storage/protocolStorageRepository.js";
import type { ConnectSessionRecord, ProtocolStorageRepository } from "@keymaster/contracts";
import { isVerifiedAppIdentitySnapshot } from "./appIdentity.js";

let dbPromise: Promise<ProtocolStorageRepository> | undefined;

export function openProtocolStorageRepository(): Promise<ProtocolStorageRepository> {
  dbPromise ??= openRawProtocolStorageRepository();
  return dbPromise;
}

/** Worker bootstrap 注入 protocol platform K-V。 */
export function configureProtocolStorageRepository(store: import("@keymaster/contracts").KeyValueStore): void {
  configureRawProtocolStorageRepository(store);
  dbPromise = Promise.resolve(store).then(() => openRawProtocolStorageRepository(store));
}

export async function getConnectSession(sessionId: string): Promise<ConnectSessionRecord | null> {
  const record = await (await openProtocolStorageRepository()).getConnectSession(sessionId);
  if (!record || record.revokedAt !== null || !record.origin || !isVerifiedAppIdentitySnapshot(record.appIdentity)) return null;
  return record;
}

export { isVerifiedAppIdentitySnapshot };
