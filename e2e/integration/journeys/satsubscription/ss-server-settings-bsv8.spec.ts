import { expect, test, type Page } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import {
  queryServerBillingFirstPage,
  readBillingStatus,
  readSatSupplierConnectionLight,
  refreshRemoteSubscriptionsFromPage,
  refreshSpiBalanceFromPage,
  waitForSatSupplierConnectionLight,
  waitForSatSupplierConnectionState,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_SATSUB_DEFAULT_SETTINGS_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_SATSUB_DEFAULT_SETTINGS_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUB_DEFAULT_SETTINGS_SCENARIO;

/** 内置缺省供应商编号；与 plugin-sat-subscription 的 SAT_DEFAULT_SUPPLIER_ID 一致，不可改。 */
const DEFAULT_SUPPLIER_ID = "bsv8";
const LOCAL_PASSWORD = "real-bsv8-default-password-123";

/** 等绿（红绿灯 online），公网快闪时由调用方重试。 */
async function waitSupplierOnline(page: Page): Promise<void> {
  await waitForSatSupplierConnectionState(page, DEFAULT_SUPPLIER_ID, "online");
  await waitForSatSupplierConnectionLight(page, DEFAULT_SUPPLIER_ID, "online");
  expect(await readSatSupplierConnectionLight(page, DEFAULT_SUPPLIER_ID)).toBe("online");
}

/**
 * 快闪容忍：每次先等绿再执行查询动作，失败则重来，最多 3 次。
 * 只容忍瞬态失败，最终必须无 alert 且不断言放水。
 */
async function withOnlineRetry(page: Page, action: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitSupplierOnline(page);
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 业务目标：直连内置 bsv8 缺省网关（非本地 SS），验证缺省配置本身可用：
 * 红绿灯 online、刷新 SPI 余额、刷新远端订阅、查询服务器账单均正常。
 *
 * 开始状态：全新 Chromium context；用户通过真实 Local 页面建立全新
 * active Key（无资金、无账单）。preview 构建对应 mainnet 缺省网关。
 *
 * 成功标准：
 * - bsv8 卡片显示内置默认说明且无删除按钮，红绿灯 data-state=online；
 * - 刷新 SPI 后行内出现 BSV/mainnet 账户且无 role=alert；
 * - 刷新远端订阅后状态栏提示已刷新且无 alert；
 * - 查询账单第 1 页成功；全新 Key 账单为空（0 条、已是最后一页、
 *   上一页/下一页禁用）且无 alert。
 *
 * 安全边界：只做只读查询（SPI 信息、订阅列表、账单页），不启用接收、
 * 不发布、不充值；不断言、不触碰任何扣费路径。
 *
 * 外部资源与收尾：连接真实公网网关；关闭 context 后本地状态丢弃，
 * 连接由页面/Coordinator 生命周期收尾。
 *
 * 覆盖需求：KM-SATSUB-001。
 */
test(JOURNEY_ID + "：bsv8 缺省网关设置页三功能", async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  const browserErrors = captureBrowserErrors(page, context);

  try {
    await test.step("用户通过真实 Local 页面建立 active Key", async () => {
      await initializeNewLocalUser(
        { page },
        { bucketLabel: "缺省网关测试桶", keyLabel: "缺省网关测试 Key", password: LOCAL_PASSWORD },
      );
    });

    await test.step("打开系统设置并确认 bsv8 缺省卡片", async () => {
      await openSettingsPage(page, {
        label: /^System$|^系统$/u,
        path: /\/settings\/system$/u,
        heading: /^System$|^系统$/u,
      });
      const row = page.locator(`[data-supplier-id="${DEFAULT_SUPPLIER_ID}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(/内置默认 Supplier/u);
      await expect(row.getByRole("button", { name: /^删除$/u })).toHaveCount(0);
    });

    await test.step("缺省网关红绿灯变绿", async () => {
      await waitSupplierOnline(page);
    });

    await test.step("刷新 SPI 余额与远端订阅正常", async () => {
      // 公网网关偶发快闪（已知问题，保活只覆盖空闲超时）：等绿再点，
      // 失败则重回等绿，最多 3 次；最终状态必须干净。
      await withOnlineRetry(page, () => refreshSpiBalanceFromPage(page, DEFAULT_SUPPLIER_ID));
      const spiAccount = page.getByTestId(new RegExp(`^ss-spi-account-${DEFAULT_SUPPLIER_ID}-BSV-`));
      await expect(spiAccount.first()).toBeVisible({ timeout: 30_000 });
      await expect(spiAccount.first()).toContainText(/充值地址/u);
      await withOnlineRetry(page, () => refreshRemoteSubscriptionsFromPage(page, DEFAULT_SUPPLIER_ID));
    });

    await test.step("查询服务器账单（全新 Key 为空且翻页禁用）", async () => {
      await withOnlineRetry(page, () => queryServerBillingFirstPage(page, DEFAULT_SUPPLIER_ID));
      expect(await readBillingStatus(page, DEFAULT_SUPPLIER_ID)).toContain("第 1 页");
      const records = page.getByTestId(new RegExp(`^ss-billing-record-${DEFAULT_SUPPLIER_ID}-`));
      await expect(records).toHaveCount(0);
      expect(await readBillingStatus(page, DEFAULT_SUPPLIER_ID)).toContain("已是最后一页");
      const row = page.locator(`[data-supplier-id="${DEFAULT_SUPPLIER_ID}"]`);
      await expect(row.getByRole("button", { name: /上一页|Previous page/iu })).toBeDisabled();
      await expect(row.getByRole("button", { name: /下一页|Next page/iu })).toBeDisabled();
      await expect(page.locator(".sat-subscription-settings").getByRole("alert")).toHaveCount(0);
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [LOCAL_PASSWORD]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
