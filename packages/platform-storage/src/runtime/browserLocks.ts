// 浏览器存储锁抽象。
//
// Web Locks 是 secure-context API，因此任意主机的 HTTP 页面可能没有
// navigator.locks。此处只在显式 insecure context 中提供“当前页面内”队列；
// 它不能伪造跨标签页互斥，调用方应把该模式显示为兼容降级，而不能把它
// 当作多标签页安全保证。

export interface BrowserStorageLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

const tails = new Map<string, Promise<void>>();

function abortError(): Error {
  const error = new Error("Storage operation was cancelled");
  error.name = "AbortError";
  return error;
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

const insecureContextLocks: BrowserStorageLocks = {
  async request<T>(name: string, optionsOrCallback: { signal?: AbortSignal } | (() => Promise<T>), maybeCallback?: () => Promise<T>): Promise<T> {
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) throw new TypeError("Storage lock callback is required");
    const previous = tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(name, tail);
    try {
      await waitForTurn(previous, options?.signal);
      if (options?.signal?.aborted) throw abortError();
      return await callback();
    } finally {
      release();
      if (tails.get(name) === tail) tails.delete(name);
    }
  }
};

/** Native Web Locks, or the explicitly limited insecure-HTTP page queue. */
export function browserStorageLocks(): BrowserStorageLocks | undefined {
  const native = (globalThis as typeof globalThis & { navigator?: { locks?: BrowserStorageLocks } }).navigator?.locks;
  if (native) return native;
  if (globalThis.isSecureContext === false) return insecureContextLocks;
  return undefined;
}

export function browserStorageLockMode(): "native" | "single-page-fallback" | "unavailable" {
  const native = (globalThis as typeof globalThis & { navigator?: { locks?: BrowserStorageLocks } }).navigator?.locks;
  if (native) return "native";
  return globalThis.isSecureContext === false ? "single-page-fallback" : "unavailable";
}
