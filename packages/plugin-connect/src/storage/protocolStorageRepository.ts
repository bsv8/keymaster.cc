import { sameNetworkIdentity } from "@keymaster/contracts";
import type {
  BorrowedModuleFileStore, ConnectSessionRecord, ProtocolCommandRecord, ProtocolFeePoolDeliveryRecord,
  ProtocolFeePoolRecord, ProtocolConnectPaymentRecord, ProtocolOriginSettingsRecord, ConnectStorageRepository,
  ApplicationConnectionEvent, ConnectedApplication, ProtocolMethod, ApplicationOpenMode,
} from "@keymaster/contracts";

export const CONNECT_STORAGE_VERSION = 1;
export interface ConnectStorageStores {
  durablePolicy: BorrowedModuleFileStore;
  sessions: BorrowedModuleFileStore;
  commandHistory: BorrowedModuleFileStore;
}
interface Policy {
  mode: ApplicationOpenMode;
  applications: ConnectedApplication[];
  events: ApplicationConnectionEvent[];
  permissions: Array<{ key: string; methods: ProtocolMethod[]; updatedAt: number }>;
  origins: ProtocolOriginSettingsRecord[];
  feePools: ProtocolFeePoolRecord[];
  deliveries: ProtocolFeePoolDeliveryRecord[];
  payments: ProtocolConnectPaymentRecord[];
}
function conflict(): Error { return Object.assign(new Error("Connect document revision conflict"), { code: "storage_conflict" }); }
function upsert<T>(rows: T[], record: T, matches: (row: T) => boolean): void {
  const index = rows.findIndex(matches);
  if (index < 0) rows.push(record); else rows[index] = record;
}

/** Business documents, each replaced with file CAS. No second index or value objects. */
function document<T>(files: BorrowedModuleFileStore, path: string, empty: () => T, validate: (value: unknown) => value is T) {
  if (!files) throw new Error(`Protocol file storage binding is required: ${path}`);
  let writeTail: Promise<void> = Promise.resolve();
  async function read() {
    const file = await files.get(path);
    if (!file) return { value: empty(), revision: 0, fileRevision: undefined as string | undefined };
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !validate(data.data)) {
      throw new Error(`Invalid Protocol document: ${path}`);
    }
    return { value: data.data as T, revision: data.revision as number, fileRevision: file.revision as string | undefined };
  }
  function update<R>(change: (value: T) => R, options: { ifRevision?: number; shouldWrite?: (result: R) => boolean } = {}): Promise<R> {
    // Read only after earlier writes settle. Separate repository instances still
    // compete through file CAS; this queue prevents self-inflicted conflicts.
    const operation = writeTail.then(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read();
        if (options.ifRevision !== undefined && options.ifRevision !== current.revision) throw conflict();
        const result = change(current.value);
        if (options.shouldWrite?.(result) === false) return result;
        const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, revision: current.revision + 1, data: current.value }));
        try {
          await files.put(path, bytes, { contentType: "application/json", ...(current.fileRevision === undefined ? { ifNoneMatch: true as const } : { ifRevision: current.fileRevision }) });
          return result;
        } catch (error) {
          if (options.ifRevision !== undefined || attempt === 7 || (error as { code?: string }).code !== "storage_conflict") throw error;
        }
      }
      throw conflict();
    });
    // A failed caller still receives its error, without poisoning later writes.
    writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  return { read, update };
}
const recordArray = (value: unknown): value is Array<Record<string, unknown>> => Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row));
export function openConnectStorageRepository(stores: ConnectStorageStores): ConnectStorageRepository {
  const policy = document<Policy>(stores.durablePolicy, "durable-policy.json", () => ({ mode: "iframe", applications: [], events: [], permissions: [], origins: [], feePools: [], deliveries: [], payments: [] }), (value): value is Policy => {
    if (!value || typeof value !== "object") return false;
    const data = value as Policy;
    return (data.mode === "iframe" || data.mode === "popup") && [data.applications, data.events, data.permissions, data.origins, data.feePools, data.deliveries, data.payments].every(recordArray);
  });
  const commands = document<ProtocolCommandRecord[]>(stores.commandHistory, "command-history.json", () => [], (value): value is ProtocolCommandRecord[] => recordArray(value) && value.every(row => typeof row.id === "string" && typeof row.updatedAt === "number"));
  const sessions = document<ConnectSessionRecord[]>(stores.sessions, "sessions.json", () => [], (value): value is ConnectSessionRecord[] => recordArray(value) && value.every(row => typeof row.sessionId === "string" && typeof row.appPublicKeyHex === "string" && typeof row.authorizationId === "string"));
  const sortedCommands = async () => (await commands.read()).value.sort((a,b) => b.updatedAt-a.updatedAt);
  return {
    getApplicationOpenMode: async () => (await policy.read()).value.mode,
    async setApplicationOpenMode(mode) { await policy.update(data => { data.mode = mode; }); },
    listApplicationEvents: async () => (await policy.read()).value.events,
    async putApplicationEvent(event) { await policy.update(data => upsert(data.events,event,row => row.id===event.id)); },
    listApplications: async () => (await policy.read()).value.applications,
    async putApplication(application) { await policy.update(data => upsert(data.applications,application,row => row.key===application.key)); },
    getApplicationPermissions: async key => (await policy.read()).value.permissions.find(row => row.key===key) ?? null,
    async setApplicationPermission(key, method, enabled) {
      await policy.update(data => {
        const methods = new Set(data.permissions.find(row => row.key===key)?.methods ?? []);
        if (enabled) methods.add(method); else methods.delete(method);
        const at = Date.now();
        upsert(data.permissions,{ key, methods: [...methods], updatedAt: at },row => row.key===key);
        data.events.push({ id: crypto.randomUUID(), applicationKey: key, at, kind: enabled ? "permission-granted" : "permission-revoked", method });
      });
    },
    listCommands: sortedCommands,
    async putCommand(record) { await commands.update(rows => upsert(rows,record,row => row.id===record.id)); },
    getCommand: async id => (await commands.read()).value.find(row => row.id===id) ?? null,
    listCommandsByOrigin: async origin => (await sortedCommands()).filter(row => row.origin===origin),
    getOrigin: async origin => (await policy.read()).value.origins.find(row => row.origin===origin) ?? null,
    async putOrigin(record) { await policy.update(data => upsert(data.origins,record,row => row.origin===record.origin)); },
    listOrigins: async () => (await policy.read()).value.origins,
    getFeePool: async key => (await policy.read()).value.feePools.find(row => row.poolKey===key) ?? null,
    async putFeePool(record) { await policy.update(data => upsert(data.feePools,record,row => row.poolKey===record.poolKey)); },
    async deleteFeePool(key) { await policy.update(data => { data.feePools=data.feePools.filter(row => row.poolKey!==key); }); },
    listFeePoolsByOrigin: async origin => (await policy.read()).value.feePools.filter(row => row.origin===origin),
    async putFeePoolDelivery(record) { await policy.update(data => upsert(data.deliveries,record,row => row.id===record.id)); },
    getFeePoolDelivery: async id => (await policy.read()).value.deliveries.find(row => row.id===id) ?? null,
    listFeePoolDeliveriesByOrigin: async origin => (await policy.read()).value.deliveries.filter(row => row.origin===origin),
    async settleFeePoolDelivery(id, settledTxid, settledAt) {
      await policy.update(data => {
        const record=data.deliveries.find(row => row.id===id);
        if (!record) throw new Error(`Protocol fee pool delivery not found: ${id}`);
        Object.assign(record,{ settledTxid, settledAt });
      });
    },
    getConnectPayment: async key => (await policy.read()).value.payments.find(row => row.key===key) ?? null,
    async getConnectPaymentEntry(key) {
      const data=await policy.read(); const record=data.value.payments.find(row => row.key===key);
      return record ? { record, revision:data.revision } : null;
    },
    async claimConnectPayment(record, options={}) {
      // The identity check, pending limit and claim share one document CAS.
      return policy.update(data => {
        const existing=data.payments.find(row => row.key===record.key);
        if (existing) return { created:false, record:existing };
        if (options.maxPending !== undefined && data.payments.filter(row => row.appPublicKeyHex===record.appPublicKeyHex && sameNetworkIdentity(row.networkIdentity,record.networkIdentity) && row.status==="pending").length >= options.maxPending) throw new Error("payment-pending-limit");
        data.payments.push(record); return { created:true, record };
      }, { shouldWrite: result => result.created });
    },
    async putConnectPayment(record) { await policy.update(data => upsert(data.payments,record,row => row.key===record.key)); },
    async putConnectPaymentIfRevision(record,revision) { await policy.update(data => upsert(data.payments,record,row => row.key===record.key), { ifRevision: revision }); },
    listConnectPaymentsByOrigin: async origin => (await policy.read()).value.payments.filter(row => row.origin===origin),
    async putConnectSession(record) {
      if (!record.appPublicKeyHex || !record.authorizationId) throw new Error("Verified App identity required");
      await sessions.update(rows => upsert(rows,record,row => row.sessionId===record.sessionId));
    },
    async getConnectSession(identity,origin,authorizationId) {
      const matches=(await sessions.read()).value.filter(record => record.networkIdentity && sameNetworkIdentity(record.networkIdentity,identity) && record.ownerPublicKeyHex.toLowerCase()===identity.publicKeyHex.toLowerCase() && record.origin===origin && (!authorizationId || record.authorizationId===authorizationId));
      return matches.length===1 ? matches[0]! : null;
    },
    listConnectSessions: async () => (await sessions.read()).value,
    listConnectSessionsByOrigin: async origin => (await sessions.read()).value.filter(row => row.origin===origin),
  };
}
