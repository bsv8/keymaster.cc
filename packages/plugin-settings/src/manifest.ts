// packages/plugin-settings/src/manifest.ts
// 设置页：注册 /settings 页面、菜单。

import type {
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { SettingsPage } from "./SettingsPage.js";

/** 设置 i18n 资源。设计缘由：route / menu / 设置项 label 全部走 I18nText，
 * 同时在 resources 中提供 settings.language.* 给语言设置区复用。 */
const settingsResources: I18nPluginResources = {
  namespace: "settings",
  resources: {
    en: {
      "settings.route.label": "Settings",
      "settings.menu.label": "Settings",
      "settings.page.title": "Settings",
      "settings.page.description": "Items from settings.registry.",
      "settings.field.boolean.yes": "Yes",
      "settings.field.boolean.no": "No",
      "settings.field.saved": "Saved",
      "settings.language.title": "Language",
      "settings.language.description": "Choose display language. Affects all UI text; switch is instant.",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "Simplified Chinese"
    },
    "zh-CN": {
      "settings.route.label": "设置",
      "settings.menu.label": "设置",
      "settings.page.title": "设置",
      "settings.page.description": "来自 settings.registry 的设置项。",
      "settings.field.boolean.yes": "是",
      "settings.field.boolean.no": "否",
      "settings.field.saved": "已保存",
      "settings.language.title": "语言",
      "settings.language.description": "选择界面显示语言，影响所有 UI 文案；切换立即生效。",
      "settings.language.option.en": "English",
      "settings.language.option.zh-CN": "简体中文"
    }
  }
};

export const settingsPlugin: PluginManifest = {
  id: "settings",
  name: "Settings",
  description: "设置页容器。",
  i18n: settingsResources,
  dependencies: [{ capability: "settings.registry", reason: "需要从注册表读取设置项" }],
  setup(ctx) {
    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "settings.page",
      path: "/settings",
      label: { key: "settings.route.label", fallback: "Settings" },
      component: SettingsPage,
      inMenu: true,
      menuGroup: "settings",
      order: 999,
      icon: "Settings"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.settings",
      label: { key: "settings.menu.label", fallback: "Settings" },
      routeId: "settings.page",
      group: "settings",
      order: 999,
      icon: "Settings",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);
  }
};
