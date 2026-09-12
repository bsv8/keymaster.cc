import { expect, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

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
  await navigateToBusinessPage(page, { label: input.label, path: input.path });
  await expect(page.getByRole("heading", { name: input.heading }).first()).toBeVisible();
}

/** 用户在系统设置中切换语言，并确认热更新与持久化结果同时成立。 */
export async function changeLanguage(page: Page, language: "en" | "zh-CN"): Promise<void> {
  // SystemSettingsPage 用 registry group id 作为业务 section id；这里按
  // 语言设置组找 combobox，避免依赖当前翻译文本是否被浏览器纳入 label 名称。
  const selector = page.locator("#language").getByRole("combobox");
  await expect(selector).toBeVisible();
  await selector.selectOption(language);
  await expect.poll(() => page.locator("html").getAttribute("lang")).toBe(language);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("keymaster.languageMode"))).toBe(language);
}

/**
 * 读取设置工作区中可见的插件卡片数量。
 * data-plugin-id 是插件的业务身份，不是布局选择器；它只在 Driver 内
 * 使用，Journey 只接收“存在可管理插件”的业务结果。
 */
export async function countManagedPlugins(page: Page): Promise<number> {
  return page.locator("[data-plugin-id]").count();
}
