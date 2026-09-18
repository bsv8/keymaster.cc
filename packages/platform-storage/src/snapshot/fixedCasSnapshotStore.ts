import type {
  PluginStorageDeclaration,
  SnapshotStore,
  StorageBucketProvider,
  StorageNamespaceBinding,
  StorageSnapshot,
  StorageSnapshotEnvelope,
  StorageSnapshotJsonCompatible,
  StorageSnapshotWriteCondition,
  StorageSnapshotWriteResult,
} from "@keymaster/contracts";
import { buildStorageSnapshotPath, validatePluginStorageDeclaration } from "@keymaster/contracts";
import { assertProviderPath } from "../bucket-providers/bucketProvider.js";
import { StorageRuntimeError } from "../runtime/storageError.js";

export interface FixedCasSnapshotStoreOptions<T> {
  /** 只由中央 Root 生成的完整绑定；调用方不能传入物理路径。 */
  provider: StorageBucketProvider;
  binding: StorageNamespaceBinding;
  /** 读取后/写入前后使用的 Root 世代门禁。 */
  isCurrent?: () => boolean;
  /** 严格校验并可规范化 snapshot payload。 */
  validate: (value: unknown) => StorageSnapshotJsonCompatible<T>;
}

function fail(message: string): StorageRuntimeError {
  return new StorageRuntimeError("storage_provider_error", message);
}

function mapError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict") {
    return new StorageRuntimeError("storage_conflict", "Storage snapshot CAS conflicted");
  }
  return fail("Storage snapshot operation failed");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function stableValue(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("Storage snapshot value is not JSON serializable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value instanceof Uint8Array) throw fail("Storage snapshot value is not JSON serializable");
  if (seen.has(value)) throw fail("Storage snapshot value is cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw fail("Storage snapshot array is sparse");
        items.push(stableValue(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail("Storage snapshot value is not a JSON object");
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item, seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function jsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw fail("Storage snapshot envelope is not serializable");
  }
}

function parseEnvelope<T>(bytes: Uint8Array, expected: PluginStorageDeclaration): StorageSnapshotEnvelope<T> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw fail("Storage snapshot envelope is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["format", "version", "declaration", "revision", "value"])) {
    throw fail("Storage snapshot envelope is invalid");
  }
  const candidate = value as Partial<StorageSnapshotEnvelope<T>>;
  const revision = candidate.revision;
  if (candidate.format !== "keymaster.storage.snapshot" || candidate.version !== 1
    || !Number.isSafeInteger(revision) || (revision as number) < 1
    || !candidate.declaration || typeof candidate.declaration !== "object" || Array.isArray(candidate.declaration)) {
    throw fail("Storage snapshot envelope is invalid");
  }
  const declaration = candidate.declaration as PluginStorageDeclaration;
  if (!exactKeys(declaration, ["moduleId", "purposeId", "scope", "authority", "model", "schemaVersion"])) {
    throw fail("Storage snapshot declaration is invalid");
  }
  try {
    validatePluginStorageDeclaration(declaration);
  } catch {
    throw fail("Storage snapshot declaration is invalid");
  }
  if (declaration.moduleId !== expected.moduleId
    || declaration.purposeId !== expected.purposeId
    || declaration.scope !== expected.scope
    || declaration.authority !== expected.authority
    || declaration.model !== expected.model
    || declaration.schemaVersion !== expected.schemaVersion) {
    throw fail("Storage snapshot declaration does not match its binding");
  }
  return {
    format: "keymaster.storage.snapshot",
    version: 1,
    declaration: { ...declaration },
    revision: revision as number,
    value: candidate.value as T,
  };
}

/**
 * 构造中央系统固定 CAS snapshot。
 *
 * 一个 declaration 永远只对应一个固定对象；初次发布使用
 * If-None-Match，后续发布使用读到的 ETag 做 If-Match。ETag、Provider 和
 * 物理路径都被限制在本模块，返回给上层的只有 value/revision。
 */
export function createFixedCasSnapshotStore<T>(options: FixedCasSnapshotStoreOptions<T>): SnapshotStore<T> {
  const declaration = validatePluginStorageDeclaration(options.binding);
  if (declaration.model !== "snapshot") throw new StorageRuntimeError("storage_forbidden", "Snapshot store requires snapshot model");
  if (options.provider.bucketId !== options.binding.bucketId) throw new StorageRuntimeError("storage_forbidden", "Storage bucket binding mismatch");
  const path = buildStorageSnapshotPath(options.binding);
  assertProviderPath(path);
  let closed = false;
  const validate = options.validate;

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw new StorageRuntimeError("storage_unavailable", "Storage snapshot handle is stale");
  }

  async function withLease<R>(operation: () => Promise<R>): Promise<R> {
    assertOpen();
    try {
      return await operation();
    } catch (error) {
      throw mapError(error);
    }
  }

  async function readInternal(): Promise<{ snapshot?: StorageSnapshot<T>; etag?: string }> {
    assertOpen();
    const object = await options.provider.get(path);
    assertOpen();
    if (!object) return {};
    const envelope = parseEnvelope<T>(object.bytes, declaration);
    const value = validate(envelope.value);
    stableValue(value);
    return { snapshot: { value, revision: envelope.revision }, etag: object.etag };
  }

  return {
    read: () => withLease(async () => (await readInternal()).snapshot),
    write: (input: T, condition: StorageSnapshotWriteCondition = {}): Promise<StorageSnapshotWriteResult> => withLease(async () => {
      const value = validate(input);
      const valueFingerprint = stableValue(value);
      const current = await readInternal();
      const currentRevision = current.snapshot?.revision ?? 0;
      if (condition.ifRevision !== undefined && condition.ifRevision !== currentRevision) {
        throw new StorageRuntimeError("storage_conflict", "Storage snapshot revision changed");
      }
      if (current.snapshot && stableValue(current.snapshot.value) === valueFingerprint) {
        return { revision: currentRevision, wrote: false };
      }
      const envelope: StorageSnapshotEnvelope<T> = {
        format: "keymaster.storage.snapshot",
        version: 1,
        declaration,
        revision: currentRevision + 1,
        value,
      };
      assertOpen();
      await options.provider.put(path, jsonBytes(envelope), current.etag ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
      // Root 切换/owner generation 改变的写入不能被调用方视为成功；
      // Provider 并没有暴露给调用方，因此这里直接 fail closed。
      assertOpen();
      return { revision: envelope.revision, wrote: true };
    }),
    close() { closed = true; },
  };
}
