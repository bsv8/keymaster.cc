// Key 应用锁 `<owner 公钥>/lock.json`（keymaster.key-lock）。
//
// 同一把 Key 同一时间只允许一个浏览器使用（读写都算）；不同 Key 的锁互不
// 影响。创建、续约和抢占必须作为条件写执行；拿不到锁就不应安装该 Key 的
// 正常业务运行态。

import type { KeymasterKeyLockV1, StorageBucketProvider } from "@keymaster/contracts";
import { KEYMASTER_KEY_LOCK_TIMING, keyLockPath, validateKeymasterKeyLock } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";

export interface KeyLockReadResult {
  /** 当前合法锁；缺失或损坏时为 undefined。 */
  record?: KeymasterKeyLockV1;
  /** Provider 版本标签，用于条件写/删除。 */
  etag?: string;
  /** 当前对象是否存在但格式无效。 */
  invalid: boolean;
}

export interface KeyLockOptions {
  /** 锁保护的 Key 公钥；决定锁文件路径。 */
  ownerPublicKeyHex: string;
  /** 浏览器 sessionId，必须是 32 位小写 hex。 */
  holder: string;
  /** 测试用时钟；生产默认使用 Date.now。 */
  now?: () => number;
  /** 失去锁时的回调；回调不得继续执行该 Key 的桶 I/O。 */
  onLost?: (error: StorageRuntimeError) => void;
}

export interface KeyLock {
  /** 读取当前锁；无效文件按无锁返回，但不在读取阶段覆盖。 */
  read(): Promise<KeyLockReadResult>;
  /** 获取或续约本浏览器的锁，并启动自动心跳。 */
  acquire(): Promise<KeymasterKeyLockV1>;
  /** 手动续约；条件写失败即视为失去锁。 */
  heartbeat(): Promise<KeymasterKeyLockV1>;
  /** 主动释放本浏览器持有的锁。 */
  release(): Promise<void>;
  /** 停止定时器；不自动删除桶内锁。 */
  dispose(): void;
  /** 当前实例是否仍持有锁。 */
  isHeld(): boolean;
}

const providerWriteTails = new WeakMap<object, Promise<void>>();

/**
 * 条件写冲突后的有界重试上限。
 *
 * 冲突不等于“另一个浏览器”：上一个 Worker 的迟到心跳、刷新窗口内的旧
 * 会话或远程一致性延迟都可能让读到的 ETag 失效，而锁文件仍属于本
 * holder。此时必须重读 ETag 再抢，不能把本浏览器误报成其它浏览器。
 */
const ACQUIRE_CONFLICT_RETRY_LIMIT = 4;
const RELEASE_CONFLICT_RETRY_LIMIT = 3;

/** 退避等待；让迟到的条件写先落地，再重读最新锁状态。 */
function waitBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
}

function withProviderWrite<T>(provider: StorageBucketProvider, operation: () => Promise<T>): Promise<T> {
  const previous = providerWriteTails.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  providerWriteTails.set(provider, current);
  return previous.then(operation).finally(() => {
    release();
    if (providerWriteTails.get(provider) === current) providerWriteTails.delete(provider);
  });
}

function lockError(code: "storage_conflict" | "storage_provider_error" | "storage_unavailable", message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function encode(value: KeymasterKeyLockV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode(bytes: Uint8Array): KeymasterKeyLockV1 | undefined {
  try {
    return validateKeymasterKeyLock(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return undefined;
  }
}

function nextRecord(holder: string, now: number, acquiredAt = now): KeymasterKeyLockV1 {
  return {
    format: "keymaster.key-lock",
    version: 1,
    holder,
    acquiredAt,
    heartbeatAt: now,
    expiresAt: now + KEYMASTER_KEY_LOCK_TIMING.ttlMs,
  };
}

/** 创建一个绑定 Provider 与 owner 的 Key 应用锁。 */
export function createKeyLock(provider: StorageBucketProvider, options: KeyLockOptions): KeyLock {
  if (!/^[0-9a-f]{32}$/u.test(options.holder)) throw new TypeError("Key lock holder is invalid");
  const path = keyLockPath(options.ownerPublicKeyHex);
  const now = options.now ?? (() => Date.now());
  let held = false;
  let released = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function lose(error: StorageRuntimeError): never {
    held = false;
    stopHeartbeat();
    options.onLost?.(error);
    throw error;
  }

  async function read(): Promise<KeyLockReadResult> {
    const object = await provider.get(path);
    if (!object) return { invalid: false };
    const record = decode(object.bytes);
    return { ...(record ? { record } : {}), ...(object.etag === undefined ? {} : { etag: object.etag }), invalid: !record };
  }

  async function write(record: KeymasterKeyLockV1, etag: string | undefined, createOnly: boolean): Promise<void> {
    try {
      await withProviderWrite(provider, () => provider.put(path, encode(record), {
        ...(createOnly ? { ifNoneMatch: "*" as const } : {}),
        ...(createOnly ? {} : etag === undefined ? {} : { ifMatch: etag }),
      }));
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw lockError("storage_provider_error", "Key lock write failed");
    }
  }

  async function acquire(): Promise<KeymasterKeyLockV1> {
    if (released) throw lockError("storage_unavailable", "Key lock is disposed");
    for (let attempt = 0; ; attempt += 1) {
      const current = await read();
      const timestamp = now();
      if (current.record && current.record.expiresAt > timestamp && current.record.holder !== options.holder) {
        throw lockError("storage_conflict", "Key is being used by another browser");
      }
      const record = nextRecord(options.holder, timestamp, current.record?.holder === options.holder ? current.record.acquiredAt : timestamp);
      try {
        await write(record, current.etag, !current.record && !current.invalid);
      } catch (caught) {
        if (!(caught instanceof StorageRuntimeError) || caught.code !== "storage_conflict") throw caught;
        // 读-写之间锁文件被改动：重读判定真实持有者，再决定重试或失败。
        if (released) throw lockError("storage_unavailable", "Key lock is disposed");
        if (attempt >= ACQUIRE_CONFLICT_RETRY_LIMIT) {
          throw lockError("storage_conflict", "Key lock was acquired by another browser");
        }
        const fresh = await read();
        if (fresh.record && fresh.record.expiresAt > now() && fresh.record.holder !== options.holder) {
          throw lockError("storage_conflict", "Key is being used by another browser");
        }
        await waitBeforeRetry(attempt);
        continue;
      }
      held = true;
      stopHeartbeat();
      timer = setInterval(() => { void heartbeat().catch(() => undefined); }, KEYMASTER_KEY_LOCK_TIMING.heartbeatIntervalMs);
      return record;
    }
  }

  async function heartbeat(): Promise<KeymasterKeyLockV1> {
    if (released || !held) throw lockError("storage_conflict", "Key lock is not held");
    const current = await read();
    const timestamp = now();
    if (!current.record || current.record.holder !== options.holder || current.record.expiresAt <= timestamp) {
      return lose(lockError("storage_conflict", "Key lock has been lost"));
    }
    const record = nextRecord(options.holder, timestamp, current.record.acquiredAt);
    try {
      await write(record, current.etag, false);
    } catch (caught) {
      if (caught instanceof StorageRuntimeError && caught.code === "storage_conflict") return lose(lockError("storage_conflict", "Key lock has been lost"));
      return lose(caught instanceof StorageRuntimeError ? caught : lockError("storage_provider_error", "Key lock heartbeat failed"));
    }
    return record;
  }

  async function release(): Promise<void> {
    stopHeartbeat();
    if (!held || released) { held = false; return; }
    held = false;
    for (let attempt = 0; ; attempt += 1) {
      const current = await read();
      if (!current.record || current.record.holder !== options.holder) return;
      try {
        await withProviderWrite(provider, () => provider.delete(path, current.etag === undefined ? {} : { ifMatch: current.etag }));
        return;
      } catch (caught) {
        if (caught instanceof StorageRuntimeError && caught.code === "storage_not_found") return;
        // 同 holder 的迟到心跳可能刚换了 ETag；删除失败不等于锁已易主，
        // 重读一次，只要仍是本 holder 就继续删。
        if (caught instanceof StorageRuntimeError && caught.code === "storage_conflict" && attempt < RELEASE_CONFLICT_RETRY_LIMIT && !released) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw caught instanceof StorageRuntimeError ? caught : lockError("storage_provider_error", "Key lock release failed");
      }
    }
  }

  function dispose(): void {
    released = true;
    held = false;
    stopHeartbeat();
  }

  return { read, acquire, heartbeat, release, dispose, isHeld: () => held && !released };
}
