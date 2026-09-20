/**
 * Keymaster 领域自己的跨物理 Worker authority 锁。
 *
 * WebLoom 只负责 typed transport；这里使用 origin 级 Web Locks 名称，
 * 因此同源的不同 Worker URL（例如旧构建和新构建）仍然竞争同一把锁。
 * 锁会在整个 Coordinator Worker 生命周期内保持，直到 Worker 退场；
 * 不是每个业务请求临时创建一把只在当前 Worker 内有效的锁。
 */

export const COORDINATOR_AUTHORITY_LOCK_NAME = "keymaster.coordinator.authority:v1";

export interface CoordinatorAuthorityLock {
  /** 释放当前 Worker 的跨 Worker authority；调用必须幂等。 */
  release(): Promise<void>;
}

interface NativeWebLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: boolean },
    callback: (lock: unknown | null) => Promise<T> | T,
  ): Promise<T>;
}

function authorityError(code: "upgrade.authority_unavailable" | "upgrade.authority_conflict", message: string, cause?: unknown): Error & { code: string } {
  const error = Object.assign(new Error(message), { code });
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function isTestBuild(): boolean {
  return (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test";
}

function nativeWebLocks(): NativeWebLockManager | undefined {
  try {
    const navigatorValue = (globalThis as typeof globalThis & {
      navigator?: { locks?: NativeWebLockManager };
    }).navigator;
    return navigatorValue?.locks;
  } catch {
    // 读取 WorkerNavigator.locks 失败等价于能力不可用；调用方必须
    // fail closed，不能退回每个 Worker 自己的内存 authority。
    return undefined;
  }
}

/**
 * Node/Vitest 没有 SharedWorker 的 Navigator；测试只在显式 test build 中
 * 使用这个进程内替身，生产/预览构建绝不把它当作跨 Worker 保证。
 */
let testAuthorityLockHeld = false;

async function acquireTestAuthorityLock(): Promise<CoordinatorAuthorityLock> {
  if (testAuthorityLockHeld) {
    throw authorityError("upgrade.authority_conflict", "Another Coordinator authority already owns the test lock");
  }
  testAuthorityLockHeld = true;
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      testAuthorityLockHeld = false;
    },
  };
}

/**
 * 取得跨 Worker authority。ifAvailable=true 是故意的：旧构建仍存活时，
 * 新构建立即失败关闭，不能排队后再用过期的本地 session/私钥执行 I/O。
 */
export async function acquireCoordinatorAuthorityLock(): Promise<CoordinatorAuthorityLock> {
  const locks = nativeWebLocks();
  if (!locks?.request) {
    if (isTestBuild()) return acquireTestAuthorityLock();
    throw authorityError(
      "upgrade.authority_unavailable",
      "Keymaster Coordinator requires native Web Locks for cross-Worker authority",
    );
  }

  let acquired = false;
  let releaseHeld: (() => void) | undefined;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquiredPromise = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });

  let requestPromise: Promise<unknown>;
  try {
    requestPromise = locks.request(
      COORDINATOR_AUTHORITY_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          rejectAcquired(authorityError(
            "upgrade.authority_conflict",
            "Another Coordinator Worker already owns the Keymaster authority lock",
          ));
          return;
        }
        acquired = true;
        resolveAcquired();
        await held;
      },
    );
  } catch (error) {
    // 部分 Worker/测试替身会在 request() 调用点同步抛错；它和返回
    // rejected Promise 一样表示 Web Lock 能力不可用，不能把原始 DOM
    // 异常直接泄漏成普通启动失败，也不能误退回本地互斥。
    throw authorityError(
      "upgrade.authority_unavailable",
      "Keymaster Coordinator authority Web Lock request failed",
      error,
    );
  }
  void requestPromise.catch((error) => {
    if (!acquired) {
      rejectAcquired(authorityError(
        "upgrade.authority_unavailable",
        "Keymaster Coordinator authority Web Lock request failed",
        error,
      ));
    }
  });

  await acquiredPromise;
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      releaseHeld?.();
      await requestPromise.catch(() => undefined);
    },
  };
}
