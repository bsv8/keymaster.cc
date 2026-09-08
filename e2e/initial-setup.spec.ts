import { expect, test, type Page } from "@playwright/test";

const SETUP_PASSWORD = "setup-password-123";

/** 走完首次设置的 Local 桶阶段，停在“第一把 Key”选择页。 */
async function prepareLocalBucket(page: Page, bucketName: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /Local/ }).click();
  await page.getByLabel(/Bucket name|桶名称/).fill(bucketName);
  await page.getByRole("button", { name: /Next|继续/ }).click();
  await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/).fill(SETUP_PASSWORD);
  await page.getByLabel(/Confirm password|确认密码/).fill(SETUP_PASSWORD);
  await page.getByRole("button", { name: /Save and continue|保存并继续/ }).click();
  await expect(page.getByRole("heading", { name: /Set up your first Key|设置第一把 Key/ })).toBeVisible();
}

test("initial setup creates exactly one generated Key and opens Key management", async ({ page }) => {
  await prepareLocalBucket(page, "Generated E2E bucket");

  await page.getByRole("button", { name: /Create a Key|新建 Key/ }).click();
  await page.getByLabel(/Tag Name/).fill("Generated E2E Key");
  await page.getByRole("button", { name: /Create and open Key management|创建并进入 Key 管理/ }).click();

  await expect(page).toHaveURL(/\/settings\/vault$/);
  await expect(page.getByText("Generated E2E Key", { exact: true })).toBeVisible();
});

test("initial setup imports one Hex Key with the setup password and opens Key management", async ({ page }) => {
  await prepareLocalBucket(page, "Imported E2E bucket");

  await page.getByRole("button", { name: /Import a Key|导入 Key/ }).click();
  await page.getByRole("button", { name: /Hex/ }).click();
  await page.getByRole("button", { name: /Next|下一步/ }).click();
  await page.getByLabel(/Text|文本/).fill("0000000000000000000000000000000000000000000000000000000000000001");
  await page.getByRole("button", { name: /Parse|解析/ }).click();
  await page.getByLabel(/Label|标签/).fill("Imported E2E Key");
  await page.getByRole("button", { name: /Create Vault and import|创建 Vault 并导入/ }).click();

  await expect(page).toHaveURL(/\/settings\/vault$/);
  await expect(page.getByText("Imported E2E Key", { exact: true })).toBeVisible();
});
