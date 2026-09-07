// KMP-001 / KMP-002：真实 Chromium 页面 -> SharedWorker -> MessagePort 服务桥。
// 测试使用临时浏览器上下文和临时 Vault，不接触真实付款、广播或生产私钥。

import { expect, test, type Page } from "@playwright/test";

const DEMO_APP_ORIGIN = "https://demo.apps.bsv8.com";
const EXTERNAL_APPVIEW_ORIGIN = process.env.KEYMASTER_EXTERNAL_APPVIEW_ORIGIN?.replace(/\/$/u, "");
const EXTERNAL_APPVIEW_SUCCESS_SELECTOR = process.env.KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR;
const DEMO_APP_IDENTITY = {
  app: {
    description: "Keymaster Connect V1 外部调用方 demo，验证 identity.get、intent.sign、cipher.encrypt、cipher.decrypt。",
    id: "keymaster-connect-demo",
    name: "Keymaster Connect Demo"
  },
  publisherPublicKey: "032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",
  requirements: ["private-key", "storage"],
  signature: "ac1d19a29d0ce1039f3f4ef4c3c8f6a2175c346a41e81837fa0f5b57e77880dc0d8198635bdbc137250c254cbe35486b2a859620273c5df4e839760a08736981",
  version: 1
} as const;

function isImmutableBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

/**
 * 一个最小的真实外部 App 页面：使用生产协议报文完成 appView
 * `ready -> connect.launch -> result`，不绕过 Session Window。
 * 页面由 Playwright 路由拦截提供，避免测试接触公网应用部署。
 */
function demoAppFixtureHtml(): string {
  const identity = JSON.stringify(DEMO_APP_IDENTITY);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect Demo E2E</title></head>
<body data-testid="appview-connect-launch" data-result="pending">
  <p id="result">pending</p>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const sessionWindowOrigin = params.get("sessionWindowOrigin");
      const launchToken = params.get("launchToken");
      const result = document.getElementById("result");
      const opener = window.opener;
      const requestId = "appview-production-e2e-launch";
      const identity = ${identity};
      const fail = (message) => {
        document.body.dataset.result = "error";
        result.textContent = message;
      };
      if (!sessionWindowOrigin || !launchToken || !opener) {
        fail("missing-appview-bootstrap");
        return;
      }
      window.addEventListener("message", (event) => {
        if (event.origin !== sessionWindowOrigin || event.source !== opener) return;
        const value = event.data;
        if (!value || value.v !== 1 || value.type !== "result" || value.id !== requestId) return;
        document.body.dataset.result = value.ok ? "ok" : "error";
        result.textContent = value.ok ? "ok" : String(value.error && value.error.code || "protocol-error");
      });
      opener.postMessage({ v: 1, type: "ready" }, sessionWindowOrigin);
      setTimeout(() => {
        opener.postMessage({
          v: 1,
          type: "request",
          id: requestId,
          method: "connect.launch",
          params: { launchToken, appIdentity: identity }
        }, sessionWindowOrigin);
      }, 0);
    })();
  </script>
</body></html>`;
}

interface LifecycleHooks {
  bootstrap(): Promise<{
    ownerPublicKeyHex: string;
    sessionEpoch: string;
    buildId: string;
    bridgeState: string;
    services: Array<{ capabilityId: string; providerInstanceId: string; status: string; hasServerGrant: boolean }>;
  }>;
  ownerStorageRoundTrip(): Promise<{ key: string; value: unknown; bridgeState: string; providerInstanceId: string }>;
  deriveAddress(): Promise<{ address: string; ownerPublicKeyHex: string; providerInstanceId: string }>;
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
    expect(evidence.storage.providerInstanceId).toBeTruthy();
    expect(evidence.crypto.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/u);
    expect(evidence.crypto.ownerPublicKeyHex).toHaveLength(66);
    expect(evidence.crypto.providerInstanceId).toBeTruthy();
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

  test("Playwright fixture /apps → Session Window → 外部 AppView 完成 connect.launch", async ({ page }) => {
    test.setTimeout(120_000);
    await page.context().route(`${DEMO_APP_ORIGIN}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: demoAppFixtureHtml()
      });
    });

    await lifecycleHooks(page);
    await page.evaluate(async () => window.__lifecycleProductionE2E!.bootstrap());
    // 保留同一生产 Host/Coordinator 会话，通过真实 SPA 路由进入 `/apps`；
    // 整页 reload 会关闭最后一个端口并让 SharedWorker 重启，不应把这条
    // AppView 交接验收和“冷启动无本地 Storage 选择”的另一个场景混在一起。
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
      { timeout: 60_000 }
    ).toBe(1);
    const sessionWindow = page.context().pages().find((candidate) => candidate.url().includes("/protocol/v1/popup?boot=appView"));
    if (!sessionWindow) throw new Error("Lifecycle E2E Session Window was not opened");
    await expect(sessionWindow.getByTestId("appview-done")).toBeVisible({ timeout: 60_000 });
    await sessionWindow.getByTestId("appview-open-app").click();

    await expect.poll(
      () => page.context().pages().filter((candidate) => candidate.url().startsWith(`${DEMO_APP_ORIGIN}/`)).length,
      { timeout: 60_000 }
    ).toBe(1);
    const appPage = page.context().pages().find((candidate) => candidate.url().startsWith(`${DEMO_APP_ORIGIN}/`));
    if (!appPage) throw new Error("Lifecycle E2E external AppView page was not opened");
    await expect(appPage.locator("body")).toHaveAttribute("data-result", "ok", { timeout: 60_000 });
    await expect(appPage.getByText("ok")).toBeVisible();
    expect(new URL(appPage.url()).searchParams.get("launchToken")).toBeTruthy();
    expect(new URL(appPage.url()).searchParams.get("sessionWindowOrigin")).toBe(new URL(page.url()).origin);
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
