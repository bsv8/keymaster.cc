import { describe, expect, it } from "vitest";
import { createLocalStorageBucketProvider } from "../bucket-providers/local/localStorageBucketProvider.js";
import { createStorageHoldSnapshotRepository } from "./storageHoldSnapshotRepository.js";
import { createStorageBucketManagementService } from "./storageBucketManagement.js";
import { createStorageCatalogRepository } from "../bootstrap/storageCatalogRepository.js";
import { decryptBucketConfig, decryptBucketKey, deriveBucketCryptoContext, parseBucketDocument, verifyBucketDocument } from "./keymasterHoldAdapter.js";
import type { LocalStorageLike, LocalStorageLocks } from "../bucket-providers/local/localStorageBucketProvider.js";
import type { StorageBucketProvider } from "@keymaster/contracts";

class MemoryStorage implements LocalStorageLike {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const locks: LocalStorageLocks = {
  async request<T>(
    _name: string,
    optionsOrCallback: { signal?: AbortSignal } | (() => Promise<T>),
    callback?: () => Promise<T>
  ): Promise<T> {
    const operation = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (!operation) throw new TypeError("Web Locks callback is required");
    return operation();
  }
};

function catalogBucketInput(label: string) {
  return {
    label,
    backend: "local" as const,
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256" as const,
      passwordEncoding: "utf-8" as const,
      iterations: 100_000,
      outputLengthBits: 256 as const,
      saltB64Url: "0123456789ab"
    },
    encryptedConfig: {
      cipher: {
        algorithm: "aes-gcm" as const,
        keyLengthBits: 256 as const,
        ivB64Url: "0123456789ab",
        tagLengthBits: 128 as const,
        ciphertextAndTagB64Url: "encrypted-config"
      }
    }
  };
}

function managementFixture() {
  const storage = new MemoryStorage();
  let id = 0;
  const catalog = createStorageCatalogRepository({ storage, locks, generateId: () => `catalog-bucket-${++id}` });
  return { storage, catalog, manager: createStorageBucketManagementService({ catalog }) };
}

describe("Storage Hold snapshot", () => {
  it("publishes an immutable snapshot and cold-exports without a password", async () => {
    const provider = createLocalStorageBucketProvider({ storage: new MemoryStorage(), locks, bucketId: "hold-bucket" });
    const manager = createStorageBucketManagementService({
      catalog: undefined
    });
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const sealed = await manager.sealConfigAndKeys({ config: { kind: "local" }, keys: [{ label: "主 Key", privateKey }], password: "bucket-password" });
    // sealConfigAndKeys 清理调用方可控的字节；这里验证它没有把密码留在 API 返回值中。
    expect(privateKey.every((byte) => byte === 0)).toBe(true);
    const repository = createStorageHoldSnapshotRepository(provider, { generateId: () => "snapshot-1", now: () => 100 });
    await repository.publish({ document: sealed.document, configRevision: 1, bucketGeneration: 1 });

    const exported = await manager.coldExport(provider);
    const document = parseBucketDocument(exported);
    expect(document.keys).toHaveLength(1);
    expect(document.keys[0]?.label).toBe("主 Key");
    const context = await deriveBucketCryptoContext("bucket-password", sealed.keyDerivation);
    try {
      await verifyBucketDocument(document, context);
      const unlocked = await decryptBucketKey(document.keys[0]!, context);
      expect(unlocked.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/u);
      unlocked.privateKey.fill(0);
    } finally {
      context.dispose();
    }
    provider.dispose();
  });

  it("does not publish a new head when an immutable record write conflicts", async () => {
    const storage = new MemoryStorage();
    const provider = createLocalStorageBucketProvider({ storage, locks, bucketId: "conflict-bucket" });
    const manager = createStorageBucketManagementService({ catalog: undefined });
    const firstKey = new Uint8Array(32); firstKey[31] = 1;
    const first = await manager.sealConfigAndKeys({ config: { kind: "local" }, keys: [{ label: "A", privateKey: firstKey }], password: "bucket-password" });
    const repo = createStorageHoldSnapshotRepository(provider, { generateId: () => "snapshot-1" });
    await repo.publish({ document: first.document, configRevision: 1, bucketGeneration: 1 });
    const secondKey = new Uint8Array(32); secondKey[31] = 2;
    const second = await manager.sealConfigAndKeys({ config: { kind: "local" }, keys: [{ label: "B", privateKey: secondKey }], password: "bucket-password" });
    await expect(repo.publish({ document: second.document, configRevision: 2, bucketGeneration: 1, snapshotId: "snapshot-1" })).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(repo.readCommitted()).resolves.toMatchObject({ document: { keys: [{ label: "A" }] } });
    provider.dispose();
  });

  it("imports a verified Hold document without re-encrypting its records", async () => {
    const { storage, catalog, manager } = managementFixture();
    const privateKey = new Uint8Array(32); privateKey[31] = 3;
    const sealed = await manager.sealConfigAndKeys({ config: { kind: "local" }, keys: [{ label: "导入 Key", privateKey }], password: "bucket-password" });
    let catalogSeenBeforeImportCommit;
    const entry = await manager.importBucketDocument({
      document: JSON.stringify(sealed.document),
      password: "bucket-password",
      label: "导入桶",
      createProvider: (_config, bucketId) => {
        catalogSeenBeforeImportCommit = catalog.read();
        return createLocalStorageBucketProvider({ storage, locks, bucketId });
      }
    });
    expect(entry.snapshotRevision).toBe(1);
    expect(catalogSeenBeforeImportCommit).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    const provider = createLocalStorageBucketProvider({ storage, locks, bucketId: entry.bucketId });
    const exported = await manager.coldExport(provider);
    expect(parseBucketDocument(exported)).toEqual(parseBucketDocument(JSON.stringify(sealed.document)));
    expect(catalog.read().buckets[0]?.label).toBe("导入桶");
    provider.dispose();
  });

  it("does not expose a newly created bucket until its first Hold snapshot is committed", async () => {
    const { catalog, manager } = managementFixture();
    let catalogSeenBeforeSnapshot;
    const entry = await manager.prepareBucketConfig({ kind: "local" }, "bucket-password", {
      label: "延迟暴露桶",
      backend: "local",
      createProvider: (bucketId) => {
        catalogSeenBeforeSnapshot = catalog.read();
        return createLocalStorageBucketProvider({ storage: new MemoryStorage(), locks, bucketId });
      }
    });

    expect(catalogSeenBeforeSnapshot).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    expect(catalog.read()).toMatchObject({ selectedBucketId: entry.bucketId, buckets: [{ bucketId: entry.bucketId, snapshotRevision: 1 }] });
  }, 15_000);

  it("does not compensate a failed new-bucket initialization by deleting another tab's catalog bucket", async () => {
    const { catalog, manager } = managementFixture();
    const existing = await catalog.createBucket(catalogBucketInput("已绑定桶"));
    const seenBeforeFailure: string[] = [];

    await expect(manager.prepareBucketConfig({ kind: "local" }, "bucket-password", {
      label: "初始化失败桶",
      backend: "local",
      createProvider: (bucketId) => {
        seenBeforeFailure.push(...catalog.read().buckets.map((bucket) => bucket.bucketId));
        return {
          provider: "local",
          bucketId,
          probe: async () => ({ ok: true, conditionalWrites: "native" as const, latencyMs: 0 }),
          get: async () => undefined,
          list: async () => ({ objects: [] }),
          put: async () => { throw new Error("first Hold write failed"); },
          delete: async () => undefined,
          dispose: () => undefined
        } satisfies StorageBucketProvider;
      }
    })).rejects.toThrow("first Hold write failed");

    expect(seenBeforeFailure).toEqual([existing.bucketId]);
    expect(catalog.read()).toEqual({ format: "keymaster.storage.catalog", version: 2, selectedBucketId: existing.bucketId, buckets: [existing] });
  }, 15_000);

  it("changes the bucket password as one catalog and full-snapshot revision", async () => {
    const { storage, catalog, manager } = managementFixture();
    const privateKey = new Uint8Array(32); privateKey[31] = 4;
    const sealed = await manager.sealConfigAndKeys({ config: { kind: "local" }, keys: [{ label: "改密 Key", privateKey }], password: "old-password" });
    const entry = await manager.importBucketDocument({
      document: JSON.stringify(sealed.document),
      password: "old-password",
      label: "可改密桶",
      createProvider: (_config, bucketId) => createLocalStorageBucketProvider({ storage, locks, bucketId })
    });
    const provider = createLocalStorageBucketProvider({ storage, locks, bucketId: entry.bucketId });
    const updated = await manager.changeBucketPassword({ entry, provider, oldPassword: "old-password", newPassword: "new-password" });
    expect(updated.configRevision).toBe(2);
    expect(updated.snapshotRevision).toBe(2);
    const committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
    const newContext = await deriveBucketCryptoContext("new-password", updated.keyDerivation);
    try {
      await verifyBucketDocument(committed.document, newContext);
      await expect(decryptBucketConfig(updated.encryptedConfig, newContext)).resolves.toEqual({ kind: "local" });
      const unlocked = await decryptBucketKey(committed.document.keys[0]!, newContext);
      expect(unlocked.label).toBe("改密 Key");
      unlocked.privateKey.fill(0);
    } finally {
      newContext.dispose();
    }
    const oldContext = await deriveBucketCryptoContext("old-password", entry.keyDerivation);
    try {
      await expect(verifyBucketDocument(committed.document, oldContext)).rejects.toBeTruthy();
    } finally {
      oldContext.dispose();
    }
    expect(catalog.read().buckets[0]?.configRevision).toBe(2);
    provider.dispose();
  }, 15_000);

  it("re-seals the full snapshot when a connection configuration is edited", async () => {
    const { storage, catalog, manager } = managementFixture();
    const privateKey = new Uint8Array(32); privateKey[31] = 5;
    const originalConfig = {
      kind: "s3" as const,
      endpoint: "https://old.example.com",
      region: "auto",
      bucket: "workspace",
      accessKeyId: "access-id",
      secretAccessKey: "secret-value",
      prefix: "team-a/"
    };
    const sealed = await manager.sealConfigAndKeys({ config: originalConfig, keys: [{ label: "配置 Key", privateKey }], password: "bucket-password" });
    const entry = await manager.importBucketDocument({
      document: JSON.stringify(sealed.document),
      password: "bucket-password",
      label: "配置桶",
      // 这里用 local provider 作为可控的对象存储夹具；管理服务只依赖
      // Provider 契约，不会根据 provider 字段重新解释 Hold 配置。
      createProvider: (_config, bucketId) => createLocalStorageBucketProvider({ storage, locks, bucketId })
    });
    const oldProvider = createLocalStorageBucketProvider({ storage, locks, bucketId: entry.bucketId });
    const nextProvider = createLocalStorageBucketProvider({ storage, locks, bucketId: entry.bucketId });
    const updated = await manager.changeBucketConnectionConfig({
      entry,
      provider: oldProvider,
      nextProvider,
      password: "bucket-password",
      label: "更新后的配置桶",
      config: { ...originalConfig, endpoint: "https://new.example.com", forcePathStyle: true }
    });
    expect(updated.configRevision).toBe(2);
    expect(updated.snapshotRevision).toBe(2);
    expect(updated.label).toBe("更新后的配置桶");
    expect(catalog.read().buckets[0]?.configRevision).toBe(2);
    const context = await deriveBucketCryptoContext("bucket-password", updated.keyDerivation);
    try {
      await expect(decryptBucketConfig(updated.encryptedConfig, context)).resolves.toMatchObject({ endpoint: "https://new.example.com", forcePathStyle: true });
      const committed = await createStorageHoldSnapshotRepository(nextProvider).readCommitted();
      await verifyBucketDocument(committed.document, context);
      expect(committed.document.keys).toHaveLength(1);
    } finally {
      context.dispose();
      oldProvider.dispose();
      nextProvider.dispose();
    }
  });

  it("keeps connection removal separate from destructive data cleanup", async () => {
    const { catalog, manager } = managementFixture();
    const current = await catalog.createBucket(catalogBucketInput("当前桶"));
    const other = await catalog.createBucket(catalogBucketInput("待销毁桶"));
    const objects = new Map([
      ["keys/a", new Uint8Array([1])],
      ["data/b", new Uint8Array([2, 3])]
    ]);
    const provider: StorageBucketProvider = {
      provider: "local",
      bucketId: other.bucketId,
      probe: async () => ({ ok: true, conditionalWrites: "native", latencyMs: 0 }),
      get: async (path) => {
        const bytes = objects.get(path);
        return bytes ? { path, bytes, size: bytes.byteLength, etag: path } : undefined;
      },
      list: async () => ({ objects: [...objects].map(([path, bytes]) => ({ path, bytes, size: bytes.byteLength, etag: path })) }),
      put: async () => ({ etag: "unused" }),
      delete: async (path) => { objects.delete(path); },
      dispose: () => undefined
    };

    await expect(manager.destroyBucketData({ entry: current, provider: { ...provider, bucketId: current.bucketId } })).rejects.toMatchObject({ code: "storage_forbidden" });
    await expect(manager.catalog.removeBucket(other.bucketId, other)).resolves.toBeTruthy();
    // 连接移除不会触碰 Provider 数据；重新加回目录后，销毁动作才执行物理删除。
    const restored = await catalog.createBucket(catalogBucketInput("待销毁桶"));
    expect(restored.bucketId).not.toBe(other.bucketId);
    // 使用原 entry 仍能验证真实销毁语义，目录 CAS 会拒绝过时条目，故先
    // 只保留一个独立的数据销毁夹具并直接检查 Provider 清空。
    const dataEntry = await catalog.createBucket(catalogBucketInput("数据桶"));
    const dataProvider: StorageBucketProvider = { ...provider, bucketId: dataEntry.bucketId };
    await expect(manager.destroyBucketData({ entry: dataEntry, provider: dataProvider })).resolves.toEqual({ deletedObjects: 2, scope: "all-local-objects" });
    expect(objects.size).toBe(0);
    expect(catalog.read().buckets.map((bucket) => bucket.label)).toEqual(["当前桶", "待销毁桶"]);
  });

  it("checks the latest catalog entry before listing or deleting data", async () => {
    const { catalog, manager } = managementFixture();
    await catalog.createBucket(catalogBucketInput("当前桶"));
    const stale = await catalog.createBucket(catalogBucketInput("旧名称"));
    await catalog.updateBucket(stale.bucketId, { label: "并发更新后的桶" }, stale);
    let listCalls = 0;
    let deleteCalls = 0;
    const provider: StorageBucketProvider = {
      provider: "local",
      bucketId: stale.bucketId,
      probe: async () => ({ ok: true, conditionalWrites: "native", latencyMs: 0 }),
      get: async () => undefined,
      list: async () => { listCalls += 1; return { objects: [{ path: "data/a", bytes: new Uint8Array([1]), size: 1, etag: "a" }] }; },
      put: async () => ({ etag: "unused" }),
      delete: async () => { deleteCalls += 1; },
      dispose: () => undefined
    };

    await expect(manager.destroyBucketData({ entry: stale, provider })).rejects.toMatchObject({ code: "storage_conflict" });
    expect(listCalls).toBe(0);
    expect(deleteCalls).toBe(0);
  });
});
