// Worker-safe protocol storage access. No UI/runtime barrels are imported.
import { openProtocolStorageRepository as openRawProtocolStorageRepository, type ProtocolStorageStores } from "./storage/protocolStorageRepository.js";
import type { ConnectSessionRecord, ProtocolStorageRepository } from "@keymaster/contracts";
import { isVerifiedAppIdentitySnapshot } from "./appIdentity.js";

let dbPromise: Promise<ProtocolStorageRepository> | undefined;

export function openProtocolStorageRepository(): Promise<ProtocolStorageRepository> {
  if (!dbPromise) return Promise.reject(new Error("Protocol storage has not been bootstrapped"));
  return dbPromise;
}

/** Worker bootstrap 注入 Protocol V1 的 purpose-scoped K-V 借用句柄。 */
export function configureProtocolStorageRepository(
  stores: ProtocolStorageStores
): void {
  dbPromise = Promise.resolve(openRawProtocolStorageRepository(stores));
}

export async function getConnectSession(sessionId: string): Promise<ConnectSessionRecord | null> {
  const record = await (await openProtocolStorageRepository()).getConnectSession(sessionId);
  if (!record || record.revokedAt !== null || !record.origin || !isVerifiedAppIdentitySnapshot(record.appIdentity)) return null;
  return record;
}

export { isVerifiedAppIdentitySnapshot };
