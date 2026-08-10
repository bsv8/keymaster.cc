// Worker-safe protocol storage access. No UI/runtime barrels are imported.
import { openProtocolStorageDb as openRawProtocolStorageDb } from "./protocolStorageDb.js";
import type { ConnectSessionRecord, ProtocolStorageDb } from "@keymaster/contracts";
import { isVerifiedAppIdentitySnapshot } from "./appIdentity.js";

let dbPromise: Promise<ProtocolStorageDb> | undefined;

export function openProtocolStorageDb(): Promise<ProtocolStorageDb> {
  dbPromise ??= openRawProtocolStorageDb();
  return dbPromise;
}

export async function getConnectSession(sessionId: string): Promise<ConnectSessionRecord | null> {
  const record = await (await openProtocolStorageDb()).getConnectSession(sessionId);
  if (!record || record.revokedAt !== null || !record.origin || !isVerifiedAppIdentitySnapshot(record.appIdentity)) return null;
  return record;
}

export { isVerifiedAppIdentitySnapshot };
