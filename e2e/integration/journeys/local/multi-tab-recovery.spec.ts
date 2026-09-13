import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { reloadAndAssertSameKey } from "../../drivers/vaultDriver.js";
import { attachBrowserErrors } from "../../support/browserEvidence.js";
import { MULTI_TAB_RECOVERY_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = MULTI_TAB_RECOVERY_SCENARIO.id;
export const JOURNEY_METADATA = MULTI_TAB_RECOVERY_SCENARIO;

/**
 * 这个场景故意使用同一个 BrowserContext 创建两个真实页面。
 * localStorage、Web Locks 和 SharedWorker 因而处在同一个浏览器 origin，
 * 与用户在两个标签页之间切换的运行条件一致。
 */
function captureTabBrowserErrors(
  pageOne: Page,
  pageTwo: Page,
  context: BrowserContext,
): BrowserErrorEvidence {
  const evidence: { pageErrors: string[]; consoleErrors: string[]; workerErrors: string[] } = {
    pageErrors: [],
    consoleErrors: [],
    workerErrors: [],
  };

  pageOne.on("pageerror", (error) => evidence.pageErrors.push(`tab1 pageerror: ${error.name}: ${error.message}`));
  pageTwo.on("pageerror", (error) => evidence.pageErrors.push(`tab2 pageerror: ${error.name}: ${error.message}`));
  context.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const owner = message.page() === pageOne ? "tab1" : message.page() === pageTwo ? "tab2" : "worker";
    const target = owner === "worker" ? evidence.workerErrors : evidence.consoleErrors;
    target.push(`${owner} console.${message.type()}: ${message.text()}`);
  });
  return evidence;
}

/**
 * 刷新成功的业务结果是“进入锁定态并能看见同一把 Key”，不是保留旧的
 * unlocked Window runtime。这个断言同时排除启动 fatal 和带诊断的崩溃壳。
 */
async function expectLockedTab(page: Page, keyLabel: string, tabLabel: string): Promise<void> {
  await expect(
    page.getByRole("heading", { name: /Wallet locked|钱包已锁定/ }),
    `${tabLabel} 刷新后必须进入可恢复的锁定态`,
  ).toBeVisible({ timeout: 20_000 });
  const selectedKey = page.getByRole("region", { name: /Selected private key|当前选择的私钥/ })
    .getByText(keyLabel, { exact: false });
  await expect(selectedKey, `${tabLabel} 刷新后必须仍能读到同一把 Key`).toBeVisible();
  await expect(
    page.locator("[data-fatal-crash]"),
    `${tabLabel} 刷新不得进入 fatal crash 壳`,
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /启动.*运行失败/ }),
    `${tabLabel} 刷新不得显示启动/运行失败`,
  ).toHaveCount(0);
}

async function attachTabDiagnostic(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const details = page.locator("details").first();
  if (!(await details.isVisible().catch(() => false))) return;
  const summary = details.locator("summary");
  if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
  const diagnostic = await details.locator("pre").textContent().catch(() => null);
  if (diagnostic) {
    await testInfo.attach(name, { body: diagnostic, contentType: "text/plain" });
  }
}

/**
 * 真实浏览器回归：
 *
 * tab1 初始化 -> tab1 刷新 -> tab2 打开并刷新 -> 回到 tab1 再刷新。
 *
 * 之前的 local-initialization-smoke 只有一个 Page，无法证明旧页面的
 * SharedWorker peer 在新页面接管时正确撤权，也无法捕获“第二页刷新后把
 * 第一页刷新拖入失败”的顺序性问题。本测试保留单页 smoke，同时覆盖
 * 两个标签页共享 Local catalog/Worker 的真实生命周期。
 */
test(JOURNEY_ID + "：tab1→tab2→tab1 刷新后 Local 运行态可恢复", async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const pageTwo = await context.newPage();
  const browserErrors = captureTabBrowserErrors(page, pageTwo, context);
  const password = "multi-tab-refresh-e2e-password-123";

  try {
    const ready = await test.step("tab1 用户完成 Local 初始化", async () => initializeNewLocalUser(
      { page },
      { bucketLabel: "Multi-tab refresh E2E bucket", keyLabel: "Multi-tab refresh E2E Key", password },
    ));

    await test.step("tab1 首次刷新后恢复到锁定态", async () => {
      await reloadAndAssertSameKey(page, ready.keyLabel);
      await expectLockedTab(page, ready.keyLabel, "tab1");
    });

    await test.step("tab2 打开后刷新，仍使用同一个 Local catalog", async () => {
      await pageTwo.goto("/", { waitUntil: "domcontentloaded" });
      await expect(pageTwo).toHaveTitle("KeyMaster");
      await expectLockedTab(pageTwo, ready.keyLabel, "tab2 open");

      await pageTwo.reload({ waitUntil: "domcontentloaded" });
      await expectLockedTab(pageTwo, ready.keyLabel, "tab2");
    });

    await test.step("回到 tab1 再刷新，旧 tab2 peer 不得破坏恢复", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectLockedTab(page, ready.keyLabel, "tab1 second refresh");
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachTabDiagnostic(page, testInfo, "tab1-visible-diagnostic");
    await attachTabDiagnostic(pageTwo, testInfo, "tab2-visible-diagnostic");
    await pageTwo.close().catch(() => undefined);
  }
});
