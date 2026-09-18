import { expect, type Page } from "@playwright/test";

/**
 * 读取首页「我的信息」里显示的当前公钥。
 *
 * 这是用户可见的身份真值：桶/Key 切换 Journey 一律以它为准，不通过
 * Worker 内部接口或测试替身判断切换结果。完整公钥在 `code[title]` 上，
 * 页面正文只展示短公钥。
 */
export async function readMyInfoPublicKey(page: Page): Promise<string> {
  // 不在首页时快速失败，调用方通常会在 poll 里重试；避免默认 action
  // 超时把一次“还没导航回首页”拖成几十秒。
  await page.getByTestId("home-my-info-button").click({ timeout: 5_000 });
  const modal = page.getByTestId("home-my-info-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  const row = modal.locator(".home-actions__identity-row").filter({ hasText: /公钥|Public key/u });
  await expect(row, "我的信息必须显示公钥行").toHaveCount(1);
  const code = row.locator("code").first();
  await expect(code).not.toBeEmpty();
  const title = await code.getAttribute("title");
  expect(title, "我的信息必须提供完整公钥").toMatch(/^0[23][0-9a-f]{64}$/iu);
  await modal.getByRole("button", { name: /关闭我的信息|Close my info/iu }).click();
  await expect(modal).toBeHidden();
  return (title ?? "").toLowerCase();
}
