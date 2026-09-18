import { expect, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

/** 进入消息首页；只确认消息业务入口已装配，不把网络连接伪装成就绪。 */
export async function openMessages(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Messages$|^消息$/,
    path: /\/messages$/,
  });
  await expect(page.getByRole("heading", { name: /Messages|消息/ })).toBeVisible();
}

/** 验证明显错误的身份在会话表单内失败，用户仍可继续修正。 */
export async function rejectInvalidNewChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Start a new chat|开始新对话/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/publicKeyHex/).fill("not-a-public-key");
  await dialog.getByRole("button", { name: /Go to chat|进入会话/ }).click();
  await expect(dialog.getByText(/Invalid publicKeyHex|无效/)).toBeVisible();
}

/** 用生产路由打开合法对端；成功只表示会话入口有效，不表示已完成远端收发。 */
export async function openNewChat(page: Page, peerPublicKeyHex: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Start a new chat|开始新对话/ }).click();
  }
  await dialog.getByLabel(/publicKeyHex/).fill(peerPublicKeyHex);
  await dialog.getByRole("button", { name: /Go to chat|进入会话/ }).click();
  await expect(page).toHaveURL(new RegExp(`/message/${peerPublicKeyHex}`));
  await expect(page.locator('[data-message-detail="ok"]')).toBeVisible();
}

/** 在已打开的会话详情页发送一条文本消息；不把点击当成远端已收到。 */
export async function sendChatMessage(page: Page, body: string): Promise<void> {
  const detail = page.locator('[data-message-detail="ok"]');
  await detail.getByLabel(/^Body$|^正文$/u).fill(body);
  await detail.getByRole("button", { name: /^Send$|^发送$/u }).click();
}

/** 等待会话详情页出现指定归属方向的消息气泡；超时说明本地历史没有该消息。 */
export async function expectChatMessageBubble(
  page: Page,
  body: string,
  direction: "me" | "peer",
  timeoutMs = 60_000,
): Promise<void> {
  await expect(
    page.locator(`.km-message-detail__bubble.is-${direction}`, { hasText: body }),
  ).toBeVisible({ timeout: timeoutMs });
}

/** 统计当前会话中包含指定正文的气泡数量，用于证明重复投递不会生成重复历史。 */
export async function countChatMessageBubbles(page: Page, body: string): Promise<number> {
  return page.locator(".km-message-detail__bubble", { hasText: body }).count();
}
