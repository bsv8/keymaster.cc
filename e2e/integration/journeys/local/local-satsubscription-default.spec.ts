import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { lockWallet, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import { attachBrowserErrors } from "../../support/browserEvidence.js";
import { LOCAL_SATSUBSCRIPTION_DEFAULT_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_SATSUBSCRIPTION_DEFAULT_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_SATSUBSCRIPTION_DEFAULT_SCENARIO;

const PASSWORD = "local-satsub-default-e2e-password-123";

/**
 * 缺省供应商连接的是外部网关；网关不可达只属于外部资源状态，
 * 不是应用错误。其余 pageerror / console.error / worker error 一律算失败。
 */
function isExpectedExternalGatewayError(text: string): boolean {
  return /bsv8\.com|WebSocket|net::ERR_|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|Failed to fetch|TransportError|libp2p/iu.test(text);
}

/** i18n 缺 key 属于 debug 诊断：owner 资源登记/注销过渡期会出现，不是运行时故障。 */
function isI18nDiagnostic(text: string): boolean {
  return /\[i18n\] missing key/u.test(text);
}

interface StrictErrors {
  readonly unexpected: string[];
  readonly expectedExternal: string[];
  readonly diagnostics: string[];
}

function captureStrictErrors(page: Page, context: BrowserContext): StrictErrors {
  const unexpected: string[] = [];
  const expectedExternal: string[] = [];
  const diagnostics: string[] = [];
  const record = (source: string, text: string): void => {
    const entry = `${source}: ${text}`;
    if (isI18nDiagnostic(text)) diagnostics.push(entry);
    else if (isExpectedExternalGatewayError(text)) expectedExternal.push(entry);
    else unexpected.push(entry);
  };
  page.on("pageerror", (error) => record("pageerror", `${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    record(`console.${message.type()}`, message.text());
  });
  context.on("console", (message) => {
    if (message.page() === page) return;
    if (message.type() !== "error" && message.type() !== "warning") return;
    record("worker", message.text());
  });
  return { unexpected, expectedExternal, diagnostics };
}

async function expectLocked(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("heading", { name: /钱包已锁定|Wallet locked/u }),
    `${label} 必须回到锁定页并重新输入 Key 密码`,
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel(/密码|password/iu), `${label} 必须显示密码输入`).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: /Primary navigation|主导航/u }),
    `${label} 不得直接进入已解锁页面`,
  ).toHaveCount(0);
}

async function expectUnlocked(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("navigation", { name: /Primary navigation|主导航/u }),
    `${label} 应处于已解锁页面`,
  ).toBeVisible({ timeout: 20_000 });
}

/** 打开系统设置并断言缺省 bsv8 供应商可见（含默认标记）。 */
async function expectDefaultSupplierVisible(page: Page, label: string): Promise<void> {
  await openSettingsPage(page, {
    label: /^System$|^系统$/u,
    path: /\/settings\/system$/u,
    heading: /^System$|^系统$/u,
  });
  const settings = page.locator(".sat-subscription-settings");
  await expect(settings, `${label} 必须显示 SatSubscription 设置区`).toBeVisible({ timeout: 20_000 });
  await expect(settings, `${label} 必须显示缺省 bsv8 供应商`).toContainText("bsv8", { timeout: 20_000 });
  await expect(settings, `${label} 不得显示空供应商态`).not.toContainText(/尚未配置供应商|No suppliers configured/u);
}

async function reloadAndExpectLocked(page: Page, label: string): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectLocked(page, label);
}

async function attachStrictErrors(testInfo: TestInfo, errors: StrictErrors): Promise<void> {
  const lines = [
    errors.unexpected.length ? `未预期错误\n${errors.unexpected.join("\n")}` : "",
    errors.expectedExternal.length ? `外部网关连接错误（允许）\n${errors.expectedExternal.join("\n")}` : "",
    errors.diagnostics.length ? `i18n 诊断（允许）\n${errors.diagnostics.join("\n")}` : "",
  ].filter(Boolean);
  if (lines.length > 0) {
    await attachBrowserErrors(testInfo, { pageErrors: [], consoleErrors: [lines.join("\n\n")], workerErrors: [] });
  }
}

/**
 * 业务目标：
 * 缺省 SatSubscription 供应商在解锁后可用；刷新与多 tab 的安全边界符合产品契约。
 *
 * 边界：
 * - 单页面刷新必须回到锁定页；
 * - 多 tab 共享解锁（刷新不要求密码）；
 * - 任意 tab 手动锁定后所有 tab 都锁定。
 */
test(JOURNEY_ID + "：缺省 SatSubscription、刷新锁定与多 tab 共享解锁", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const errors = captureStrictErrors(page, context);
  let pageTwo: Page | undefined;

  try {
    await test.step("A 完成 Local 初始化并看到缺省供应商", async () => {
      await initializeNewLocalUser(
        { page },
        { bucketLabel: "缺省 Sat 供应商桶", keyLabel: "缺省 Sat 供应商 Key", password: PASSWORD },
      );
      await expectDefaultSupplierVisible(page, "初始化后 tab A");
    });

    await test.step("A 第一次刷新必须回到锁定页", async () => {
      await reloadAndExpectLocked(page, "tab A 第一次刷新");
      await unlockWalletInPlace(page, PASSWORD);
      await expectDefaultSupplierVisible(page, "tab A 第一次解锁");
    });

    await test.step("A 第二次刷新必须回到锁定页", async () => {
      await reloadAndExpectLocked(page, "tab A 第二次刷新");
      await unlockWalletInPlace(page, PASSWORD);
      await expectDefaultSupplierVisible(page, "tab A 第二次解锁");
    });

    await test.step("B 在 A 已解锁时打开：共享解锁且能看到缺省供应商", async () => {
      pageTwo = await context.newPage();
      await pageTwo.goto("/settings/system", { waitUntil: "domcontentloaded" });
      await expectUnlocked(pageTwo, "tab B 首次打开");
      await expectDefaultSupplierVisible(pageTwo, "tab B 首次打开");
    });

    await test.step("B 在场时 A 刷新：共享解锁，不缺省丢供应商", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectUnlocked(page, "tab A 在 B 在场时刷新");
      await expectDefaultSupplierVisible(page, "tab A 在 B 在场时刷新");
    });

    await test.step("A 在场时 B 刷新：共享解锁，不缺省丢供应商", async () => {
      await pageTwo!.reload({ waitUntil: "domcontentloaded" });
      await expectUnlocked(pageTwo!, "tab B 刷新");
      await expectDefaultSupplierVisible(pageTwo!, "tab B 刷新");
    });

    await test.step("B 手动锁定：A、B 两个 tab 都必须锁定", async () => {
      await lockWallet(pageTwo!);
      await expectLocked(pageTwo!, "tab B 手动锁定");
      await expectLocked(page, "tab B 手动锁定后的 tab A");
    });

    await test.step("B 重新解锁：共享解锁恢复，两个 tab 都能看到缺省供应商", async () => {
      await unlockWalletInPlace(pageTwo!, PASSWORD);
      await expectUnlocked(pageTwo!, "tab B 重新解锁");
      await expectUnlocked(page, "tab B 重新解锁后的 tab A");
      await expectDefaultSupplierVisible(page, "tab B 重新解锁后的 tab A");
    });

    await test.step("从首页手动锁定：两个 tab 都锁定，首页组件不得崩溃", async () => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expectUnlocked(page, "tab A 回首页");
      await lockWallet(page);
      await expectLocked(page, "tab A 首页手动锁定");
      await expectLocked(pageTwo!, "tab A 首页手动锁定后的 tab B");
    });

    await test.step("从资产总览手动锁定：路由组件不得崩溃", async () => {
      await unlockWalletInPlace(pageTwo!, PASSWORD);
      await expectUnlocked(pageTwo!, "tab B 再解锁");
      await page.goto("/assets", { waitUntil: "domcontentloaded" });
      await expectUnlocked(page, "tab A 资产页");
      await lockWallet(page);
      await expectLocked(page, "tab A 资产页手动锁定");
      await expectLocked(pageTwo!, "tab A 资产页锁定后的 tab B");
    });

    await test.step("从 P2PKH 钱包页手动锁定：路由组件不得崩溃", async () => {
      await unlockWalletInPlace(pageTwo!, PASSWORD);
      await expectUnlocked(pageTwo!, "tab B 第三次解锁");
      await page.goto("/p2pkh/mainnet/transactions", { waitUntil: "domcontentloaded" });
      await expectUnlocked(page, "tab A P2PKH 钱包页");
      await lockWallet(page);
      await expectLocked(page, "tab A P2PKH 钱包页手动锁定");
      await expectLocked(pageTwo!, "tab A P2PKH 钱包页锁定后的 tab B");
    });
  } finally {
    await attachStrictErrors(testInfo, errors);
    await pageTwo?.close().catch(() => undefined);
  }

  expect(errors.unexpected, `出现未预期的页面/Worker 错误：\n${errors.unexpected.join("\n")}`).toEqual([]);
});
