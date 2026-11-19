import { SAT_SUBSCRIPTION_RESOURCE_LIMITS } from "@keymaster/contracts";
export interface WorkerBridgeBudgetDependencies {
  configuration(): { bridgeMaxInFlightBytes: number; bridgeMaxPendingItems: number };
  error(code: "ERR_BRIDGE_BYTES_LIMIT" | "ERR_BRIDGE_PENDING_LIMIT", message: string): Error;
}
/** Window P2P owns bounded bridge admission and cancellation of queued operations. */
export function createWorkerBridgeBudget(deps: WorkerBridgeBudgetDependencies) {
  let windowP2pExecutorBridgeInFlightBytes = 0;
  let windowP2pExecutorBridgeInFlightItems = 0;
interface WindowP2pExecutorBridgeBudgetWaiter {
  reservedBytes: number;
  reservedItems: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}
const windowP2pExecutorBridgeBudgetWaiters: WindowP2pExecutorBridgeBudgetWaiter[] = [];

function pumpWindowP2pExecutorBridgeBudget(): void {
  const maxBytes = Math.min(deps.configuration().bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(deps.configuration().bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  while (windowP2pExecutorBridgeBudgetWaiters.length > 0) {
    const waiter = windowP2pExecutorBridgeBudgetWaiters[0]!;
    if (waiter.signal?.aborted) {
      windowP2pExecutorBridgeBudgetWaiters.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new DOMException("The operation was aborted", "AbortError"));
      continue;
    }
    if (windowP2pExecutorBridgeInFlightBytes + waiter.reservedBytes > maxBytes) break;
    if (windowP2pExecutorBridgeInFlightItems + waiter.reservedItems > maxItems) break;
    windowP2pExecutorBridgeBudgetWaiters.shift();
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    windowP2pExecutorBridgeInFlightBytes += waiter.reservedBytes;
    windowP2pExecutorBridgeInFlightItems += waiter.reservedItems;
    waiter.resolve();
  }
}

function reserveWindowP2pExecutorBridgeBytes(reservedBytes: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  const maxBytes = Math.min(deps.configuration().bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(deps.configuration().bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > maxBytes) {
    return Promise.reject(deps.error("ERR_BRIDGE_BYTES_LIMIT", "Window P2P bridge byte limit cannot admit this operation"));
  }
  // inFlightItems 已包含 pending、入站 reservation 以及已经从 waiter
  // 队列中准入但尚未落入 pending map 的项；再加上 waiter 才是完整在途数。
  // 不能只看两个 Map，否则同一轮同步 burst 会在 continuation 执行前超额
  // 接受一倍以上的请求。
  if (windowP2pExecutorBridgeInFlightItems + windowP2pExecutorBridgeBudgetWaiters.length >= maxItems) {
    return Promise.reject(deps.error("ERR_BRIDGE_PENDING_LIMIT", "Window P2P bridge pending item limit reached"));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: WindowP2pExecutorBridgeBudgetWaiter = {
      reservedBytes,
      reservedItems: 1,
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = windowP2pExecutorBridgeBudgetWaiters.indexOf(waiter);
        if (index < 0) return;
        windowP2pExecutorBridgeBudgetWaiters.splice(index, 1);
        reject(new DOMException("The operation was aborted", "AbortError"));
        pumpWindowP2pExecutorBridgeBudget();
      },
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    windowP2pExecutorBridgeBudgetWaiters.push(waiter);
    pumpWindowP2pExecutorBridgeBudget();
  });
}

function releaseWindowP2pExecutorBridgeBytes(reservedBytes: number, reservedItems = 1): void {
  windowP2pExecutorBridgeInFlightBytes = Math.max(0, windowP2pExecutorBridgeInFlightBytes - reservedBytes);
  windowP2pExecutorBridgeInFlightItems = Math.max(0, windowP2pExecutorBridgeInFlightItems - reservedItems);
  pumpWindowP2pExecutorBridgeBudget();
}


  return {
    reserve: reserveWindowP2pExecutorBridgeBytes,
    release: releaseWindowP2pExecutorBridgeBytes,
    pump: pumpWindowP2pExecutorBridgeBudget,
    snapshot: () => ({ bytes: windowP2pExecutorBridgeInFlightBytes, items: windowP2pExecutorBridgeInFlightItems, queued: windowP2pExecutorBridgeBudgetWaiters.length }),
    drop(bytes: number, items: number) {
      windowP2pExecutorBridgeInFlightBytes = Math.max(0, windowP2pExecutorBridgeInFlightBytes - bytes);
      windowP2pExecutorBridgeInFlightItems = Math.max(0, windowP2pExecutorBridgeInFlightItems - items);
    },
    reserveInbound(bytes: number): boolean {
      const maxBytes = Math.min(deps.configuration().bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
      const maxItems = Math.min(deps.configuration().bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
      if (bytes < 1 || bytes > maxBytes || windowP2pExecutorBridgeInFlightBytes + bytes > maxBytes || windowP2pExecutorBridgeInFlightItems + 1 > maxItems) return false;
      windowP2pExecutorBridgeInFlightBytes += bytes;
      windowP2pExecutorBridgeInFlightItems += 1;
      return true;
    },
    reset(error: Error) {
      windowP2pExecutorBridgeInFlightBytes = 0;
      windowP2pExecutorBridgeInFlightItems = 0;
      for (const waiter of windowP2pExecutorBridgeBudgetWaiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
    },
  };
}
