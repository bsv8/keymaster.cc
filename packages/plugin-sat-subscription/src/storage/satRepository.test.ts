import { describe, expect, it } from "vitest";
import type {
  KeyValueCommitInput,
  KeyValueCommitResult,
  KeyValueEntry,
  KeyValueEntryMeta,
  KeyValueListInput,
  KeyValueListResult,
  KeyValueStore,
  KeyValueValue,
  KeyValueWriteCondition,
} from "@keymaster/contracts";
import {
  createSatSubscriptionRepository,
  emptySatSubscriptionSnapshot
} from "./satRepository.js";

const OWNER_A = "02" + "11".repeat(32);
const OWNER_B = "03" + "22".repeat(32);

/**
 * 构造一个模拟 Worker 延迟绑定的 owner 句柄：创建时 owner 为空，
 * 第一次读取时才绑定 OWNER_A；后续可切换到另一个 owner 或锁定态。
 */
function createDeferredOwnerHandle(): {
  handle: KeyValueStore;
  setOwner: (owner: string) => void;
} {
  const partitions = new Map<string, { revision: number; values: Map<string, { value: unknown; updatedAt: number }> }>();
  let closed = false;
  let ownerPublicKeyHex = "";
  let bindNextRead = true;

  /** 测试 fake 只保存 Repository 用到的 partition/key/value，并复制快照避免共享引用。 */
  const copy = <T>(value: T): T => typeof structuredClone === "function" ? structuredClone(value) : value;
  const assertOpen = (): void => { if (closed) throw new Error("test K-V handle is closed"); };
  const partitionFor = (partition: string) => {
    const current = partitions.get(partition);
    if (current) return current;
    const created = { revision: 0, values: new Map<string, { value: unknown; updatedAt: number }>() };
    partitions.set(partition, created);
    return created;
  };
  const commit = async (input: KeyValueCommitInput): Promise<KeyValueCommitResult> => {
    assertOpen();
    const current = partitionFor(input.partition);
    if (input.ifRevision !== undefined && input.ifRevision !== current.revision) throw new Error("test K-V revision changed");
    const committedAt = Date.now();
    const nextValues = new Map(current.values);
    for (const operation of input.operations) {
      if (operation.type === "put") nextValues.set(operation.key, { value: copy(operation.value), updatedAt: committedAt });
      else nextValues.delete(operation.key);
    }
    const revision = input.operations.length === 0 ? current.revision : current.revision + 1;
    partitions.set(input.partition, { revision, values: nextValues });
    return { revision, commitId: "test-commit-" + revision, committedAt };
  };
  const get = async <T = KeyValueValue>(key: string, options: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> => {
    assertOpen();
    if (bindNextRead) {
      ownerPublicKeyHex = OWNER_A;
      bindNextRead = false;
    }
    const partition = partitionFor(options.partition ?? "default");
    const stored = partition.values.get(key);
    return stored === undefined
      ? undefined
      : { key, value: copy(stored.value) as T, revision: partition.revision, updatedAt: stored.updatedAt };
  };
  const list = async (input: KeyValueListInput = {}): Promise<KeyValueListResult> => {
    assertOpen();
    const partition = partitionFor(input.partition ?? "default");
    const prefix = input.prefix ?? "";
    const entries = [...partition.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, stored]) => ({ key, value: copy(stored.value) as KeyValueValue, revision: partition.revision, updatedAt: stored.updatedAt }));
    return { revision: partition.revision, entries };
  };
  const put = async <T>(key: string, value: T, condition: KeyValueWriteCondition = {}): Promise<KeyValueEntryMeta> => {
    const result = await commit({
      partition: condition.partition ?? "default",
      ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }),
      operations: [{ type: "put", key, value }],
    });
    return { key, revision: result.revision, updatedAt: result.committedAt };
  };
  const remove = async (key: string, condition: KeyValueWriteCondition = {}): Promise<void> => {
    await commit({
      partition: condition.partition ?? "default",
      ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }),
      operations: [{ type: "delete", key }],
    });
  };
  const handle: KeyValueStore = {
    /** 测试用抽象桶身份，不对应真实物理存储路径。 */
    bucketId: "sat-repository-test-bucket",
    /** 测试用桶世代，用于满足公开 K-V 句柄契约。 */
    bucketGeneration: 1,
    /** 延迟 owner getter 是本回归的核心：首次 get 前必须保持空字符串。 */
    get ownerPublicKeyHex() { return ownerPublicKeyHex; },
    /** 测试插件的稳定 App 存储命名空间。 */
    applicationStorageId: "SatSubscription",
    get,
    list,
    put,
    delete: remove,
    commit,
    close() { closed = true; },
  };
  return {
    handle,
    setOwner: (owner) => { ownerPublicKeyHex = owner; }
  };
}

describe("SatSubscriptionRepository owner binding", () => {
  it("首次 load 绑定 owner 后，第一次 save 和刷新恢复使用同一 owner", async () => {
    const deferred = createDeferredOwnerHandle();
    const repository = createSatSubscriptionRepository(deferred.handle);

    const loaded = await repository.load();
    expect(loaded.ownerPublicKeyHex).toBe(OWNER_A);

    await repository.save(emptySatSubscriptionSnapshot(OWNER_A));
    const restored = await repository.load();
    expect(restored.ownerPublicKeyHex).toBe(OWNER_A);
  });

  it("owner 切换或锁定时仍拒绝旧 owner 的读写", async () => {
    const deferred = createDeferredOwnerHandle();
    const repository = createSatSubscriptionRepository(deferred.handle);
    await repository.load();
    await repository.save(emptySatSubscriptionSnapshot(OWNER_A));

    deferred.setOwner(OWNER_B);
    await expect(repository.load()).rejects.toThrow("SatSubscription owner mismatch");

    deferred.setOwner("");
    await expect(repository.save(emptySatSubscriptionSnapshot(OWNER_A))).rejects.toThrow("SatSubscription owner mismatch on save");
  });
});
