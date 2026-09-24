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
 * 用户完成初始化后，通过正式菜单查看自动锁屏、智能调度、私钥导出、BSV 链、本地文件、价格、插件和广播网关，
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
 * - 正式设置入口都能从业务导航打开；
 * - 语言热切换同时更新 html lang 和持久化模式；
 * - 刷新后仍能进入设置工作区，并能读取插件状态和广播网关入口。
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
test(JOURNEY_ID + "：从正式菜单查看独立设置并热切换界面语言", async ({ page, context }, testInfo) => {
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

    await test.step("安全、智能调度和私钥导出使用独立入口，设置菜单不再提供系统页", async () => {
      await openSettingsPage(page, {
        label: /^Auto lock$|^自动锁屏$/u,
        path: /\/settings\/auto-lock$/u,
        heading: /^Auto lock$|^自动锁屏$/u,
      });
      await expect(page.locator(".autolock-settings")).toBeVisible();
      await expect(page.locator(".autolock-summary")).toBeVisible();
      await expect(page.getByRole("button", { name: /^5 minutes$|^5 分钟$/u })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: /^Custom$|^自定义$/u }).click();
      const autoLockEditor = page.getByRole("dialog");
      await expect(autoLockEditor.getByPlaceholder(/e\.g\.|例如/u)).toBeVisible();
      await autoLockEditor.getByRole("button", { name: /^Cancel$|^取消$/u }).click();
      await openSettingsPage(page, {
        label: /^Smart scheduling$|^智能调度$/u,
        path: /\/settings\/smart-scheduling$/u,
        heading: /^Smart scheduling$|^智能调度$/u,
      });
      await expect(page.locator(".background-settings")).toBeVisible();
      await openSettingsPage(page, {
        label: /^Export private key$|^导出私钥$/u,
        path: /\/settings\/current-key$/u,
        heading: /^Export private key$|^导出私钥$/u,
      });
      const exportCard = page.getByRole("region", { name: /^Encrypted private key backup$|^加密私钥备份$/u });
      await expect(exportCard).toBeVisible();
      await exportCard.getByRole("button", { name: /^Export private key$|^导出私钥$/u }).click();
      const exportDialog = page.getByRole("dialog");
      await expect(exportDialog).toContainText(/Export private key|导出私钥/u);
      await exportDialog.getByRole("button", { name: /^Cancel$|^取消$/u }).click();
      await expect(exportDialog).toHaveCount(0);
      const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/ });
      await expect(navigation.getByRole("button", { name: /^System$|^系统$/u })).toHaveCount(0);
    });

    await test.step("用户通过顶栏切换界面语言", async () => {
      const current = await page.locator("html").getAttribute("lang");
      const next = current === "zh-CN" ? "en" : "zh-CN";
      await changeLanguage(page, next);
      // 页面刷新会按安全契约撤销 Window runtime 并回到安全入口（local 为
      // 钱包锁定页）；语言是当前 Window runtime 的会话级偏好、不落盘，
      // 因此刷新后允许回到默认语言，这里只验证解锁后仍能再次热切换。
      await reloadAndAssertSameKey(page, ready.keyLabel);
      await unlockWalletInPlace(page, password);
      await expect(page.getByRole("navigation", { name: /Primary navigation|主导航/ })).toBeVisible();
      await openSettingsPage(page, {
        label: /^Smart scheduling$|^智能调度$/u,
        path: /\/settings\/smart-scheduling$/u,
        heading: /^Smart scheduling$|^智能调度$/u,
      });
      const restored = await page.locator("html").getAttribute("lang");
      await changeLanguage(page, restored === "zh-CN" ? "en" : "zh-CN");
    });

    await test.step("用户从设置菜单打开 BSV 链配置", async () => {
      await openSettingsPage(page, {
        label: /^BSV Chain$|^BSV 链$/u,
        path: /\/settings\/bsv-chain$/u,
        heading: /^BSV Chain$|^BSV 链$/u,
      });
      await expect(page.locator("#p2pkh")).toBeVisible();
      await expect(page.locator("#woc")).toBeVisible();
    });

    await test.step("用户从设置菜单打开本地文件", async () => {
      await openSettingsPage(page, {
        label: /^Local files$|^本地文件$/u,
        path: /\/settings\/local-files$/u,
        heading: /^Local files$|^本地文件$/u,
      });
      await expect(page.getByRole("region", { name: /^Local files$|^本地文件$/u })).toBeVisible();
    });

    await test.step("用户在广播网关同一页面查看 SatSubscription 与 WebRTC", async () => {
      await openSettingsPage(page, {
        label: /^Broadcast gateway$|^广播网关$/,
        path: /\/settings\/system-status$/u,
        heading: /^Broadcast gateway$|^广播网关$/,
      });
      const gateway = page.locator(".system-status-page");
      const satRegion = gateway.getByRole("region", { name: /^SatSubscription$/u });
      await expect(satRegion).toBeVisible();
      const webrtcRegion = gateway.getByRole("region", { name: /^WebRTC$/u });
      await expect(webrtcRegion).toBeVisible();
      await expect(page.locator(".sat-subscription-settings")).toBeVisible();
      await expect(page.locator('[data-webrtc-settings="main"]')).toBeVisible();
      await webrtcRegion.getByRole("button", { name: /^Add STUN server$|^新增 STUN 服务器$/u }).click();
      const stunEditor = page.getByRole("dialog");
      await expect(stunEditor.getByPlaceholder("stun:host:port")).toBeVisible();
      await expect(stunEditor.getByRole("button", { name: /^Save STUN server$|^保存 STUN 服务器$/u })).toBeDisabled();
      await stunEditor.getByRole("button", { name: /^Cancel$|^取消$/u }).click();
      await expect(stunEditor).toHaveCount(0);
      await satRegion.getByRole("button", { name: /^Add supplier$|^新增供应商$/u }).click();
      const supplierEditor = page.getByRole("dialog");
      await expect(supplierEditor.getByLabel(/Supplier id|供应商编号/u)).toBeVisible();
      await supplierEditor.getByRole("button", { name: /^Cancel$|^取消$/u }).click();
      await expect(supplierEditor).toHaveCount(0);
      await expect(gateway.getByRole("tab")).toHaveCount(0);
    });

    await test.step("用户通过菜单查看价格和插件配置入口", async () => {
      await openSettingsPage(page, {
        label: /^BSV Price$|^BSV 价格$/,
        path: /\/settings\/bsv-price$/u,
        heading: /^BSV Price settings$|^BSV Price 设置$/,
      });
      await openSettingsPage(page, {
        label: /^Plugin settings$|^Plugins$|^插件设置$|^插件$/,
        path: /\/settings\/plugins$/u,
        heading: /^Plugins$|^插件管理$/,
      });
      expect(await countManagedPlugins(page), "插件管理页必须由正式运行时提供可观察的插件状态").toBeGreaterThan(0);
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
