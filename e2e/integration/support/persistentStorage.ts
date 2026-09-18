// 浏览器 persistent-storage 授权的共享 E2E 帮助。
//
// Playwright 没有暴露 `persistent-storage` 这个 permission 名称，只能通过
// CDP 授予 Chromium 的 `durableStorage`；业务代码仍通过
// `navigator.storage.persisted()/persist()` 做真实校验。CDP Browser session
// 不能提前 detach，否则权限会随它结束被撤销。

import type { Page } from "@playwright/test";

export async function grantPersistentStorage(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("Persistent storage grant requires a Chromium browser");
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("Persistent storage grant requires a browser context");
  const origin = new URL(page.url()).origin;
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  if (!persisted) throw new Error("Chromium durableStorage permission was not applied");
  // 不 detach cdp：Chromium 会随 Browser CDP session 结束撤销该 context 的权限。
}
