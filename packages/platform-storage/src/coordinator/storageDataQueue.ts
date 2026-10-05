export interface StorageDataSlotLifecycle {
  /** 物理 Provider Promise 已真正开始执行。 */
  onPhysicalStart?: () => void;
  /** 物理 Provider Promise 已 settle；此时才允许释放并发槽。 */
  onPhysicalSettled?: () => void;
}

// Storage owns admission fairness and physical Promise accounting; Coordinator only wires callers and leases.
export const STORAGE_DATA_CONCURRENCY = 4;
export const STORAGE_DATA_MAX_QUEUE = 64;
export const STORAGE_DATA_MAX_ACTIVE_PER_PORT = STORAGE_DATA_CONCURRENCY - 1;
function storageCoordinatorError(code: "storage_limit_exceeded" | "storage_unavailable", message: string = code): Error & { code: typeof code } {
  const error = new Error(message) as Error & { code: typeof code };
  error.code = code;
  return error;
}


export function createStorageDataQueue() {
let storageDataActive = 0;
type StorageDataWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  active: boolean;
  clientId: string;
};
const storageDataWaiters: StorageDataWaiter[] = [];
const storageDataActiveByPort = new Map<string, number>();
function pumpStorageDataWaiters(): void {
  while (storageDataActive < STORAGE_DATA_CONCURRENCY && storageDataWaiters.length) {
    let index = storageDataWaiters.findIndex((waiter) => (storageDataActiveByPort.get(waiter.clientId) ?? 0) < STORAGE_DATA_MAX_ACTIVE_PER_PORT);
    if (index < 0) index = 0; // no competing port: do not strand a single client
    const waiter = storageDataWaiters.splice(index, 1)[0]!;
    if (!waiter.active) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      continue;
    }
    if (waiter.signal?.aborted) {
      waiter.active = false;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      continue;
    }
    waiter.active = false;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    storageDataActive += 1;
    storageDataActiveByPort.set(waiter.clientId, (storageDataActiveByPort.get(waiter.clientId) ?? 0) + 1);
    waiter.resolve();
  }
}


/**
 * 取得 Storage physical slot。
 *
 * cancel 只结束调用方等待的 RPC，不结束 Provider 自己的 Promise。槽位和
 * 每端口 physical 计数必须等真实 Promise settle 后才释放，否则忽略
 * AbortSignal 的 Provider 可以被反复 cancel 绕过全局并发上限。
 */
async function withStorageDataSlot<T>(
  clientId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
  lifecycle?: StorageDataSlotLifecycle
): Promise<T> {
  let slotHeld = false;
  const releasePhysicalSlot = (): void => {
    if (!slotHeld) return;
    slotHeld = false;
    storageDataActive = Math.max(0, storageDataActive - 1);
    const nextPort = Math.max(0, (storageDataActiveByPort.get(clientId) ?? 1) - 1);
    if (nextPort) storageDataActiveByPort.set(clientId, nextPort); else storageDataActiveByPort.delete(clientId);
    pumpStorageDataWaiters();
    lifecycle?.onPhysicalSettled?.();
  };

  if (signal?.aborted) throw storageCoordinatorError("storage_unavailable", "Storage request cancelled");
  if (storageDataActive >= STORAGE_DATA_CONCURRENCY || (storageDataActiveByPort.get(clientId) ?? 0) >= STORAGE_DATA_MAX_ACTIVE_PER_PORT) {
    if (storageDataWaiters.length >= STORAGE_DATA_MAX_QUEUE) throw storageCoordinatorError("storage_limit_exceeded");
    await new Promise<void>((resolve, reject) => {
      const waiter: StorageDataWaiter = { resolve, reject, signal, active: true, clientId };
      const abort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = storageDataWaiters.indexOf(waiter);
        if (index >= 0) storageDataWaiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      };
      waiter.onAbort = abort;
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      storageDataWaiters.push(waiter);
    });
    // pumpStorageDataWaiters() 在 resolve waiter 后到这里之间可能发生
    // abort；这时已占用的 slot 不能泄漏，但也不能启动 Provider。
    slotHeld = true;
    if (signal?.aborted) {
      releasePhysicalSlot();
      throw storageCoordinatorError("storage_unavailable", "Storage request cancelled");
    }
  } else {
    storageDataActive += 1;
    storageDataActiveByPort.set(clientId, (storageDataActiveByPort.get(clientId) ?? 0) + 1);
    slotHeld = true;
  }

  lifecycle?.onPhysicalStart?.();
  const operation = Promise.resolve().then(run);
  // 这里是唯一的 physical slot release 点。不能放到下面 RPC race 的
  // finally，否则 cancel 会在 Provider 仍运行时把槽位重新交给新请求。
  void operation.then(releasePhysicalSlot, releasePhysicalSlot);
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await operation;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

  return { run: withStorageDataSlot, snapshot: () => ({ active: storageDataActive, queued: storageDataWaiters.length }),
    resetForTests() { storageDataActive = 0; storageDataActiveByPort.clear(); storageDataWaiters.length = 0; } };
}
