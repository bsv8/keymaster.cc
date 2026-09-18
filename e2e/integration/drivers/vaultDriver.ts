import { expect, type Page } from "@playwright/test";
import { waitForUnlockedHome } from "./appDriver.js";

/** 用户主动锁定后，旧运行态必须收口到解锁入口。 */
export async function lockWallet(page: Page): Promise<void> {
  // Key 管理页已删除后，页面级“Lock wallet”不存在；已解锁壳层只有
  // 顶栏一个 Lock 动作，直接用它。
  await page.getByRole("button", { name: /^(Lock|锁定)$/u }).click();
  await expect.poll(() => page.getByRole("button", { name: /Unlock|解锁/ }).count(), {
    timeout: 15_000,
    message: "锁定后应出现解锁入口，旧 active runtime 不得继续作为可用页面",
  }).toBeGreaterThan(0);
}

/** 使用短期调用方持有的密码恢复同一把 Key（真值由 session/文件校验负责）。 */
export async function unlockWallet(page: Page, password: string, keyLabel: string): Promise<void> {
  void keyLabel;
  await page.getByLabel(/密码|password/iu).fill(password);
  // 锁定态只有一个提交按钮，而且空密码时它是 disabled；先填写短期密码，
  // 再提交，避免把“解锁入口”误当成可点击的导航按钮。
  await page.getByRole("button", { name: /Unlock|解锁/ }).click();
  await waitForUnlockedHome(page);
}

/**
 * 在当前业务页解锁，不强行要求跳转任何业务页。
 *
 * 页面刷新会保留原来的 SPA path，但安全边界会先把 Window runtime 撤销并
 * 显示锁定壳；设置页、日志页等场景恢复后应留在原业务页，所以不能复用
 * 只适用于 `/settings/vault` 的 unlockWallet。
 */
export async function unlockWalletInPlace(page: Page, password: string): Promise<void> {
  await page.getByLabel(/密码|password/iu).fill(password);
  await page.getByRole("button", { name: /Unlock|解锁/ }).click();
  await expect(page.getByRole("button", { name: /^(Lock wallet|Lock|锁定钱包|锁定)$/u })).toBeVisible({ timeout: 20_000 });
}

/**
 * 刷新后确认冷启动进入锁定页，再由调用方重新解锁。
 *
 * local 桶没有启动密码：设备记录 + session 都在本机，刷新后直接回到
 * “钱包已锁定”；s3 桶才会先经过存储认证。
 */
export async function reloadAndAssertSameKey(page: Page, keyLabel: string): Promise<void> {
  void keyLabel;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Choose a bucket type|选择桶类型/ })).toHaveCount(0);
  await expect(page.getByLabel(/密码|password/iu)).toBeVisible();
}

/**
 * 在锁定壳里用 Key 密码解锁，并容忍 S3 冷启动的已知身份切换窗口。
 *
 * 已知产品待办：S3 冷启动解锁的第一条 session.state 可能落在窗口身份
 * 切换窗口内，RPC 已 accepted 但 UI 仍停在锁定壳。真实用户会再点一次
 * 解锁；自动化必须显式重放（有界一次），否则冒烟会随机失败。
 */
export async function unlockWalletWithReplay(page: Page, keyPassword: string): Promise<void> {
  const lockedHeading = page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ });
  // 已解锁后顶栏“Lock”与可能的页面级“Lock wallet”会同时匹配；这里只要求
  // 任意一个锁定入口出现，用 first() 避免 strict mode 冲突。
  const unlockedShellEntry = page.getByRole("button", { name: /^(Lock wallet|Lock|锁定钱包|锁定)$/u }).first();
  let reachedUnlocked = false;
  for (let attempt = 1; attempt <= 2 && !reachedUnlocked; attempt += 1) {
    await page.getByLabel(/Key password|密码|password/iu).fill(keyPassword);
    await page.getByRole("button", { name: /^Unlock$|^解锁$/u }).click();
    reachedUnlocked = await unlockedShellEntry.waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
    if (!reachedUnlocked) await expect(lockedHeading).toBeVisible({ timeout: 20_000 });
  }
  if (!reachedUnlocked) throw new Error("S3 解锁被接受后仍未进入已解锁壳层");
}

/**
 * S3 桶刷新恢复：设备记录被启动密码保护，所以先过存储认证页，再在锁定
 * 壳里输入该 Key 自己的密码；解锁完成的 UI 结果就是已解锁壳层本身。
 */
export async function reloadS3BucketAndUnlock(
  page: Page,
  startupPassword: string,
  keyPassword: string,
  keyLabel: string,
): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  const authHeading = page.getByTestId("storage-authentication").getByRole("heading", { name: /存储需要认证|Storage authentication required/ });
  const lockedHeading = page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ });
  await expect.poll(async () => (await authHeading.isVisible().catch(() => false)) || (await lockedHeading.isVisible().catch(() => false)), {
    timeout: 60_000,
    message: "S3 刷新后必须进入存储认证页或锁定页",
  }).toBe(true);
  if (await authHeading.isVisible().catch(() => false)) {
    const auth = page.getByTestId("storage-authentication");
    await auth.getByLabel(/密码|password/iu).fill(startupPassword);
    await auth.getByRole("button", { name: /^解锁$|^Unlock$/u }).click();
  }
  // 启动密码与 Key 密码是两个密码域：认证通过后仍要输入该 Key 的密码。
  await expect(lockedHeading).toBeVisible({ timeout: 90_000 });
  // 锁定壳出现不等于恢复完成：必须等当前 Key 已经从桶里读回并选中，
  // 否则自动化会在窗口会话尚未重新接管时提交解锁（真实用户的手速不会）。
  await expect(page.getByRole("heading", { name: /Selected private key|已选私钥/u })).toBeVisible({ timeout: 60_000 });
  await unlockWalletWithReplay(page, keyPassword);
  // Key 管理页已删除：解锁完成的 UI 结果就是已解锁壳层本身；
  // Key 的存在性与内容由调用方的 KeymasterFormats 文件真值校验负责。
  void keyLabel;
}
