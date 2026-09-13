import { expect, test, type Page } from "@playwright/test";
import { DEPLOYMENT_APPVIEW_CONNECT_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = DEPLOYMENT_APPVIEW_CONNECT_SCENARIO.id;
export const JOURNEY_METADATA = DEPLOYMENT_APPVIEW_CONNECT_SCENARIO;

const TARGET_URL = process.env.KEYMASTER_E2E_DEPLOYMENT_BASE_URL;
const EXTERNAL_APPVIEW_ORIGIN = process.env.KEYMASTER_EXTERNAL_APPVIEW_ORIGIN?.replace(/\/$/u, "");
const EXTERNAL_APPVIEW_SUCCESS_SELECTOR = process.env.KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR;

/**
 * 外部 AppView Journey 只消费部署 hook 的 bootstrap 结果；用本文件的显式
 * 窄类型读取 Window，避免依赖生命周期 Gate spec 提供的 ambient 声明。
 */
interface ExternalAppViewLifecycleHooks {
  /** 返回部署构建身份和 Connect bridge 就绪状态。 */
  bootstrap(): Promise<{
    /** 部署系统注入的不可变 commit-sourceDigest 标识。 */
    buildId: string;
    /** Window 到 Coordinator 的正式 bridge 状态。 */
    bridgeState: string;
  }>;
}

/** 目标部署注入的测试 hook；类型只在本 Journey 内使用，不修改生产 Window。 */
type ExternalAppViewWindow = Window & {
  __lifecycleProductionE2E?: ExternalAppViewLifecycleHooks;
};

function isImmutableBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

async function grantPersistentStorage(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("部署 AppView Journey 需要 Chromium");
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("部署 AppView Journey 无法取得 Chromium context id");
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: new URL(page.url()).origin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  if (!(await page.evaluate(() => navigator.storage.persisted()))) {
    await cdp.detach();
    throw new Error("部署 AppView Journey 未获得 durableStorage 权限");
  }
}

/**
 * 业务目标：在指定不可变 Build ID 的目标部署中，从正式 Apps 菜单完成
 * connect.launch，并让外部 AppView 收到绑定 origin 的 session。
 *
 * 公开入口 Build ID smoke 与本测试共用部署执行档；本地 preview 的三条
 * Worker/锁屏技术证据属于 G-PLUGIN-LIFECYCLE-PRODUCTION，不在这里重复运行。
 */
test(JOURNEY_ID + "：已部署外部 AppView 完成 connect.launch", async ({ page }) => {
  test.setTimeout(180_000);
  if (!TARGET_URL) throw new Error("部署 Journey 必须设置 KEYMASTER_E2E_DEPLOYMENT_BASE_URL");
  if (!EXTERNAL_APPVIEW_ORIGIN) throw new Error("部署 Journey 必须设置 KEYMASTER_EXTERNAL_APPVIEW_ORIGIN");
  if (!EXTERNAL_APPVIEW_SUCCESS_SELECTOR) throw new Error("部署 Journey 必须设置 KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR");
  const target = new URL(TARGET_URL);
  if (!["http:", "https:"].includes(target.protocol) || ["localhost", "127.0.0.1", "::1"].includes(target.hostname)) {
    throw new Error("KEYMASTER_E2E_DEPLOYMENT_BASE_URL 必须是非本机 http(s) 部署地址");
  }
  const expectedBuildId = process.env.KEYMASTER_DEPLOYED_BUILD_ID;
  if (!isImmutableBuildId(expectedBuildId)) throw new Error("KEYMASTER_DEPLOYED_BUILD_ID 必须是不可变 commit-sourceDigest 标识");

  await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  await grantPersistentStorage(page);
  await expect.poll(() => page.evaluate(() => typeof (window as ExternalAppViewWindow).__lifecycleProductionE2E), {
    timeout: 60_000,
    message: "目标部署必须提供 connect.launch 验收所需的生命周期 hook",
  }).toBe("object");
  const bootstrap = await page.evaluate(async () => {
    const hooks = (window as ExternalAppViewWindow).__lifecycleProductionE2E;
    if (!hooks) throw new Error("目标部署未提供 connect.launch 生命周期 hook");
    return await hooks.bootstrap();
  });
  expect(isImmutableBuildId(bootstrap.buildId)).toBe(true);
  expect(bootstrap.buildId).toBe(expectedBuildId);
  expect(bootstrap.bridgeState).toBe("ready");

  await page.evaluate(() => {
    window.history.pushState({}, "", "/apps");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("apps-card-demo")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("apps-open-demo").click();
  await expect(page.getByTestId("app-launch-modal")).toBeVisible();
  await page.getByLabel(/vault password/i).fill("deployment-appview-e2e-password");
  await page.getByTestId("app-launch-confirm").click();

  await expect.poll(
    () => page.context().pages().filter((candidate) => candidate.url().includes("/protocol/v1/popup?boot=appView")).length,
    { timeout: 60_000 },
  ).toBe(1);
  const sessionWindow = page.context().pages().find((candidate) => candidate.url().includes("/protocol/v1/popup?boot=appView"));
  if (!sessionWindow) throw new Error("部署 AppView 验收未打开 Session Window");
  await expect(sessionWindow.getByTestId("appview-done")).toBeVisible({ timeout: 60_000 });
  await sessionWindow.getByTestId("appview-open-app").click();

  await expect.poll(
    () => page.context().pages().filter((candidate) => candidate.url().startsWith(`${EXTERNAL_APPVIEW_ORIGIN}/`)).length,
    { timeout: 60_000 },
  ).toBe(1);
  const appPage = page.context().pages().find((candidate) => candidate.url().startsWith(`${EXTERNAL_APPVIEW_ORIGIN}/`));
  if (!appPage) throw new Error("部署 AppView 页面未打开");
  await expect(appPage.locator(EXTERNAL_APPVIEW_SUCCESS_SELECTOR)).toBeVisible({ timeout: 60_000 });
  expect(new URL(appPage.url()).searchParams.get("launchToken")).toBeTruthy();
  expect(new URL(appPage.url()).searchParams.get("sessionWindowOrigin")).toBe(target.origin);
});
