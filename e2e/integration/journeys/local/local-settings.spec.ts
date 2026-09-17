import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import {
  changeLanguage,
  countManagedPlugins,
  openSettingsPage,
} from "../../drivers/settingsDriver.js";
import { reloadAndAssertSameKey, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { LOCAL_SETTINGS_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_SETTINGS_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_SETTINGS_SCENARIO;

/**
 * 业务目标：
 * 用户完成初始化后，通过正式菜单查看系统、应用、插件和系统状态设置，
 * 并切换一次界面语言。
 *
 * 用户价值：
 * 证明设置是由 registry 组成的真实工作区，而不是只在某个页面中存在的静态链接；
 * 用户的语言选择在刷新后仍然有效。
 *
 * 开始状态：
 * - 一个全新的 Chromium context；
 * - Local 桶、Vault 和 active Key 已在本场景前置 Flow 中一次性建立；
 * - 不读取 S3、testnet 或任何长期秘密。
 *
 * 成功标准：
 * - 四个正式设置入口都能从业务导航打开；
 * - 语言热切换同时更新 html lang 和持久化模式；
 * - 刷新后仍能进入设置工作区，并能读取插件状态和系统状态入口。
 *
 * 业务风险：
 * 如果菜单和页面不是同一个 registry 真值，用户可能看到入口却无法配置；
 * 如果语言只写入内存，刷新后会丢失用户选择；如果插件依赖状态异常，设置页不应假装可用。
 *
 * 外部资源与收尾：
 * 只使用本次浏览器 context 的 Local 数据；context 关闭后自动丢弃，不产生远端副作用。
 *
 * 覆盖需求：KM-NAV-001、KM-SETTINGS-001。
 */
test(JOURNEY_ID + "：从正式菜单查看设置并持久化语言", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const password = "settings-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);

  try {
    const ready = await test.step("用户先建立可继续使用的本地身份", async () => {
      return initializeNewLocalUser(
        { page },
        { bucketLabel: "设置集成测试桶", keyLabel: "设置测试首 Key", password },
      );
    });

    await test.step("用户在系统设置中切换界面语言", async () => {
      await openSettingsPage(page, {
        label: /^System$|^系统$/,
        path: /\/settings\/system$/u,
        heading: /^System$|^系统$/,
      });
      const current = await page.locator("html").getAttribute("lang");
      const next = current === "zh-CN" ? "en" : "zh-CN";
      await changeLanguage(page, next);
      // 页面刷新会按安全契约撤销 Window runtime 并回到已有桶认证页；先验证
      // html/lang 的持久化结果，再按真实恢复 Flow 解锁，不能把“刷新后仍
      // 假设 unlocked”当作设置页的成功条件。
      await reloadAndAssertSameKey(page, ready.keyLabel);
      await unlockWalletInPlace(page, password);
      await expect(page.locator("html")).toHaveAttribute("lang", next);
      await expect(page.getByRole("navigation", { name: /Primary navigation|主导航/ })).toBeVisible();
    });

    await test.step("用户通过菜单查看应用和插件配置入口", async () => {
      await openSettingsPage(page, {
        label: /^Application settings$|^应用设置$/,
        path: /\/settings\/apps$/u,
        heading: /^Application settings$|^应用设置$/,
      });
      await openSettingsPage(page, {
        label: /^Plugin settings$|^Plugins$|^插件设置$|^插件$/,
        path: /\/settings\/plugins$/u,
        heading: /^Plugins$|^插件管理$/,
      });
      expect(await countManagedPlugins(page), "插件管理页必须由正式运行时提供可观察的插件状态").toBeGreaterThan(0);
    });

    await test.step("用户查看系统状态，而不是进入孤立配置页", async () => {
      await openSettingsPage(page, {
        label: /^System status$|^系统状态$/,
        path: /\/settings\/system-status$/u,
        heading: /^System status$|^系统状态$/,
      });
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
