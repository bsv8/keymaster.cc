// MSFile 真实页面 Driver：只通过正式设置页和首页文件入口操作。
//
// 定位集中在 Driver；Journey 只接收业务结果（供应商已连接、预览内容、
// 下载文件、没有文件、配置持久化）。这里不读取 Coordinator、K-V、transport
// 或任何 MSFile service 内部状态，也不注入协议替身。

import { expect, type Download, type Locator, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

export interface MsFileSupplierDraft {
  readonly name: string;
  readonly supplierPublicKeyHex: string;
  readonly addresses: readonly string[];
}

/** `/settings/system` 的 MSFile group；aria-label 是它的业务身份。 */
function msfileSettings(page: Page): Locator {
  return page.getByRole("region", { name: /^MSFile$/u });
}

/** 首页/路由共用的「通过 Seed 获取文件」模块。 */
function msfileHomeFile(page: Page): Locator {
  return page.getByRole("region", { name: /Get a file by Seed|通过 Seed 获取文件/ });
}

/** 打开正式 MSFile 文件入口；成功只表示页面就绪，不表示任何远端读取。 */
export async function openMsFileFilesPage(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Get a file by Seed$|^通过 Seed 获取文件$/u,
    path: /\/msfile\/files$/u,
  });
  await expect(page.getByRole("heading", { name: /Get a file by Seed|通过 Seed 获取文件/ })).toBeVisible();
}

/**
 * 保存全局 Seed/Block 金额上限。
 *
 * 读金额来自供应商；这里保存的是本机拒绝越界的上限。设置为正数可以证明
 * 免费/可获取内容不会被当成“未配置”而静默阻塞。
 */
export async function saveMsFilePriceLimits(
  page: Page,
  input: { readonly seedMaxPriceSatoshis: string; readonly blockMaxPriceSatoshis: string },
): Promise<void> {
  const settings = msfileSettings(page);
  await expect(settings.getByRole("heading", { name: /Price limits|价格限制/ })).toBeVisible();
  await settings.getByLabel(/Seed max price|Seed 单个最高金额/).first().fill(input.seedMaxPriceSatoshis);
  await settings.getByLabel(/Block max price|Block 单个最高金额/).first().fill(input.blockMaxPriceSatoshis);
  await settings.getByRole("button", { name: /Save price limits|保存价格限制/ }).click();
  await expect(settings.getByText(/Saved\.|已保存/).first()).toBeVisible();
}

/** 保存一个真实供应商；地址由 Resource 提供，Driver 不推导 PeerId。 */
export async function addMsFileSupplier(page: Page, supplier: MsFileSupplierDraft): Promise<void> {
  const settings = msfileSettings(page);
  await settings.getByLabel(/Display name|显示名称/).first().fill(supplier.name);
  await settings.getByLabel(/Supplier public key|供应商公钥/).first().fill(supplier.supplierPublicKeyHex);
  await settings.getByLabel(/Dialable addresses|可拨号地址/).first().fill(supplier.addresses.join("\n"));
  await settings.getByRole("button", { name: /Add supplier|新增供应商/ }).click();
  await expect(supplierRow(settings, supplier.name)).toBeVisible();
}

function supplierRow(settings: Locator, supplierName: string): Locator {
  return settings.locator("li").filter({ hasText: supplierName }).first();
}

/** 用正式 probe 验证协议协商；失败时保留供应商的错误文本。 */
export async function testMsFileSupplierConnection(page: Page, supplierName: string): Promise<void> {
  const row = supplierRow(msfileSettings(page), supplierName);
  await row.getByRole("button", { name: /Test connection|测试连接/ }).click();
  await expect(
    row.getByText(/Connected and protocol negotiated|连接成功且协议协商通过/),
    "真实供应商必须完成连接和协议协商，而不是只出现在列表里",
  ).toBeVisible({ timeout: 90_000 });
}

async function submitSeedHashQuery(page: Page, seedHashHex: string): Promise<void> {
  const widget = msfileHomeFile(page);
  await widget.getByLabel(/Seed Hash/).fill(seedHashHex);
  await widget.getByRole("button", { name: /Find file|查询文件/ }).click();
}

/**
 * 查询并按首页文本预览断言完整内容。
 *
 * 供应商状态必须先是“可获取”，随后 `<pre>` 的文本必须与 NAS 源文件
 * 完全一致；只看到文件名或进度条不算读取成功。
 */
export async function expectMsFileTextPreview(page: Page, seedHashHex: string, expectedText: string): Promise<void> {
  const widget = msfileHomeFile(page);
  await submitSeedHashQuery(page, seedHashHex);
  await expect(widget.getByText(/^Available$|^可获取$/u).first()).toBeVisible({ timeout: 120_000 });
  const preview = widget.getByLabel(/Text preview|文本预览/);
  await expect(preview).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => preview.textContent(), {
    timeout: 30_000,
    message: "文本预览必须与 NAS 源文件逐字节一致",
  }).toBe(expectedText);
}

/** 查询并完成一次浏览器下载；字节对账由 Journey 负责。 */
export async function downloadMsFileBySeedHash(page: Page, seedHashHex: string): Promise<Download> {
  const widget = msfileHomeFile(page);
  await submitSeedHashQuery(page, seedHashHex);
  const downloadButton = widget.getByRole("button", { name: /^Download$|^下载$/u });
  await expect(downloadButton).toBeVisible({ timeout: 120_000 });
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await downloadButton.click();
  return download;
}

/** 未知 Seed 必须只显示“没有文件”，且不出现任何下载入口。 */
export async function expectMsFileAbsent(page: Page, seedHashHex: string): Promise<void> {
  const widget = msfileHomeFile(page);
  await submitSeedHashQuery(page, seedHashHex);
  await expect(widget.getByText(/^No file$|^没有文件$/u)).toBeVisible({ timeout: 60_000 });
  await expect(widget.getByText(/This supplier does not have the file|该供应商没有此文件/)).toBeVisible();
  await expect(widget.getByRole("button", { name: /^Download$|^下载$/u })).toHaveCount(0);
}
