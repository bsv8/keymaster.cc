// Worker-safe connect storage access (持久身份仍为 protocol)。No UI/runtime barrels are imported.
import { openConnectStorageRepository as openRawConnectStorageRepository, type ConnectStorageStores } from "./storage/protocolStorageRepository.js";
import type { ConnectSessionRecord, ConnectStorageRepository } from "@keymaster/contracts";

let dbPromise: Promise<ConnectStorageRepository> | undefined;

export function openConnectStorageRepository(): Promise<ConnectStorageRepository> {
  if (!dbPromise) return Promise.reject(new Error("Connect storage has not been bootstrapped"));
  return dbPromise;
}

/** Worker bootstrap 注入 Connect（持久身份 protocol）V1 的 插件文件 借用句柄。 */
export function configureConnectStorageRepository(
  stores: ConnectStorageStores
): void {
  dbPromise = Promise.resolve(openRawConnectStorageRepository(stores));
}

export async function getConnectSession(identity: import("@keymaster/contracts").NetworkIdentity, origin: string,authorizationId?:string): Promise<ConnectSessionRecord | null> {
  const record = await (await openConnectStorageRepository()).getConnectSession(identity, origin,authorizationId);
  if (!record || record.revokedAt !== null || !record.origin || !record.appPublicKeyHex) return null;
  return record;
}
