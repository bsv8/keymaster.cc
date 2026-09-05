import type {
  KeyValueCommitInput,
  KeyValueCommitResult,
  KeyValueEntry,
  KeyValueEntryMeta,
  KeyValueListInput,
  KeyValueListResult,
  KeyValueStore,
  KeyValueValue,
  StorageBucketProvider,
  StorageNamespaceBinding
} from "@keymaster/contracts";

/**
 * 仅供测试夹具使用的 K-V 实现。
 *
 * 生产代码必须注入 OPFS/S3 绑定的 KeyValueStore；这里不连接浏览器
 * 持久化 API，避免测试为了构造 Vault 而重新引入旧存储后端。
 */
export function createInMemoryKeyValueStore(binding: StorageNamespaceBinding): KeyValueStore {
  const partitions = new Map<string, { revision: number; values: Map<string, { value: unknown; updatedAt: number }> }>();
  let closed = false;
  const provider = { bucketId: binding.bucketId } as StorageBucketProvider;
  const clone = <T>(value: T): T => value instanceof Uint8Array ? new Uint8Array(value) as T : structuredClone(value);
  const stateFor = (partition: string) => partitions.get(partition) ?? { revision: 0, values: new Map() };
  const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
  const key = (value: string) => {
    if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\u0000") || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".keymaster")) throw new Error("K-V key is invalid");
    return value;
  };
  const commit = async (input: KeyValueCommitInput): Promise<KeyValueCommitResult> => {
    assertOpen();
    const current = stateFor(input.partition);
    if (input.ifRevision !== undefined && input.ifRevision !== current.revision) throw new Error("K-V partition revision changed");
    if (input.operations.length === 0) return { revision: current.revision, commitId: "", committedAt: Date.now() };
    const next = new Map(current.values);
    const committedAt = Date.now();
    for (const operation of input.operations) {
      key(operation.key);
      if (operation.type === "delete") next.delete(operation.key);
      else next.set(operation.key, { value: clone(operation.value), updatedAt: committedAt });
    }
    const result = { revision: current.revision + 1, values: next };
    partitions.set(input.partition, { revision: result.revision, values: result.values });
    return { revision: result.revision, commitId: crypto.randomUUID(), committedAt };
  };
  const store: KeyValueStore = {
    bucketId: provider.bucketId,
    bucketGeneration: binding.bucketGeneration,
    ownerPublicKeyHex: binding.ownerPublicKeyHex ?? "",
    applicationStorageId: binding.applicationStorageId,
    async get<T = KeyValueValue>(entryKey: string, input: { partition?: string } = {}) {
      assertOpen();
      const entry = stateFor(input.partition ?? "default").values.get(key(entryKey));
      return entry ? { key: entryKey, value: clone(entry.value) as T, revision: stateFor(input.partition ?? "default").revision, updatedAt: entry.updatedAt } as KeyValueEntry<T> : undefined;
    },
    async list(input: KeyValueListInput = {}): Promise<KeyValueListResult> {
      assertOpen();
      const partition = input.partition ?? "default";
      const state = stateFor(partition);
      const prefix = input.prefix ?? "";
      const keys = [...state.values.keys()].filter((entryKey) => entryKey.startsWith(prefix)).sort();
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const limit = input.limit ?? 200;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("K-V cursor or limit is invalid");
      const selected = keys.slice(offset, offset + limit);
      return {
        revision: state.revision,
        entries: selected.map((entryKey) => {
          const entry = state.values.get(entryKey)!;
          return { key: entryKey, value: clone(entry.value), revision: state.revision, updatedAt: entry.updatedAt };
        }),
        nextCursor: offset + selected.length < keys.length ? String(offset + selected.length) : undefined
      };
    },
    async put(entryKey, value, condition = {}): Promise<KeyValueEntryMeta> {
      const result = await commit({ partition: condition.partition ?? "default", ifRevision: condition.ifRevision, operations: [{ type: "put", key: entryKey, value }] });
      return { key: entryKey, revision: result.revision, updatedAt: result.committedAt };
    },
    async delete(entryKey, condition = {}) {
      await commit({ partition: condition.partition ?? "default", ifRevision: condition.ifRevision, operations: [{ type: "delete", key: entryKey }] });
    },
    commit,
    close() { closed = true; }
  };
  return store;
}
