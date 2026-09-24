import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { readSessionPublicKey } from "../../drivers/appDriver.js";
import { initializeLocalUser } from "../../drivers/initialSetupDriver.js";
import {
  addMsFileSupplier,
  downloadMsFileBySeedHash,
  expectMsFileAbsent,
  expectMsFileTextPreview,
  openMsFileFilesPage,
  openMsFileSettingsPage,
  saveMsFilePriceLimits,
  testMsFileSupplierConnection,
} from "../../drivers/msfileDriver.js";
import { reloadAndAssertSameKey, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import {
  MSFILE_NAS_ABSENT_SEED_HASH,
  MSFILE_NAS_BINARY_FILENAME,
  MSFILE_NAS_TEXT_CONTENT,
  MSFILE_NAS_TEXT_FILENAME,
  msfileNasJourneyFixtures,
} from "../../fixtures/msfileNasFixtures.js";
import { assertMsFileProxyProtocolCommit } from "../../fixtures/msfileProxyProtocol.js";
import { startMsFileNasResource, type MsFileNasResource } from "../../resources/msfile/localNasResource.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_MSFILE_NAS_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_MSFILE_NAS_SCENARIO.id;
export const JOURNEY_METADATA = REAL_MSFILE_NAS_SCENARIO;

const PREVIEW_ORIGIN = "http://127.0.0.1:4173";
const SUPPLIER_NAME = "真实 MSFile NAS 本地供应商";
const USER_PASSWORD = "real-msfile-nas-password";
const SEED_MAX_PRICE_SATOSHIS = "5000";
const BLOCK_MAX_PRICE_SATOSHIS = "1000";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 业务目标：普通用户在真实页面上配置并通过 P2P 从正式 nas 读取真实文件；
 * 文本预览和下载字节都必须与 NAS 磁盘源文件一致，未知 Seed 不得伪装成功。
 *
 * 开始状态：Node 从 MSFILE_PROXY_PROTOCOL_DIR 构建正式 `cmd/msfile-nas`，
 * 用一次性 NAS 目录、确定性供应商身份（私钥 1）和 WebRTC Direct listener
 * 发布两个夹具文件；浏览器是全新 Chromium context。
 *
 * 成功标准：
 * - 设置页保存全局金额上限并 pin 真实 NAS 公钥/PeerId，Test connection 成功；
 * - 首页入口对文本 Seed 显示可获取，预览内容与源文件完全一致；
 * - 二进制文件下载后的 SHA-256 与长度等于 NAS 源文件；
 * - 未知 Seed 只显示没有文件，不出现下载入口；
 * - 供应商 Read 计数证明读取到达真实 NAS 且没有悬挂请求；
 * - 刷新并重新解锁后同一身份仍能用持久化配置再次取得同一文件。
 *
 * 业务风险：把页面预览/下载入口、供应商列表或 probe 点击当成远端已提供
 * 内容会误导用户；本场景同时要求页面可见结果、下载字节和供应商侧计数。
 *
 * 外部资源与收尾：只使用一次性临时目录、回环地址和随机端口；结束时关闭
 * 浏览器、NAS 进程和临时目录，不产生真实资金流动或长期秘密。
 *
 * 覆盖需求：KM-MSFILE-001。
 */
test(JOURNEY_ID + "：真实 msfile-nas 的 Seed 文件获取与下载", async ({}, testInfo) => {
  test.setTimeout(480_000);
  await assertMsFileProxyProtocolCommit();
  const nas: MsFileNasResource = await startMsFileNasResource({ files: msfileNasJourneyFixtures() });
  const browser: Browser = await chromium.launch();
  const context: BrowserContext = await browser.newContext({ baseURL: PREVIEW_ORIGIN, acceptDownloads: true });
  const page: Page = await context.newPage();
  const browserErrors: BrowserErrorEvidence = captureBrowserErrors(page, context);

  try {
    let publicKeyHex = "";

    await test.step("用户建立可恢复的 Local 身份", async () => {
      const ready = await initializeLocalUser(page, {
        bucketLabel: "真实 MSFile NAS",
        keyLabel: "真实 MSFile NAS Key",
        password: USER_PASSWORD,
      });
      publicKeyHex = ready.publicKeyHex;
      expect(publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/u);
    });

    await test.step("用户在本地文件页保存金额上限并 pin 真实 NAS 身份", async () => {
      await openMsFileSettingsPage(page);
      await saveMsFilePriceLimits(page, {
        seedMaxPriceSatoshis: SEED_MAX_PRICE_SATOSHIS,
        blockMaxPriceSatoshis: BLOCK_MAX_PRICE_SATOSHIS,
      });
      await addMsFileSupplier(page, {
        name: SUPPLIER_NAME,
        supplierPublicKeyHex: nas.supplierPublicKeyHex,
        addresses: [nas.webRtcDirectAddress],
      });
      await testMsFileSupplierConnection(page, SUPPLIER_NAME);
    });

    await test.step("文本文件通过正式入口取得且预览与源文件一致", async () => {
      await openMsFileFilesPage(page);
      const text = nas.fileByFilename(MSFILE_NAS_TEXT_FILENAME);
      expect(text.mediaType).toBe("text/plain");
      await expectMsFileTextPreview(page, text.seedHashHex, MSFILE_NAS_TEXT_CONTENT);
    });

    await test.step("二进制文件下载后与 NAS 源文件对账", async () => {
      const binary = nas.fileByFilename(MSFILE_NAS_BINARY_FILENAME);
      expect(binary.sizeBytes).toBeGreaterThan(512 * 1024);
      const download = await downloadMsFileBySeedHash(page, binary.seedHashHex);
      expect(download.suggestedFilename()).toBe(MSFILE_NAS_BINARY_FILENAME);
      const path = await download.path();
      if (!path) throw new Error("浏览器没有产生下载文件");
      const bytes = await fs.readFile(path);
      expect(bytes.byteLength).toBe(binary.sizeBytes);
      expect(sha256Hex(bytes)).toBe(binary.sha256Hex);
    });

    await test.step("未知 Seed 只显示没有文件，不会伪装成功", async () => {
      await expectMsFileAbsent(page, MSFILE_NAS_ABSENT_SEED_HASH);
    });

    await test.step("供应商 Read 计数证明读取到达真实 NAS", async () => {
      await expect.poll(async () => {
        const metrics = await nas.readMetrics();
        return metrics.started - (metrics.completed + metrics.aborted);
      }, {
        timeout: 30_000,
        message: "供应商 Read 必须在终态收口，不能有悬挂请求",
      }).toBe(0);
      const metrics = await nas.readMetrics();
      expect(metrics.started).toBeGreaterThanOrEqual(2);
      expect(metrics.completed).toBeGreaterThanOrEqual(2);
      expect(metrics.completed + metrics.aborted).toBe(metrics.started);
      console.log(JSON.stringify({
        event: "msfile_nas_journey_read_metrics",
        supplierPublicKeyHex: nas.supplierPublicKeyHex,
        peerId: nas.peerId,
        seedCount: nas.files.length,
        readMetrics: metrics,
      }));
    });

    await test.step("刷新并重新解锁后同一身份仍能取得同一文件", async () => {
      await reloadAndAssertSameKey(page, "");
      await unlockWalletInPlace(page, USER_PASSWORD);
      expect(await readSessionPublicKey(page)).toBe(publicKeyHex);
      const text = nas.fileByFilename(MSFILE_NAS_TEXT_FILENAME);
      await expectMsFileTextPreview(page, text.seedHashHex, MSFILE_NAS_TEXT_CONTENT);
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [USER_PASSWORD]);
    await attachVisibleDiagnostic(page, testInfo);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await nas.stop();
  }
});
