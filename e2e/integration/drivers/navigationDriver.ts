import { expect, type Page } from "@playwright/test";

/**
 * 通过正式业务菜单执行 SPA 导航。
 *
 * 不能在已解锁场景中使用 page.goto()：那会触发页面销毁，Window 会在
 * pagehide/beforeunload 阶段主动撤销 Coordinator 会话，下一页按安全语义
 * 必须回到锁定态。这里验证用户真实可用的 business.registry 菜单入口，
 * 同时保留同一页面和同一运行态。
 */
export async function navigateToBusinessPage(
  page: Page,
  input: { readonly label: RegExp; readonly path: RegExp },
): Promise<void> {
  const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/ });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: input.label }).click();
  await expect(page).toHaveURL(input.path);
}
