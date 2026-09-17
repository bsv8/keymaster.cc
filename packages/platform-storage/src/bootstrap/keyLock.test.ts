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
  private readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  async probe() { return { ok: true as const, conditionalWrites: "native" as const, latencyMs: 0 }; }
  async get(path: string): Promise<StorageBucketObject | undefined> {
    const object = this.objects.get(path);
    return object ? { path, bytes: object.bytes.slice(), etag: object.etag } : undefined;
  }
  async list() { return { objects: [] }; }
  async put(path: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: "*" } = {}) {
    const existing = this.objects.get(path);
    if (condition.ifNoneMatch === "*" && existing) throw new StorageRuntimeError("storage_conflict", "exists");
    if (condition.ifMatch !== undefined && condition.ifMatch !== existing?.etag) throw new StorageRuntimeError("storage_conflict", "changed");
    const etag = String(bytes.length) + ":" + bytes[0];
    this.objects.set(path, { bytes: bytes.slice(), etag });
    return { etag };
  }
  async delete(path: string, condition: { ifMatch?: string } = {}) {
    const existing = this.objects.get(path);
    if (!existing) throw new StorageRuntimeError("storage_not_found", "missing");
    if (condition.ifMatch !== undefined && condition.ifMatch !== existing.etag) throw new StorageRuntimeError("storage_conflict", "changed");
    this.objects.delete(path);
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

  it("损坏的锁文件按无锁处理并覆盖", async () => {
    const provider = new MemoryProvider();
    await provider.put(keyLockPath(OWNER_A), new TextEncoder().encode("broken"));
    const lock = createKeyLock(provider, { ownerPublicKeyHex: OWNER_A, holder: HOLDER_A, now: () => 1_000 });
    await expect(lock.acquire()).resolves.toMatchObject({ holder: HOLDER_A });
    expect((await lock.read()).invalid).toBe(false);
    lock.dispose();
  });
});
