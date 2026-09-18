import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { initializeLocalUser } from "../../drivers/initialSetupDriver.js";
import {
  expectMsFileTextPreview,
  openMsFileFilesPage,
  openMsFileMediaBySeedHash,
  playMsFileMedia,
  saveMsFilePriceLimits,
  testMsFileSupplierConnection,
} from "../../drivers/msfileDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_MSFILE_OFFICIAL_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_MSFILE_OFFICIAL_SCENARIO.id;
export const JOURNEY_METADATA = REAL_MSFILE_OFFICIAL_SCENARIO;

const PREVIEW_ORIGIN = "http://127.0.0.1:4173";
const SUPPLIER_NAME = "BSV8 Official MSFiles";
/** 系统内置官方供应商公钥；设置页必须以该系统缺省身份展示。 */
const OFFICIAL_SUPPLIER_PUBLIC_KEY_HEX = "039da34bc7ccccff68bb7b4295094f4d9180020302909bb75e4b4610d865619c26";
const USER_PASSWORD = "real-msfile-official-password";
const SEED_MAX_PRICE_SATOSHIS = "5000";
const BLOCK_MAX_PRICE_SATOSHIS = "1000";

/** 官方 msfiles 服务已发布的四个内容；Seed Hash 是内容真值，不由页面输入改写。 */
const OFFICIAL_WAV_SEED_HASH = "f2f71316c34747750aab3f865304053fdeedb68f03bcd7c873e170dd7eb2f192";
const OFFICIAL_MP3_SEED_HASH = "e1953e1ecd316c618c14914d27fa8f1a4b1f3ee9e86548912ae9e4d0493e6656";
const OFFICIAL_MP4_SEED_HASH = "5e190580670fd873aafdd78126d25d40797f466a9eec22682b68f91f75d57afe";
const OFFICIAL_MARKDOWN_SEED_HASH = "e50d7349ac9c2ff8965900e0b6c2f84fd11060ccf26864ef3512975f6cd189cf";
/** 官方 Hello.md 的 6 字节 UTF-8 内容；文本预览必须逐字节一致。 */
const OFFICIAL_MARKDOWN_CONTENT = "World\n";

const MEDIA_PREFIX = "/__keymaster/msfile-media/";

interface MediaRangeEvidence {
  readonly url: string;
  readonly range: string | null;
  status: number | null;
}

/**
 * 业务目标：真实用户只使用系统缺省配置，就从 BSV8 官方 msfiles 服务按
 * 正确方式打开官方示例文件；媒体必须走原生 Range 播放，文本必须走预览，
 * 不能退化成整文件下载。
 *
 * 开始状态：全新 Chromium context；MSFile 系统内置官方供应商（公钥
 * 039da3…26，WSS /dns4/msfiles.bsv8.com/tcp/443/tls/ws）。浏览器可直接
 * 访问公网官方服务，不注入任何传输替身。
 *
 * 成功标准：
 * - 内置官方供应商无需手工添加：设置页显示系统内置且无法删除，Test connection 真实成功；
 * - sample-15s.wav、sample-15s.mp3、sample-30s.mp4 都通过虚拟媒体 URL
 *   进入原生 Range 播放（playing + 真实 Block 读取），而不是 blob 整文件下载；
 * - Hello.md 以文本预览打开并显示与源文件一致的内容；
 * - 媒体请求带有真实 Range 且由 Service Worker 返回 206。
 *
 * 业务风险：把“能下载”当成“能打开”会掩盖播放链路退化；本场景明确要求
 * 每个文件走其对应的正式打开方式。
 *
 * 外部资源与收尾：只读取公开只读内容，不产生费用或本地持久化；结束时
 * 关闭浏览器并保持官方服务不变。
 *
 * 覆盖需求：KM-MSFILE-001。
 */
test(JOURNEY_ID + "：BSV8 官方 msfiles 服务的四个文件按正确方式打开", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const browser: Browser = await chromium.launch();
  const context: BrowserContext = await browser.newContext({ baseURL: PREVIEW_ORIGIN, acceptDownloads: true });
  const page: Page = await context.newPage();
  const browserErrors: BrowserErrorEvidence = captureBrowserErrors(page, context);
  const mediaRanges: MediaRangeEvidence[] = [];
  const onRequest = (request: { url(): string; headers(): Record<string, string> }) => {
    if (!new URL(request.url()).pathname.startsWith(MEDIA_PREFIX)) return;
    mediaRanges.push({ url: request.url(), range: request.headers().range ?? null, status: null });
  };
  const onResponse = (response: { url(): string; status(): number }) => {
    if (!new URL(response.url()).pathname.startsWith(MEDIA_PREFIX)) return;
    const entry = mediaRanges.find((candidate) => candidate.url === response.url() && candidate.status === null);
    if (entry) entry.status = response.status();
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  try {
    await test.step("用户建立可恢复的 Local 身份", async () => {
      const ready = await initializeLocalUser(page, {
        bucketLabel: "官方 MSFiles",
        keyLabel: "官方 MSFiles Key",
        password: USER_PASSWORD,
      });
      expect(ready.publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/u);
    });

    await test.step("内置官方供应商无需手工添加即可测试连接", async () => {
      await openSettingsPage(page, {
        label: /^System$|^系统$/u,
        path: /\/settings\/system$/u,
        heading: /^System$|^系统$/u,
      });
      await saveMsFilePriceLimits(page, {
        seedMaxPriceSatoshis: SEED_MAX_PRICE_SATOSHIS,
        blockMaxPriceSatoshis: BLOCK_MAX_PRICE_SATOSHIS,
      });
      const settings = page.getByRole("region", { name: /^MSFile$/u });
      const row = settings.locator("li").filter({ hasText: SUPPLIER_NAME }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(/System default|系统内置/u)).toBeVisible();
      await expect(row.getByText(OFFICIAL_SUPPLIER_PUBLIC_KEY_HEX.slice(0, 12), { exact: false })).toBeVisible();
      await expect(row.getByRole("button", { name: /Delete|删除/ })).toHaveCount(0);
      await testMsFileSupplierConnection(page, SUPPLIER_NAME);
    });

    await test.step("三个媒体文件按原生 Range 方式打开并播放", async () => {
      await openMsFileFilesPage(page);
      const mediaFiles = [
        { label: "sample-15s.wav", seedHashHex: OFFICIAL_WAV_SEED_HASH },
        { label: "sample-15s.mp3", seedHashHex: OFFICIAL_MP3_SEED_HASH },
        { label: "sample-30s.mp4", seedHashHex: OFFICIAL_MP4_SEED_HASH },
      ];
      const evidence: Array<Record<string, unknown>> = [];
      for (const file of mediaFiles) {
        const player = await openMsFileMediaBySeedHash(page, file.seedHashHex);
        const media = player.locator("audio, video");
        // 正确打开方式：原生元素绑定虚拟媒体 URL（由 SW 做 Range），不是 blob 下载。
        await expect(media).toHaveAttribute("src", /\/__keymaster\/msfile-media\/[0-9a-f]{32}/u);
        expect(await media.getAttribute("src")).not.toMatch(/^blob:/u);
        const playback = await playMsFileMedia(page, player);
        evidence.push({ filename: file.label, seedHashHex: file.seedHashHex, ...playback });
      }
      expect(evidence).toHaveLength(mediaFiles.length);
      // 每个文件都必须真正读到 Block；这里证明打开方式不是整文件 Blob 下载。
      for (const entry of evidence) expect(entry.readBlocks).toBeGreaterThan(0);
      console.log(JSON.stringify({ event: "msfile_official_media_playback", evidence }));
    });

    await test.step("Hello.md 以文本预览打开而不是下载", async () => {
      const widget = page.getByRole("region", { name: /Get a file by Seed|通过 Seed 获取文件/ });
      await expectMsFileTextPreview(page, OFFICIAL_MARKDOWN_SEED_HASH, OFFICIAL_MARKDOWN_CONTENT);
      // 文本打开方式不出现原生媒体播放器；下载入口保持可选但不被自动触发。
      await expect(widget.locator(".msfile-home-file__streaming-player")).toHaveCount(0);
    });

    await test.step("媒体虚拟 URL 由真实 Range 请求和 206 响应承载", async () => {
      await expect.poll(() => mediaRanges.filter((entry) => entry.range !== null).length, {
        timeout: 30_000,
        message: "媒体必须通过 Range 请求读取，而不是整文件传输",
      }).toBeGreaterThan(0);
      const ranged = mediaRanges.filter((entry) => entry.range !== null);
      expect(ranged.some((entry) => entry.status === 206)).toBe(true);
      console.log(JSON.stringify({
        event: "msfile_official_media_range_evidence",
        requestCount: mediaRanges.length,
        rangedRequestCount: ranged.length,
        statuses: [...new Set(mediaRanges.map((entry) => entry.status))],
      }));
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [USER_PASSWORD]);
    await attachVisibleDiagnostic(page, testInfo);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
});
