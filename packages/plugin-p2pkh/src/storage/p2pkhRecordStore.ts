// P2PKH 记录数据库：用受限 KeyValueStore 承载业务记录。
//
// 这里保留 repository 需要的 transaction/objectStore/index 抽象，但这些名称
// 只表示内存中的记录操作，不是浏览器数据库 API。每个写事务结束时通过一次
// K-V commit 原子发布，读取只看当前句柄已经加载的桶快照。

import type { KeyValueCommitOperation, KeyValueStore } from "@keymaster/contracts";

export type RecordKey = string | number | readonly (string | number)[];

export interface RecordKeyRange {
  lower?: RecordKey;
  upper?: RecordKey;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

export type RecordQuery = RecordKey | RecordKeyRange | null | undefined;
export type RecordMode = "readonly" | "readwrite";
type PlainRecord = object;

const compare = (left: RecordKey, right: RecordKey): number => {
  const a = Array.isArray(left) ? left : [left];
  const b = Array.isArray(right) ? right : [right];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index];
    const bv = b[index];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
};

export function recordKeyRange(lower: RecordKey, upper: RecordKey, lowerOpen = false, upperOpen = false): RecordKeyRange {
  return { lower, upper, lowerOpen, upperOpen };
}

function matches(value: RecordKey, query: RecordQuery): boolean {
  if (query === undefined || query === null) return true;
  if (typeof query === "object" && !Array.isArray(query) && ("lower" in query || "upper" in query)) {
    const range = query as RecordKeyRange;
    if (range.lower !== undefined && (compare(value, range.lower) < 0 || (range.lowerOpen && compare(value, range.lower) === 0))) return false;
    if (range.upper !== undefined && (compare(value, range.upper) > 0 || (range.upperOpen && compare(value, range.upper) === 0))) return false;
    return true;
  }
  return compare(value, query as RecordKey) === 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** JSON 记录的规范化编码；对象字段排序，避免字段插入顺序造成假冲突。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function pathValue(record: PlainRecord, path: string | string[]): RecordKey | undefined {
  const fields = record as Record<string, unknown>;
  if (Array.isArray(path)) return path.map((part) => fields[part] as string | number);
  return fields[path] as string | number | undefined;
}

const INDEX_PATHS: Record<string, Record<string, string | string[]>> = {
  p2pkh_addresses: { publicKeyHex: "publicKeyHex", network: "network", address: "address" },
  p2pkh_transactions: {
    resourceId: "resourceId", resourceBlockHeight: ["resourceId", "blockHeight"], resourceTxid: ["resourceId", "txid"],
    resourceTimeline: ["resourceId", "lastConfirmedAt", "txid"], inputOutpointKeys: "inputOutpointKeys", ownedOutpointKeys: "ownedOutpointKeys", txid: "txid"
  },
  p2pkh_owned_outpoints: {
    resourceChainState: ["resourceId", "chainState"], chainState: "chainState", resourceTxid: ["resourceId", "txid"],
    resourceTimeline: ["resourceId", "updatedAt", "outpointKey"], resourceOutpointKey: ["resourceId", "outpointKey"], outpointKey: "outpointKey",
    spentByTxid: "spentByTxid", resourceCreatedBlockHeight: ["resourceId", "createdBlockHeight"]
  },
  p2pkh_transaction_sync: { resourceId: "resourceId" },
  p2pkh_local_transactions: {
    resourceId: "resourceId", resourceChainResolution: ["resourceId", "chainResolution"], resourceTxid: ["resourceId", "txid"],
    resourceTimeline: ["resourceId", "updatedAt", "id"], txid: "txid", inputOutpointKeys: "inputOutpointKeys", parentTxids: "parentTxids"
  },
  p2pkh_local_outpoints: { resourceId: "resourceId", resourceTimeline: ["resourceId", "updatedAt", "id"], submissionId: "submissionId", state: "state", outpointKey: ["txid", "vout"] },
  p2pkh_local_input_claims: { resourceId: "resourceId", resourceTimeline: ["resourceId", "updatedAt", "id"], outpointKey: "outpointKey", submissionId: "submissionId", state: "state" },
  p2pkh_protocol_submissions: { resourceId: "resourceId" }
};

function primaryKey(name: string, value: PlainRecord): string {
  const fields = value as Record<string, unknown>;
  const key = fields.id ?? fields.resourceId;
  if (typeof key !== "string" && typeof key !== "number") throw new Error(`Record in ${name} has no primary key`);
  return String(key);
}

export class P2pkhStateIndex {
  constructor(private readonly collection: P2pkhStateCollection, private readonly path: string | string[]) {}
  async get(query: RecordQuery): Promise<PlainRecord | undefined> { return (await this.getAll(query))[0]; }
  async getAll(query?: RecordQuery): Promise<PlainRecord[]> {
    const rows = [...this.collection.rows.values()].filter((row) => {
      const value = pathValue(row, this.path);
      // Compound indexes compare the complete tuple. Multi-entry indexes
      // (for example inputOutpointKeys) still support a scalar query.
      if (Array.isArray(value)) return Array.isArray(query) ? compare(value, query) === 0 : value.some((item) => matches(item, query));
      return value !== undefined && matches(value, query);
    });
    return rows.sort((left, right) => compare(pathValue(left, this.path) ?? "", pathValue(right, this.path) ?? "")).map(clone);
  }
}

export class P2pkhStateCollection {
  readonly rows = new Map<string, PlainRecord>();
  constructor(private readonly recordStore: P2pkhRecordStore, readonly name: string) {}
  index(name: string): P2pkhStateIndex {
    const path = INDEX_PATHS[this.name]?.[name];
    if (!path) throw new Error(`Unknown P2PKH index ${this.name}.${name}`);
    return new P2pkhStateIndex(this, path);
  }
  async get(key: RecordKey): Promise<PlainRecord | undefined> { return clone(this.rows.get(String(key)) as PlainRecord | undefined); }
  async getAll(query?: RecordQuery): Promise<PlainRecord[]> {
    return [...this.rows.entries()].filter(([key]) => matches(key, query)).sort(([a], [b]) => compare(a, b)).map(([, value]) => clone(value));
  }
  async put(value: PlainRecord): Promise<string> { const key = primaryKey(this.name, value); this.rows.set(key, clone(value)); return key; }
  async delete(key: RecordKey): Promise<void> { this.rows.delete(String(key)); }
  async clear(): Promise<void> { this.rows.clear(); }
}

export class P2pkhStateTransaction {
  private aborted = false;
  constructor(private readonly recordStore: P2pkhRecordStore, readonly names: string[], readonly mode: RecordMode) {}
  objectStore(name: string): P2pkhStateCollection {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is not in transaction`);
    return this.recordStore.collection(name);
  }
  abort(): void { this.aborted = true; }
  isAborted(): boolean { return this.aborted; }
}

export class P2pkhRecordStore {
  readonly objectStoreNames: string[] = Object.keys(INDEX_PATHS);
  private closed = false;
  private baseline = new Map<string, Map<string, PlainRecord>>();
  private partitionRevision = 0;
  private constructor(private readonly store: KeyValueStore) {}

  private replaceFromSnapshot(snapshot: Map<string, Map<string, PlainRecord>>): void {
    for (const name of this.objectStoreNames) {
      const collection = this.collection(name);
      collection.rows.clear();
      for (const [key, value] of snapshot.get(name) ?? []) collection.rows.set(key, clone(value));
    }
  }

  private snapshotEquals(left: PlainRecord | undefined, right: PlainRecord | undefined): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  private storageConflict(recordKey: string): Error & { code: "storage_conflict" } {
    const error = new Error(`P2PKH record changed concurrently: ${recordKey}`) as Error & { code: "storage_conflict" };
    error.code = "storage_conflict";
    return error;
  }

  static async open(store: KeyValueStore): Promise<P2pkhRecordStore> {
    const recordStore = new P2pkhRecordStore(store);
    let revision = 0;
    let cursor: string | undefined;
    do {
      const page = await store.list({ partition: "records", prefix: "record/", cursor, limit: 1000 });
      revision = page.revision;
      for (const entry of page.entries) {
        const name = entry.key.slice("record/".length).split("/")[0];
        if (!name || !recordStore.objectStoreNames.includes(name)) continue;
        const collection = recordStore.collection(name);
        const value = entry.value as PlainRecord;
        const fields = value as Record<string, unknown>;
        collection.rows.set(String(fields.id ?? fields.resourceId), clone(value));
      }
      cursor = page.nextCursor;
    } while (cursor);
    recordStore.partitionRevision = revision;
    recordStore.baseline = recordStore.snapshot();
    return recordStore;
  }

  private collections = new Map<string, P2pkhStateCollection>();
  collection(name: string): P2pkhStateCollection {
    if (!this.objectStoreNames.includes(name)) throw new Error(`Unknown P2PKH store ${name}`);
    let collection = this.collections.get(name);
    if (!collection) { collection = new P2pkhStateCollection(this, name); this.collections.set(name, collection); }
    return collection;
  }
  transaction(names: string | string[], mode: RecordMode): P2pkhStateTransaction {
    if (this.closed) throw new Error("P2PKH storage is closed");
    const selected = typeof names === "string" ? [names] : names;
    selected.forEach((name) => this.collection(name));
    return new P2pkhStateTransaction(this, selected, mode);
  }
  snapshot(): Map<string, Map<string, PlainRecord>> {
    return new Map([...this.collections.entries()].map(([name, collection]) => [name, new Map([...collection.rows.entries()].map(([key, value]) => [key, clone(value)]))]));
  }
  restore(snapshot: Map<string, Map<string, PlainRecord>>): void {
    for (const [name, collection] of this.collections) { collection.rows.clear(); for (const [key, value] of snapshot.get(name) ?? []) collection.rows.set(key, clone(value)); }
  }
  async flush(): Promise<void> {
    if (this.closed) throw new Error("P2PKH storage is closed");
    const local = this.snapshot();
    const changed = new Map<string, PlainRecord | undefined>();
    for (const name of this.objectStoreNames) {
      const before = this.baseline.get(name) ?? new Map();
      const after = local.get(name) ?? new Map();
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(key);
        const next = after.get(key);
        if (!this.snapshotEquals(previous, next)) changed.set(`${name}/${key}`, next ? clone(next) : undefined);
      }
    }
    // 只合并本句柄相对 baseline 的修改。这样另一个句柄已经提交的
    // UTXO/交易记录不会被“全量删除再重写”覆盖。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remote = await this.readRemoteSnapshot();
      // `merged` 必须是 remote 的独立副本；如果直接修改
      // `remote.snapshot`，后面的 before/after 比较会看到同一份 Map，
      // 导致 operations 为空，数据只停留在当前内存句柄中而没有提交到 K-V。
      const merged = new Map<string, Map<string, PlainRecord>>(
        [...remote.snapshot.entries()].map(([name, records]) => [
          name,
          new Map([...records.entries()].map(([key, value]) => [key, clone(value)]))
        ])
      );
      // 三方合并只允许“远端仍等于 baseline”或“远端已经等于 local”。
      // 如果同一条记录同时被两个句柄改成不同值，不能依赖 partition CAS
      // 重试把后提交者的旧快照重新写回去，必须向调用方报告冲突。
      for (const [key, value] of changed) {
        const separator = key.indexOf("/");
        const name = key.slice(0, separator);
        const recordKey = key.slice(separator + 1);
        const baselineValue = this.baseline.get(name)?.get(recordKey);
        const remoteValue = remote.snapshot.get(name)?.get(recordKey);
        if (!this.snapshotEquals(remoteValue, baselineValue) && !this.snapshotEquals(remoteValue, value)) {
          throw this.storageConflict(key);
        }
      }
      for (const [key, value] of changed) {
        const separator = key.indexOf("/");
        const name = key.slice(0, separator);
        const recordKey = key.slice(separator + 1);
        const collection = merged.get(name) ?? new Map<string, PlainRecord>();
        if (value === undefined) collection.delete(recordKey); else collection.set(recordKey, clone(value));
        merged.set(name, collection);
      }
      const operations: KeyValueCommitOperation[] = [];
      for (const name of this.objectStoreNames) {
        const before = remote.snapshot.get(name) ?? new Map();
        const after = merged.get(name) ?? new Map();
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const previous = before.get(key);
          const next = after.get(key);
          if (this.snapshotEquals(previous, next)) continue;
          operations.push(next === undefined
            ? { type: "delete", key: `record/${name}/${key}` }
            : { type: "put", key: `record/${name}/${key}`, value: next });
        }
      }
      try {
        const result = operations.length > 0
          ? await this.store.commit({ partition: "records", ifRevision: remote.revision, operations })
          : { revision: remote.revision };
        this.replaceFromSnapshot(merged);
        this.baseline = this.snapshot();
        this.partitionRevision = result.revision;
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/conflict|revision changed/i.test(error.message)) throw error;
      }
    }
    throw new Error("P2PKH storage conflict did not settle");
  }

  private async readRemoteSnapshot(): Promise<{ revision: number; snapshot: Map<string, Map<string, PlainRecord>> }> {
    const snapshot = new Map<string, Map<string, PlainRecord>>();
    let cursor: string | undefined;
    let revision = 0;
    do {
      const page = await this.store.list({ partition: "records", prefix: "record/", cursor, limit: 1000 });
      revision = page.revision;
      for (const entry of page.entries) {
        const name = entry.key.slice("record/".length).split("/")[0];
        if (!name || !this.objectStoreNames.includes(name)) continue;
        const recordKey = entry.key.slice(`record/${name}/`.length);
        const collection = snapshot.get(name) ?? new Map<string, PlainRecord>();
        collection.set(recordKey, clone(entry.value as PlainRecord));
        snapshot.set(name, collection);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { revision, snapshot };
  }
  close(): void { this.closed = true; this.store.close(); }
}
