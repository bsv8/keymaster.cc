// 施工单 003：真实 Chromium + 真实 Go msfile-nas 的原生 Range Gate。
//
// 该文件不注入 fake transport。媒体夹具写入临时 NAS 目录，页面通过正式
// Coordinator / msfile.service / WebRTC Direct 读取；日志只输出 Range、
// Block 序号/数量、响应元数据和媒体事件，不输出 Hash、session URL 或字节。

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { promises as fs } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { nativeMediaFixtures, type NativeMediaFixture } from "./fixtures/nativeMediaFixtures.js";
import { assertMsFileProxyProtocolCommit, MSFILE_GO_DIR } from "./fixtures/msfileProxyProtocol.js";

const execFileAsync = promisify(execFile);
const MEDIA_PREFIX = "/__keymaster/msfile-media/";
const GO_NAS_DIR = MSFILE_GO_DIR;

interface ProductionHooks {
  /** 初始化测试 Vault 并返回当前 active key。 */
  bootstrap(): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }>;
  /** 写入真实 supplier 配置并等待 service ready。 */
  configure(supplier: { name: string; supplierPublicKeyHex: string; addresses: string[]; enabled: boolean }): Promise<void>;
  /** 仅测试使用：延迟真实 Block Read 结果，制造可观察的在途请求。 */
  setReadDelay(milliseconds: number): void;
  /** 仅测试使用：让协议版本不匹配的 SW 接管页面并返回安全失败。 */
  installProtocolMismatchServiceWorker(): Promise<{ errorCode: string; controllerScriptUrl: string }>;
  /** 仅测试使用：锁定当前 Vault，触发生命周期撤销。 */
  lock(): Promise<string>;
  /** 仅测试使用：解锁当前 Vault。 */
  unlock(): Promise<string>;
  /** 仅测试使用：切换 active key，触发生命周期撤销。 */
  switchToGeneratedKey(): Promise<{ previousPublicKeyHex: string; activePublicKeyHex: string }>;
}

interface IndexedNativeFile {
  /** Go supplier 返回的 Seed Hash。 */
  seedHashHex: string;
  /** Go supplier 返回的文件长度。 */
  sizeBytes: number;
  /** Go supplier 返回给页面的 MIME。 */
  mediaType: string;
}

interface NativeNasFixture {
  /** 测试临时目录，afterAll 会完整清理。 */
  directory: string;
  /** 真实 Go msfile-nas 进程。 */
  process: ChildProcess;
  /** supplier 的正式身份公钥。 */
  supplierPublicKeyHex: string;
  /** 带 PeerId 的 WebRTC Direct 地址。 */
  webRtcAddress: string;
  /** Go supplier 受保护管理 API 的 HTTPS 根地址。 */
  adminOrigin: string;
  /** 按文件名索引的真实 Seed/Stat 结果。 */
  files: Record<string, IndexedNativeFile>;
  /** Go 进程 stderr，失败时附加到测试错误。 */
  stderr: string[];
}

interface SupplierReadMetrics {
  /** 已接受的 Read 请求数量。 */
  started: number;
  /** 已完成内容读取并提交终态响应的数量。 */
  completed: number;
  /** 被同 Hash 新请求覆盖的数量。 */
  cancelled: number;
  /** 在返回终态前因 stream/context 取消的数量。 */
  aborted: number;
}

interface JsonResponse<T> {
  ok: boolean;
  status: number;
  value?: T;
}

interface GateRequest {
  /** 浏览器实际发给虚拟媒体 URL 的 HTTP 方法。 */
  method: string;
  /** 浏览器实际发出的单 Range；没有时为 null。 */
  range: string | null;
}

interface GateResponse {
  /** 虚拟媒体 URL 的 HTTP 响应码。 */
  status: number;
  /** 响应 Content-Length。 */
  contentLength: string | null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 loopback TCP 端口"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function freeUdpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("无法分配 loopback UDP 端口"));
        return;
      }
      socket.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function requestJson<T>(url: string): Promise<JsonResponse<T>> {
  return new Promise<JsonResponse<T>>((resolveResponse, reject) => {
    const request = httpsGet(url, {
      rejectUnauthorized: false,
      headers: { authorization: "Bearer msfile-e2e-admin-token" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolveResponse({ ok: false, status });
          return;
        }
        try {
          resolveResponse({
            ok: true,
            status,
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}

async function waitForJson<T>(url: string, accept: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson<T>(url);
      if (response.ok && response.value !== undefined) {
        if (accept(response.value)) return response.value;
      } else {
        lastError = new Error("HTTP " + String(response.status));
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error("等待 Go supplier 超时：" + (lastError instanceof Error ? lastError.message : String(lastError)));
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

function supplierConfig(fixture: NativeNasFixture) {
  return {
    name: "MSFile Native Range Gate NAS",
    supplierPublicKeyHex: fixture.supplierPublicKeyHex,
    addresses: [fixture.webRtcAddress],
    enabled: true,
  };
}

async function startNasFixture(): Promise<NativeNasFixture> {
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-msfile-native-range-"));
  const nasData = join(directory, "nas-data");
  const seedData = join(directory, "seed-data");
  const identityKey = join(directory, "supplier.key");
  const tlsCert = join(directory, "supplier.crt");
  const tlsKey = join(directory, "supplier-tls.key");
  const config = join(directory, "msfile-nas.yaml");
  const binary = join(directory, "msfile-nas");
  const definitions = nativeMediaFixtures();
  const stderr: string[] = [];
  await fs.mkdir(nasData, { recursive: true });
  await fs.mkdir(seedData, { recursive: true });
  await fs.writeFile(identityKey, "0".repeat(63) + "1\n", { mode: 0o600 });
  for (const definition of definitions) {
    await fs.writeFile(join(nasData, definition.filename), definition.bytes);
  }
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", tlsKey, "-out", tlsCert, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync("go", ["build", "-o", binary, "./cmd/msfile-nas"], {
    cwd: GO_NAS_DIR,
    maxBuffer: 8 * 1024 * 1024,
  });
  const webRtcPort = await freeUdpPort();
  const webPort = await freePort();
  await fs.writeFile(config, [
    "identity_key_file: " + JSON.stringify(identityKey),
    "nas_data: " + JSON.stringify(nasData),
    "seed_data: " + JSON.stringify(seedData),
    "access_mode: public",
    "public_key_whitelist: []",
    "full_scan_interval: 1h",
    "file_stable_interval: 50ms",
    "invalid_retention: 1h",
    // 真实 supplier 在 Resolve 前可取消等待，用于在 seek/lifecycle 取消时
    // 形成可观察的在途 Read；浏览器 fetch body cancel 的传播由 R14 单独记录。
    "read_delay: 750ms",
    "hash_workers: 2",
    "enable_file_watcher: false",
    "webrtc_direct_public_addresses: [" + JSON.stringify("/dns4/localhost/udp/" + String(webRtcPort) + "/webrtc-direct") + "]",
    "listen:",
    "  - /ip4/127.0.0.1/udp/" + String(webRtcPort) + "/webrtc-direct",
    "  - /ip4/127.0.0.1/tcp/" + String(webPort) + "/tls/ws",
    "tls_cert_file: " + JSON.stringify(tlsCert),
    "tls_key_file: " + JSON.stringify(tlsKey),
    "admin_token: msfile-e2e-admin-token",
    "",
  ].join("\n"));

  const child = spawn(binary, ["--config", config], {
    cwd: GO_NAS_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const adminOrigin = "https://127.0.0.1:" + String(webPort);
  try {
    const status = await waitForJson<{
      peer_id: string;
      supplier_public_key: string;
      listen_addresses: string[];
    }>(
      adminOrigin + "/api/status",
      (value) => Array.isArray(value.listen_addresses) && value.listen_addresses.length >= 2,
    );
    const rawWebRtcAddress = status.listen_addresses.find((value) => value.includes("/webrtc-direct"));
    if (!rawWebRtcAddress) throw new Error("Go supplier 没有 WebRTC Direct 地址");
    const webRtcAddress = rawWebRtcAddress + "/p2p/" + status.peer_id;
    const files = await waitForJson<{
      items: Array<{
        recommended_filename: string;
        seed_hash: string;
        size_bytes: number;
        media_type: string;
        state: string;
      }>;
    }>(
      adminOrigin + "/api/files?state=ready&limit=20",
      (value) => value.items.filter((item) => item.state === "ready").length >= definitions.length,
    );
    const indexed: Record<string, IndexedNativeFile> = {};
    for (const definition of definitions) {
      const item = files.items.find((candidate) => candidate.recommended_filename === definition.filename && candidate.state === "ready");
      if (!item) throw new Error("Go supplier 未索引媒体夹具：" + definition.filename);
      indexed[definition.filename] = {
        seedHashHex: item.seed_hash,
        sizeBytes: item.size_bytes,
        mediaType: item.media_type || definition.mediaType,
      };
    }
    return {
      directory,
      process: child,
      supplierPublicKeyHex: status.supplier_public_key,
      webRtcAddress,
      adminOrigin,
      files: indexed,
      stderr,
    };
  } catch (error) {
    await stopChild(child);
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error(
      (error instanceof Error ? error.message : String(error)) +
      "；supplier stderr=" + stderr.join(""),
    );
  }
}

function apiOf(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    await api.bootstrap();
  });
}

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as Window & { __msfileProductionE2E?: unknown }).__msfileProductionE2E), undefined, {
    timeout: 30_000,
  });
}

async function bootstrapPage(page: Page): Promise<void> {
  await page.goto("/?msfileE2E=1", { waitUntil: "load" });
  await waitForHooks(page);
  await apiOf(page);
}

async function configurePage(page: Page, fixture: NativeNasFixture): Promise<void> {
  await page.evaluate(async (config) => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    await api.configure(config);
  }, supplierConfig(fixture));
}

async function configurePageWithName(page: Page, fixture: NativeNasFixture, name: string): Promise<void> {
  await page.evaluate(async ({ config, supplierName }) => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    await api.configure({ ...config, name: supplierName });
  }, { config: supplierConfig(fixture), supplierName: name });
}

async function setReadDelay(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((value) => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    api.setReadDelay(value);
  }, milliseconds);
}

async function lockPage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    return api.lock();
  });
}

async function switchKeyPage(page: Page): Promise<{ previousPublicKeyHex: string; activePublicKeyHex: string }> {
  return page.evaluate(async () => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    return api.switchToGeneratedKey();
  });
}

async function installProtocolMismatchPage(page: Page): Promise<{ errorCode: string; controllerScriptUrl: string }> {
  return page.evaluate(async () => {
    const api = (window as Window & { __msfileProductionE2E?: ProductionHooks }).__msfileProductionE2E;
    if (!api) throw new Error("MSFile production E2E hook 未安装");
    return api.installProtocolMismatchServiceWorker();
  });
}

async function supplierReadMetrics(fixture: NativeNasFixture): Promise<SupplierReadMetrics> {
  const response = await requestJson<{ msfile_read_metrics?: SupplierReadMetrics }>(fixture.adminOrigin + "/api/status");
  if (!response.ok || !response.value?.msfile_read_metrics) {
    throw new Error("Go supplier /api/status 没有 msfile_read_metrics：HTTP " + String(response.status));
  }
  return response.value.msfile_read_metrics;
}

async function expectRevokedMediaUrl(page: Page, url: string, reason: string): Promise<number> {
  let status = 0;
  await expect.poll(async () => {
    status = await page.evaluate(async ({ mediaUrl, probeReason }) => {
      const separator = mediaUrl.includes("?") ? "&" : "?";
      const response = await fetch(mediaUrl + separator + "lifecycleProbe=" + encodeURIComponent(probeReason) + "&nonce=" + String(Date.now()), {
        headers: { Range: "bytes=0-3" },
      });
      return response.status;
    }, { mediaUrl: url, probeReason: reason });
    return status;
  }, { timeout: 30_000, intervals: [100, 250, 500, 1_000] }).toBe(404);
  return status;
}

async function preparePage(page: Page, fixture: NativeNasFixture): Promise<void> {
  await bootstrapPage(page);
  await configurePage(page, fixture);
  // 配置写入真实 service 后重新加载页面，确保首页 Resource Store 取得
  // 最新 supplier generation，并让原生媒体从干净 session 开始。
  await bootstrapPage(page);
}

async function selectNativeFile(page: Page, file: IndexedNativeFile): Promise<{
  player: ReturnType<Page["locator"]>;
  media: ReturnType<Page["locator"]>;
  url: string;
}> {
  await page.locator("#msfile-home-seed-hash").fill(file.seedHashHex);
  await page.locator(".msfile-home-file__form").locator("button[type=submit]").click();
  const player = page.locator(".msfile-home-file__streaming-player").last();
  await expect(player).toBeVisible({ timeout: 120_000 });
  const media = player.locator("audio, video");
  await expect(media).toHaveAttribute("src", /\/__keymaster\/msfile-media\/[0-9a-f]{32}/u, { timeout: 30_000 });
  const url = await media.getAttribute("src");
  if (!url) throw new Error("原生媒体元素没有安装虚拟 URL");
  await expect.poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), {
    timeout: 30_000,
  }).toMatch(/\/msfile-media-sw\.js$/u);
  return { player, media, url };
}

async function startNativePlayback(page: Page, file: IndexedNativeFile): Promise<{
  player: ReturnType<Page["locator"]>;
  media: ReturnType<Page["locator"]>;
  url: string;
}> {
  const selected = await selectNativeFile(page, file);
  await recordNativeEvents(page, selected.media);
  await playNative(selected.media);
  await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");
  return selected;
}

const NATIVE_EVENTS = [
  "play", "waiting", "loadstart", "loadedmetadata", "canplay", "playing",
  "seeking", "seeked", "progress", "pause", "ended", "error", "abort",
];

async function recordNativeEvents(page: Page, media: ReturnType<Page["locator"]>): Promise<void> {
  await media.evaluate((element, eventTypes) => {
    const target = element as HTMLMediaElement;
    const state = { events: [] as string[], playError: "" };
    for (const eventType of eventTypes) {
      target.addEventListener(eventType, () => state.events.push(eventType));
    }
    Object.defineProperty(window, "__msfileNativeRangeGateEvents", {
      configurable: true,
      value: state,
    });
  }, NATIVE_EVENTS);
}

async function playNative(media: ReturnType<Page["locator"]>): Promise<void> {
  await media.evaluate(async (element) => {
    const target = element as HTMLMediaElement;
    target.muted = true;
    try {
      await target.play();
    } catch (error) {
      const state = (window as Window & { __msfileNativeRangeGateEvents?: { playError: string } }).__msfileNativeRangeGateEvents;
      if (state) state.playError = error instanceof Error ? error.message : String(error);
    }
  });
}

async function nativeEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __msfileNativeRangeGateEvents?: { events?: string[] } })
    .__msfileNativeRangeGateEvents?.events ?? []);
}

function debugCounts(debug: string): {
  actualSupplierBlockReads: number;
  completedBlockReads: number;
  cancelledRequests: number;
  supplierReadCountDeltas: number[];
} {
  const actualSupplierBlockReads = (debug.match(/range\.block\.read [^\n]*"inflightHit":false/gu) ?? []).length;
  const completedBlockReads = (debug.match(/range\.block\.done\b/gu) ?? []).length;
  const cancelledRequests = (debug.match(/range\.request\.cancelled\b/gu) ?? []).length;
  const supplierReadCountDeltas = Array.from(debug.matchAll(/"supplierReadCount":(\d+)/gu), (match) => Number(match[1]));
  return { actualSupplierBlockReads, completedBlockReads, cancelledRequests, supplierReadCountDeltas };
}

function mediaDebug(player: ReturnType<Page["locator"]>): Promise<string> {
  return player.locator(".msfile-home-file__media-debug pre").textContent().then((value) => value ?? "");
}

async function seekAndWait(media: ReturnType<Page["locator"]>, seconds: number): Promise<number> {
  return media.evaluate((element, targetSeconds) => new Promise<number>((resolve, reject) => {
    const target = element as HTMLMediaElement;
    let settled = false;
    let timer: number | undefined;
    const onSeeked = () => finish();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      target.removeEventListener("seeked", onSeeked);
      if (error) reject(error);
      else resolve(target.currentTime);
    };
    timer = window.setTimeout(() => finish(new Error("等待 seeked 超时")), 30_000);
    target.addEventListener("seeked", onSeeked, { once: true });
    target.currentTime = targetSeconds;
    if (!target.seeking && Math.abs(target.currentTime - targetSeconds) < 0.25) window.setTimeout(() => finish(), 0);
  }), seconds);
}

async function rapidSeekAndWait(
  media: ReturnType<Page["locator"]>,
  seconds: readonly number[],
): Promise<{ currentTime: number; seekedCount: number }> {
  return media.evaluate(async (element, targets) => {
    const target = element as HTMLMediaElement;
    const finalTarget = targets[targets.length - 1]!;
    let seekedCount = 0;
    const onSeeked = () => { seekedCount += 1; };
    target.addEventListener("seeked", onSeeked);
    for (const value of targets) {
      target.currentTime = value;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: number | undefined;
      const check = () => {
        if (!target.seeking && Math.abs(target.currentTime - finalTarget) < 0.75) finish();
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
        target.removeEventListener("seeked", check);
        if (error) reject(error);
        else resolve();
      };
      timeout = window.setTimeout(() => finish(new Error("连续拖动最终 seek 超时")), 30_000);
      target.addEventListener("seeked", check);
      check();
    });
    target.removeEventListener("seeked", onSeeked);
    target.pause();
    return { currentTime: target.currentTime, seekedCount };
  }, seconds);
}

function attachGateNetworkEvidence(page: Page): {
  requests: GateRequest[];
  responses: GateResponse[];
  failedRequests: string[];
  dispose(): void;
} {
  const requests: GateRequest[] = [];
  const responses: GateResponse[] = [];
  const failedRequests: string[] = [];
  const onRequest = (request: { url(): string; method(): string; headers(): Record<string, string> }) => {
    if (!new URL(request.url()).pathname.startsWith(MEDIA_PREFIX)) return;
    requests.push({ method: request.method(), range: request.headers().range ?? null });
  };
  const onResponse = (response: { url(): string; status(): number; headers(): Record<string, string> }) => {
    if (!new URL(response.url()).pathname.startsWith(MEDIA_PREFIX)) return;
    responses.push({
      status: response.status(),
      contentLength: response.headers()["content-length"] ?? null,
    });
  };
  const onFailed = (request: { url(): string; failure(): { errorText?: string } | null }) => {
    if (!new URL(request.url()).pathname.startsWith(MEDIA_PREFIX)) return;
    failedRequests.push(request.failure()?.errorText ?? "unknown");
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  return {
    requests,
    responses,
    failedRequests,
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    },
  };
}

test.describe("MSFile 原生 Range production Gate（施工单 003）", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: NativeNasFixture;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    await assertMsFileProxyProtocolCommit();
    fixture = await startNasFixture();
  });

  test.afterAll(async () => {
    if (fixture) {
      await stopChild(fixture.process);
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 2, enabled: {} }));
    });
  });

  test("R10/R15/R16/R21/R22：MP4、MP3、WAV、WebM 均由原生媒体进入真实 SW/Go Range 链路", async ({ page }) => {
    test.setTimeout(360_000);
    const evidence: Array<Record<string, unknown>> = [];
    const definitions = nativeMediaFixtures();
    for (const definition of definitions) {
      await preparePage(page, fixture);
      const file = fixture.files[definition.filename]!;
      const network = attachGateNetworkEvidence(page);
      try {
        const selected = await selectNativeFile(page, file);
        await recordNativeEvents(page, selected.media);
        await playNative(selected.media);
        await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");
        const debug = await mediaDebug(selected.player);
        const counts = debugCounts(debug);
        const readBlocks = Number(await selected.player.getAttribute("data-msfile-media-read-blocks") ?? "0");
        expect(readBlocks).toBeGreaterThan(0);
        expect(counts.actualSupplierBlockReads).toBeGreaterThan(0);
        expect(debug).toContain("range.request.mapped");
        // playing 不代表浏览器已经停止拉流；它可能继续读取前方数据，或
        // 在测试切换文件时收到 cancel。两种都是施工单允许的原生行为。
        await expect.poll(() => mediaDebug(selected.player), { timeout: 30_000 }).toMatch(/range\.request\.(done|cancelled)/u);
        const finalDebug = await mediaDebug(selected.player);
        evidence.push({
          filename: definition.filename,
          declaredMediaType: file.mediaType,
          browserEvents: await nativeEvents(page),
          requestCount: network.requests.length,
          requests: network.requests,
          responses: network.responses,
          failedRequests: network.failedRequests,
          readBlocks,
          // 每条 inflightHit=false 都对应一次页面 msfile.service -> 真实 Go supplier Read。
          goSupplierBlockReadEvidence: debugCounts(finalDebug).actualSupplierBlockReads,
          completedBlockReads: debugCounts(finalDebug).completedBlockReads,
          cancelledRequests: debugCounts(finalDebug).cancelledRequests,
          supplierReadCountDeltas: debugCounts(finalDebug).supplierReadCountDeltas,
        });
      } finally {
        network.dispose();
      }
    }
    console.log(JSON.stringify({ event: "msfile_native_range_matrix", evidence }));
    expect(evidence).toHaveLength(definitions.length);
  });

  test("R16：多 MiB 尾部 moov MP4 通过尾部 Range 获取索引，不顺序读取中间 Block", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    const file = fixture.files["fixture-native-h264-aac-tail-moov.mp4"]!;
    const network = attachGateNetworkEvidence(page);
    try {
      const blockBytes = 256 * 1024;
      expect(file.sizeBytes).toBeGreaterThan(8 * 1024 * 1024);
      const selected = await selectNativeFile(page, file);
      await recordNativeEvents(page, selected.media);
      await playNative(selected.media);
      await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");

      const debug = await mediaDebug(selected.player);
      const ranges = network.requests
        .map((request) => request.range)
        .filter((range): range is string => range !== null);
      const tailRanges = ranges.filter((range) => {
        const match = range.match(/^bytes=(\d+)-/u);
        if (!match) return false;
        const start = Number(match[1]);
        return start > 0 && start >= file.sizeBytes - 2 * blockBytes;
      });
      const blockIndexes = Array.from(
        debug.matchAll(/range\.block\.read [^\n]*"blockIndex":(\d+)/gu),
        (match) => Number(match[1]),
      );
      const uniqueBlockIndexes = new Set(blockIndexes);
      const totalBlocks = Math.ceil(file.sizeBytes / blockBytes);

      expect(tailRanges.length).toBeGreaterThan(0);
      expect(uniqueBlockIndexes.size).toBeLessThan(totalBlocks);
      expect(await selected.media.evaluate((element) => (element as HTMLMediaElement).error?.code ?? null)).toBeNull();
      console.log(JSON.stringify({
        event: "msfile_native_range_tail_moov",
        fileSizeBytes: file.sizeBytes,
        totalBlocks,
        requests: network.requests,
        responses: network.responses,
        tailRanges,
        supplierBlockIndexes: [...uniqueBlockIndexes],
        browserEvents: await nativeEvents(page),
      }));
    } finally {
      network.dispose();
    }
  });

  test("R03/R04/R05/R06/R14/R22：真实虚拟 URL 的 HEAD、单 Range、416 和流式 cancel", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    const file = fixture.files["fixture-native-long.wav"]!;
    const network = attachGateNetworkEvidence(page);
    try {
      const selected = await selectNativeFile(page, file);
      const contract = await page.evaluate(async (url) => {
        async function readResponse(input: RequestInit): Promise<Record<string, unknown>> {
          const response = await fetch(url, input);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {
            status: response.status,
            contentRange: response.headers.get("content-range"),
            contentLength: response.headers.get("content-length"),
            contentType: response.headers.get("content-type"),
            acceptRanges: response.headers.get("accept-ranges"),
            bodyBytes: bytes.byteLength,
          };
        }
        return {
          head: await readResponse({ method: "HEAD" }),
          fixed: await readResponse({ headers: { Range: "bytes=2-5" } }),
          open: await readResponse({ headers: { Range: "bytes=262144-" } }),
          suffix: await readResponse({ headers: { Range: "bytes=-32" } }),
          invalid: await readResponse({ headers: { Range: "bytes=999999999-" } }),
        };
      }, selected.url);
      expect(contract.head).toMatchObject({
        status: 200,
        contentLength: String(file.sizeBytes),
        contentType: expect.stringMatching(/^audio\/wav/u),
        acceptRanges: "bytes",
        bodyBytes: 0,
      });
      expect(contract.fixed).toMatchObject({
        status: 206,
        contentRange: "bytes 2-5/" + String(file.sizeBytes),
        contentLength: "4",
        bodyBytes: 4,
      });
      expect(contract.open).toMatchObject({
        status: 206,
        contentRange: "bytes 262144-" + String(file.sizeBytes - 1) + "/" + String(file.sizeBytes),
        contentLength: String(file.sizeBytes - 262144),
        bodyBytes: file.sizeBytes - 262144,
      });
      expect(contract.suffix).toMatchObject({
        status: 206,
        contentRange: "bytes " + String(file.sizeBytes - 32) + "-" + String(file.sizeBytes - 1) + "/" + String(file.sizeBytes),
        contentLength: "32",
        bodyBytes: 32,
      });
      expect(contract.invalid).toMatchObject({
        status: 416,
        contentRange: "bytes */" + String(file.sizeBytes),
        bodyBytes: 0,
      });
      await setReadDelay(page, 1_000);
      const beforeSupplierCancel = await supplierReadMetrics(fixture);
      const pendingCancel = await page.evaluate(async (url) => {
        const controller = new AbortController();
        const response = await fetch(url, { headers: { Range: "bytes=0-" }, signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Range response 没有 ReadableStream body");
        // 先启动一次 pull，再在 Go supplier 的可取消延迟期间取消；这样
        // 不是“读完整个 arrayBuffer 后再 cancel”，而是能观察真实 Abort。
        const firstRead = reader.read().then(
          (first) => first.done ? 0 : first.value.byteLength,
          () => 0,
        );
        (window as Window & {
          __msfileNativeRangePendingCancel?: {
            controller: AbortController;
            reader: ReadableStreamDefaultReader<Uint8Array>;
            firstRead: Promise<number>;
          };
        }).__msfileNativeRangePendingCancel = { controller, reader, firstRead };
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
        };
      }, selected.url);
      // 先确认 Go 已接受这一次 Read，再让页面取消；否则仅以固定 sleep
      // 取消可能发生在请求尚未到达 supplier 的窗口内。
      await expect.poll(async () => (await supplierReadMetrics(fixture)).started, {
        timeout: 30_000,
        intervals: [100, 250, 500, 1_000],
      }).toBeGreaterThan(beforeSupplierCancel.started);
      const cancelled = await page.evaluate(async (response) => {
        const state = (window as Window & {
          __msfileNativeRangePendingCancel?: {
            controller: AbortController;
            reader: ReadableStreamDefaultReader<Uint8Array>;
            firstRead: Promise<number>;
          };
        }).__msfileNativeRangePendingCancel;
        if (!state) throw new Error("Range cancel state 未建立");
        state.controller.abort("e2e-cancel");
        await state.reader.cancel("e2e-cancel").catch(() => undefined);
        delete (window as Window & { __msfileNativeRangePendingCancel?: unknown }).__msfileNativeRangePendingCancel;
        return {
          status: response.status,
          contentRange: response.contentRange,
          firstChunkBytes: await state.firstRead,
        };
      }, pendingCancel);
      expect(cancelled.status).toBe(206);
      expect(cancelled.firstChunkBytes).toBe(0);
      const debug = await mediaDebug(selected.player);
      const counts = debugCounts(debug);
      console.log(JSON.stringify({
        event: "msfile_native_range_http_contract",
        file: "fixture-native-long.wav",
        contract,
        cancelled,
        // 这里验证浏览器 ReadableStream 的显式 cancel；Go supplier 的真实
        // Abort 证据由 R18 生命周期 Gate 通过 connection.abort 单独验证。
        supplierReadsBeforeBodyCancel: beforeSupplierCancel,
        requests: network.requests,
        responses: network.responses,
        goSupplierBlockReadEvidence: counts.actualSupplierBlockReads,
        debug: {
          mappedRanges: (debug.match(/range\.request\.mapped\b/gu) ?? []).length,
          completedBlockReads: counts.completedBlockReads,
          cancelledRequests: counts.cancelledRequests,
        },
      }));
      expect(counts.actualSupplierBlockReads).toBeGreaterThan(0);
    } finally {
      network.dispose();
    }
  });

  test("R11/R12/R13/R22：远跳、回跳、连续拖动和取消都由原生元素/生命周期完成", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    const file = fixture.files["fixture-native-long.wav"]!;
    // 真实 Go Read 已经由 service 发起后，延迟结果交付，保证 seek 时旧
    // Block 仍处于在途状态；AbortSignal 仍会传入真实 supplier 请求。
    await setReadDelay(page, 750);
    const network = attachGateNetworkEvidence(page);
    try {
      const selected = await selectNativeFile(page, file);
      await recordNativeEvents(page, selected.media);
      await playNative(selected.media);
      await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");
      await expect.poll(() => selected.player.getAttribute("data-msfile-media-phase"), { timeout: 30_000 }).toBe("playing");
      const duration = await selected.media.evaluate((element) => (element as HTMLMediaElement).duration);
      expect(duration).toBeGreaterThan(100);

      const remoteTarget = duration * 0.75;
      const remotePosition = await seekAndWait(selected.media, remoteTarget);
      expect(Math.abs(remotePosition - remoteTarget)).toBeLessThan(3);
      await selected.media.evaluate((element) => (element as HTMLMediaElement).play());
      await expect.poll(() => selected.player.getAttribute("data-msfile-media-phase"), { timeout: 30_000 }).toBe("playing");

      const backPosition = await seekAndWait(selected.media, 2);
      expect(Math.abs(backPosition - 2)).toBeLessThan(1);
      const beforeAdvance = await selected.media.evaluate((element) => (element as HTMLMediaElement).currentTime);
      await wait(2_000);
      const afterAdvance = await selected.media.evaluate((element) => (element as HTMLMediaElement).currentTime);
      expect(afterAdvance).toBeGreaterThan(beforeAdvance + 0.5);

      const drag = await rapidSeekAndWait(selected.media, [remoteTarget, 2, duration * 0.5, 5]);
      expect(drag.seekedCount).toBeGreaterThan(0);
      expect(Math.abs(drag.currentTime - 5)).toBeLessThan(0.75);
      await selected.media.evaluate((element) => (element as HTMLMediaElement).play());
      await expect.poll(() => selected.player.getAttribute("data-msfile-media-phase"), { timeout: 30_000 }).toBe("playing");
      const beforeFinalAdvance = await selected.media.evaluate((element) => (element as HTMLMediaElement).currentTime);
      await wait(1_500);
      const afterFinalAdvance = await selected.media.evaluate((element) => (element as HTMLMediaElement).currentTime);
      expect(afterFinalAdvance).toBeGreaterThan(beforeFinalAdvance + 0.25);
      expect(await selected.media.evaluate((element) => (element as HTMLMediaElement).error?.code ?? null)).toBeNull();

      const oldUrl = selected.url;
      const debugBeforeCancel = await mediaDebug(selected.player);
      const failedRequestsBeforeCancel = network.failedRequests.length;
      // 播放中的 GET 已经是实际在途 Range；只操作用户可见的 Cancel，
      // 观察原生请求失败/取消和 session 撤销。
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => page.locator(".msfile-home-file").innerText(), { timeout: 30_000 }).toMatch(/cancel/i);
      await wait(250);
      let revokedStatus = 0;
      await expect.poll(async () => {
        revokedStatus = await page.evaluate(async (url) => {
          const response = await fetch(url, { headers: { Range: "bytes=123-128" } });
          return response.status;
        }, oldUrl + "?revokeProbe=" + String(Date.now()));
        return revokedStatus;
      }, { timeout: 5_000, intervals: [100, 250, 500] }).toBe(404);
      expect(revokedStatus).toBe(404);
      const debug = debugBeforeCancel;
      expect(debugCounts(debug).cancelledRequests).toBeGreaterThan(0);
      expect(network.failedRequests.length).toBeGreaterThan(failedRequestsBeforeCancel);
      console.log(JSON.stringify({
        event: "msfile_native_range_seek_cancel",
        duration,
        remoteTarget,
        remotePosition,
        backPosition,
        beforeAdvance,
        afterAdvance,
        drag,
        beforeFinalAdvance,
        afterFinalAdvance,
        requestCountBeforeCancel: network.requests.length,
        failedRequestsBeforeCancel,
        requests: network.requests,
        responses: network.responses,
        failedRequests: network.failedRequests,
        cancelOutcome: "native-playback-request-cancelled-by-ui",
        revokedStatus,
        debugCounts: debugCounts(debug),
      }));
    } finally {
      network.dispose();
    }
  });

  test("G-SW-RESTART：Service Worker 重启后已有 session 仍可继续 Range、seek 和播放", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    await setReadDelay(page, 750);
    const file = fixture.files["fixture-native-long.wav"]!;
    const network = attachGateNetworkEvidence(page);
    try {
      const selected = await selectNativeFile(page, file);
      await recordNativeEvents(page, selected.media);
      await playNative(selected.media);
      await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");
      const duration = await selected.media.evaluate((element) => (element as HTMLMediaElement).duration);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");

      // 先用新的 fetch 强制唤醒刚被停止的 SW；Range Host 仍在当前页面，
      // 因而这条请求不能依赖 SW 重启前的任何内存 Map。
      const beforeRestartProbe = network.requests.length;
      const restartProbe = await page.evaluate(async (url) => {
        const response = await fetch(url, { headers: { Range: "bytes=1572864-" } });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("SW 重启探测没有 ReadableStream body");
        const first = await reader.read();
        await reader.cancel("sw-restart-probe");
        return { status: response.status, firstChunkBytes: first.done ? 0 : first.value.byteLength };
      }, selected.url);
      expect(restartProbe.status).toBe(206);
      expect(restartProbe.firstChunkBytes).toBeGreaterThan(0);
      expect(network.requests.length).toBeGreaterThan(beforeRestartProbe);

      const target = duration * 0.75;
      const position = await seekAndWait(selected.media, target);
      expect(Math.abs(position - target)).toBeLessThan(3);
      await selected.media.evaluate((element) => (element as HTMLMediaElement).play());
      await expect.poll(() => selected.player.getAttribute("data-msfile-media-phase"), { timeout: 30_000 }).toBe("playing");
      expect(await selected.media.evaluate((element) => (element as HTMLMediaElement).error?.code ?? null)).toBeNull();
      console.log(JSON.stringify({
        event: "msfile_native_range_sw_restart",
        restartProbe,
        target,
        position,
        requests: network.requests,
        responses: network.responses,
      }));
    } finally {
      network.dispose();
    }
  });

  test("R18：Vault lock/dispose 后旧媒体 session 撤销且不再发起 supplier Read", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    await setReadDelay(page, 750);
    const selected = await startNativePlayback(page, fixture.files["fixture-native-long.wav"]!);
    const beforeLock = await supplierReadMetrics(fixture);
    const lockStatus = await lockPage(page);
    expect(["ok", "accepted", "already-locked"]).toContain(lockStatus);
    const revokedStatus = await expectRevokedMediaUrl(page, selected.url, "lock");
    await wait(1_500);
    const afterLock = await supplierReadMetrics(fixture);
    expect(afterLock.started).toBeGreaterThanOrEqual(beforeLock.started);
    expect(afterLock.started).toBe(afterLock.completed + afterLock.aborted);
    expect(afterLock.aborted).toBeGreaterThan(beforeLock.aborted);
    console.log(JSON.stringify({
      event: "msfile_native_range_lifecycle_lock",
      lockStatus,
      revokedStatus,
      supplierReadMetrics: { beforeLock, afterLock },
    }));
  });

  test("R18：active key、supplier generation 和文件切换都会撤销旧媒体 session", async ({ page }) => {
    test.setTimeout(360_000);
    await preparePage(page, fixture);
    await setReadDelay(page, 750);

    const keySelected = await startNativePlayback(page, fixture.files["fixture-native-long.wav"]!);
    const beforeKeySwitch = await supplierReadMetrics(fixture);
    const keySwitch = await switchKeyPage(page);
    expect(keySwitch.activePublicKeyHex).not.toBe(keySwitch.previousPublicKeyHex);
    const keyRevokedStatus = await expectRevokedMediaUrl(page, keySelected.url, "active-key-change");
    await wait(1_500);
    const afterKeySwitch = await supplierReadMetrics(fixture);
    expect(afterKeySwitch.started).toBe(afterKeySwitch.completed + afterKeySwitch.aborted);
    expect(afterKeySwitch.aborted).toBeGreaterThan(beforeKeySwitch.aborted);

    // 换 key 后重新进入干净页面，验证新 active key 下仍能建立正式 supplier
    // 配置；旧媒体 URL 必须保持撤销，不能被新页面复用。
    await preparePage(page, fixture);
    await setReadDelay(page, 750);
    const supplierSelected = await startNativePlayback(page, fixture.files["fixture-native-long.wav"]!);
    const beforeSupplierChange = await supplierReadMetrics(fixture);
    await configurePageWithName(page, fixture, "MSFile Native Range Gate NAS replacement v2");
    const supplierRevokedStatus = await expectRevokedMediaUrl(page, supplierSelected.url, "supplier-generation-change");
    await wait(1_500);
    const afterSupplierChange = await supplierReadMetrics(fixture);
    expect(afterSupplierChange.started).toBe(afterSupplierChange.completed + afterSupplierChange.aborted);
    expect(afterSupplierChange.aborted).toBeGreaterThan(beforeSupplierChange.aborted);

    await preparePage(page, fixture);
    await setReadDelay(page, 750);
    const fileSelected = await startNativePlayback(page, fixture.files["fixture-native-long.wav"]!);
    const beforeFileChange = await supplierReadMetrics(fixture);
    const replacement = await selectNativeFile(page, fixture.files["fixture-native-mp3.mp3"]!);
    const fileRevokedStatus = await expectRevokedMediaUrl(page, fileSelected.url, "file-change");
    await wait(1_500);
    const afterFileChange = await supplierReadMetrics(fixture);
    expect(replacement.url).not.toBe(fileSelected.url);
    expect(afterFileChange.started).toBe(afterFileChange.completed + afterFileChange.aborted);
    expect(afterFileChange.aborted).toBeGreaterThan(beforeFileChange.aborted);
    console.log(JSON.stringify({
      event: "msfile_native_range_lifecycle_fences",
      keySwitch,
      keyRevokedStatus,
      supplierRevokedStatus,
      fileRevokedStatus,
      supplierReadMetrics: { beforeKeySwitch, afterKeySwitch, beforeSupplierChange, afterSupplierChange, beforeFileChange, afterFileChange },
    }));
  });

  test("R18：页面 unload 后旧媒体 session 不再可访问", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    await setReadDelay(page, 750);
    const selected = await startNativePlayback(page, fixture.files["fixture-native-long.wav"]!);
    const beforeUnload = await supplierReadMetrics(fixture);
    await page.goto("/?msfileE2E=1", { waitUntil: "load" });
    await waitForHooks(page);
    const revokedStatus = await expectRevokedMediaUrl(page, selected.url, "page-unload");
    await wait(1_500);
    const afterUnload = await supplierReadMetrics(fixture);
    expect(revokedStatus).toBe(404);
    expect(afterUnload.started).toBe(afterUnload.completed + afterUnload.aborted);
    expect(afterUnload.aborted).toBeGreaterThan(beforeUnload.aborted);
    console.log(JSON.stringify({
      event: "msfile_native_range_lifecycle_unload",
      revokedStatus,
      supplierReadMetrics: { beforeUnload, afterUnload },
    }));
  });

  test("R19：协议版本不匹配时安全中止，且不安装媒体 URL", async ({ page }) => {
    test.setTimeout(240_000);
    await preparePage(page, fixture);
    const mismatch = await installProtocolMismatchPage(page);
    expect(mismatch.errorCode).toBe("msfile_media_service_worker");
    expect(mismatch.controllerScriptUrl).toMatch(/\/e2e-mismatch-sw\.js$/u);

    const file = fixture.files["fixture-native-mp3.mp3"]!;
    await page.locator("#msfile-home-seed-hash").fill(file.seedHashHex);
    await page.locator(".msfile-home-file__form").locator("button[type=submit]").click();
    const player = page.locator(".msfile-home-file__streaming-player").last();
    await expect(player).toBeVisible({ timeout: 120_000 });
    const media = player.locator("audio, video");
    await expect.poll(() => player.getAttribute("data-msfile-media-phase"), { timeout: 30_000 }).toBe("failed");
    expect(await media.getAttribute("src")).toBeNull();
    const debug = await mediaDebug(player);
    expect(debug).toContain("msfile_media_service_worker");
    expect(debug).not.toContain("range.session.bound");
    console.log(JSON.stringify({
      event: "msfile_native_range_sw_protocol_mismatch",
      mismatch,
      mediaSourceInstalled: false,
    }));
  });

  test("R21：production preview 的媒体 SW 响应满足部署 smoke 契约", async ({ request }) => {
    const response = await request.get("/msfile-media-sw.js", { failOnStatusCode: false });
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toMatch(/javascript/u);
    expect(headers["service-worker-allowed"]).toBe("/");
    expect(headers["cache-control"]).toMatch(/no-cache/u);
    const body = await response.text();
    expect(body).toContain("msfile-media");
    expect(body).not.toMatch(/<html|<!doctype/iu);
    console.log(JSON.stringify({
      event: "msfile_native_range_deployment_smoke",
      status: response.status(),
      contentType: headers["content-type"] ?? null,
      serviceWorkerAllowed: headers["service-worker-allowed"] ?? null,
      cacheControl: headers["cache-control"] ?? null,
      isHtmlFallback: false,
    }));
  });

  test("R01/R17/G-SW-UPGRADE：旧根作用域 controller 不能跳过当前 SW 注册和协议握手", async ({ page }) => {
    test.setTimeout(180_000);
    await preparePage(page, fixture);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/e2e-old-root-sw.js", {
        scope: "/",
        type: "module",
      });
      await registration.update();
    });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), {
      timeout: 30_000,
    }).toMatch(/\/e2e-old-root-sw\.js$/u);

    const file = fixture.files["fixture-native-mp3.mp3"]!;
    const selected = await selectNativeFile(page, file);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), {
      timeout: 60_000,
    }).toMatch(/\/msfile-media-sw\.js$/u);
    await recordNativeEvents(page, selected.media);
    await playNative(selected.media);
    await expect.poll(() => nativeEvents(page), { timeout: 120_000 }).toContain("playing");
    const debug = await mediaDebug(selected.player);
    expect(debug).toContain('"backend":"native-range"');
    expect(debug).toMatch(/"buildVersion":"[^"\n]+"/u);
    expect(debug).toContain('"serviceWorkerProtocolVersion":1');
    expect(debug).toMatch(/"serviceWorkerScriptUrl":"[^"\n]*\/msfile-media-sw\.js"/u);
    expect(debug).not.toContain("mse.seek");
    expect(debug).toContain("sw.register.ready");
    expect(debug).toContain("range.session.bound");

    const secondPage = await page.context().newPage();
    try {
      await secondPage.addInitScript(() => {
        localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 2, enabled: {} }));
      });
      await secondPage.goto("/?msfileE2E=1", { waitUntil: "load" });
      await expect.poll(() => secondPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), {
        timeout: 30_000,
      }).toMatch(/\/msfile-media-sw\.js$/u);
      const crossClientStatus = await secondPage.evaluate(async (url) => {
        const response = await fetch(url + "?crossClient=" + String(Date.now()), { headers: { Range: "bytes=0-3" } });
        return response.status;
      }, selected.url);
      expect(crossClientStatus).toBe(404);
    } finally {
      await secondPage.close();
    }
    console.log(JSON.stringify({
      event: "msfile_native_range_sw_upgrade",
      oldController: "/e2e-old-root-sw.js",
      currentController: await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""),
      browserEvents: await nativeEvents(page),
      debugCounts: debugCounts(debug),
      crossClientStatus: 404,
    }));
  });
});
