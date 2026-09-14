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
export function createInMemoryKeyValueStore(
  binding: StorageNamespaceBinding,
  options: { now?: () => number; generateId?: () => string } = {},
): KeyValueStore {
  const partitions = new Map<string, { revision: number; committedAt: number; values: Map<string, { value: unknown; updatedAt: number }> }>();
  let closed = false;
  const provider = { bucketId: binding.bucketId } as StorageBucketProvider;
  const clone = <T>(value: T): T => value instanceof Uint8Array ? new Uint8Array(value) as T : structuredClone(value);
  const semanticValue = (value: unknown): string => {
    if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(",")}`;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error("K-V value is not serializable");
    const normalized = JSON.parse(serialized) as unknown;
    const visit = (current: unknown): string => {
      if (current === null || typeof current !== "object") return JSON.stringify(current);
      if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
      return `{${Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => `${JSON.stringify(name)}:${visit(entry)}`).join(",")}}`;
    };
    return `json:${visit(normalized)}`;
  };
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const stateFor = (partition: string) => partitions.get(partition) ?? { revision: 0, committedAt: 0, values: new Map() };
  const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
  const key = (value: string) => {
    if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\u0000") || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".keymaster")) throw new Error("K-V key is invalid");
    return value;
  };
  const commitInternal = async (input: KeyValueCommitInput): Promise<KeyValueCommitResult & { values: Map<string, { value: unknown; updatedAt: number }> }> => {
    assertOpen();
    const current = stateFor(input.partition);
    if (input.ifRevision !== undefined && input.ifRevision !== current.revision) {
      throw Object.assign(new Error("K-V partition revision changed"), { code: "storage_conflict" as const });
    }
    if (input.operations.length === 0) return { revision: current.revision, commitId: "", committedAt: current.committedAt, values: current.values };
    const next = new Map(current.values);
    const committedAt = now();
    for (const operation of input.operations) {
      key(operation.key);
      if (operation.type === "delete") next.delete(operation.key);
      else {
        const previous = next.get(operation.key);
        next.set(operation.key, previous && semanticValue(previous.value) === semanticValue(operation.value)
          ? previous!
          : { value: clone(operation.value), updatedAt: committedAt });
      }
    }
    const changed = next.size !== current.values.size || [...next].some(([entryKey, entry]) => {
      const previous = current.values.get(entryKey);
      return !previous || semanticValue(previous.value) !== semanticValue(entry.value);
    });
    if (!changed) return { revision: current.revision, commitId: "", committedAt: current.committedAt, values: current.values };
    const result = { revision: current.revision + 1, values: next };
    partitions.set(input.partition, { revision: result.revision, committedAt, values: result.values });
    return { revision: result.revision, commitId: generateId(), committedAt, values: result.values };
  };
  const commit = async (input: KeyValueCommitInput): Promise<KeyValueCommitResult> => {
    const { revision, commitId, committedAt } = await commitInternal(input);
    return { revision, commitId, committedAt };
  };
  const store: KeyValueStore = {
    bucketId: provider.bucketId,
    bucketGeneration: binding.bucketGeneration,
    ownerPublicKeyHex: binding.ownerPublicKeyHex ?? "",
    moduleId: binding.moduleId,
    purposeId: binding.purposeId,
    scope: binding.scope,
    authority: binding.authority,
    model: "kv",
    schemaVersion: binding.schemaVersion,
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
      const result = await commitInternal({ partition: condition.partition ?? "default", ifRevision: condition.ifRevision, operations: [{ type: "put", key: entryKey, value }] });
      const updatedAt = result.values.get(entryKey)?.updatedAt;
      if (updatedAt === undefined) throw new Error("K-V put did not produce an entry");
      return { key: entryKey, revision: result.revision, updatedAt };
    },
    async delete(entryKey, condition = {}) {
      await commit({ partition: condition.partition ?? "default", ifRevision: condition.ifRevision, operations: [{ type: "delete", key: entryKey }] });
    },
    commit,
    close() { closed = true; }
  };
  return store;
}
