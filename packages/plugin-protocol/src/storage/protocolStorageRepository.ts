// Protocol V1 storage repository.
//
// Each durable concern is bound to its own Host-owned purpose handle:
//   - durable-policy: origin settings and fee-pool state;
//   - sessions: connect authorization sessions;
//   - command-history: terminal, user-visible command history.
//
// The repository only borrows these handles. Their lifecycle remains owned by
// the Host, so this module never calls `close()` on an injected store.

import type {
  BorrowedKeyValueStore,
  ConnectSessionRecord,
  ProtocolCommandRecord,
  ProtocolFeePoolRecord,
  ProtocolOriginSettingsRecord,
  ProtocolStorageRepository
} from "@keymaster/contracts";

export const PROTOCOL_STORAGE_VERSION = 1;

/** The three central purposes required by Protocol V1. */
export interface ProtocolStorageStores {
  durablePolicy: BorrowedKeyValueStore;
  sessions: BorrowedKeyValueStore;
  commandHistory: BorrowedKeyValueStore;
}

const PARTITION = "protocol";
const COMMAND_PREFIX = "commands/";
const ORIGIN_PREFIX = "origins/";
const FEE_POOL_PREFIX = "fee-pools/";
const SESSION_PREFIX = "sessions/";

function requireStore(store: BorrowedKeyValueStore | undefined, name: string): BorrowedKeyValueStore {
  if (!store) throw new Error(`Protocol ${name} storage binding is required`);
  return store;
}

async function listValues<T>(
  store: BorrowedKeyValueStore,
  prefix: string
): Promise<Array<{ key: string; value: T; revision: number }>> {
  const values: Array<{ key: string; value: T; revision: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix, cursor, limit: 1000 });
    values.push(...page.entries.map((entry) => ({
      key: entry.key,
      value: entry.value as unknown as T,
      revision: entry.revision
    })));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function currentRevision(store: BorrowedKeyValueStore): Promise<number> {
  return (await store.list({ partition: PARTITION, limit: 1 })).revision;
}

/**
 * Open the Protocol V1 repository over three independently bound stores.
 * Storage errors are intentionally not caught: callers must observe failed
 * user writes and decide how to surface them.
 */
export function openProtocolStorageRepository(stores: ProtocolStorageStores): ProtocolStorageRepository {
  const durablePolicy = requireStore(stores?.durablePolicy, "durable-policy");
  const sessions = requireStore(stores?.sessions, "sessions");
  const commandHistory = requireStore(stores?.commandHistory, "command-history");

  const commandKey = (id: string) => `${COMMAND_PREFIX}${id}`;
  const originKey = (origin: string) => `${ORIGIN_PREFIX}${encodeURIComponent(origin)}`;
  const feePoolKey = (key: string) => `${FEE_POOL_PREFIX}${encodeURIComponent(key)}`;
  const sessionKey = (id: string) => `${SESSION_PREFIX}${id}`;

  return {
    /* ----- command-history ----- */
    async putCommand(record: ProtocolCommandRecord) {
      await commandHistory.put(commandKey(record.id), record, { partition: PARTITION });
    },
    async getCommand(id: string) {
      return (await commandHistory.get<ProtocolCommandRecord>(commandKey(id), { partition: PARTITION }))?.value ?? null;
    },
    async listCommandsByOrigin(origin: string) {
      return (await listValues<ProtocolCommandRecord>(commandHistory, COMMAND_PREFIX))
        .map((row) => row.value)
        .filter((row) => row.origin === origin)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /* ----- durable-policy ----- */
    async getOrigin(origin: string) {
      return (await durablePolicy.get<ProtocolOriginSettingsRecord>(originKey(origin), { partition: PARTITION }))?.value ?? null;
    },
    async putOrigin(record: ProtocolOriginSettingsRecord) {
      await durablePolicy.put(originKey(record.origin), record, { partition: PARTITION });
    },
    async listOrigins() {
      return (await listValues<ProtocolOriginSettingsRecord>(durablePolicy, ORIGIN_PREFIX)).map((row) => row.value);
    },
    async getFeePool(poolKey: string) {
      return (await durablePolicy.get<ProtocolFeePoolRecord>(feePoolKey(poolKey), { partition: PARTITION }))?.value ?? null;
    },
    async putFeePool(record: ProtocolFeePoolRecord) {
      await durablePolicy.put(feePoolKey(record.poolKey), record, { partition: PARTITION });
    },
    async deleteFeePool(poolKey: string) {
      await durablePolicy.delete(feePoolKey(poolKey), { partition: PARTITION });
    },
    async listFeePoolsByOrigin(origin: string) {
      return (await listValues<ProtocolFeePoolRecord>(durablePolicy, FEE_POOL_PREFIX))
        .map((row) => row.value)
        .filter((row) => row.origin === origin);
    },

    /* ----- sessions ----- */
    async putConnectSession(record: ConnectSessionRecord) {
      await sessions.put(sessionKey(record.sessionId), record, { partition: PARTITION });
    },
    async getConnectSession(sessionId: string) {
      return (await sessions.get<ConnectSessionRecord>(sessionKey(sessionId), { partition: PARTITION }))?.value ?? null;
    },
    async listConnectSessionsByOrigin(origin: string) {
      return (await listValues<ConnectSessionRecord>(sessions, SESSION_PREFIX))
        .map((row) => row.value)
        .filter((row) => row.origin === origin);
    },
    async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
      const existing = await listValues<ConnectSessionRecord>(sessions, SESSION_PREFIX);
      const revision = await currentRevision(sessions);
      const revokedAt = Date.now();
      const operations = [
        { type: "put" as const, key: sessionKey(record.sessionId), value: record },
        ...existing
          .filter((row) => row.value.sessionId !== record.sessionId
            && row.value.origin === record.origin
            && row.value.revokedAt === null)
          .map((row) => ({
            type: "put" as const,
            key: row.key,
            value: { ...row.value, revokedAt }
          }))
      ];
      await sessions.commit({ partition: PARTITION, ifRevision: revision, operations });
    }
  };
}
