// 中央系统固定 CAS snapshot。
//
// 一个 declaration 永远只对应逻辑根下的一个固定对象（`<root>current`）。
// 差异只在 CAS 边界：本地没有 Provider ETag，初次发布用 ifNoneMatch，后续发布
// 用读到的本地 revision 做 ifRevision。revision 0 表示对象不存在，因此
// 「读—比较—写」也不会覆盖别人的并发发布。

import type {
  PluginStorageDeclaration,
  SnapshotStore,
  StorageNamespaceBinding,
  StorageSnapshot,
  StorageSnapshotEnvelope,
  StorageSnapshotJsonCompatible,
  StorageSnapshotWriteCondition,
  StorageSnapshotWriteResult,
} from "@keymaster/contracts";
import { buildStorageSnapshotPath, keyValueSemanticFingerprint, validatePluginStorageDeclaration } from "@keymaster/contracts";
import type { WalletStore } from "../local/indexedDbWalletStore.js";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";

export interface FixedCasSnapshotStoreOptions<T> {
  /** 正式本地介质；业务调用方不能替换。 */
  store: WalletStore;
  /** 只由 Coordinator 预绑定的完整绑定；调用方不能传入物理路径。 */
  binding: StorageNamespaceBinding;
  /** 世代栅栏；返回 false 表示句柄已失效。 */
  isCurrent?: () => boolean;
  /** 严格校验并可规范化 snapshot payload。 */
  validate: (value: unknown) => StorageSnapshotJsonCompatible<T>;
}

function fail(message: string): StorageRuntimeError {
  return new StorageRuntimeError("storage_provider_error", message);
}

function mapError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  const code = storageErrorCode(error);
  if (code) return new StorageRuntimeError(code, "Storage snapshot operation failed");
  return fail("Storage snapshot operation failed");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
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
  if (!exactKeys(declaration, ["moduleId", "purposeId", "authority", "model", "schemaVersion"])) {
    throw fail("Storage snapshot declaration is invalid");
  }
  try {
    validatePluginStorageDeclaration(declaration);
  } catch {
    throw fail("Storage snapshot declaration is invalid");
  }
  if (declaration.moduleId !== expected.moduleId
    || declaration.purposeId !== expected.purposeId
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

/** 构造中央系统固定 CAS snapshot。 */
export function createFixedCasSnapshotStore<T>(options: FixedCasSnapshotStoreOptions<T>): SnapshotStore<T> {
  const declaration = validatePluginStorageDeclaration(options.binding);
  if (declaration.model !== "snapshot") throw new StorageRuntimeError("storage_forbidden", "Snapshot store requires snapshot model");
  if (declaration.authority === "third-party-app") throw new StorageRuntimeError("storage_forbidden", "Snapshot store is not available to third-party apps");
  const path = buildStorageSnapshotPath(options.binding);
  let closed = false;
  const validate = options.validate;

  function assertOpen(): void {
    if (closed || options.isCurrent?.() === false) throw new StorageRuntimeError("storage_unavailable", "Storage snapshot handle is stale");
  }

  async function readInternal(): Promise<{ snapshot?: StorageSnapshot<T>; objectRevision: number }> {
    assertOpen();
    const object = await options.store.get(path);
    assertOpen();
    // 对象存在但 envelope 不可解析属于明确的损坏，不静默当作「不存在」重新
    // 发布：那会用默认值覆盖掉可能仍可恢复的证据。
    if (!object) return { objectRevision: 0 };
    const envelope = parseEnvelope<T>(object.bytes, declaration);
    const value = validate(envelope.value);
    return { snapshot: { value, revision: envelope.revision }, objectRevision: object.revision };
  }

  async function withLease<R>(operation: () => Promise<R>): Promise<R> {
    assertOpen();
    try {
      return await operation();
    } catch (error) {
      throw mapError(error);
    }
  }

  return {
    read: () => withLease(async () => (await readInternal()).snapshot),
    write: (input: T, condition: StorageSnapshotWriteCondition = {}): Promise<StorageSnapshotWriteResult> => withLease(async () => {
      const value = validate(input);
      const fingerprint = keyValueSemanticFingerprint(value);
      const current = await readInternal();
      const currentRevision = current.snapshot?.revision ?? 0;
      if (condition.ifRevision !== undefined && condition.ifRevision !== currentRevision) {
        throw new StorageRuntimeError("storage_conflict", "Storage snapshot revision changed");
      }
      if (current.snapshot && keyValueSemanticFingerprint(current.snapshot.value) === fingerprint) {
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
      await options.store.put(path, jsonBytes(envelope), {
        // 条件与写入在同一事务：并发发布只有一方成功，另一方得到 conflict。
        ifRevision: current.objectRevision,
        contentType: "application/json",
      });
      assertOpen();
      return { revision: envelope.revision, wrote: true };
    }),
    close() { closed = true; },
  };
}
