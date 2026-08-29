// 施工单 2026-08-26/001：真实 Chromium + SharedWorker + Go supplier 证据。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { assertMsFileProxyProtocolCommit, MSFILE_GO_DIR } from "./fixtures/msfileProxyProtocol.js";

const execFileAsync = promisify(execFile);
const GO_LAB_DIR = MSFILE_GO_DIR;
const GO_KEY_FILE = join(GO_LAB_DIR, "nas-test.key");
const GO_LISTEN_ADDR = "/ip4/127.0.0.1/udp/0/webrtc-direct";

type OpenPages = { context: BrowserContext; pageA: Page; pageB: Page };
type Lease = { leaseId: string; sessionEpoch: string; activePublicKeyHex: string };

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
  await Promise.all([
    pageA.goto("/?msfileSpike=1", { waitUntil: "load" }),
    pageB.goto("/?msfileSpike=1", { waitUntil: "load" })
  ]);
  await Promise.all([
    pageA.waitForFunction(() => window.__msfileExecutorSpike !== undefined, undefined, { timeout: 20_000 }),
    pageB.waitForFunction(() => window.__msfileExecutorSpike !== undefined, undefined, { timeout: 20_000 })
  ]);
  return { context, pageA, pageB };
}

async function buildGoLab(): Promise<{ directory: string; binary: string }> {
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-msfile-spike-"));
  const binary = join(directory, "msfile-webrtc-lab");
  await execFileAsync("go", ["build", "-o", binary, "./cmd/msfile-webrtc-lab"], { cwd: GO_LAB_DIR, maxBuffer: 4 * 1024 * 1024 });
  return { directory, binary };
}

async function startGoSupplier(binary: string, ownerPublicKeyHex: string): Promise<{ process: import("node:child_process").ChildProcess; address: string; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = (await import("node:child_process")).spawn(binary, [
    "labnas",
    "--identity-key-file", GO_KEY_FILE,
    "--listen", GO_LISTEN_ADDR,
    "--allow-public-key", ownerPublicKeyHex
  ], { cwd: GO_LAB_DIR, stdio: ["ignore", "pipe", "pipe"] });
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
  const result = await evaluateWithRetry(page, async () => window.__msfileExecutorSpike!.acquire());
  expect(result).toHaveProperty("leaseId");
  return result as Lease;
}

test.describe("MSFile Window executor spike（施工单 001）", () => {
  test.describe.configure({ mode: "serial" });

  let goLab: { directory: string; binary: string } | undefined;

  test.beforeAll(async () => {
    await assertMsFileProxyProtocolCommit();
    goLab = await buildGoLab();
  });

  test.afterAll(async () => {
    if (goLab) await fs.rm(goLab.directory, { recursive: true, force: true });
  });

  test("A01/A02/A11/A12/A13: Window host performs real Go Noise, Identity, Identify Push and constrained Peer Record signing", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, pageA } = await openSpikeContext(browser);
    let supplier: { process: import("node:child_process").ChildProcess; address: string; stdout: string[]; stderr: string[] } | undefined;
    try {
      const lease = await acquire(pageA);
      supplier = await startGoSupplier(goLab!.binary, lease.activePublicKeyHex);
      let evidence;
      try {
        evidence = await pageA.evaluate(async (address) => window.__msfileExecutorSpike!.connectAndInspect(address), supplier.address);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; Go supplier stdout=${supplier.stdout.join("")}; stderr=${supplier.stderr.join("")}`);
      }
      expect(evidence.hostStarted).toBe(true);
      expect(evidence.localPublicKeyHex).toBe(lease.activePublicKeyHex);
      expect(evidence.localPeerId).toBe(evidence.identity.remote_peer_id);
      expect(evidence.localPublicKeyHex).toBe(evidence.identity.remote_public_key_hex);
      expect(evidence.identity.direct).toBe(true);
      // Go network.ConnStats.Transport reports the underlying UDP transport for
      // WebRTC Direct. The dial address and Direct flag are the protocol evidence.
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

  test("A03/A09: typed bridge rejects malformed fields and abort leaves no pending signer request", async ({ browser }) => {
    const { context, pageA } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      const shortNoise = await pageA.evaluate(async () => {
        try { await window.__msfileExecutorSpike!.signNoiseStaticKey(new Uint8Array(31)); return "accepted"; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      });
      expect(shortNoise).toMatch(/32 bytes/);
      const validNoise = await pageA.evaluate(async () => window.__msfileExecutorSpike!.signNoiseStaticKey(new Uint8Array(32)));
      expect(validNoise.signatureByteLength).toBeGreaterThan(0);
      const sequence = await pageA.evaluate(async () => {
        await window.__msfileExecutorSpike!.signPeerRecord("7");
        try { await window.__msfileExecutorSpike!.signPeerRecord("6"); return "accepted"; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      });
      expect(sequence).toMatch(/monotonic|sequence/);
      const forged = await pageA.evaluate(async () => window.__msfileExecutorSpike!.rejectForgedPeerRecords());
      expect(forged.wrongPeerId).toMatch(/does not match/);
      expect(forged.nonEmptyAddresses).toMatch(/must be empty/);
      expect(forged.overflowSequence).toMatch(/uint64/);
      const aborted = await pageA.evaluate(async () => window.__msfileExecutorSpike!.abortNoiseSign());
      expect(aborted.error).toBeTruthy();
      expect(aborted.pendingAfter).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("A04/A07: same SharedWorker permits one executor, closes the port, then permits takeover", async ({ browser }) => {
    const { context, pageA, pageB } = await openSpikeContext(browser);
    try {
      await Promise.all([
        pageA.evaluate(async () => window.__msfileExecutorSpike!.bootstrap()),
        pageB.evaluate(async () => window.__msfileExecutorSpike!.bootstrap())
      ]);
      const [resultA, resultB] = await Promise.all([
        pageA.evaluate(async () => window.__msfileExecutorSpike!.acquire()),
        pageB.evaluate(async () => window.__msfileExecutorSpike!.acquire())
      ]);
      const leases = [resultA, resultB].filter((result): result is Lease => "leaseId" in result);
      expect(leases).toHaveLength(1);
      const winner = leases[0]!;
      if ("leaseId" in resultA) {
        await pageA.close();
        await pageB.waitForTimeout(250);
        const takeover = await pageB.evaluate(async () => window.__msfileExecutorSpike!.acquire());
        expect(takeover).toHaveProperty("leaseId");
        expect((takeover as Lease).leaseId).not.toBe(winner.leaseId);
      } else {
        await pageB.close();
        const takeover = await pageA.evaluate(async () => window.__msfileExecutorSpike!.acquire());
        expect(takeover).toHaveProperty("leaseId");
      }
    } finally {
      await context.close();
    }
  });

  test("A06: lock during a real signer request advances epoch and invalidates the old signer", async ({ browser }) => {
    const { context, pageA, pageB } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      await pageB.evaluate(() => {
        const state = window as Window & { __msfileSpikeLockPromise?: Promise<{ status: string }> };
        const channel = new BroadcastChannel("msfile-spike-lifecycle-lock");
        state.__msfileSpikeLockPromise = new Promise((resolve) => {
          channel.addEventListener("message", () => {
            channel.close();
            resolve(window.__msfileExecutorSpike!.lock());
          }, { once: true });
        });
      });
      const started = await pageA.evaluate(() => {
        const result = window.__msfileExecutorSpike!.beginNoiseSign();
        const channel = new BroadcastChannel("msfile-spike-lifecycle-lock");
        channel.postMessage("lock-now");
        channel.close();
        return result;
      });
      const lock = await pageB.evaluate(async () => {
        const state = window as Window & { __msfileSpikeLockPromise?: Promise<{ status: string }> };
        if (!state.__msfileSpikeLockPromise) throw new Error("lock listener is not armed");
        return state.__msfileSpikeLockPromise;
      });
      expect(started.pendingAfterStart).toBe(1);
      const result = await pageA.evaluate(async () => window.__msfileExecutorSpike!.finishNoiseSign());
      expect(lock.status).toBe("accepted");
      expect(result.signResult).not.toBe("ok");
      expect(result.pendingAfter).toBe(0);
      const newLease = await acquire(pageA);
      expect(newLease.leaseId).toBeTruthy();
      expect(newLease.sessionEpoch).toBeTruthy();

      const replacement = await pageB.evaluate(async () => window.__msfileExecutorSpike!.generateReplacementKey());
      expect(replacement.publicKeyHex).not.toBe(newLease.activePublicKeyHex);
      await pageB.evaluate((publicKeyHex) => {
        const state = window as Window & { __msfileSpikeSwitchPromise?: Promise<{ status: string }> };
        const channel = new BroadcastChannel("msfile-spike-lifecycle-switch");
        state.__msfileSpikeSwitchPromise = new Promise((resolve) => {
          channel.addEventListener("message", () => {
            channel.close();
            resolve(window.__msfileExecutorSpike!.setActive(publicKeyHex));
          }, { once: true });
        });
      }, replacement.publicKeyHex);
      await pageA.evaluate(() => {
        window.__msfileExecutorSpike!.beginNoiseSign();
        const channel = new BroadcastChannel("msfile-spike-lifecycle-switch");
        channel.postMessage("switch-now");
        channel.close();
      });
      const switched = await pageB.evaluate(async () => {
        const state = window as Window & { __msfileSpikeSwitchPromise?: Promise<{ status: string }> };
        if (!state.__msfileSpikeSwitchPromise) throw new Error("key switch listener is not armed");
        return state.__msfileSpikeSwitchPromise;
      });
      const switchSign = await pageA.evaluate(async () => window.__msfileExecutorSpike!.finishNoiseSign());
      expect(switched.status).toBe("ok");
      expect(switchSign.signResult).not.toBe("ok");
      expect(switchSign.pendingAfter).toBe(0);
      const replacementLease = await acquire(pageA);
      expect(replacementLease.activePublicKeyHex).toBe(replacement.publicKeyHex);
    } finally {
      await context.close();
    }
  });

  test("A08/A10/A14: transferable burst is bounded and Window exposes no private-key surface", async ({ browser }) => {
    const { context, pageA } = await openSpikeContext(browser);
    try {
      await acquire(pageA);
      const result = await evaluateWithRetry(pageA, async () => window.__msfileExecutorSpike!.transferBurst(16 * 1024 * 1024, 256 * 1024, 4));
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
