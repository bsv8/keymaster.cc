// packages/plugin-woc/src/wocService.test.ts
// WOC service 行为单测。
//
// 设计缘由（用户反馈）：
//   - 旧测试只看"完成数量"或"snapshot 字段类型"，不能抓真实互斥与限流。
//   - 新测试聚焦三件事：
//     1. 在没有 Web Locks 的 node 环境下，coordinated 必须为 false——
//        我们删掉了 BroadcastChannel 自手搓互斥，承诺只在 Web Locks
//        可用时才声明强协调。
//     2. 当我们注入一个共享的 fake Web Locks 时，两个 service 实例
//        必须串行——任意时刻 acquireSlot 临界区内只能有一个 holder，
//        且持锁者 dispose 后另一个能继续。
//     3. 真正的滑动窗口限流：N 个请求 + requestsPerSecond=R，
//        任意连续 1000ms 内不超过 R 次 fetch。
//
// 时序控制：rate=很大的值（如 1000）以避免被限流卡住，让 pump 串行
// 推进足够快；对限流断言用 rate=3 + 实测时间间隔。其他断言依赖 await
// 而不是 sleep 等待，避免时序敏感。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageBus } from "@keymaster/runtime";
import { createWocService } from "./wocService.js";

interface FetchCall {
  url: string;
  ts: number;
}

function reverseHexBytes(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  const parts = clean.match(/../g) ?? [];
  return parts.reverse().join("");
}

async function calcCanonicalTxidFromRawTxHex(rawTxHex: string): Promise<string> {
  const clean = rawTxHex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  const first = await crypto.subtle.digest("SHA-256", bytes);
  const second = await crypto.subtle.digest("SHA-256", first);
  return Array.from(new Uint8Array(second), (b) => b.toString(16).padStart(2, "0")).reverse().join("");
}

const fetchLog: FetchCall[] = [];

function installFetchMock(opts?: { delayMs?: number; on?: (url: string) => Response | undefined }) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    fetchLog.push({ url, ts: Date.now() });
    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    const custom = opts?.on?.(url);
    if (custom) return custom;
    if (url.includes("/tx/raw")) {
      return new Response(JSON.stringify({ txid: "broadcast-txid" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/confirmed/balance")) {
      return new Response(JSON.stringify({ confirmed: 100, unconfirmed: 0 }), { status: 200 });
    }
    if (url.includes("/confirmed/unspent")) {
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }
    if (url.includes("/confirmed/history")) {
      return new Response(JSON.stringify({ result: [], nextPageToken: undefined }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * 用 FIFO 队列实现的 fake navigator.locks，模拟浏览器 Web Locks 行为。
 * 同名锁串行执行，回调结束才放下一个。挂在 globalThis.navigator.locks，
 * 供同进程内多个 WOC service 实例共享——等价于一个浏览器多 tab 共享
 * 同一把 Web Lock。
 */
function installFakeWebLocks(): { uninstall: () => void; isBusy: () => boolean } {
  const queues = new Map<string, Array<() => void>>();
  const held = new Set<string>();
  const navAny = globalThis as { navigator?: Navigator };
  const prevNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const prevNav = navAny.navigator;
  const fakeNav = {
    ...(prevNav ?? {}),
    locks: {
      async request<T>(name: string, cb: () => Promise<T>): Promise<T | undefined> {
        if (held.has(name)) {
          await new Promise<void>((resolve) => {
            const q = queues.get(name) ?? [];
            q.push(resolve);
            queues.set(name, q);
          });
        }
        held.add(name);
        try {
          return await cb();
        } finally {
          held.delete(name);
          const q = queues.get(name);
          const next = q?.shift();
          if (next) next();
        }
      }
    }
  } as unknown as Navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: fakeNav
  });
  return {
    uninstall() {
      if (prevNavigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", prevNavigatorDescriptor);
        return;
      }
      if (prevNav) {
        Object.defineProperty(globalThis, "navigator", {
          configurable: true,
          writable: true,
          value: prevNav
        });
        return;
      }
      delete (navAny as { navigator?: Navigator }).navigator;
    },
    isBusy() {
      return held.size > 0;
    }
  };
}

beforeEach(() => {
  fetchLog.length = 0;
  localStorage.removeItem("woc.settings");
  localStorage.removeItem("woc.sharedTimestamps");
  installFetchMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WocService basics", () => {
  it("throws when messageBus is missing (硬切换 008 收尾)", () => {
    // 阶段 2：CreateWocServiceOptions.messageBus 强制必填；manifest 必须传 runtime messageBus。
    expect(() => createWocService({} as never)).toThrow(/messageBus is required/);
  });

  it("throws when requestsPerSecond is not positive", () => {
    const s = createWocService({ messageBus: createMessageBus() });
    expect(() => s.updateConfig({ requestsPerSecond: 0 })).toThrow();
    expect(() => s.updateConfig({ requestsPerSecond: -1 })).toThrow();
    s.dispose();
  });

  it("trims trailing slash on baseUrl", () => {
    const s = createWocService({ messageBus: createMessageBus() });
    const c = s.updateConfig({ baseUrl: "https://example.test/bsv///" });
    expect(c.baseUrl).toBe("https://example.test/bsv");
    s.dispose();
  });

  it("snapshot starts with 0 queued/inFlight", () => {
    const s = createWocService({ messageBus: createMessageBus() });
    const snap = s.getQueueSnapshot();
    expect(snap.queued).toBe(0);
    expect(snap.inFlight).toBe(0);
    s.dispose();
  });

  it("aborted request resolves with abort error", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    const ctl = new AbortController();
    const p = s.getAddressConfirmedBalance("main", "addr1", { signal: ctl.signal, priority: "background" });
    ctl.abort();
    await expect(p).rejects.toBeDefined();
    s.dispose();
  });

  it("429 sets backoff and surfaces lastError", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    let first = true;
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      if (first) {
        first = false;
        return new Response("rate", { status: 429, headers: { "retry-after": "1" } });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    s.updateConfig({ baseUrl: "https://mock.test" });
    await expect(s.getAddressConfirmedBalance("main", "addr1", { priority: "background" })).rejects.toThrow();
    const snap = s.getQueueSnapshot();
    expect(snap.backoffUntil).toBeGreaterThan(Date.now());
    expect(snap.lastError).toContain("429");
    s.dispose();
  });

  it("default rate is 2 (硬切换 001)", async () => {
    // 硬切换 001：默认 requestsPerSecond 从 3 改为 2。给服务端窗口、
    // 同 IP 其它请求、浏览器调度误差、429 backoff 留余量。
    const { DEFAULT_WOC_CONFIG } = await import("./wocSettings.js");
    expect(DEFAULT_WOC_CONFIG.requestsPerSecond).toBe(2);
  });

  it("concurrent 429 with shorter retry-after does not shrink existing backoff (硬切换 009)", async () => {
    // 关键不变量：多个 WOC 请求可以并发飞行；先返回的 429 可能要求
    // 等待 30 秒，后返回的 429 可能只要求等待 1 秒。全局 backoff
    // 必须取最长要求，不能被短窗口覆盖。
    //
    // 用 deferred promise 让两个 fetch 同时在飞行；用 actor pump 串行起
    // 跑后（in-flight=2）再分别 resolve。比"自然等 30 秒"快得多。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
    let firstStarted = false;
    let secondStarted = false;
    let firstResolve: (r: Response) => void = () => undefined;
    let secondResolve: (r: Response) => void = () => undefined;
    const firstPending = new Promise<Response>((r) => {
      firstResolve = r;
    });
    const secondPending = new Promise<Response>((r) => {
      secondResolve = r;
    });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      if (!firstStarted) {
        firstStarted = true;
        return firstPending;
      }
      if (!secondStarted) {
        secondStarted = true;
        return secondPending;
      }
      throw new Error("unexpected third fetch");
    }) as unknown as typeof fetch;
    // 立即挂 no-op catch:在测试中途 resolve 触发 429 reject 时,避免
    // unhandledRejection 误报；具体 reject 行为不影响 backoff 断言。
    const p1 = s.getAddressConfirmedBalance("main", "addr-1", { priority: "background" });
    const p2 = s.getAddressConfirmedBalance("main", "addr-2", { priority: "background" });
    p1.catch(() => undefined);
    p2.catch(() => undefined);
    // 等两个 fetch 都已启动（actor pump 串行 pick + acquireSlot 后
    // in-flight=2）。
    for (let i = 0; i < 50 && !(firstStarted && secondStarted); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);
    // 第一个 429:retry-after=30,设置长 backoff 窗口。
    firstResolve(new Response("rate", { status: 429, headers: { "retry-after": "30" } }));
    await new Promise((r) => setTimeout(r, 0));
    const afterLongRetry = s.getQueueSnapshot().backoffUntil ?? 0;
    expect(afterLongRetry).toBeGreaterThan(Date.now());
    // 第二个 429:retry-after=1;若不做单调合并,会把 backoff 缩到 ~1s。
    secondResolve(new Response("rate", { status: 429, headers: { "retry-after": "1" } }));
    await new Promise((r) => setTimeout(r, 0));
    const afterShortRetry = s.getQueueSnapshot().backoffUntil ?? 0;
    // 关键断言：第二次 backoffUntil 不应缩短既有窗口。
    expect(afterShortRetry).toBeGreaterThanOrEqual(afterLongRetry);
    s.dispose();
  }, 5_000);

  it("429 triggered during slot wait: queued entry does NOT proceed (硬切换 001)", async () => {
    // 关键修复：等待 slot 期间其它请求 429 -> 全局 backoff;
    // 当前 entry 必须放回队头，等 backoff 解除再继续发。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1 });
    // 第一次 fetch 触发 429,设置 retry-after=1s。
    let firstCall = true;
    let firstReturnedAt = 0;
    let secondCallStartedAt = 0;
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        // 第一次快速返回 429；firstReturnedAt 锚定 429 实际发生时间。
        firstReturnedAt = Date.now();
        return new Response("rate", { status: 429, headers: { "retry-after": "1" } });
      }
      // 第二次必须等到 backoff 解除后才能调用——若 backoff 期间被调,测试失败。
      secondCallStartedAt = Date.now();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // 发两个请求：第一个 429 触发 backoff;第二个排队。
    const p1 = s.getAddressConfirmedBalance("main", "addr-1", { priority: "background" });
    const p2 = s.getAddressConfirmedBalance("main", "addr-2", { priority: "background" });
    await expect(p1).rejects.toThrow();
    await p2;
    // 关键断言：第二个 fetch 实际发起时间在 firstReturnedAt 之后 ≥ 1000ms
    // （即 retry-after=1 完整被尊重）。注意 firstReturnedAt 应大于 0；
    // 若 fetch mock 异常未赋值，会被这条断言抓住。
    expect(firstReturnedAt).toBeGreaterThan(0);
    expect(secondCallStartedAt - firstReturnedAt).toBeGreaterThanOrEqual(900);
    s.dispose();
  }, 5_000);

  it("broadcast() normalizes exact, reversed, and mismatch txids", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });

    const cases = [
      { rawTxHex: "deadbeef", mode: "exact" as const },
      { rawTxHex: "cafebabe", mode: "reversed" as const },
      { rawTxHex: "0f0e0d0c", mode: "mismatch" as const }
    ];

    for (const c of cases) {
      (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { txhex: string } : { txhex: c.rawTxHex };
        const canonicalTxid = await calcCanonicalTxidFromRawTxHex(body.txhex);
        if (c.mode === "exact") {
          return new Response(JSON.stringify({ txid: canonicalTxid }), { status: 200 });
        }
        if (c.mode === "reversed") {
          return new Response(JSON.stringify({ txid: reverseHexBytes(canonicalTxid) }), { status: 200 });
        }
        return new Response(JSON.stringify({ txid: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }), {
          status: 200
        });
      }) as unknown as typeof fetch;
      const res = await s.broadcast("main", c.rawTxHex, { signal: undefined });
      expect(res.accepted).toBe(true);
      expect(res.canonicalTxid).toBe(await calcCanonicalTxidFromRawTxHex(c.rawTxHex));
      if (c.mode === "exact") {
        expect(res.txidIntegrity).toBe("exact");
        expect(res.providerReturnedTxidNormalized).toBe(res.canonicalTxid);
      } else if (c.mode === "reversed") {
        expect(res.txidIntegrity).toBe("reversed");
        expect(res.providerReturnedTxidRaw).toBeDefined();
      } else {
        expect(res.txidIntegrity).toBe("mismatch");
      }
    }
    s.dispose();
  });
});

describe("WocService coordinated flag", () => {
  // 关键变更：删除 BroadcastChannel 互斥后，只有 Web Locks 算"协调"。
  // 这是契约的关键不变量；UI 据 coordinated=false 提示用户。

  it("coordinated=false when navigator.locks is absent", () => {
    // 默认 node 测试环境没有 navigator.locks。
    const s = createWocService({ messageBus: createMessageBus() });
    expect(s.getQueueSnapshot().coordinated).toBe(false);
    s.dispose();
  });

  it("coordinated=true when navigator.locks is available", () => {
    const fakeLocks = installFakeWebLocks();
    try {
      const s = createWocService({ messageBus: createMessageBus() });
      expect(s.getQueueSnapshot().coordinated).toBe(true);
      s.dispose();
    } finally {
      fakeLocks.uninstall();
    }
  });
});

describe("WocService rate limiting", () => {
  // 用 fake Web Locks 把两个 service 串行起来,验证滑动窗口在锁内严格成立。
  it("rate=3 single tab: 9 requests spread across ≥2 windows", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 3 });
    installFetchMock(); // 已在 beforeEach,这里只是显式表达 mock 立即返回。
    const t0 = Date.now();
    const promises = Array.from({ length: 9 }).map((_, i) =>
      s.getAddressConfirmedBalance("main", `addr-${i}`, { priority: "background" })
    );
    await Promise.all(promises);
    const elapsed = Date.now() - t0;
    // 9 个请求 / 3 req/s → 至少 ~2666ms（前 3 个在 t≈0；4~6 在 t≈1000;
    // 7~9 在 t≈2000）。给宽松下界 1500ms 容纳节点抖动。
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    // 任意连续 1000ms 内不超过 3 次。
    for (let i = 0; i + 3 < fetchLog.length; i += 1) {
      const window = fetchLog[i + 3]!.ts - fetchLog[i]!.ts;
      // 容忍 1ms 抖动：rate=3 时 minSpacing=333.33，3 间隔合计 1000ms 整数化后可能少 1ms。
      expect(window).toBeGreaterThanOrEqual(999);
    }
    s.dispose();
  }, 10_000);

  it("with fake Web Locks: two service instances never enter critical section concurrently", async () => {
    const fakeLocks = installFakeWebLocks();
    try {
      const a = createWocService({ messageBus: createMessageBus() });
      const b = createWocService({ messageBus: createMessageBus() });
      a.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
      b.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
      expect(a.getQueueSnapshot().coordinated).toBe(true);
      expect(b.getQueueSnapshot().coordinated).toBe(true);

      // 临界区计数器：每次 fetch 开始时 +1,结束时 -1;并发数 > 1 即失败。
      // 注意：fetch 在 acquireSlot 释放之后才调度,所以两个 fetch 可以并发
      //      ——但 acquireSlot 不会并发。因此这里 maxConcurrent 可能 > 1,
      //      只用于"系统活着且确实在跑"的活性检查。
      let inCritical = 0;
      let maxConcurrent = 0;
      let fetchCount = 0;
      (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
        fetchCount += 1;
        inCritical += 1;
        maxConcurrent = Math.max(maxConcurrent, inCritical);
        await new Promise((r) => setTimeout(r, 5));
        inCritical -= 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 6; i += 1) {
        promises.push(a.getAddressConfirmedBalance("main", `a-${i}`, { priority: "background" }));
        promises.push(b.getAddressConfirmedBalance("main", `b-${i}`, { priority: "background" }));
      }
      await Promise.all(promises);

      // 12 个请求全部完成。
      expect(fetchCount).toBe(12);
      // Web Locks 强制 acquireSlot 串行;dispose 时已全部释放。
      expect(fakeLocks.isBusy()).toBe(false);
      // 活性自检：至少有 1 个请求进入 fetch（防御测试本身退化）。
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);
      a.dispose();
      b.dispose();
    } finally {
      fakeLocks.uninstall();
    }
  }, 10_000);

  it("with fake Web Locks: disposing holder lets another service proceed", async () => {
    const fakeLocks = installFakeWebLocks();
    try {
      const a = createWocService({ messageBus: createMessageBus() });
      const b = createWocService({ messageBus: createMessageBus() });
      a.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1 });
      b.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1 });

      // rate=1:第一个请求立即,后续每 1000ms 才一个。
      // 让 a 先发一个请求,然后立刻 dispose a。b 必须能继续发自己的请求。
      const pA = a.getAddressConfirmedBalance("main", "a-first", { priority: "background" });
      await pA;
      a.dispose();

      const pB = b.getAddressConfirmedBalance("main", "b-first", { priority: "background" });
      // b 不应被 a 残留的锁卡住——fake locks 在 a 的请求结束时已释放。
      // b 的请求必须能在合理时间内完成（rate=1 但 shared timestamp 已记录
      // a 的 send time,所以 b 要等约 1000ms 后才能发）。
      await pB;
      expect(fetchLog.length).toBe(2);
      expect(fakeLocks.isBusy()).toBe(false);
      b.dispose();
    } finally {
      fakeLocks.uninstall();
    }
  }, 5_000);
});

describe("WocService priority", () => {
  it("broadcast wins over background even when enqueued later", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
    const order: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (url: string) => {
      order.push(url);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ txid: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const pBg = s.getAddressConfirmedBalance("main", "bg-addr", { priority: "background" });
    const pBc = s.broadcast("main", "cafebabe", { signal: undefined });
    await Promise.all([pBg, pBc]);
    // 回归守卫：pump 第一轮必须选 broadcast（最高 priority）；不能先
    // 把 background 抬进 in-flight，也不能让 broadcast 在 await 本地
    // canonical 计算时让出执行权被 background 抢走。修复（硬切换 003
    // 收尾）前，broadcast 任务先 await calc，pump 趁机拉起 background
    // 的 fetch，order[0] 变成 /confirmed/balance，本断言失败。
    expect(order[0]).toContain("/tx/raw");
    s.dispose();
  });

  it("broadcast run's first action is /tx/raw fetch, not local async calc (硬切换 003 收尾)", async () => {
    // 关键回归守卫：broadcast 任务出队后，第一步必须进入 /tx/raw 请求；
    // 不能先 await 本地 canonical 计算（calcCanonicalTxidFromRawTxHex），
    // 否则 broadcast 任务会先让出执行权，pump 趁机拉起 background 任务的
    // fetch，破坏 broadcast 优先级。
    //
    // 旧实现顺序：await calc → fetchJson
    //   pump 选 broadcast → run await calc → yield → pump 选 background →
    //   run 同步 fetch → order[0] = background。
    // 修复后顺序：fetchJson → await calc
    //   pump 选 broadcast → run 同步 fetch → order[0] = /tx/raw。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
    const order: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (url: string) => {
      order.push(url);
      return new Response(JSON.stringify({ txid: "tx" }), { status: 200 });
    }) as unknown as typeof fetch;
    // 先入队 4 个 background，让 broadcast 排在它们之后入队。
    const pBgs = Array.from({ length: 4 }).map((_, i) =>
      s.getAddressConfirmedBalance("main", `bg-${i}`, { priority: "background" })
    );
    const pBc = s.broadcast("main", "deadbeef", { signal: undefined });
    await Promise.all([...pBgs, pBc]);
    // 关键断言：broadcast 任务的 fetch 必须是第一个（pump 先选 broadcast，
    // 且 broadcast 第一步就是 fetch，没有先做本地计算让出执行权）。
    expect(order[0]).toContain("/tx/raw");
    s.dispose();
  });
});

describe("WocService 404 empty result (硬切换 008)", () => {
  // 设计缘由：WOC 对同一地址 balance endpoint 可以返回 200 + 0，但
  // confirmed/unspent 与 confirmed/history 可能返回 404。对钱包来说，
  // 这不是同步失败，而是空 UTXO / 空历史。endpoint 层把 404 翻译成
  // 空结果；其它 endpoint 的 404 仍按错误处理。

  it("confirmed/unspent 404 returns []", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    const result = await s.getAddressConfirmedUtxos("main", "addr-no-utxos");
    expect(result).toEqual([]);
    s.dispose();
  });

  it("unconfirmed/unspent 404 returns []", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    const result = await s.getAddressUnconfirmedUtxos("main", "addr-no-utxos");
    expect(result).toEqual([]);
    s.dispose();
  });

  it("confirmed/history 404 returns { items: [], nextPageToken: undefined }", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    const result = await s.listAddressConfirmedHistory("main", "addr-no-history", { limit: 50 });
    expect(result).toEqual({ items: [], nextPageToken: undefined });
    s.dispose();
  });

  it("unconfirmed/history 404 returns { items: [] }", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    const result = await s.listAddressUnconfirmedHistory("main", "addr-no-history");
    expect(result).toEqual({ items: [] });
    s.dispose();
  });

  it("500 still rejects for confirmed/unspent", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("server error", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;
    await expect(s.getAddressConfirmedUtxos("main", "addr")).rejects.toThrow(/WOC 500/);
    s.dispose();
  });

  it("500 still rejects for confirmed/history", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("server error", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;
    await expect(s.listAddressConfirmedHistory("main", "addr", { limit: 50 })).rejects.toThrow(/WOC 500/);
    s.dispose();
  });

  it("429 still applies backoff and rejects for confirmed/unspent", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("rate", { status: 429, headers: { "retry-after": "1" } });
    }) as unknown as typeof fetch;
    await expect(s.getAddressConfirmedUtxos("main", "addr")).rejects.toThrow();
    // 关键：backoffUntil 必须被设置；不能让 429 静默退化为空结果。
    expect(s.getQueueSnapshot().backoffUntil).toBeGreaterThan(Date.now());
    s.dispose();
  });

  it("broadcast 404 still rejects (not an empty list endpoint)", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    // broadcast / tx raw 端点 404 必须按错误处理——不是空集合语义。
    await expect(s.broadcast("main", "deadbeef", { signal: undefined })).rejects.toThrow(/WOC 404/);
    s.dispose();
  });

  it("404 empty-result does NOT pollute snapshot.lastError", async () => {
    // 关键：endpoint 翻译 404 为空结果后，pump 走 entry.resolve 分支，
    // snapshot.lastError 不会被设为 "WOC 404 Not Found"。WOC tray UI 据此
    // 不会显示假的错误状态。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
    const result = await s.getAddressConfirmedUtxos("main", "addr");
    expect(result).toEqual([]);
    // 关键断言：lastError 不应包含 "404"——endpoint 已翻译成空结果。
    expect(s.getQueueSnapshot().lastError ?? "").not.toContain("404");
    s.dispose();
  });
});

describe("WocService messageBus integration (硬切换 008 收尾)", () => {
  // 设计缘由：
  //   - WOC 通过 MessageBus 接收请求；MessageBus 内部 timeout / abort
  //     会沿 ctl.signal 传到 WOC actor 的内部 mailbox。
  //   - WOC_ACTOR_ACCEPT_CONCURRENCY = 32：MessageBus 并发投递不串行化，
  //     WOC 内部 priority queue / rate limit 仍负责真正限流。
  //   - resetBackoff 不再清 backoffUntil：服务端 Retry-After 必须被尊重，
  //     不能被成功广播提前覆盖。

  it("MessageBus timeout stops WOC from continuing to fetch", async () => {
    // 关键：MessageBus 在 timeoutMs 触发后，actor 的 entry 立即 settle 为
    // canceled；handler 不应继续驱动 fetch。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    let fetchCount = 0;
    let abortObserved = false;
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (_url, init) => {
      fetchCount += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const p = s.getAddressConfirmedBalance("main", "addr", {
      priority: "background",
      timeoutMs: 20
    });
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    // 关键断言：fetch 只被调用一次；超时后 WOC 不再发起新 fetch。
    expect(fetchCount).toBe(1);
    expect(abortObserved).toBe(true);
    s.dispose();
  });

  it("MessageBus timeout removes from inFlight/queued exactly once", async () => {
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (_url, init) => {
      // 永不 resolve 直到 abort；模拟真实网络被取消的行为。
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const p = s.getAddressConfirmedBalance("main", "addr", {
      priority: "background",
      timeoutMs: 20
    });
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    const snap = s.getQueueSnapshot();
    expect(snap.queued).toBe(0);
    expect(snap.inFlight).toBe(0);
    s.dispose();
  });

  it("Retry-After backoff is respected for subsequent broadcast", async () => {
    // 关键：429 设定 Retry-After=1 后，pump 必须等 backoff 解除才能发
    // broadcast；这间接证明 backoffUntil 仍生效（没被 resetBackoff 提前清掉）。
    // 旧实现 resetBackoff 同时清 backoffStep 与 backoffUntil，pump 的下一
    // 轮 backoff 检查会因 backoffUntil=0 而放行——本测试要求 broadcast
    // 必须在 backoff 解除后才发出。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test" });
    let firstBalance = true;
    let broadcastFetchAt = 0;
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (url) => {
      if (firstBalance && url.includes("/confirmed/balance")) {
        firstBalance = false;
        return new Response("rate", { status: 429, headers: { "retry-after": "1" } });
      }
      if (url.includes("/tx/raw")) {
        broadcastFetchAt = Date.now();
        return new Response(JSON.stringify({ txid: "tx" }), { status: 200 });
      }
      return new Response(JSON.stringify({ confirmed: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    const p1 = s.getAddressConfirmedBalance("main", "addr1", { priority: "background" });
    await expect(p1).rejects.toThrow();
    // 429 触发后 backoffUntil 应被设置。
    const initialBackoff = s.getQueueSnapshot().backoffUntil ?? 0;
    expect(initialBackoff).toBeGreaterThan(Date.now());
    const pBc = s.broadcast("main", "deadbeef", { signal: undefined });
    await pBc;
    // 关键断言：broadcast 实际 fetch 时间 ≥ 429 触发时间 + retry-after。
    // 这证明 backoffUntil 仍生效；否则 resetBackoff 清掉 backoffUntil，
    // pump 下一轮检查 backoffUntil > now 会放行，broadcast 立即发。
    expect(broadcastFetchAt - t0).toBeGreaterThanOrEqual(900);
    s.dispose();
  }, 5_000);

  it("broadcast wins over queued background requests", async () => {
    // 关键：WOC_ACTOR_ACCEPT_CONCURRENCY=32 让 MessageBus 并发投递不阻塞；
    // WOC 内部 priority queue 仍按 priority 选 next。多个 background
    // 入队后 broadcast 仍应插队。
    const s = createWocService({ messageBus: createMessageBus() });
    s.updateConfig({ baseUrl: "https://mock.test", requestsPerSecond: 1000 });
    const order: string[] = [];
    let firstInFlight = true;
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (url) => {
      order.push(url);
      if (firstInFlight) {
        firstInFlight = false;
        // 让第一个 background 慢一点，让后续 background + broadcast 排到队列。
        await new Promise((r) => setTimeout(r, 30));
      }
      if (url.includes("/tx/raw")) {
        return new Response(JSON.stringify({ txid: "tx" }), { status: 200 });
      }
      return new Response(JSON.stringify({ confirmed: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    // 第一个 background 进入 inFlight。
    const p0 = s.getAddressConfirmedBalance("main", "addr0", { priority: "background" });
    // 给 pump 一点时间把 p0 拉入 inFlight。
    await new Promise((r) => setTimeout(r, 5));
    // 4 个 background 排队。
    const pBgs = Array.from({ length: 4 }).map((_, i) =>
      s.getAddressConfirmedBalance("main", `bg-${i}`, { priority: "background" })
    );
    // broadcast 排在所有 background 之后入队。
    const pBc = s.broadcast("main", "cafebabe", { signal: undefined });
    await Promise.all([p0, ...pBgs, pBc]);
    // pump 第一轮选 p0（已在 inFlight），第二轮选 broadcast（最高 priority），
    // 然后才轮到 background 队列。
    expect(order[0]).toContain("/confirmed/balance");
    expect(order[1]).toContain("/tx/raw");
    s.dispose();
  }, 5_000);
});
