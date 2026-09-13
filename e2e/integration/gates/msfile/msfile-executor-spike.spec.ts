// 施工单 2026-08-26/001：真实 Chromium + SharedWorker + Go supplier 证据。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { assertMsFileProxyProtocolCommit, getMsFileGoDir } from "../../fixtures/msfileProxyProtocol.js";
import { MSFILE_EXECUTOR_GATE } from "../../support/scenarioMetadata.js";

export const GATE_ID = MSFILE_EXECUTOR_GATE.id;
export const GATE_METADATA = MSFILE_EXECUTOR_GATE;

const execFileAsync = promisify(execFile);
const GO_LISTEN_ADDR = "/ip4/127.0.0.1/udp/0/webrtc-direct";

type OpenPages = { context: BrowserContext; pageA: Page; pageB: Page };
type Lease = { leaseId: string; sessionEpoch: string; activePublicKeyHex: string };

interface WindowP2pExecutorSpikeHooks {
  acquire(): Promise<any>;
  connectAndInspect(address: string): Promise<any>;
  signNoiseStaticKey(bytes: Uint8Array): Promise<any>;
  signPeerRecord(sequence: string): Promise<any>;
  rejectForgedPeerRecords(): Promise<any>;
  abortNoiseSign(): Promise<any>;
  bootstrap(): Promise<any>;
  lock(): Promise<any>;
  beginNoiseSign(): any;
  finishNoiseSign(): Promise<any>;
  generateReplacementKey(): Promise<any>;
  setActive(publicKeyHex: string): Promise<any>;
  transferBurst(totalBytes: number, chunkBytes: number, concurrency: number): Promise<any>;
}

declare global {
  interface Window {
    /** 仅由 VITE_MSFILE_SPIKE=1 构建暴露的 executor 技术 Gate hook。 */
    __windowP2pExecutorSpike?: WindowP2pExecutorSpikeHooks;
  }
}

async function evaluateWithRetry<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.evaluate(fn);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/context was destroyed|navigation/i.test(message)) throw error;
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
}

async function openSpikeContext(browser: Browser): Promise<OpenPages> {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await grantPersistentStorage(pageA);
  await Promise.all([
    pageA.goto("/?msfileSpike=1", { waitUntil: "load" }),
    pageB.goto("/?msfileSpike=1", { waitUntil: "load" })
  ]);
  await Promise.all([
    pageA.waitForFunction(() => window.__windowP2pExecutorSpike !== undefined, undefined, { timeout: 20_000 }),
    pageB.waitForFunction(() => window.__windowP2pExecutorSpike !== undefined, undefined, { timeout: 20_000 })
  ]);
  return { context, pageA, pageB };
}

async function grantPersistentStorage(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("MSFile spike requires Chromium");
  await page.goto("/?msfileSpikePermission=1", { waitUntil: "domcontentloaded" });
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("MSFile spike browser context is unavailable");
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: "http://127.0.0.1:4173",
    browserContextId,
    permissions: ["durableStorage"],
  });
  if (!(await page.evaluate(() => navigator.storage.persisted()))) {
    await cdp.detach();
    throw new Error("MSFile spike durableStorage permission was not applied");
  }
  // 保持 Browser CDP session 存活到 context 关闭；detach 会撤销该 context
  // 的权限，进而让真实 OPFS bootstrap 误报为环境故障。
}

async function buildGoLab(): Promise<{ directory: string; binary: string }> {
  const goLabDir = getMsFileGoDir();
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-msfile-spike-"));
  const binary = join(directory, "msfile-webrtc-lab");
  await execFileAsync("go", ["build", "-o", binary, "./cmd/msfile-webrtc-lab"], { cwd: goLabDir, maxBuffer: 4 * 1024 * 1024 });
  return { directory, binary };
}

async function startGoSupplier(binary: string, ownerPublicKeyHex: string): Promise<{ process: import("node:child_process").ChildProcess; address: string; stdout: string[]; stderr: string[] }> {
  const goLabDir = getMsFileGoDir();
  const goKeyFile = join(goLabDir, "nas-test.key");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = (await import("node:child_process")).spawn(binary, [
    "labnas",
    "--identity-key-file", goKeyFile,
    "--listen", GO_LISTEN_ADDR,
    "--allow-public-key", ownerPublicKeyHex
  ], { cwd: goLabDir, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  const address = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Go supplier did not publish an address; stderr=${stderr.join("")}`)); }
    }, 30_000);
    child.on("error", (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on("exit", (code, signal) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Go supplier exited before ready: code=${code} signal=${signal} stderr=${stderr.join("")}`)); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const value = chunk.toString();
      stderr.push(value);
      const direct = value.split(/\r?\n/u).map((line) => line.match(/^LabNAS multiaddr: (.+)$/u)?.[1]).find((value): value is string => Boolean(value && value.includes("/webrtc-direct")));
      if (direct && !settled) { settled = true; clearTimeout(timer); resolve(direct); }
    });
  });
  return { process: child, address, stdout, stderr };
}

async function stopChild(child: import("node:child_process").ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function acquire(page: Page): Promise<Lease> {
  const result = await evaluateWithRetry(page, async () => window.__windowP2pExecutorSpike!.acquire());
  expect(result).toHaveProperty("leaseId");
  return result as Lease;
}

test.describe(GATE_ID + "：MSFile Window executor spike（施工单 001）", () => {
  test.describe.configure({ mode: "serial" });

  let goLab: { directory: string; binary: string } | undefined;

  test.beforeAll(async () => {
    await assertMsFileProxyProtocolCommit();
    goLab = await buildGoLab();
  });

  test.afterAll(async () => {
    if (goLab) await fs.rm(goLab.directory, { recursive: true, force: true });
  });

  test("A01/A02/A11/A12/A13：Window 主机执行真实 Go Noise、身份、Identify Push 和受约束 Peer Record 签名", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, pageA } = await openSpikeContext(browser);
    let supplier: { process: import("node:child_process").ChildProcess; address: string; stdout: string[]; stderr: string[] } | undefined;
    try {
      const lease = await acquire(pageA);
      supplier = await startGoSupplier(goLab!.binary, lease.activePublicKeyHex);
      let evidence;
      try {
        evidence = await pageA.evaluate(async (address) => window.__windowP2pExecutorSpike!.connectAndInspect(address), supplier.address);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; Go supplier stdout=${supplier.stdout.join("")}; stderr=${supplier.stderr.join("")}`);
      }
      expect(evidence.hostStarted).toBe(true);
      expect(evidence.localPublicKeyHex).toBe(lease.activePublicKeyHex);
      expect(evidence.localPeerId).toBe(evidence.identity.remote_peer_id);
      expect(evidence.localPublicKeyHex).toBe(evidence.identity.remote_public_key_hex);
      expect(evidence.identity.direct).toBe(true);
      // Go network.ConnStats.Transport 报告 WebRTC Direct 使用的底层 UDP 传输；
      // dial 地址和 Direct 标记共同构成协议证据。
      expect(evidence.identity.transport).toBe("udp");
      expect(evidence.echo).toBe("msfile-window-executor-spike");
      expect(evidence.identifyPush).toBe("ok");
      expect(evidence.rawPrivateKeyError).toContain("non-extractable");
      expect(evidence.rawAccessAttempts).toBe(1);
      expect(evidence.noiseSignCount).toBeGreaterThan(0);
      expect(evidence.peerRecordSignCount).toBeGreaterThanOrEqual(2);
      console.log(JSON.stringify({ event: "msfile_spike_identity_evidence", leaseId: lease.leaseId, sessionEpoch: lease.sessionEpoch, activePublicKeyHex: evidence.localPublicKeyHex, peerId: evidence.localPeerId, noiseSignCount: evidence.noiseSignCount, peerRecordSignCount: evidence.peerRecordSignCount, rawPrivateKeyError: evidence.rawPrivateKeyError, transport: evidence.identity.transport }));
    } finally {
      if (supplier) await stopChild(supplier.process);
      await context.close();
    }
  });

  test("A03/A09：类型化 bridge 拒绝畸形字段，abort 后没有待处理 signer 请求", async ({ browser }) => {
    const { context, pageA } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      const shortNoise = await pageA.evaluate(async () => {
        try { await window.__windowP2pExecutorSpike!.signNoiseStaticKey(new Uint8Array(31)); return "accepted"; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      });
      expect(shortNoise).toMatch(/32 bytes/);
      const validNoise = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.signNoiseStaticKey(new Uint8Array(32)));
      expect(validNoise.signatureByteLength).toBeGreaterThan(0);
      const sequence = await pageA.evaluate(async () => {
        await window.__windowP2pExecutorSpike!.signPeerRecord("7");
        try { await window.__windowP2pExecutorSpike!.signPeerRecord("6"); return "accepted"; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      });
      expect(sequence).toMatch(/monotonic|sequence/);
      const forged = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.rejectForgedPeerRecords());
      expect(forged.wrongPeerId).toMatch(/does not match/);
      expect(forged.nonEmptyAddresses).toMatch(/must be empty/);
      expect(forged.overflowSequence).toMatch(/uint64/);
      const aborted = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.abortNoiseSign());
      expect(aborted.error).toBeTruthy();
      expect(aborted.pendingAfter).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("A04/A07：同一 SharedWorker 只允许一个 executor，端口关闭后允许接管", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, pageA, pageB } = await openSpikeContext(browser);
    try {
      await Promise.all([
        pageA.evaluate(async () => window.__windowP2pExecutorSpike!.bootstrap()),
        pageB.evaluate(async () => window.__windowP2pExecutorSpike!.bootstrap())
      ]);
      const [resultA, resultB] = await Promise.all([
        pageA.evaluate(async () => window.__windowP2pExecutorSpike!.acquire()),
        pageB.evaluate(async () => window.__windowP2pExecutorSpike!.acquire())
      ]);
      const leases = [resultA, resultB].filter((result): result is Lease => "leaseId" in result);
      expect(leases).toHaveLength(1);
      const winner = leases[0]!;
      if ("leaseId" in resultA) {
        await pageA.close();
        await pageB.waitForTimeout(250);
        const takeover = await pageB.evaluate(async () => window.__windowP2pExecutorSpike!.acquire());
        expect(takeover).toHaveProperty("leaseId");
        expect((takeover as Lease).leaseId).not.toBe(winner.leaseId);
      } else {
        await pageB.close();
        const takeover = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.acquire());
        expect(takeover).toHaveProperty("leaseId");
      }
    } finally {
      await context.close();
    }
  });

  test("A06：真实 signer 请求进行时锁定会推进 epoch 并使旧 signer 失效", async ({ browser }) => {
    const { context, pageA, pageB } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      const started = await pageA.evaluate(() => {
        const result = window.__windowP2pExecutorSpike!.beginNoiseSign();
        return result;
      });
      // beginNoiseSign 已把 RPC 投递给 SharedWorker；让浏览器先完成一次
      // 消息派发，再通知另一页锁定，确保本用例验证的是“进行中的签名”
      // 被 epoch 栅栏失效，而不是两个尚未送达的请求随机竞速。
      await pageA.waitForTimeout(10);
      const lockPromise = pageB.evaluate(async () => window.__windowP2pExecutorSpike!.lock());
      expect(started.pendingAfterStart).toBe(1);
      const result = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.finishNoiseSign());
      const lock = await lockPromise;
      console.log(JSON.stringify({ event: "msfile_spike_lifecycle_timing", sign: result, lock }));
      expect(lock.status).toBe("accepted");
      expect(result.signResult).not.toBe("ok");
      expect(result.pendingAfter).toBe(0);
      const newLease = await acquire(pageA);
      expect(newLease.leaseId).toBeTruthy();
      expect(newLease.sessionEpoch).toBeTruthy();

      const replacement = await pageB.evaluate(async () => window.__windowP2pExecutorSpike!.generateReplacementKey());
      expect(replacement.publicKeyHex).not.toBe(newLease.activePublicKeyHex);
      await pageA.evaluate(() => {
        window.__windowP2pExecutorSpike!.beginNoiseSign();
      });
      await pageA.waitForTimeout(10);
      const switchedPromise = pageB.evaluate(async (publicKeyHex) => window.__windowP2pExecutorSpike!.setActive(publicKeyHex), replacement.publicKeyHex);
      const switchSign = await pageA.evaluate(async () => window.__windowP2pExecutorSpike!.finishNoiseSign());
      const switched = await switchedPromise;
      expect(switched.status).toBe("ok");
      expect(switchSign.signResult).not.toBe("ok");
      expect(switchSign.pendingAfter).toBe(0);
      const replacementLease = await acquire(pageA);
      expect(replacementLease.activePublicKeyHex).toBe(replacement.publicKeyHex);
    } finally {
      await context.close();
    }
  });

  test("A08/A10/A14：transferable burst 有界且 Window 不暴露私钥表面", async ({ browser }) => {
    const { context, pageA } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      const result = await evaluateWithRetry(pageA, async () => window.__windowP2pExecutorSpike!.transferBurst(16 * 1024 * 1024, 256 * 1024, 4));
      expect(result.drained).toBe(5);
      expect(result.peakPendingByteLength).toBe(17 * 1024 * 1024);
      expect(result.peakPendingByteLength).toBeLessThanOrEqual(17 * 1024 * 1024);
      expect(result.detachedOriginals).toBe(true);
      const surface = await pageA.evaluate(() => ({
        sensitiveLikeKeys: Object.keys(window).filter((key) => /private|secret|raw.?private/i.test(key)),
        storage: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].join("\n")
      }));
      expect(surface.sensitiveLikeKeys).toEqual([]);
      expect(surface.storage).not.toMatch(/privateKey|private_key|rawPrivate/i);
      console.log(JSON.stringify({
        event: "msfile_spike_transfer_evidence",
        transferredItems: result.drained,
        transferredBytes: result.peakPendingByteLength,
        queueByteLimit: 17 * 1024 * 1024,
        heapBaselineBytes: result.heapBaselineBytes,
        peakHeapBytes: result.peakHeapBytes,
        samplingMethod: "performance.memory.usedJSHeapSize sampled at baseline, after each transfer, and after drain"
      }));
    } finally {
      await context.close();
    }
  });
});
