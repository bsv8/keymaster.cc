import { expect, type Page } from "@playwright/test";

/**
 * 通过 business.registry 打开设置工作区。
 *
 * 设置页的业务入口由 manifest 注册，Driver 只处理可访问性定位和就绪
 * 屏障；Journey 不直接依赖侧栏的 DOM class 或内部 registry 实现。
 */
export async function openSettingsPage(
  page: Page,
  input: { readonly label: RegExp; readonly path: RegExp; readonly heading: RegExp },
): Promise<void> {
  const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/ });
  const settingsDomain = navigation
    .getByRole("heading", { name: /^Settings$|^设置$/ })
    .locator("..");
  await expect(settingsDomain).toBeVisible();
  await settingsDomain.getByRole("button", { name: input.label }).click();
  await expect(page).toHaveURL(input.path);
  await expect(page.getByRole("heading", { name: input.heading }).first()).toBeVisible();
}

/** 用户通过顶栏语言菜单切换语言，并确认界面语言立即更新。 */
export async function changeLanguage(page: Page, language: "en" | "zh-CN"): Promise<void> {
  await page.getByRole("button", { name: /Switch language|切换语言/u }).click();
  const optionName = language === "en" ? /^English$/u : /^(Simplified Chinese|简体中文)$/u;
  await page.getByRole("menuitemradio", { name: optionName }).click();
  await expect.poll(() => page.locator("html").getAttribute("lang")).toBe(language);
  // 语言偏好不再写 localStorage：跨客户端偏好由远端设置负责,当前只验证热切换。
}

/**
 * 读取设置工作区中可见的插件卡片数量。
 * data-plugin-id 是插件的业务身份，不是布局选择器；它只在 Driver 内
 * 使用，Journey 只接收“存在可管理插件”的业务结果。
 */
export async function countManagedPlugins(page: Page): Promise<number> {
  return page.locator("[data-plugin-id]").count();
}
