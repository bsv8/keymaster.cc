import { expect, type Page } from "@playwright/test";
import { waitForReadyVaultPage } from "./appDriver.js";

/** 用户主动锁定后，旧运行态必须收口到解锁入口。 */
export async function lockWallet(page: Page): Promise<void> {
  // 顶栏也有一个 aria-label=Lock；这里必须选择锁定页提供的完整
  // “Lock wallet/锁定钱包”动作，避免严格模式在两个语义相近按钮之间
  // 随机失败。
  await page.getByRole("button", { name: /^(Lock wallet|锁定钱包)$/u }).click();
  await expect.poll(() => page.getByRole("button", { name: /Unlock|解锁/ }).count(), {
    timeout: 15_000,
    message: "锁定后应出现解锁入口，旧 active runtime 不得继续作为可用页面",
  }).toBeGreaterThan(0);
}

/** 使用短期调用方持有的密码恢复同一把 Key。 */
export async function unlockWallet(page: Page, password: string, keyLabel: string): Promise<void> {
  await page.getByLabel(/Password|密码/).fill(password);
  // 锁定态只有一个提交按钮，而且空密码时它是 disabled；先填写短期密码，
  // 再提交，避免把“解锁入口”误当成可点击的导航按钮。
  await page.getByRole("button", { name: /Unlock|解锁/ }).click();
  await waitForReadyVaultPage(page, keyLabel);
}

/**
 * 在当前业务页解锁，不强行要求跳回 Key 管理页。
 *
 * 页面刷新会保留原来的 SPA path，但安全边界会先把 Window runtime 撤销并
 * 显示锁定壳；设置页、日志页等场景恢复后应留在原业务页，所以不能复用
 * 只适用于 `/settings/vault` 的 unlockWallet。
 */
export async function unlockWalletInPlace(page: Page, password: string): Promise<void> {
  await page.getByLabel(/Password|密码/).fill(password);
  await page.getByRole("button", { name: /Unlock|解锁/ }).click();
  await expect(page.getByRole("button", { name: /^(Lock wallet|Lock|锁定钱包|锁定)$/u })).toBeVisible({ timeout: 20_000 });
}

/** 刷新后确认冷态仍保留同一身份，再由调用方重新解锁。 */
export async function reloadAndAssertSameKey(page: Page, keyLabel: string): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Wallet locked|钱包已锁定/ })).toBeVisible();
  // 刷新会销毁 Window 运行态，这是安全边界；这里验证的是持久化 Key
  // 仍可从锁定页读回，而不是把“刷新后仍 unlocked”误当成契约。
  await expect(
    page.getByRole("region", { name: /Selected private key|当前选择的私钥/ })
      .getByText(keyLabel, { exact: false }),
  ).toBeVisible();
}
