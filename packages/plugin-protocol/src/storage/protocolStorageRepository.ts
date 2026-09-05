// Protocol 平台 K-V Repository。
//
// Connect session、origin 策略、费用池和命令历史全部位于 `protocol` platform
// namespace。Repository 不知道 Provider/物理路径，也不保留旧 schema 迁移。

import type {
  ConnectSessionRecord,
  KeyValueStore,
  LaunchTokenRecord,
  ProtocolCommandRecord,
  ProtocolFeePoolRecord,
  ProtocolOriginSettingsRecord,
  ProtocolStorageRepository
} from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

export const PROTOCOL_STORAGE_ID = "protocol";
export const PROTOCOL_STORAGE_VERSION = 1;
const PARTITION = "protocol";
const COMMAND_PREFIX = "commands/";
const ORIGIN_PREFIX = "origins/";
const FEE_POOL_PREFIX = "fee-pools/";
const SESSION_PREFIX = "sessions/";
const LAUNCH_TOKEN_PREFIX = "launch-tokens/";

let configuredStore: KeyValueStore | undefined;
let testStore: KeyValueStore | undefined;

function storeForCall(): KeyValueStore {
  if (configuredStore) return configuredStore;
  testStore ??= createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: PROTOCOL_STORAGE_ID, schemaVersion: 1, bucketId: "test-memory", bucketGeneration: 1 });
  return testStore;
}

export function configureProtocolStorageRepository(store: KeyValueStore): void {
  configuredStore?.close();
  configuredStore = store;
}

export function disposeProtocolStorageRepository(): void {
  configuredStore?.close();
  configuredStore = undefined;
  testStore?.close();
  testStore = undefined;
}

async function listValues<T>(store: KeyValueStore, prefix: string): Promise<Array<{ key: string; value: T; revision: number }>> {
  const values: Array<{ key: string; value: T; revision: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix, cursor, limit: 1000 });
    values.push(...page.entries.map((entry) => ({ key: entry.key, value: entry.value as unknown as T, revision: entry.revision })));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function currentRevision(store: KeyValueStore): Promise<number> {
  return (await store.list({ partition: PARTITION, limit: 1 })).revision;
}

export async function openProtocolStorageRepository(store: KeyValueStore = storeForCall()): Promise<ProtocolStorageRepository> {
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("Protocol storage is closed"); };
  const commandKey = (id: string) => `${COMMAND_PREFIX}${id}`;
  const originKey = (origin: string) => `${ORIGIN_PREFIX}${encodeURIComponent(origin)}`;
  const feePoolKey = (key: string) => `${FEE_POOL_PREFIX}${encodeURIComponent(key)}`;
  const sessionKey = (id: string) => `${SESSION_PREFIX}${id}`;
  const launchTokenKey = (token: string) => `${LAUNCH_TOKEN_PREFIX}${token}`;

  return {
    async putCommand(record: ProtocolCommandRecord) { assertOpen(); await store.put(commandKey(record.id), record, { partition: PARTITION }); },
    async getCommand(id: string) { assertOpen(); return (await store.get<ProtocolCommandRecord>(commandKey(id), { partition: PARTITION }))?.value ?? null; },
    async listCommandsByOrigin(origin: string) { assertOpen(); return (await listValues<ProtocolCommandRecord>(store, COMMAND_PREFIX)).map((row) => row.value).filter((row) => row.origin === origin).sort((a, b) => b.updatedAt - a.updatedAt); },
    async getOrigin(origin: string) { assertOpen(); return (await store.get<ProtocolOriginSettingsRecord>(originKey(origin), { partition: PARTITION }))?.value ?? null; },
    async putOrigin(record: ProtocolOriginSettingsRecord) { assertOpen(); await store.put(originKey(record.origin), record, { partition: PARTITION }); },
    async listOrigins() { assertOpen(); return (await listValues<ProtocolOriginSettingsRecord>(store, ORIGIN_PREFIX)).map((row) => row.value); },
    async getFeePool(poolKey: string) { assertOpen(); return (await store.get<ProtocolFeePoolRecord>(feePoolKey(poolKey), { partition: PARTITION }))?.value ?? null; },
    async putFeePool(record: ProtocolFeePoolRecord) { assertOpen(); await store.put(feePoolKey(record.poolKey), record, { partition: PARTITION }); },
    async deleteFeePool(poolKey: string) { assertOpen(); await store.delete(feePoolKey(poolKey), { partition: PARTITION }); },
    async listFeePoolsByOrigin(origin: string) { assertOpen(); return (await listValues<ProtocolFeePoolRecord>(store, FEE_POOL_PREFIX)).map((row) => row.value).filter((row) => row.origin === origin); },
    async putConnectSession(record: ConnectSessionRecord) { assertOpen(); await store.put(sessionKey(record.sessionId), record, { partition: PARTITION }); },
    async getConnectSession(sessionId: string) { assertOpen(); return (await store.get<ConnectSessionRecord>(sessionKey(sessionId), { partition: PARTITION }))?.value ?? null; },
    async listConnectSessionsByOrigin(origin: string) { assertOpen(); return (await listValues<ConnectSessionRecord>(store, SESSION_PREFIX)).map((row) => row.value).filter((row) => row.origin === origin); },
    async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
      assertOpen();
      const sessions = await listValues<ConnectSessionRecord>(store, SESSION_PREFIX);
      const revision = await currentRevision(store);
      const revokedAt = Date.now();
      const operations = [
        { type: "put" as const, key: sessionKey(record.sessionId), value: record },
        ...sessions.filter((row) => row.value.sessionId !== record.sessionId && row.value.origin === record.origin && row.value.revokedAt === null).map((row) => ({ type: "put" as const, key: row.key, value: { ...row.value, revokedAt } }))
      ];
      await store.commit({ partition: PARTITION, ifRevision: revision, operations });
    },
    async putLaunchToken(record: LaunchTokenRecord) { assertOpen(); await store.put(launchTokenKey(record.token), record, { partition: PARTITION }); },
    async getLaunchToken(token: string) { assertOpen(); return (await store.get<LaunchTokenRecord>(launchTokenKey(token), { partition: PARTITION }))?.value ?? null; },
    async consumeLaunchToken(token: string) {
      assertOpen();
      const entry = await store.get<LaunchTokenRecord>(launchTokenKey(token), { partition: PARTITION });
      if (!entry || entry.value.consumed) return;
      await store.commit({ partition: PARTITION, ifRevision: entry.revision, operations: [{ type: "put", key: launchTokenKey(token), value: { ...entry.value, consumed: true } }] });
    },
    async deleteLaunchToken(token: string) { assertOpen(); await store.delete(launchTokenKey(token), { partition: PARTITION }); }
  };
}
