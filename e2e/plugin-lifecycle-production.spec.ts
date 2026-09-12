// KMP-001 / KMP-002：真实 Chromium 页面 -> SharedWorker -> MessagePort 服务桥。
// 测试使用临时浏览器上下文和临时 Vault，不接触真实付款、广播或生产私钥。

import { expect, test, type Page } from "@playwright/test";

const EXTERNAL_APPVIEW_ORIGIN = process.env.KEYMASTER_EXTERNAL_APPVIEW_ORIGIN?.replace(/\/$/u, "");
const EXTERNAL_APPVIEW_SUCCESS_SELECTOR = process.env.KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR;

function isImmutableBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

interface LifecycleHooks {
  bootstrap(): Promise<{
    ownerPublicKeyHex: string;
    sessionEpoch: string;
    buildId: string;
    bridgeState: string;
    services: Array<{ capabilityId: string; serviceInstanceId: string; status: string; hasServerGrant: boolean }>;
  }>;
  ownerStorageRoundTrip(): Promise<{ key: string; value: unknown; bridgeState: string; serviceInstanceId: string }>;
  deriveAddress(): Promise<{ address: string; ownerPublicKeyHex: string; serviceInstanceId: string }>;
  lockRevokesOldProxy(): Promise<{
    lockStatus: string;
    unlockStatus: string;
    oldProxyErrorCode: string;
    oldProviderInstanceId: string;
    newProviderInstanceId: string;
    oldProxyRejected: boolean;
  }>;
  dedicatedWorkerRoundTrip(): Promise<{ address: string; signatureLength: number; revoked: boolean }>;
}

async function lifecycleHooks(page: Page): Promise<void> {
  await page.goto("/?lifecycleE2E=1", { waitUntil: "load" });
  await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined, undefined, { timeout: 30_000 });
}

async function grantPersistentStorage(page: Page): Promise<void> {
  // Chromium 的 Playwright API 没有暴露 persistent-storage 这个 Web
  // permission 名称；用 CDP 授予 durableStorage，模拟用户已允许 OPFS
  // 持久化，避免 E2E 受无头浏览器权限策略影响。业务代码仍通过
  // navigator.storage.persisted() 做真实校验。
  const browser = page.context().browser();
  if (!browser) throw new Error("Lifecycle E2E requires a Chromium browser");
  // 先让页面进入目标 origin；about:blank target 的权限状态不会可靠地
  // 反映到后续 SharedWorker。
  await page.goto("/?lifecyclePermission=1", { waitUntil: "domcontentloaded" });
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("Lifecycle E2E page browser context is unavailable");
  const localOrigin = new URL(page.url()).origin;
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: localOrigin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  if (!persisted) {
    await cdp.detach();
    throw new Error("Lifecycle E2E durableStorage permission was not applied");
  }
  // 不能在这里 detach：Chromium 会随 Browser CDP session 结束撤销该
  // context 的权限；测试结束时 Playwright 会统一关闭 Browser。
}

test.describe("插件生命周期生产跨环境链", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await grantPersistentStorage(page);
  });

  test("真实 SharedWorker/MessagePort 提供 owner K-V 与 crypto，并具备服务端 grant", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => {
      const hooks = window.__lifecycleProductionE2E!;
      const bootstrap = await hooks.bootstrap();
      const storage = await hooks.ownerStorageRoundTrip();
      const crypto = await hooks.deriveAddress();
      return { bootstrap, storage, crypto };
    });

    expect(evidence.bootstrap.bridgeState).toBe("ready");
    expect(evidence.bootstrap.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "coordinator.owner-storage", status: "ready", hasServerGrant: true }),
      expect.objectContaining({ capabilityId: "coordinator.crypto", status: "ready", hasServerGrant: true }),
    ]));
    expect(evidence.storage.value).toEqual({ source: "browser-shared-worker-message-port", ok: true });
    expect(evidence.storage.serviceInstanceId).toBeTruthy();
    expect(evidence.crypto.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/u);
    expect(evidence.crypto.ownerPublicKeyHex).toHaveLength(66);
    expect(evidence.crypto.serviceInstanceId).toBeTruthy();
  });

  test("锁屏立即拒绝旧代理，解锁后生成新的 Provider 实例", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => window.__lifecycleProductionE2E!.lockRevokesOldProxy());

    expect(evidence.lockStatus).toBe("accepted");
    expect(["accepted", "already-unlocked"]).toContain(evidence.unlockStatus);
    expect(evidence.oldProxyRejected).toBe(true);
    expect(evidence.oldProxyErrorCode).not.toBe("none");
    expect(evidence.oldProviderInstanceId).toBeTruthy();
    expect(evidence.newProviderInstanceId).toBeTruthy();
    expect(evidence.newProviderInstanceId).not.toBe(evidence.oldProviderInstanceId);
  });

  test("真实启动 Dedicated Worker 的 Session Crypto 并在 dispose 后撤权", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => window.__lifecycleProductionE2E!.dedicatedWorkerRoundTrip());

    expect(evidence.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/u);
    expect(evidence.signatureLength).toBeGreaterThan(0);
    expect(evidence.revoked).toBe(true);
  });

  test("已部署的外部 AppView 完成 connect.launch（发布门禁）", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      !EXTERNAL_APPVIEW_ORIGIN || !EXTERNAL_APPVIEW_SUCCESS_SELECTOR,
      "设置 KEYMASTER_EXTERNAL_APPVIEW_ORIGIN 和 KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR 后执行已部署 AppView 验收",
    );
    expect(isImmutableBuildId(process.env.KEYMASTER_DEPLOYED_BUILD_ID)).toBe(true);
    const origin = EXTERNAL_APPVIEW_ORIGIN!;
    await lifecycleHooks(page);
    const bootstrap = await page.evaluate(async () => window.__lifecycleProductionE2E!.bootstrap());
    expect(isImmutableBuildId(bootstrap.buildId)).toBe(true);
    expect(bootstrap.buildId).toBe(process.env.KEYMASTER_DEPLOYED_BUILD_ID);
    await page.evaluate(() => {
      window.history.pushState({}, "", "/apps");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByTestId("apps-card-demo")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("apps-open-demo").click();
    await expect(page.getByTestId("app-launch-modal")).toBeVisible();
    await page.getByLabel(/vault password/i).fill("lifecycle-production-e2e-password");
    await page.getByTestId("app-launch-confirm").click();

    await expect.poll(
      () => page.context().pages().filter((candidate) => candidate.url().includes("/protocol/v1/popup?boot=appView")).length,
      { timeout: 60_000 },
    ).toBe(1);
    const sessionWindow = page.context().pages().find((candidate) => candidate.url().includes("/protocol/v1/popup?boot=appView"));
    if (!sessionWindow) throw new Error("已部署 AppView 验收未打开 Session Window");
    await expect(sessionWindow.getByTestId("appview-done")).toBeVisible({ timeout: 60_000 });
    await sessionWindow.getByTestId("appview-open-app").click();

    await expect.poll(
      () => page.context().pages().filter((candidate) => candidate.url().startsWith(`${origin}/`)).length,
      { timeout: 60_000 },
    ).toBe(1);
    const appPage = page.context().pages().find((candidate) => candidate.url().startsWith(`${origin}/`));
    if (!appPage) throw new Error("已部署 AppView 页面未打开");
    await expect(appPage.locator(EXTERNAL_APPVIEW_SUCCESS_SELECTOR!)).toBeVisible({ timeout: 60_000 });
    expect(new URL(appPage.url()).searchParams.get("launchToken")).toBeTruthy();
    expect(new URL(appPage.url()).searchParams.get("sessionWindowOrigin")).toBe(new URL(page.url()).origin);
  });
});
