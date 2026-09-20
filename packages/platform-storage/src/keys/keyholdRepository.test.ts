import { describe, expect, it } from "vitest";
import type {
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import {
  createKeyHoldRepository,
  KEYHOLD_KEYS_PREFIX,
} from "./keyholdRepository.js";

/** 只模拟桶对象、分页和原生条件写；不引入第二套持久化模型。 */
class MemoryBucketProvider implements StorageBucketProvider {
  readonly provider = "local" as const;
  readonly bucketId = "keyhold-test";
  readonly writes: Array<{ path: string; condition: StorageBucketWriteCondition }> = [];
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private sequence = 0;
  failGet = false;

  async probe(): Promise<StorageBucketProbeResult> {
    return { ok: true, conditionalWrites: "native", latencyMs: 0 };
  }

  async get(path: string): Promise<StorageBucketObject | undefined> {
    if (this.failGet) throw new StorageRuntimeError("storage_provider_error", "读取失败");
    const value = this.objects.get(path);
    return value === undefined
      ? undefined
      : { path, bytes: value.bytes.slice(), size: value.bytes.byteLength, etag: value.etag };
  }

  async list(input: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageBucketListPage> {
    const prefix = input.prefix ?? "";
    const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
    const limit = input.limit ?? 1000;
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const selected = paths.slice(offset, offset + limit).map((path) => {
      const value = this.objects.get(path)!;
      return { path, bytes: new Uint8Array(), size: value.bytes.byteLength, etag: value.etag };
    });
    return {
      objects: selected,
      ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
    };
  }

  async put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition = {}): Promise<{ etag: string }> {
    const current = this.objects.get(path);
    if (condition.ifNoneMatch === "*" && current !== undefined) {
      throw new StorageRuntimeError("storage_conflict", "目标已存在");
    }
    if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) {
      throw new StorageRuntimeError("storage_conflict", "版本已变化");
    }
    this.writes.push({ path, condition: { ...condition } });
    const etag = `etag-${++this.sequence}`;
    this.objects.set(path, { bytes: bytes.slice(), etag });
    return { etag };
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<void> {
    const current = this.objects.get(path);
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
      throw new StorageRuntimeError("storage_conflict", "版本已变化");
    }
    this.objects.delete(path);
  }

  dispose(): void { /* 测试 Provider 无需释放资源。 */ }
}

function privateKey(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = value;
  return bytes;
}

// KDF 迭代（600k）在批量并发运行时可能超过默认 5s；这里给整个套件 15s
// 上限，避免把“慢”误报为“失败”。
describe("KeyHold repository", { timeout: 15_000 }, () => {
  it("按公钥文件名创建、列出、读取、解锁和导出单 Key", async () => {
    const provider = new MemoryBucketProvider();
    const repository = createKeyHoldRepository(provider);
    const secret = privateKey(1);
    const created = await repository.create({ label: "主 Key", privateKeyBytes: secret, password: "key-password", iterations: 600_000 });
    const path = `${KEYHOLD_KEYS_PREFIX}${created.document.publicKeyHex}.keyhold`;

    expect([...provider.objects.keys()]).toEqual([path]);
    expect(provider.writes[0]).toMatchObject({ path, condition: { ifNoneMatch: "*" } });
    expect(await repository.read(created.document.publicKeyHex)).toEqual(created);
    await expect(repository.list()).resolves.toEqual({
      keys: [{ label: "主 Key", publicKeyHex: created.document.publicKeyHex, path, etag: created.etag }],
      invalidFiles: [],
    });
    await expect(repository.export(created.document.publicKeyHex)).resolves.toEqual(created.bytes);
    const all = await repository.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.document).toEqual(created.document);
    expect(all[0]!.bytes).toEqual(created.bytes);

    await expect(repository.unlock(created.document.publicKeyHex, "wrong-password"))
      .rejects.toMatchObject({ code: "storage_identity_required" });
    const unlocked = await repository.unlock(created.document.publicKeyHex, "key-password");
    expect(unlocked.document).toEqual(created.document);
    expect(unlocked.privateKeyBytes).toEqual(secret);
    expect(unlocked.etag).toBe(created.etag);
    unlocked.privateKeyBytes.fill(0);
  });

  it("导入时保留原始 bytes，并拒绝同名覆盖和非法文件", async () => {
    const sourceProvider = new MemoryBucketProvider();
    const source = createKeyHoldRepository(sourceProvider);
    const created = await source.create({ label: "导入 Key", privateKeyBytes: privateKey(2), password: "key-password", iterations: 600_000 });
    const importedBytes = new TextEncoder().encode(`\n${new TextDecoder().decode(created.bytes)}\n`);
    const targetProvider = new MemoryBucketProvider();
    const target = createKeyHoldRepository(targetProvider);

    const imported = await target.import(importedBytes);
    expect(imported.bytes).toEqual(importedBytes);
    await expect(target.export(created.document.publicKeyHex)).resolves.toEqual(importedBytes);
    await expect(target.import(importedBytes)).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(target.import(new TextEncoder().encode("{}"))).rejects.toMatchObject({ code: "storage_remote_corrupt" });
    await expect(target.import(new Uint8Array(17 * 1024 * 1024))).rejects.toMatchObject({ code: "storage_limit_exceeded" });
  });

  it("改密使用读取到的 ETag，旧密码失效且新密码可解锁", async () => {
    const provider = new MemoryBucketProvider();
    const repository = createKeyHoldRepository(provider);
    const created = await repository.create({ label: "改密 Key", privateKeyBytes: privateKey(3), password: "old-password", iterations: 600_000 });
    const changed = await repository.changePassword({ publicKeyHex: created.document.publicKeyHex, oldPassword: "old-password", newPassword: "new-password", iterations: 600_000 });

    expect(changed.document.publicKeyHex).toBe(created.document.publicKeyHex);
    expect(changed.bytes).not.toEqual(created.bytes);
    expect(provider.writes.at(-1)).toMatchObject({ path: `${KEYHOLD_KEYS_PREFIX}${created.document.publicKeyHex}.keyhold`, condition: { ifMatch: created.etag } });
    await expect(repository.unlock(created.document.publicKeyHex, "old-password"))
      .rejects.toMatchObject({ code: "storage_identity_required" });
    const unlocked = await repository.unlock(created.document.publicKeyHex, "new-password");
    expect(unlocked.privateKeyBytes).toEqual(privateKey(3));
    unlocked.privateKeyBytes.fill(0);
  });

  it("列目录时只跳过损坏 KeyHold，并传播 Provider 读取错误", async () => {
    const provider = new MemoryBucketProvider();
    const repository = createKeyHoldRepository(provider);
    const created = await repository.create({ label: "有效 Key", privateKeyBytes: privateKey(4), password: "key-password", iterations: 600_000 });
    provider.objects.set("keys/not-a-public-key.keyhold", { bytes: new Uint8Array([1]), etag: "bad-name" });
    provider.objects.set(`keys/${created.document.publicKeyHex}.keyhold.bak`, { bytes: new Uint8Array([1]), etag: "bad-extension" });
    provider.objects.set("keys/" + "02" + "aa".repeat(32) + ".keyhold", { bytes: new TextEncoder().encode("not-json"), etag: "bad-document" });

    await expect(repository.list()).resolves.toMatchObject({
      keys: [{ publicKeyHex: created.document.publicKeyHex }],
      invalidFiles: [
        { path: "keys/02" + "aa".repeat(32) + ".keyhold" },
        { path: `keys/${created.document.publicKeyHex}.keyhold.bak` },
        { path: "keys/not-a-public-key.keyhold" },
      ],
    });
    provider.failGet = true;
    await expect(repository.list()).rejects.toMatchObject({ code: "storage_provider_error" });
  });

  it("删除支持可选 ETag，过期版本不会误删", async () => {
    const provider = new MemoryBucketProvider();
    const repository = createKeyHoldRepository(provider);
    const created = await repository.create({ label: "删除 Key", privateKeyBytes: privateKey(5), password: "key-password", iterations: 600_000 });

    await expect(repository.delete(created.document.publicKeyHex, "stale-etag"))
      .rejects.toMatchObject({ code: "storage_conflict" });
    await expect(repository.delete(created.document.publicKeyHex, created.etag)).resolves.toBeUndefined();
    await expect(repository.read(created.document.publicKeyHex)).resolves.toBeUndefined();
  });
});
