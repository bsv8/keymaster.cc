import { sameNetworkIdentity } from "@keymaster/contracts";
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
  ProtocolFeePoolDeliveryRecord,
  ProtocolFeePoolRecord,
  ProtocolConnectPaymentRecord,
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
const FEE_POOL_DELIVERY_PREFIX = "fee-pool-deliveries/";
const CONNECT_PAYMENT_PREFIX = "connect-payments/";
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
  const feePoolDeliveryKey = (id: string) => `${FEE_POOL_DELIVERY_PREFIX}${encodeURIComponent(id)}`;
  const sessionKey = (id: string) => `${SESSION_PREFIX}${encodeURIComponent(id)}`;
  const connectPaymentKey = (key: string) => `${CONNECT_PAYMENT_PREFIX}${encodeURIComponent(key)}`;

  return {
    async getApplicationOpenMode() {
      const record = await durablePolicy.get<{ mode: "iframe" | "popup" }>("wallet-application-open-mode", { partition: PARTITION });
      if (!record) return "iframe";
      if (record.value.mode !== "iframe" && record.value.mode !== "popup") throw new Error("Invalid stored application open mode");
      return record.value.mode;
    },
    async setApplicationOpenMode(mode) {
      await durablePolicy.put("wallet-application-open-mode", { mode }, { partition: PARTITION });
    },
    async listApplicationEvents() {
      return (await listValues<import("@keymaster/contracts").ApplicationConnectionEvent>(durablePolicy, "application-event:")).map(row => row.value);
    },
    async putApplicationEvent(event) {
      await durablePolicy.put(`application-event:${event.id}`, event, { partition: PARTITION });
    },
    async listApplications() {
      return (await listValues<import("@keymaster/contracts").ConnectedApplication>(durablePolicy, "application:")).map(row => row.value);
    },
    async putApplication(application) {
      await durablePolicy.put(`application:${encodeURIComponent(application.key)}`, application, { partition: PARTITION });
    },
    async getApplicationPermissions(key: string) {
      return (await durablePolicy.get<{ key: string; methods: import("@keymaster/contracts").ProtocolMethod[]; updatedAt: number }>(`app-permission:${encodeURIComponent(key)}`, { partition: PARTITION }))?.value ?? null;
    },
    async setApplicationPermission(key, method, enabled) {
      const storeKey = `app-permission:${encodeURIComponent(key)}`;
      for (let attempt = 0; attempt < 8; attempt++) {
        const revision = await currentRevision(durablePolicy);
        const previous = (await durablePolicy.get<{ methods: import("@keymaster/contracts").ProtocolMethod[] }>(storeKey, { partition: PARTITION }))?.value;
        const methods = new Set(previous?.methods ?? []);
        if (enabled) methods.add(method); else methods.delete(method);
        try {
          const at = Date.now(), id = crypto.randomUUID();
          await durablePolicy.commit({ partition: PARTITION, ifRevision: revision, operations: [
            { type: "put", key: storeKey, value: { key, methods: [...methods], updatedAt: at } },
            { type: "put", key: `application-event:${id}`, value: { id, applicationKey: key, at, kind: enabled ? "permission-granted" : "permission-revoked", method } }
          ] });
          return;
        } catch (error) { if (attempt === 7 || (error as { code?: string }).code !== "storage_conflict") throw error; }
      }
    },
    async listCommands() {
      return (await listValues<ProtocolCommandRecord>(commandHistory, COMMAND_PREFIX)).map(row => row.value).sort((a, b) => b.updatedAt - a.updatedAt);
    },
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

    /* ----- feePoolDeliveries (E01) ----- */
    async putFeePoolDelivery(record: ProtocolFeePoolDeliveryRecord) {
      await durablePolicy.put(feePoolDeliveryKey(record.id), record, { partition: PARTITION });
    },
    async getFeePoolDelivery(id: string) {
      return (await durablePolicy.get<ProtocolFeePoolDeliveryRecord>(feePoolDeliveryKey(id), { partition: PARTITION }))?.value ?? null;
    },
    async listFeePoolDeliveriesByOrigin(origin: string) {
      return (await listValues<ProtocolFeePoolDeliveryRecord>(durablePolicy, FEE_POOL_DELIVERY_PREFIX))
        .map((row) => row.value)
        .filter((row) => row.origin === origin);
    },
    async settleFeePoolDelivery(id: string, settledTxid: string, settledAt: number) {
      const existing = (await durablePolicy.get<ProtocolFeePoolDeliveryRecord>(feePoolDeliveryKey(id), { partition: PARTITION }))?.value;
      if (!existing) throw new Error(`Protocol fee pool delivery not found: ${id}`);
      await durablePolicy.put(feePoolDeliveryKey(id), { ...existing, settledTxid, settledAt }, { partition: PARTITION });
    },

    /* ----- Connect payment idempotency ----- */
    async getConnectPayment(key: string) {
      return (await durablePolicy.get<ProtocolConnectPaymentRecord>(connectPaymentKey(key), { partition: PARTITION }))?.value ?? null;
    },
    async getConnectPaymentEntry(key: string) {
      const entry = await durablePolicy.get<ProtocolConnectPaymentRecord>(connectPaymentKey(key), { partition: PARTITION });
      return entry ? { record: entry.value, revision: entry.revision } : null;
    },
    async claimConnectPayment(record: ProtocolConnectPaymentRecord, options: { maxPending?: number } = {}) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // Read the partition revision BEFORE checking the key. A competing
        // claim changes the revision; this claim then fails CAS instead of
        // overwriting the winner.
        const revision = await currentRevision(durablePolicy);
        const existing = (await durablePolicy.get<ProtocolConnectPaymentRecord>(connectPaymentKey(record.key), { partition: PARTITION }))?.value ?? null;
        if (existing) return { created: false, record: existing };
        if (options.maxPending !== undefined) {
          const pending = (await listValues<ProtocolConnectPaymentRecord>(durablePolicy, CONNECT_PAYMENT_PREFIX))
            .map((row) => row.value)
            .filter((row) => row.origin === record.origin && row.status === "pending").length;
          if (pending >= options.maxPending) throw new Error("payment-pending-limit");
        }
        try {
          await durablePolicy.commit({
            partition: PARTITION,
            ifRevision: revision,
            operations: [{ type: "put", key: connectPaymentKey(record.key), value: record }],
          });
          return { created: true, record };
        } catch (error) {
          if (attempt === 7) throw error;
        }
      }
      throw new Error("Protocol connect payment claim retry exhausted");
    },
    async putConnectPayment(record: ProtocolConnectPaymentRecord) {
      await durablePolicy.put(connectPaymentKey(record.key), record, { partition: PARTITION });
    },
    async putConnectPaymentIfRevision(record: ProtocolConnectPaymentRecord, revision: number) {
      await durablePolicy.put(connectPaymentKey(record.key), record, { partition: PARTITION, ifRevision: revision });
    },
    async listConnectPaymentsByOrigin(origin: string) {
      return (await listValues<ProtocolConnectPaymentRecord>(durablePolicy, CONNECT_PAYMENT_PREFIX))
        .map((row) => row.value)
        .filter((row) => row.origin === origin);
    },

    /* ----- sessions ----- */
    async putConnectSession(record: ConnectSessionRecord) {
      await sessions.put(sessionKey(record.sessionId), record, { partition: PARTITION });
    },
    async getConnectSession(identity: import("@keymaster/contracts").NetworkIdentity, origin: string) {
      const matches = (await listValues<ConnectSessionRecord>(sessions, SESSION_PREFIX))
        .map(row => row.value).filter(record => record.networkIdentity && sameNetworkIdentity(record.networkIdentity, identity)
          && record.ownerPublicKeyHex.toLowerCase() === identity.publicKeyHex.toLowerCase()
          && record.origin === origin);
      return matches.length === 1 ? matches[0]! : null;
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
            && row.value.networkIdentity.bsvNetwork === record.networkIdentity.bsvNetwork
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
