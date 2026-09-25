import { basename } from "node:path";
import { expect, type Download, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";
import { openMsFileFilesPage, openMsFileSettingsPage } from "./msfileDriver.js";
import { readRawLocalBucketObjects } from "../support/localBucketFormats.js";

export interface BitfsSellerSettingsInput {
  readonly seedPriceSatoshis: string;
  readonly fullBlockPriceSatoshis: string;
  readonly quoteLifetimeSeconds: string;
  readonly maxConcurrentSales: string;
  readonly supportedArbiterPublicKeys: readonly string[];
}

export interface BitfsBuyerSettingsInput {
  readonly buyerAutoPurchaseEnabled: boolean;
  readonly maxFullBlockPriceSatoshis: string;
  readonly sellerSelectionPriority: "price" | "recent-speed";
  readonly maxConcurrentDownloads: string;
  readonly maxConcurrentSellerSessions: string;
  readonly blocksPerBatch: string;
}

export interface UploadedMsFile {
  readonly seedHashHex: string;
  readonly fileName: string;
}

export async function openMsFileStoragePage(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Bucket storage files$|^桶存储文件$/u,
    path: /\/msfile\/storage$/u,
  });
  await expect(page.getByRole("heading", { name: /^Bucket storage files$|^桶存储文件$/u })).toBeVisible();
}

export async function configureBitfsSeller(page: Page, input: BitfsSellerSettingsInput): Promise<void> {
  await openMsFileSettingsPage(page);
  const section = page.locator("#msfile-selling");
  process.stdout.write("[bitfs-e2e] 定位卖方设置区\n");
  await expect(section).toBeVisible({ timeout: 15_000 });
  const enabled = page.locator("#msfile-selling input[type=checkbox]");
  await expect(enabled).toBeVisible({ timeout: 15_000 });
  process.stdout.write("[bitfs-e2e] 填写卖方价格与并发设置\n");
  await enabled.check({ force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方开关已设置\n");
  await page.locator("#msfile-seller-seed-price").fill(input.seedPriceSatoshis, { force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方 Seed 价格已填写\n");
  await page.locator("#msfile-seller-block-price").fill(input.fullBlockPriceSatoshis, { force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方 Block 价格已填写\n");
  await page.locator("#msfile-seller-quote-lifetime").fill(input.quoteLifetimeSeconds, { force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方报价期限已填写\n");
  await page.locator("#msfile-seller-max-sales").fill(input.maxConcurrentSales, { force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方并发上限已填写\n");
  await page.locator("#msfile-seller-arbiters").fill(input.supportedArbiterPublicKeys.join("\n"), { force: true, timeout: 10_000 });
  process.stdout.write("[bitfs-e2e] 卖方仲裁方已填写\n");
  process.stdout.write("[bitfs-e2e] 提交卖方设置\n");
  await section.getByRole("button", { name: /保存卖方设置|Save selling settings|Save seller settings/iu }).click();
  let lastStatus = "";
  await expect.poll(async () => {
    const status = (await section.locator(".msfile-settings__status").textContent())?.trim() ?? "";
    if (status && status !== lastStatus) {
      lastStatus = status;
      process.stdout.write(`[bitfs-e2e] 卖方状态：${status}\n`);
    }
    return status;
  }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000], message: "卖方必须在限定时间内完成索引并可报价" }).toMatch(/可以出售|可以接单|正在出售|Ready to sell|Selling/iu);
}

export async function configureBitfsBuyer(page: Page, input: BitfsBuyerSettingsInput): Promise<void> {
  await openMsFileSettingsPage(page);
  const enabled = page.getByRole("checkbox", { name: /Start purchases automatically|允许.*购买|自动.*购买/iu });
  if ((await enabled.isChecked()) !== input.buyerAutoPurchaseEnabled) await enabled.setChecked(input.buyerAutoPurchaseEnabled);
  await page.getByLabel(/Maximum automatic full Block price|自动购买完整 Block 最高价/iu).fill(input.maxFullBlockPriceSatoshis);
  await page.getByLabel(/卖家选择优先级|Seller selection priority/iu).selectOption(input.sellerSelectionPriority);
  await page.getByLabel(/Concurrent file purchases|同时购买文件任务数/iu).fill(input.maxConcurrentDownloads);
  await page.getByLabel(/Concurrent seller pools per file|单个文件同时传输的卖家数/iu).fill(input.maxConcurrentSellerSessions);
  await page.getByLabel(/File blocks requested per payment batch|每次请求的文件块数/iu).fill(input.blocksPerBatch);
  await page.getByRole("button", { name: /保存 BitFS 买方设置|Save BitFS buyer settings/iu }).click();
  await expect(page.getByRole("status").filter({ hasText: /BitFS 买方设置已保存|BitFS buyer settings saved/iu })).toBeVisible({ timeout: 30_000 });
}

export async function uploadMsFile(page: Page, filePath: string, timeoutMs = 150_000): Promise<UploadedMsFile> {
  const fileName = basename(filePath);
  await page.locator('[data-msfile-bucket="file-input"]').setInputFiles(filePath);
  let lastProgress = "";
  await expect.poll(async () => {
    const progress = (await page.locator(".msfile-bucket__progress, .msfile-bucket__ok").allTextContents()).join(" | ").trim();
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      process.stdout.write(`[bitfs-e2e] 上传进度：${progress}\n`);
    }
    return progress;
  }, { timeout: timeoutMs, intervals: [1_000, 2_000, 5_000], message: "MP4 上传必须在限定时间内完成" }).toMatch(/上传完成|Upload complete/iu);
  const row = page.locator(".ui-data-table tbody tr").filter({ hasText: fileName }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const seedHashHex = await row.locator("code[title]").first().getAttribute("title");
  if (!seedHashHex || !/^[0-9a-f]{64}$/u.test(seedHashHex)) throw new Error("上传完成但桶列表没有返回合法 Seed Hash");
  return { seedHashHex, fileName };
}

export async function queryBitfsSeed(page: Page, seedHashHex: string): Promise<void> {
  await openMsFileFilesPage(page);
  const widget = page.getByRole("region", { name: /Get a file by Seed|通过 Seed 获取文件/iu });
  await widget.getByLabel(/Seed Hash/iu).fill(seedHashHex);
  await widget.getByRole("button", { name: /Find file|查询文件/iu }).click();
  await expect(widget.getByText(/本地没有该文件，已发布 BitFS 需求；正在等待卖家报价|A BitFS demand was published|published a BitFS request/iu)).toBeVisible({ timeout: 30_000 });
}

export async function startBitfsPurchase(page: Page, seedHashHex: string, options: { readonly onBeforeClick?: () => void | Promise<void> } = {}): Promise<void> {
  process.stdout.write("[bitfs-e2e] 再次查询 Seed\n");
  await queryBitfsSeed(page, seedHashHex);
  process.stdout.write("[bitfs-e2e] 等待报价按钮\n");
  const widget = page.getByRole("region", { name: /Get a file by Seed|通过 Seed 获取文件/iu });
  const buyButton = widget.getByRole("button", { name: /购买此报价|Buy this quote/iu }).first();
  await expect(buyButton).toBeVisible({ timeout: 45_000 });
  process.stdout.write("[bitfs-e2e] 报价按钮已显示\n");
  await expect(buyButton).toBeEnabled({ timeout: 45_000 });
  process.stdout.write("[bitfs-e2e] 点击购买按钮\n");
  await options.onBeforeClick?.();
  await buyButton.click();
}

export async function waitForBitfsPurchaseCompleted(page: Page, seedHashHex: string, timeoutMs = 1_500_000): Promise<void> {
  const widget = page.getByRole("region", { name: /Get a file by Seed|通过 Seed 获取文件/iu });
  await expect(widget.getByLabel(/Seed Hash/iu)).toHaveValue(seedHashHex);
  const completed = widget.getByRole("button", { name: /购买完成|Purchase complete(?:d)?/iu }).first();
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastEvidence = "";
  let nextDiagnosticAt = 0;
  while (Date.now() < deadline) {
    if (await completed.isVisible()) return;
    const text = await widget.innerText();
    if (text !== lastStatus) {
      process.stdout.write(`[bitfs-e2e] 购买状态：${text}\n`);
      lastStatus = text;
    }
    if (/Data connection closed|DataChannel 已关闭|协议处理失败|protocol.*failed|连接已关闭/iu.test(text)) {
      throw new Error("BitFS purchase connection failed before completion");
    }
    if (Date.now() >= nextDiagnosticAt) {
      await assertBitfsDiagnosticsHealthy(page);
      const entries = await readRawLocalBucketObjects(page, "/bitfs-journal/sessions/.*\\.json$");
      const summaries = entries.map(entry => JSON.parse(entry.text) as {
        phase: string; pendingTxid?: string; evidence: string[];
      }).map(session => ({ phase: session.phase, pendingTxid: session.pendingTxid, evidenceCount: session.evidence.length }));
      const evidence = JSON.stringify(summaries);
      if (evidence !== lastEvidence) {
        process.stdout.write(`[bitfs-e2e] 协议状态：${evidence}\n`);
        lastEvidence = evidence;
      }
      nextDiagnosticAt = Date.now() + 10_000;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`BitFS purchase did not complete within ${timeoutMs}ms; last status: ${lastStatus}`);
}

export async function assertBitfsFundingPoolClosed(page: Page, seedHashHex: string): Promise<void> {
  const entries = await readRawLocalBucketObjects(page, "/funding/accounts/.*\\.json$");
  const accountEntry = entries.find((entry) => entry.path.endsWith(`/funding/accounts/test/${seedHashHex}.json`));
  if (!accountEntry) throw new Error("买方本地桶缺少 testnet BitFS 专款账本");
  const account = JSON.parse(accountEntry.text) as {
    network?: unknown;
    pools?: Array<{ state?: unknown }>;
    transactions?: Array<{ purpose?: unknown; state?: unknown }>;
    utxos?: Array<{ state?: unknown }>;
  };
  expect(account.network).toBe("test");
  expect(Array.isArray(account.pools) && account.pools.length > 0).toBe(true);
  expect((account.pools ?? []).every((pool) => pool.state === "closed")).toBe(true);
  expect((account.transactions ?? []).some((transaction) => transaction.purpose === "close" && transaction.state === "observed")).toBe(true);
  expect((account.utxos ?? []).some((utxo) => utxo.state === "pool-occupied" || utxo.state === "recovery-pending")).toBe(false);
}

export async function verifyDownloadedMsFile(page: Page, seedHashHex: string): Promise<Download> {
  await openMsFileStoragePage(page);
  const row = page.locator(".ui-data-table tbody tr").filter({ has: page.locator(`code[title="${seedHashHex}"]`) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: /校验|Verify/iu }).click();
  await expect(page.getByRole("status").filter({ hasText: /校验通过|Verified: seed present/iu })).toBeVisible({ timeout: 90_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await row.getByRole("button", { name: /下载|Download/iu }).click();
  return await downloadPromise;
}

/** Verify durable protocol evidence independently of the purchase button. */
export async function assertBitfsPurchaseEvidence(page: Page, seedHashHex: string): Promise<void> {
  const entries = await readRawLocalBucketObjects(page, "/bitfs-journal/sessions/.*\\.json$|/bitfs-e2e-diagnostics/");
  const sessions = entries.filter(entry => entry.path.includes("/bitfs-journal/sessions/"))
    .map(entry => JSON.parse(entry.text) as { role: string; seedHashHex: string; phase: string; evidence: string[] })
    .filter(session => session.role === "buyer" && session.seedHashHex === seedHashHex);
  expect(sessions.length, "purchase must have a durable buyer session").toBeGreaterThan(0);
  for (const session of sessions) {
    expect(session.phase).toBe("completed");
    expect(session.evidence).toEqual(expect.arrayContaining([
      "kind1-quote", "kind2-opening-request", "kind3-opening-response", "kind4-funding-delivery",
      "kind12-close-request", "kind13-close-response", "funding-transaction", "close-transaction",
    ]));
    for (const kind of ["kind5-content-request", "kind6-content-delivery", "kind7-payment-update"]) {
      expect(session.evidence.some(name => name === kind || name.startsWith(`${kind}-`)), kind).toBe(true);
    }
  }
  await assertBitfsDiagnosticsHealthy(page);
}

/** 用持久化付款轮数验证批量调度，而非仅凭设置界面的显示值。 */
export async function assertBitfsPurchaseBatching(page: Page, seedHashHex: string, blocksPerBatch: number): Promise<{ blockCount: number; paymentRounds: number }> {
  const entries = await readRawLocalBucketObjects(page, `/bitfs-journal/sessions/.*\\.json$|/bitfs-journal/download-plans/${seedHashHex}\\.json$`);
  const planEntry = entries.find((entry) => entry.path.endsWith(`/bitfs-journal/download-plans/${seedHashHex}.json`));
  expect(planEntry, "买方必须保存同 Seed 下载计划").toBeDefined();
  const plan = JSON.parse(planEntry!.text) as {
    format: string; seedHashHex: string; blockHashesHex?: string[];
    blocks: Record<string, { state: string }>;
  };
  expect(plan.format).toBe("keymaster.bitfs-buyer-download-plan");
  expect(plan.seedHashHex).toBe(seedHashHex);
  const blockCount = plan.blockHashesHex?.length ?? 0;
  expect(blockCount, "集成测试文件至少要有两个完整批次").toBeGreaterThan(blocksPerBatch);
  expect(Object.values(plan.blocks).filter((block) => block.state === "completed")).toHaveLength(blockCount);
  const sessions = entries.filter((entry) => entry.path.includes("/bitfs-journal/sessions/"))
    .map((entry) => JSON.parse(entry.text) as { role: string; seedHashHex: string; evidence: string[] })
    .filter((session) => session.role === "buyer" && session.seedHashHex === seedHashHex);
  const count = (prefix: string) => sessions.reduce((total, session) =>
    total + session.evidence.filter((name) => name.startsWith(`${prefix}-`)).length, 0);
  const paymentRounds = count("kind5-content-request");
  const expectedRounds = 1 + Math.ceil(blockCount / blocksPerBatch); // Seed 独占一轮。
  expect(paymentRounds, "每批应尽量装满 10 个不同 Block，Seed 单独付款").toBe(expectedRounds);
  expect(count("kind6-content-delivery")).toBe(paymentRounds);
  expect(count("kind7-payment-update")).toBe(paymentRounds);
  return { blockCount, paymentRounds };
}

export async function assertBitfsDiagnosticsHealthy(page: Page): Promise<void> {
  const entries = await readRawLocalBucketObjects(page, "/bitfs-e2e-diagnostics/");
  const errors = entries.filter(entry => /(?:error|failure)\.json$/u.test(entry.path));
  expect(errors.map(entry => ({ path: entry.path, detail: entry.text })), "BitFS must have no runtime or protocol failures").toEqual([]);
}
