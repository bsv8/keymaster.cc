import { chromium } from "@playwright/test";

// 与 MSFile wire/content contract 一致的最坏 attachment 大小。
const MSFILE_MAX_SEED_BYTES = 16 * 1024 * 1024;
const MSFILE_MAX_BLOCK_BYTES = 256 * 1024;
const PRESSURE_CASES = [
  { name: "recommended", seedConcurrency: 4, blockConcurrency: 8 },
  { name: "selected-hard-budget", seedConcurrency: 8, blockConcurrency: 32 },
  // 只作为“超过选定预算”的压力对照，不代表允许写入设置。
  { name: "above-selected-budget", seedConcurrency: 12, blockConcurrency: 64 },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-precise-memory-info"],
});
const page = await browser.newPage();
await page.setContent("<!doctype html><meta charset=\"utf-8\"><title>MSFile read concurrency pressure</title>");

const evidence = await page.evaluate(async (cases) => {
  function heapSnapshot() {
    const memory = performance.memory;
    return memory
      ? { usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize }
      : null;
  }

  const workerSource = `
    const held = [];
    self.onmessage = (event) => {
      if (event.data.type === "hold") {
        held.push(event.data.buffer);
        self.postMessage({ type: "held", id: event.data.id });
      } else if (event.data.type === "release") {
        held.length = 0;
        self.postMessage({ type: "released", id: event.data.id });
      }
    };
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
  let nextId = 0;

  function waitForMessages(expectedType, expectedIds) {
    return new Promise((resolve, reject) => {
      const remaining = new Set(expectedIds);
      const timer = setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        reject(new Error(`MSFile pressure Worker timeout: ${expectedType}`));
      }, 30_000);
      function onMessage(event) {
        if (event.data?.type !== expectedType || !remaining.delete(event.data.id)) return;
        if (remaining.size !== 0) return;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        resolve();
      }
      worker.addEventListener("message", onMessage);
    });
  }

  function touchPages(buffer) {
    const view = new Uint8Array(buffer);
    for (let offset = 0; offset < view.byteLength; offset += 4096) view[offset] = 0xa5;
    if (view.byteLength > 0) view[view.byteLength - 1] = 0x5a;
  }

  const results = [];
  for (const item of cases) {
    const seedBytes = item.seedConcurrency * 16 * 1024 * 1024;
    const blockBytes = item.blockConcurrency * 256 * 1024;
    const requestedBytes = seedBytes + blockBytes;
    const baselineHeap = heapSnapshot();
    let heartbeatCount = 0;
    let maxHeartbeatDelayMs = 0;
    let lastHeartbeat = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - lastHeartbeat - 10);
      lastHeartbeat = now;
      heartbeatCount += 1;
    }, 10);
    const startedAt = performance.now();

    // 先触碰每个 4 KiB 页面，避免只测到虚拟地址分配；随后一次性 transfer，
    // 模拟 bridge 同时保留多个 Seed/Block attachment 的最坏情况。
    const buffers = [];
    const ids = [];
    for (let index = 0; index < item.seedConcurrency; index += 1) {
      const buffer = new ArrayBuffer(16 * 1024 * 1024);
      touchPages(buffer);
      buffers.push(buffer);
    }
    for (let index = 0; index < item.blockConcurrency; index += 1) {
      const buffer = new ArrayBuffer(256 * 1024);
      touchPages(buffer);
      buffers.push(buffer);
    }
    for (const buffer of buffers) {
      const id = nextId++;
      ids.push(id);
      worker.postMessage({ type: "hold", id, buffer }, [buffer]);
    }
    await waitForMessages("held", ids);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const heldHeap = heapSnapshot();

    const releaseId = nextId++;
    worker.postMessage({ type: "release", id: releaseId });
    await waitForMessages("released", [releaseId]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    clearInterval(heartbeat);
    results.push({
      name: item.name,
      seedConcurrency: item.seedConcurrency,
      blockConcurrency: item.blockConcurrency,
      requestedBytes,
      requestedMiB: requestedBytes / (1024 * 1024),
      baselineHeapBytes: baselineHeap?.usedBytes ?? null,
      heldHeapBytes: heldHeap?.usedBytes ?? null,
      afterReleaseHeapBytes: heapSnapshot()?.usedBytes ?? null,
      heartbeatCount,
      maxHeartbeatDelayMs: Number(maxHeartbeatDelayMs.toFixed(2)),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      released: true,
    });
  }
  worker.terminate();
  return results;
}, PRESSURE_CASES);

const browserVersion = browser.version();
await browser.close();
console.log(JSON.stringify({
  event: "msfile_read_concurrency_pressure",
  browser: browserVersion,
  contentLimits: {
    seedBytes: MSFILE_MAX_SEED_BYTES,
    blockBytes: MSFILE_MAX_BLOCK_BYTES,
  },
  evidence,
}, null, 2));
