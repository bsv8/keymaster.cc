// 施工单 002：Headless Chromium -> Keymaster production runtime -> 正式 Go msfile-nas。
// 不注入 fake MsFileTransport；Go 进程、Noise/Yamux、WebRTC Direct/WSS、
// SharedWorker、trusted capability 与 Connect SDK 都走生产实现。

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const KEYMASTER_ORIGIN = "http://127.0.0.1:4173";
const GO_NAS_DIR = process.env.MSFILE_PROXY_PROTOCOL_DIR
  ? resolve(process.env.MSFILE_PROXY_PROTOCOL_DIR, "labs/webrtc-go")
  : "/home/david/Workspaces/MSFile-Proxy-Protocol/labs/webrtc-go";
const FILE_BYTES = 2 * 1024 * 1024;
const BLOCK_BYTES = 256 * 1024;
const CONNECT_SESSION_ID = "msfile-e2e-connect-session";
const OTHER_SUPPLIER_PUBLIC_KEY = "035f3d296df6e017c017270bfc0293dc7d197ff9e04a25c096260420644d86d21a";
const OTHER_SUPPLIER_PEER_ID = "16Uiu2HAmK4mB2kfxPQBajorRZo6sEgp9UXteN9Voi27u2RxTzma9";

const APP_IDENTITY_PROOF = {
  version: 1 as const,
  publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  app: { id: "stable-app-id", name: "Stable App", description: "Description" },
  requirements: [] as ("private-key" | "storage")[],
  signature: "ba7206e5617360697c0199ffdb3c82a2728b2e46a5b48b39d405ec65009bc3c34a3a91e0acf1f37ff88654a7a60d3f4da8532875d3f333859a22c8eb9feb7af7",
};

interface ReadSummary {
  contentHashHex: string;
  byteLength: number;
  sha256Hex: string;
}

interface ProductionHooks {
  bootstrap(): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }>;
  configure(supplier: { name: string; supplierPublicKeyHex: string; addresses: string[]; enabled: boolean }): Promise<void>;
  status(): string;
  probe(supplierPublicKeyHex: string): Promise<{ connected: boolean; addresses: Array<{ address: string; ok: boolean; errorCode?: string }> }>;
  stat(seedHashHex: string): Promise<{ seedHashHex: string; suppliers: Array<Record<string, unknown>> }>;
  readSeed(supplierPublicKeyHex: string, seedHashHex: string): Promise<ReadSummary>;
  readBlock(supplierPublicKeyHex: string, blockHashHex: string): Promise<ReadSummary>;
  readSeeds(supplierPublicKeyHex: string, seedHashHexes: string[]): Promise<ReadSummary[]>;
  readBlocks(supplierPublicKeyHex: string, blockHashHexes: string[]): Promise<ReadSummary[]>;
  seedConnectSession(input: { sessionId: string; origin: string; proof: typeof APP_IDENTITY_PROOF }): Promise<{ ownerPublicKeyHex: string }>;
  appAuthorizations(): Promise<Array<{ appName: string; key: { appId: string } }>>;
  switchToGeneratedKey(): Promise<{ previousPublicKeyHex: string; activePublicKeyHex: string }>;
  lock(): Promise<string>;
  unlock(): Promise<string>;
}

interface NasFixture {
  directory: string;
  process: ChildProcess;
  adminOrigin: string;
  supplierPublicKeyHex: string;
  peerId: string;
  webRtcAddress: string;
  wssAddress: string;
  certificateSpkiSha256Base64: string;
  seedHashes: string[];
  seedLengths: Map<string, number>;
  blockHashes: string[];
  stderr: string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForJson<T>(url: string, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json() as T;
        if (accept(value)) return value;
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function startNasFixture(): Promise<NasFixture> {
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-msfile-production-"));
  const nasData = join(directory, "nas-data");
  const seedData = join(directory, "seed-data");
  const identityKey = join(directory, "supplier.key");
  const tlsCert = join(directory, "supplier.crt");
  const tlsKey = join(directory, "supplier-tls.key");
  const config = join(directory, "msfile-nas.yaml");
  const binary = join(directory, "msfile-nas");
  const adminPort = await freePort();
  await fs.mkdir(nasData, { recursive: true });
  await fs.mkdir(seedData, { recursive: true });
  await fs.writeFile(identityKey, `${"0".repeat(63)}1\n`, { mode: 0o600 });
  for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
    const bytes = Buffer.allocUnsafe(FILE_BYTES);
    for (let offset = 0; offset < bytes.length; offset += 1) bytes[offset] = (offset + fileIndex * 53) % 251;
    await fs.writeFile(join(nasData, `fixture-${fileIndex}.bin`), bytes);
  }
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", tlsKey, "-out", tlsCert, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync("go", ["build", "-o", binary, "./cmd/msfile-nas"], { cwd: GO_NAS_DIR, maxBuffer: 8 * 1024 * 1024 });
  await fs.writeFile(config, [
    `identity_key_file: ${JSON.stringify(identityKey)}`,
    `nas_data: ${JSON.stringify(nasData)}`,
    `seed_data: ${JSON.stringify(seedData)}`,
    "access_mode: public",
    "public_key_whitelist: []",
    "full_scan_interval: 1h",
    "file_stable_interval: 50ms",
    "invalid_retention: 1h",
    "hash_workers: 2",
    "enable_file_watcher: false",
    "listen:",
    "  - /ip4/127.0.0.1/udp/0/webrtc-direct",
    "  - /ip4/127.0.0.1/tcp/0/tls/ws",
    `tls_cert_file: ${JSON.stringify(tlsCert)}`,
    `tls_key_file: ${JSON.stringify(tlsKey)}`,
    `admin_listen: 127.0.0.1:${adminPort}`,
    "",
  ].join("\n"));

  const stderr: string[] = [];
  const child = spawn(binary, ["--config", config], { cwd: GO_NAS_DIR, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const adminOrigin = `http://127.0.0.1:${adminPort}`;
  try {
    const status = await waitForJson<{
      peer_id: string;
      supplier_public_key: string;
      listen_addresses: string[];
    }>(`${adminOrigin}/api/status`, (value) => Array.isArray(value.listen_addresses) && value.listen_addresses.length >= 2);
    const webRtcAddress = status.listen_addresses.find((value) => value.includes("/webrtc-direct/"));
    const wssAddress = status.listen_addresses.find((value) => value.includes("/tls/ws/"));
    if (!webRtcAddress || !wssAddress) throw new Error(`supplier did not publish both transports: ${JSON.stringify(status.listen_addresses)}`);
    const files = await waitForJson<{ items: Array<{ seed_hash: string; state: string }> }>(
      `${adminOrigin}/api/files?state=ready&limit=20`,
      (value) => value.items.filter((item) => item.state === "ready").length >= 4,
      90_000,
    );
    const seedHashes = files.items.filter((item) => item.state === "ready").map((item) => item.seed_hash).sort().slice(0, 4);
    const seedLengths = new Map<string, number>();
    const blockHashes: string[] = [];
    for (const seedHash of seedHashes) {
      const seedPath = join(seedData, "seeds", seedHash.slice(0, 2), seedHash.slice(2, 4), `${seedHash}.seed`);
      const seed = await fs.readFile(seedPath);
      seedLengths.set(seedHash, seed.byteLength);
      if (blockHashes.length === 0) {
        for (let offset = 0; offset + 32 <= seed.length && blockHashes.length < 8; offset += 32) {
          blockHashes.push(seed.subarray(offset, offset + 32).toString("hex"));
        }
      }
    }
    if (blockHashes.length !== 8) throw new Error(`expected 8 block hashes, got ${blockHashes.length}`);
    const certificate = new X509Certificate(await fs.readFile(tlsCert));
    const spki = certificate.publicKey.export({ type: "spki", format: "der" });
    return {
      directory,
      process: child,
      adminOrigin,
      supplierPublicKeyHex: status.supplier_public_key,
      peerId: status.peer_id,
      webRtcAddress,
      wssAddress,
      certificateSpkiSha256Base64: createHash("sha256").update(spki).digest("base64"),
      seedHashes,
      seedLengths,
      blockHashes,
      stderr,
    };
  } catch (error) {
    await stopChild(child);
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}; supplier stderr=${stderr.join("")}`);
  }
}

async function startAppServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body><button id=run>Run MSFile Connect</button></body></html>");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Connect E2E app server has no TCP address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as Window & { __msfileProductionE2E?: unknown }).__msfileProductionE2E !== undefined, undefined, { timeout: 30_000 });
}

function supplier(addresses: string[], fixture: NasFixture) {
  return { name: "MSFile E2E NAS", supplierPublicKeyHex: fixture.supplierPublicKeyHex, addresses, enabled: true };
}

async function configure(page: Page, fixture: NasFixture, addresses: string[]): Promise<void> {
  await page.evaluate(async ({ config }) => {
    const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
    await api.configure(config);
  }, { config: supplier(addresses, fixture) });
}

async function readSummary(page: Page, kind: "seed" | "block", fixture: NasFixture, hash: string): Promise<ReadSummary> {
  return page.evaluate(async ({ kind: contentKind, supplierPublicKeyHex, hashHex }) => {
    const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
    return contentKind === "seed" ? api.readSeed(supplierPublicKeyHex, hashHex) : api.readBlock(supplierPublicKeyHex, hashHex);
  }, { kind, supplierPublicKeyHex: fixture.supplierPublicKeyHex, hashHex: hash });
}

test.describe("MSFile production runtime（施工单 002）", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: NasFixture;
  let browser: Browser;
  let context: BrowserContext;
  let controlPage: Page;
  let appServer: { server: Server; origin: string };
  let sdkBundle = "";

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fixture = await startNasFixture();
    appServer = await startAppServer();
    const sdkOutput = join(fixture.directory, "keymaster-connect-e2e.js");
    await execFileAsync("pnpm", [
      "exec", "esbuild", "packages/connect/src/client.ts",
      "--bundle", "--format=iife", "--platform=browser",
      "--global-name=KeymasterConnectE2E", `--outfile=${sdkOutput}`,
    ], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    sdkBundle = await fs.readFile(sdkOutput, "utf8");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--enable-precise-memory-info",
        `--ignore-certificate-errors-spki-list=${fixture.certificateSpkiSha256Base64}`,
      ],
    });
    context = await browser.newContext({ baseURL: KEYMASTER_ORIGIN });
    await context.addInitScript(() => {
      localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 2, enabled: { msfile: true } }));
    });
    controlPage = await context.newPage();
    await controlPage.goto("/?msfileE2E=1", { waitUntil: "load" });
    await waitForHooks(controlPage);
    await controlPage.evaluate(async () => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      await api.bootstrap();
    });
  });

  test.afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (appServer) await closeServer(appServer.server).catch(() => undefined);
    if (fixture) {
      await stopChild(fixture.process);
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("B01/B04/B05/B07/B15/B16: WebRTC Direct serves real Stat, Seed, Block and bounded concurrency", async () => {
    test.setTimeout(120_000);
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
    const probe = await controlPage.evaluate(async (supplierPublicKeyHex) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.probe(supplierPublicKeyHex);
    }, fixture.supplierPublicKeyHex);
    expect(probe.connected).toBe(true);
    expect(probe.addresses).toEqual([expect.objectContaining({ address: fixture.webRtcAddress, ok: true })]);

    const seedHash = fixture.seedHashes[0]!;
    const stat = await controlPage.evaluate(async (hash) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.stat(hash);
    }, seedHash);
    expect(stat.suppliers).toContainEqual(expect.objectContaining({ supplierPublicKeyHex: fixture.supplierPublicKeyHex, status: "available", fileSizeBytes: String(FILE_BYTES) }));
    const seed = await readSummary(controlPage, "seed", fixture, seedHash);
    expect(seed).toEqual({ contentHashHex: seedHash, byteLength: fixture.seedLengths.get(seedHash), sha256Hex: seedHash });
    const blockHash = fixture.blockHashes[0]!;
    const block = await readSummary(controlPage, "block", fixture, blockHash);
    expect(block).toEqual({ contentHashHex: blockHash, byteLength: BLOCK_BYTES, sha256Hex: blockHash });

    const burst = await controlPage.evaluate(async ({ supplierPublicKeyHex, seedHashes, blockHashes }) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      const startedAt = performance.now();
      const [seeds, blocks, statDuringRead] = await Promise.all([
        api.readSeeds(supplierPublicKeyHex, seedHashes),
        api.readBlocks(supplierPublicKeyHex, blockHashes),
        api.stat(seedHashes[0]!),
      ]);
      return { seeds, blocks, statDuringRead, durationMs: performance.now() - startedAt };
    }, { supplierPublicKeyHex: fixture.supplierPublicKeyHex, seedHashes: fixture.seedHashes, blockHashes: fixture.blockHashes });
    expect(burst.seeds).toHaveLength(4);
    expect(burst.blocks).toHaveLength(8);
    expect(burst.seeds.every((entry) => entry.sha256Hex === entry.contentHashHex)).toBe(true);
    expect(burst.blocks.every((entry) => entry.sha256Hex === entry.contentHashHex)).toBe(true);
    expect(burst.statDuringRead.suppliers[0]).toMatchObject({ status: "available" });
    console.log(JSON.stringify({ event: "msfile_b01_webrtc", peerId: fixture.peerId, seedReads: 4, blockReads: 8, durationMs: Math.round(burst.durationMs) }));
  });

  test("B02/B03/B08: WSS uses pinned test certificate, rejects bad TLS and falls back without changing identity", async () => {
    test.setTimeout(150_000);
    const badAddress = fixture.wssAddress.replace(/\/tcp\/\d+\//u, "/tcp/1/");
    await configure(controlPage, fixture, [badAddress, fixture.wssAddress]);
    const probe = await controlPage.evaluate(async (supplierPublicKeyHex) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.probe(supplierPublicKeyHex);
    }, fixture.supplierPublicKeyHex);
    expect(probe.connected).toBe(true);
    expect(probe.addresses[0]).toMatchObject({ address: badAddress, ok: false });
    expect(probe.addresses[1]).toMatchObject({ address: fixture.wssAddress, ok: true });
    const seedHash = fixture.seedHashes[1]!;
    const stat = await controlPage.evaluate(async (hash) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.stat(hash);
    }, seedHash);
    expect(stat.suppliers[0]).toMatchObject({ status: "available" });
    expect(await readSummary(controlPage, "seed", fixture, seedHash)).toMatchObject({ contentHashHex: seedHash, sha256Hex: seedHash });
    expect(await readSummary(controlPage, "block", fixture, fixture.blockHashes[1]!)).toMatchObject({ contentHashHex: fixture.blockHashes[1], sha256Hex: fixture.blockHashes[1] });
    console.log(JSON.stringify({
      event: "msfile_b02_wss",
      peerId: fixture.peerId,
      supplierPublicKeyHex: fixture.supplierPublicKeyHex,
      webRtcAddress: fixture.webRtcAddress,
      wssAddress: fixture.wssAddress,
      certificateSpkiSha256Base64: fixture.certificateSpkiSha256Base64,
    }));

    // 新浏览器不配置 SPKI 测试信任：同一 WSS 必须失败，证明成功链路没有
    // 通过 ignoreHTTPSErrors 全局绕过 TLS。
    const untrustedBrowser = await chromium.launch({ headless: true });
    const untrustedContext = await untrustedBrowser.newContext({ baseURL: KEYMASTER_ORIGIN });
    try {
      await untrustedContext.addInitScript(() => localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 2, enabled: { msfile: true } })));
      const page = await untrustedContext.newPage();
      await page.goto("/?msfileE2E=1", { waitUntil: "load" });
      await waitForHooks(page);
      await page.evaluate(async () => {
        const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
        await api.bootstrap();
      });
      await configure(page, fixture, [fixture.wssAddress]);
      const rejected = await page.evaluate(async (supplierPublicKeyHex) => {
        const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
        return api.probe(supplierPublicKeyHex);
      }, fixture.supplierPublicKeyHex);
      expect(rejected.connected).toBe(false);
      // Chromium 故意不向页面暴露证书握手的具体失败原因；libp2p 只能得到
      // 通用 dial failure。这里验收安全边界（未信任证书必拒绝），不伪造原因。
      expect(rejected.addresses[0]).toMatchObject({ ok: false, errorCode: "dial_failed" });
    } finally {
      await untrustedContext.close();
      await untrustedBrowser.close();
    }
  });

  test("B03: persisted supplier identity, PeerId and WebRTC certhash pins fail closed", async () => {
    test.setTimeout(120_000);
    const wrongPeerAddress = fixture.webRtcAddress.replace(/\/p2p\/[^/]+$/u, `/p2p/${OTHER_SUPPLIER_PEER_ID}`);
    await expect(configure(controlPage, fixture, [wrongPeerAddress])).rejects.toThrow();

    await expect(controlPage.evaluate(async ({ config }) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      await api.configure(config);
    }, { config: { name: "Wrong key", supplierPublicKeyHex: OTHER_SUPPLIER_PUBLIC_KEY, addresses: [fixture.webRtcAddress], enabled: true } })).rejects.toThrow();

    const wrongCerthashAddress = fixture.webRtcAddress.replace(
      /\/certhash\/([^/]+)/u,
      (_whole, hash: string) => `/certhash/${hash.slice(0, -1)}${hash.endsWith("A") ? "B" : "A"}`,
    );
    await configure(controlPage, fixture, [wrongCerthashAddress]);
    const rejected = await controlPage.evaluate(async (supplierPublicKeyHex) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.probe(supplierPublicKeyHex);
    }, fixture.supplierPublicKeyHex);
    expect(rejected.connected).toBe(false);
    expect(rejected.addresses[0]).toMatchObject({ address: wrongCerthashAddress, ok: false });
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
  });

  test("B06: same-hash larger request ID cancels the superseded real wire Read", async () => {
    test.setTimeout(120_000);
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
    const outcomes = await controlPage.evaluate(async ({ supplierPublicKeyHex, blockHashHex }) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return Promise.allSettled([
        api.readBlock(supplierPublicKeyHex, blockHashHex),
        api.readBlock(supplierPublicKeyHex, blockHashHex),
      ]).then((results) => results.map((result) => result.status === "fulfilled"
        ? { status: result.status, value: result.value }
        : { status: result.status, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) }));
    }, { supplierPublicKeyHex: fixture.supplierPublicKeyHex, blockHashHex: fixture.blockHashes[4]! });
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((entry) => entry.status === "fulfilled")).toMatchObject({
      value: { contentHashHex: fixture.blockHashes[4], sha256Hex: fixture.blockHashes[4] },
    });
  });

  test("B09/I09 headless preflight: 10,000 Stat calls reuse the production stream with bounded heap", async () => {
    test.setTimeout(240_000);
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
    const evidence = await controlPage.evaluate(async ({ seedHashes }) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      // 先预热动态导入、连接与 Stat stream，不把一次性装载计入增长量。
      await Promise.all(Array.from({ length: 4 }, (_, index) => api.stat(seedHashes[index % seedHashes.length]!)));
      const heapBeforeBytes = heap();
      const startedAt = performance.now();
      let completed = 0;
      while (completed < 10_000) {
        const count = Math.min(4, 10_000 - completed);
        const results = await Promise.all(Array.from({ length: count }, (_, index) => api.stat(seedHashes[(completed + index) % seedHashes.length]!)));
        if (results.some((result) => result.suppliers[0]?.status !== "available")) throw new Error("10k Stat returned a non-available supplier");
        completed += count;
      }
      return {
        completed,
        durationMs: performance.now() - startedAt,
        heapBeforeBytes,
        heapAfterBytes: heap(),
      };
    }, { seedHashes: fixture.seedHashes });
    expect(evidence.completed).toBe(10_000);
    if (evidence.heapAfterBytes !== null) expect(evidence.heapAfterBytes).toBeLessThan(256 * 1024 * 1024);
    console.log(JSON.stringify({ event: "msfile_i09_headless", ...evidence }));
  });

  test("B12/B13: trusted capability and real Connect SDK/session/App Identity read through WSS", async () => {
    test.setTimeout(180_000);
    await configure(controlPage, fixture, [fixture.wssAddress]);
    await controlPage.evaluate(async ({ sessionId, origin, proof }) => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      await api.seedConnectSession({ sessionId, origin, proof });
    }, { sessionId: CONNECT_SESSION_ID, origin: appServer.origin, proof: APP_IDENTITY_PROOF });

    const appPage = await context.newPage();
    await appPage.goto(appServer.origin, { waitUntil: "load" });
    await appPage.addScriptTag({ content: sdkBundle });
    await appPage.evaluate(({ targetOrigin }) => {
      const sdk = (window as Window & { KeymasterConnectE2E: { KeymasterConnectClient: new (input: { targetOrigin: string }) => unknown } }).KeymasterConnectE2E;
      (window as Window & { __keymasterConnectClient?: unknown }).__keymasterConnectClient = new sdk.KeymasterConnectClient({ targetOrigin });
    }, { targetOrigin: KEYMASTER_ORIGIN });

    const invoke = async (method: "stat" | "seed" | "block", hash: string) => {
      const existingPopup = context.pages().find((page) => page.url().includes("/protocol/v1/popup"));
      const popupPromise = existingPopup
        ? Promise.resolve(existingPopup)
        : context.waitForEvent("page", { timeout: 15_000 });
      const resultPromise = appPage.evaluate(async ({ method: operation, sessionId, supplierPublicKeyHex, hashHex }) => {
        const client = (window as Window & { __keymasterConnectClient: {
          msfileStat(input: unknown): Promise<unknown>;
          msfileReadSeed(input: unknown): Promise<unknown>;
          msfileReadBlock(input: unknown): Promise<unknown>;
        } }).__keymasterConnectClient;
        const result = operation === "stat"
          ? await client.msfileStat({ connectSessionId: sessionId, seedHashHex: hashHex })
          : operation === "seed"
            ? await client.msfileReadSeed({ connectSessionId: sessionId, supplierPublicKeyHex, seedHashHex: hashHex })
            : await client.msfileReadBlock({ connectSessionId: sessionId, supplierPublicKeyHex, blockHashHex: hashHex });
        if (operation === "stat") return result;
        const typed = result as { contentHashHex: string; content: { bytes: ArrayBuffer } };
        const bytes = new Uint8Array(typed.content.bytes);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
        return {
          contentHashHex: typed.contentHashHex,
          byteLength: bytes.byteLength,
          sha256Hex: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""),
        };
      }, { method, sessionId: CONNECT_SESSION_ID, supplierPublicKeyHex: fixture.supplierPublicKeyHex, hashHex: hash });
      const popup = await popupPromise;
      const result = await resultPromise;
      // msfile.* 在有效 session 内为自动执行能力；仅价格超限时由
      // msfile.service 自身的金额授权 UI 中断。此 supplier 价格为 0，
      // 因此这里应验证自动批准历史，不应寻找通用 Confirm 按钮。
      const methodName = method === "stat" ? "msfile.stat" : method === "seed" ? "msfile.seed.read" : "msfile.block.read";
      await expect(popup.getByRole("button", { name: new RegExp(`${methodName}.*(?:Approved|已批准)`, "u") }).last()).toBeVisible({ timeout: 30_000 });
      return result;
    };

    const seedHash = fixture.seedHashes[2]!;
    const stat = await invoke("stat", seedHash) as { suppliers: Array<Record<string, unknown>> };
    expect(stat.suppliers[0]).toMatchObject({ supplierPublicKeyHex: fixture.supplierPublicKeyHex, status: "available" });
    expect(await invoke("seed", seedHash)).toMatchObject({ contentHashHex: seedHash, sha256Hex: seedHash });
    const blockHash = fixture.blockHashes[2]!;
    expect(await invoke("block", blockHash)).toMatchObject({ contentHashHex: blockHash, sha256Hex: blockHash, byteLength: BLOCK_BYTES });
    const authorizations = await controlPage.evaluate(async () => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.appAuthorizations();
    });
    expect(authorizations).toContainEqual(expect.objectContaining({ appName: "Stable App", key: expect.objectContaining({ appId: "stable-app-id" }) }));
  });

  test("B10/B11/B14: lock revokes runtime, another tab takes executor lease, and bytes remain out of logs", async () => {
    test.setTimeout(120_000);
    const lockStatus = await controlPage.evaluate(async () => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.lock();
    });
    expect(["ok", "accepted", "already-locked"]).toContain(lockStatus);
    await expect.poll(() => controlPage.evaluate(() => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.status();
    })).toBe("unavailable");
    const unlockStatus = await controlPage.evaluate(async () => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.unlock();
    });
    expect(["ok", "accepted", "already-unlocked"]).toContain(unlockStatus);
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
    expect(await readSummary(controlPage, "block", fixture, fixture.blockHashes[3]!)).toMatchObject({ sha256Hex: fixture.blockHashes[3] });

    const keySwitch = await controlPage.evaluate(async () => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.switchToGeneratedKey();
    });
    expect(keySwitch.activePublicKeyHex).not.toBe(keySwitch.previousPublicKeyHex);
    await configure(controlPage, fixture, [fixture.webRtcAddress]);
    expect(await readSummary(controlPage, "block", fixture, fixture.blockHashes[6]!)).toMatchObject({ sha256Hex: fixture.blockHashes[6] });

    const takeoverPage = await context.newPage();
    await takeoverPage.goto("/?msfileE2E=1", { waitUntil: "load" });
    await waitForHooks(takeoverPage);
    await controlPage.close();
    await expect.poll(() => takeoverPage.evaluate(() => {
      const api = (window as Window & { __msfileProductionE2E: ProductionHooks }).__msfileProductionE2E;
      return api.status();
    }), { timeout: 15_000 }).toBe("ready");
    controlPage = takeoverPage;
    await configure(controlPage, fixture, [fixture.wssAddress]);
    expect(await readSummary(controlPage, "block", fixture, fixture.blockHashes[5]!)).toMatchObject({ sha256Hex: fixture.blockHashes[5] });
    expect(fixture.stderr.join("\n")).not.toContain("0".repeat(63) + "1");
  });
});
