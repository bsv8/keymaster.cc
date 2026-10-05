import type { CoordinatorMsFileData, CoordinatorResponse, MsFileReadConcurrencySettings } from "@keymaster/contracts";

/** MSFile owns the bounded stat/seed/block queue. Physical provider promises
 * keep their concurrency slot until settlement, including after cancellation.
 */
export function createMsfileDataQueue(settings: () => MsFileReadConcurrencySettings, unavailable: (message: string) => Error) {
const MSFILE_DATA_MAX_QUEUE = 256;
type MsFileDataClass = "stat" | "seed" | "block";
interface MsFileDataWaiter {
  clientId: string;
  dataClass: MsFileDataClass;
  signal: AbortSignal;
  run: () => Promise<CoordinatorResponse>;
  resolve: (response: CoordinatorResponse) => void;
  reject: (error: Error) => void;
  active: boolean;
  onAbort: () => void;
}
const msfileDataWaiters: MsFileDataWaiter[] = [];
const msfileDataActiveByClient = new Map<string, number>();
/** 每个 client 最近一次获得槽位的顺序；用于真正的轮转公平，而不是只靠 FIFO。 */
const msfileDataClientLastServed = new Map<string, number>();
let msfileDataDispatchSequence = 0;
let msfileDataActive = 0;
let msfileStatActive = 0;
let msfileSeedDataActive = 0;
let msfileBlockDataActive = 0;

function msfileDataClass(data: CoordinatorMsFileData): MsFileDataClass {
  switch (data.type) {
    case "stat": return "stat";
    case "read-seed": return "seed";
    case "read-block": return "block";
  }
}

function msfileDataClassHasCapacity(dataClass: MsFileDataClass): boolean {
  switch (dataClass) {
    case "stat": return msfileStatActive < settings().globalStatConcurrency;
    case "seed": return msfileSeedDataActive < settings().globalSeedReadConcurrency;
    case "block": return msfileBlockDataActive < settings().globalBlockReadConcurrency;
  }
}

function msfileDataClientActive(clientId: string): number {
  return msfileDataActiveByClient.get(clientId) ?? 0;
}

function pumpMsfileDataWaiters(): void {
  while (true) {
    let selectedIndex = -1;
    let selectedClientLastServed = Number.POSITIVE_INFINITY;
    for (let index = 0; index < msfileDataWaiters.length; index += 1) {
      const waiter = msfileDataWaiters[index]!;
      if (!waiter.active) continue;
      if (waiter.signal.aborted) {
        msfileDataWaiters.splice(index, 1);
        index -= 1;
        waiter.active = false;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(unavailable("MSFile request was cancelled while waiting"));
        continue;
      }
      if (!msfileDataClassHasCapacity(waiter.dataClass)) continue;
      // 同一类资源满时跳过；有可用槽位时按 client 的最近服务顺序轮转。
      // 仅按当前 active 数 + FIFO 会让持续入队的 player 永远压在后来
      // 的 Connect App 前面，因此这里把“最近服务时间”作为主排序键。
      const clientLastServed = msfileDataClientLastServed.get(waiter.clientId) ?? 0;
      if (clientLastServed < selectedClientLastServed) {
        selectedIndex = index;
        selectedClientLastServed = clientLastServed;
      }
    }
    if (selectedIndex < 0) break;
    const waiter = msfileDataWaiters.splice(selectedIndex, 1)[0]!;
    if (!waiter.active) continue;
    waiter.active = false;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    msfileDataActive += 1;
    if (waiter.dataClass === "stat") msfileStatActive += 1;
    if (waiter.dataClass === "seed") msfileSeedDataActive += 1;
    if (waiter.dataClass === "block") msfileBlockDataActive += 1;
    msfileDataActiveByClient.set(waiter.clientId, msfileDataClientActive(waiter.clientId) + 1);
    msfileDataDispatchSequence += 1;
    msfileDataClientLastServed.set(waiter.clientId, msfileDataDispatchSequence);
    void waiter.run().then(waiter.resolve, waiter.reject).finally(() => {
      msfileDataActive = Math.max(0, msfileDataActive - 1);
      if (waiter.dataClass === "stat") msfileStatActive = Math.max(0, msfileStatActive - 1);
      if (waiter.dataClass === "seed") msfileSeedDataActive = Math.max(0, msfileSeedDataActive - 1);
      if (waiter.dataClass === "block") msfileBlockDataActive = Math.max(0, msfileBlockDataActive - 1);
      const nextClientActive = Math.max(0, msfileDataClientActive(waiter.clientId) - 1);
      if (nextClientActive === 0) msfileDataActiveByClient.delete(waiter.clientId);
      else msfileDataActiveByClient.set(waiter.clientId, nextClientActive);
      if (nextClientActive === 0 && !msfileDataWaiters.some((pending) => pending.active && pending.clientId === waiter.clientId)) {
        msfileDataClientLastServed.delete(waiter.clientId);
      }
      pumpMsfileDataWaiters();
    });
  }
}

function withMsfileDataSlot(
  clientId: string,
  data: CoordinatorMsFileData,
  run: () => Promise<CoordinatorResponse>,
  signal: AbortSignal,
): Promise<CoordinatorResponse> {
  if (signal.aborted) return Promise.reject(unavailable("MSFile request was cancelled"));
  if (msfileDataWaiters.length >= MSFILE_DATA_MAX_QUEUE) {
    return Promise.reject(unavailable("MSFile request queue is full"));
  }
  const dataClass = msfileDataClass(data);
  return new Promise<CoordinatorResponse>((resolve, reject) => {
    const waiter: MsFileDataWaiter = {
      clientId,
      dataClass,
      signal,
      run,
      resolve,
      reject,
      active: true,
      onAbort: () => {
        const index = msfileDataWaiters.indexOf(waiter);
        if (index < 0 || !waiter.active) return;
        msfileDataWaiters.splice(index, 1);
        waiter.active = false;
        reject(unavailable("MSFile request was cancelled while waiting"));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    msfileDataWaiters.push(waiter);
    pumpMsfileDataWaiters();
  });
}

function rejectMsfileDataWaiters(error = unavailable("MSFile request queue was cancelled")): void {
  for (const waiter of msfileDataWaiters.splice(0)) {
    if (!waiter.active) continue;
    waiter.active = false;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}

return {
  run: withMsfileDataSlot,
  pump: pumpMsfileDataWaiters,
  rejectQueued: rejectMsfileDataWaiters,
  resetForTests() {
    rejectMsfileDataWaiters();
    msfileDataActiveByClient.clear();
    msfileDataClientLastServed.clear();
    msfileDataDispatchSequence = 0;
    msfileDataActive = 0;
    msfileStatActive = 0;
    msfileSeedDataActive = 0;
    msfileBlockDataActive = 0;
  },
};
}
