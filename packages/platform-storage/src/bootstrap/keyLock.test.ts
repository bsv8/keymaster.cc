import { describe, expect, it } from "vitest";
import type { StorageBucketObject, StorageBucketProvider } from "@keymaster/contracts";
import { keyLockPath } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { createKeyLock } from "./keyLock.js";

const OWNER_A = "02" + "a".repeat(64);
const OWNER_B = "03" + "b".repeat(64);
const HOLDER_A = "a".repeat(32);
const HOLDER_B = "b".repeat(32);

class MemoryProvider implements StorageBucketProvider {
  readonly provider = "s3" as const;
  readonly bucketId = "bucket";
  protected readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  /** 条件写冲突注入次数；模拟迟到心跳/远程一致性造成的 412。 */
  failNextPuts = 0;
  /** 条件删除冲突注入次数；模拟释放时读到陈旧 ETag。 */
  failNextDeletes = 0;
  async probe() { return { ok: true as const, conditionalWrites: "native" as const, latencyMs: 0 }; }
  async get(path: string): Promise<StorageBucketObject | undefined> {
    const object = this.objects.get(path);
    return object ? { path, bytes: object.bytes.slice(), etag: object.etag } : undefined;
  }
  async list() { return { objects: [] }; }
  async put(path: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: "*" } = {}) {
    if (this.failNextPuts > 0) {
      this.failNextPuts -= 1;
      throw new StorageRuntimeError("storage_conflict", "injected concurrent write");
    }
    const existing = this.objects.get(path);
    if (condition.ifNoneMatch === "*" && existing) throw new StorageRuntimeError("storage_conflict", "exists");
    if (condition.ifMatch !== undefined && condition.ifMatch !== existing?.etag) throw new StorageRuntimeError("storage_conflict", "changed");
    const etag = String(bytes.length) + ":" + bytes[0];
    this.objects.set(path, { bytes: bytes.slice(), etag });
    return { etag };
  }
  async delete(path: string, condition: { ifMatch?: string } = {}) {
    if (this.failNextDeletes > 0) {
      this.failNextDeletes -= 1;
      throw new StorageRuntimeError("storage_conflict", "injected concurrent heartbeat");
    }
    const existing = this.objects.get(path);
    if (!existing) throw new StorageRuntimeError("storage_not_found", "missing");
    if (condition.ifMatch !== undefined && condition.ifMatch !== existing.etag) throw new StorageRuntimeError("storage_conflict", "changed");
    this.objects.delete(path);
  }
  /** 测试夹具：直接写入原始锁记录，模拟外部（旧 Worker）的迟到心跳。 */
  seed(path: string, bytes: Uint8Array, etag: string): void {
    this.objects.set(path, { bytes: bytes.slice(), etag });
  }
  dispose() {}
}

describe("key application lock", () => {
  it("获取、续约并释放锁，文件写在 owner 目录下", async () => {
    const provider = new MemoryProvider();
    let timestamp = 1_000;
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => timestamp });
    const acquired = await lock.acquire();
    expect(acquired).toMatchObject({ format: "keymaster.key-lock", holder: HOLDER_A, acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: timestamp + 60_000 });
    expect(await provider.get(keyLockPath(OWNER_A))).toBeDefined();
    timestamp += 1_000;
    expect((await lock.heartbeat()).acquiredAt).toBe(1_000);
    await lock.release();
    expect(lock.isHeld()).toBe(false);
    expect(await provider.get(keyLockPath(OWNER_A))).toBeUndefined();
    lock.dispose();
  });

  it("未过期的其它持有者不能获取；不同 Key 的锁互不影响", async () => {
    const provider = new MemoryProvider();
    const first = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => 1_000 });
    await first.acquire();
    const second = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_B, now: () => 2_000 });
    await expect(second.acquire()).rejects.toMatchObject({ code: "storage_conflict" });
    const otherKey = createKeyLock(provider, { ownerPublicKeyHex: OWNER_B, holder: HOLDER_B, now: () => 2_000 });
    await expect(otherKey.acquire()).resolves.toMatchObject({ holder: HOLDER_B });
    await first.release();
    first.dispose();
    second.dispose();
    otherKey.dispose();
  });

  it("过期锁可以被其它持有者抢占", async () => {
    const provider = new MemoryProvider();
    let timestamp = 1_000;
    const first = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => timestamp });
    await first.acquire();
    timestamp += 61_000;
    const second = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_B, now: () => timestamp });
    await expect(second.acquire()).resolves.toMatchObject({ holder: HOLDER_B });
    await expect(first.heartbeat()).rejects.toMatchObject({ code: "storage_conflict" });
    first.dispose();
    second.dispose();
  });

  it("同 holder 的迟到心跳造成条件写冲突时重读并接管，不误报其它浏览器", async () => {
    const provider = new MemoryProvider();
    const timestamp = 1_000;
    // 模拟刷新窗口里旧 Worker 留下的、仍属于本 session 的锁。
    provider.seed(keyLockPath(OWNER_A), new TextEncoder().encode(JSON.stringify({
      format: "keymaster.key-lock",
      version: 1,
      holder: HOLDER_A,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: timestamp + 60_000,
    })), "stale-etag");
    provider.failNextPuts = 1;
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => timestamp + 1_000 });
    await expect(lock.acquire()).resolves.toMatchObject({ holder: HOLDER_A, acquiredAt: timestamp });
    expect(lock.isHeld()).toBe(true);
    await lock.release();
    lock.dispose();
  });

  it("冲突后重读发现其它未过期 holder 时仍然失败", async () => {
    const provider = new MemoryProvider();
    let reads = 0;
    // 首次读取看不到锁（createOnly），写入被抢占，第二次读取才发现他人锁。
    const originalGet = provider.get.bind(provider);
    provider.get = async (path: string) => {
      reads += 1;
      if (reads === 1) return undefined;
      if (reads === 2) {
        return {
          path,
          etag: "other-etag",
          bytes: new TextEncoder().encode(JSON.stringify({
            format: "keymaster.key-lock",
            version: 1,
            holder: HOLDER_B,
            acquiredAt: 1_000,
            heartbeatAt: 1_000,
            expiresAt: 1_000 + 60_000,
          })),
        };
      }
      return originalGet(path);
    };
    provider.failNextPuts = 1;
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => 2_000 });
    await expect(lock.acquire()).rejects.toMatchObject({ code: "storage_conflict", message: "Key is being used by another browser" });
    lock.dispose();
  });

  it("释放时遇到陈旧 ETag 会重读并删除本 holder 的锁", async () => {
    const provider = new MemoryProvider();
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => 1_000 });
    await lock.acquire();
    provider.failNextDeletes = 1;
    await expect(lock.release()).resolves.toBeUndefined();
    expect(await provider.get(keyLockPath(OWNER_A))).toBeUndefined();
    lock.dispose();
  });

  it("损坏的锁文件按无锁处理并覆盖", async () => {
    const provider = new MemoryProvider();
    await provider.put(keyLockPath(OWNER_A), new TextEncoder().encode("broken"));
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => 1_000 });
    await expect(lock.acquire()).resolves.toMatchObject({ holder: HOLDER_A });
    expect((await lock.read()).invalid).toBe(false);
    lock.dispose();
  });
});
