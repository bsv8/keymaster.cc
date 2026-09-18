import { expect, type Page } from "@playwright/test";
import { waitForUnlockedHome } from "./appDriver.js";

/**
 * 顶栏「桶 → Keys」切换面板的页面操作。
 *
 * 交互规则（与产品一致）：
 *   - Local 桶没有桶密码：面板打开后 Keys 自动读取，点 Key 只验证
 *     Key 自己的密码。
 *   - S3 非当前桶有桶密码：必须先输入桶密码读取 Keys，再选 Key 输入
 *     Key 密码。
 *   - Key 密码验证失败或取消时当前环境不变；driver 只在成功后继续。
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openSwitcherPanel(page: Page) {
  await page.getByTestId("storage-switcher-trigger").click();
  const panel = page.locator(".storage-bucket-tree__panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function submitKeyPassword(page: Page, keyPassword: string): Promise<void> {
  const modal = page.getByTestId("storage-switcher-key-unlock");
  await expect(modal).toBeVisible();
  await modal.getByLabel(/Key 密码|Key password/iu).fill(keyPassword);
  await modal.getByRole("button", { name: /使用密码切换|Switch with password/iu }).click();
  // 切换成功 = 弹窗关闭并进入新 Key 的 home；失败时弹窗保留并显示错误。
  try {
    await expect(modal).toBeHidden({ timeout: 60_000 });
  } catch {
    const error = await modal.locator(".ui-field__error").first().textContent().catch(() => null);
    throw new Error(`切换 Key 未完成${error ? `：${error.trim()}` : "（弹窗未关闭，页面无错误文本）"}`);
  }
  await waitForUnlockedHome(page);
}

function bucketRow(panel: ReturnType<Page["locator"]>, bucketLabel: string) {
  return panel.locator(".storage-bucket-tree__bucket").filter({ hasText: bucketLabel });
}

/** 切到当前桶内的另一把 Key：只验证 Key 自己的密码。 */
export async function switchToCurrentBucketKey(
  page: Page,
  input: { readonly keyLabel: string; readonly keyPassword: string },
): Promise<void> {
  const panel = await openSwitcherPanel(page);
  await panel.locator(".storage-bucket-tree__keys")
    .getByRole("button", { name: new RegExp(escapeRegExp(input.keyLabel), "u") })
    .click();
  await submitKeyPassword(page, input.keyPassword);
}

/** 切到非当前 Local 桶的 Key：Local 无桶密码，面板会直接列出 Keys。 */
export async function switchToLocalBucketKey(
  page: Page,
  input: { readonly bucketLabel: string; readonly keyLabel: string; readonly keyPassword: string },
): Promise<void> {
  const panel = await openSwitcherPanel(page);
  const row = bucketRow(panel, input.bucketLabel);
  await expect(row).toHaveCount(1);
  const keyButton = row.locator(".storage-bucket-tree__keys")
    .getByRole("button", { name: new RegExp(escapeRegExp(input.keyLabel), "u") });
  // Local 桶的 Keys 由只读探测自动加载，给 S3/磁盘读取留出窗口。
  await expect(keyButton).toBeVisible({ timeout: 30_000 });
  await keyButton.click();
  await submitKeyPassword(page, input.keyPassword);
}

/** 切到非当前 S3 桶的 Key：先输入桶密码读取 Keys，再输入 Key 密码。 */
export async function switchToS3BucketKey(
  page: Page,
  input: {
    readonly bucketLabel: string;
    readonly bucketPassword: string;
    readonly keyLabel: string;
    readonly keyPassword: string;
  },
): Promise<void> {
  const panel = await openSwitcherPanel(page);
  const row = bucketRow(panel, input.bucketLabel);
  await expect(row).toHaveCount(1);
  // 面板已解锁过该桶时会直接列出 Keys；只有未解锁的 S3 桶才需要桶密码。
  const readKeys = row.getByRole("button", { name: /输入密码读取 Keys|Enter password to read Keys/iu });
  if ((await readKeys.count()) > 0) {
    await readKeys.click();
    const unlock = page.getByTestId("storage-switcher-bucket-unlock");
    await expect(unlock).toBeVisible();
    await unlock.getByLabel(/桶密码|Bucket password/iu).fill(input.bucketPassword);
    await unlock.getByRole("button", { name: /读取 Keys|Read Keys/iu }).click();
  }

  const keyButton = row.locator(".storage-bucket-tree__keys")
    .getByRole("button", { name: new RegExp(escapeRegExp(input.keyLabel), "u") });
  // 桶密码验证包含解密设备记录 + 真实 S3 keys/ 列表，给足远端读取预算。
  await expect(keyButton).toBeVisible({ timeout: 60_000 });
  await keyButton.click();
  await submitKeyPassword(page, input.keyPassword);
}

/** 通过切换面板的「管理」进入 /storage/buckets，不刷新页面。 */
export async function openBucketManagerFromSwitcher(page: Page): Promise<void> {
  await openSwitcherPanel(page);
  await page.getByTestId("storage-switcher-manage").click();
  await expect(page).toHaveURL(/\/storage\/buckets/u);
  await expect(page.getByTestId("storage-buckets")).toBeVisible();
}
