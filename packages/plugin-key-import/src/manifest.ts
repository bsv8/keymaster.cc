// packages/plugin-key-import/src/manifest.ts
// key-import 是导入平台：注册 /import 页面、菜单、面包屑。
// 具体格式由 importer-* 插件通过 importer.registry 接入。
//
// 硬切换 003：route / menu / breadcrumb 走 I18nText。

import type {
  BreadcrumbProvider,
  BreadcrumbRegistry,
  I18nPluginResources,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { ImportPage } from "./ImportPage.js";

export const KEY_IMPORT_CAPABILITY = "key-import.platform";

const keyImportResources: I18nPluginResources = {
  namespace: "keyImport",
  resources: {
    en: {
      "keyImport.route.title": "Import a key",
      "keyImport.menu.title": "Import",
      "keyImport.crumb.wallet": "Wallets",
      "keyImport.crumb.title": "Import a key",
      "keyImport.page.title": "Import a key",
      "keyImport.page.desc": "Pick an import format; the platform never reads your private key directly. Keys are always stored encrypted by the Vault.",
      "keyImport.page.step.picker": "1. Pick an import format",
      "keyImport.page.step.input": "2. Input",
      "keyImport.page.step.confirm": "3. Confirm and import",
      "keyImport.page.label.text": "Text",
      "keyImport.page.placeholder.text": "Paste WIF or hex private key",
      "keyImport.page.label.file": "File",
      "keyImport.page.label.password": "Backup file password",
      "keyImport.page.placeholder.password": "Password for the encrypted JSON file",
      "keyImport.page.action.clear": "Clear",
      "keyImport.page.action.parse": "Parse",
      "keyImport.page.action.save": "Save to Vault",
      "keyImport.page.empty.title": "Waiting for parse",
      "keyImport.page.empty.desc": "After a successful parse, derived address and confirm button appear here.",
      "keyImport.page.detected": "Detected: ",
      "keyImport.page.derived": "Derived address: ",
      "keyImport.page.derivedPending": "Waiting for plugin to backfill",
      "keyImport.page.label.label": "Label",
      "keyImport.page.placeholder.label": "e.g. main wallet / cold wallet",
      "keyImport.page.err.noImporter": "Pick an import format first",
      "keyImport.page.err.noKey": "No private key parsed",
      "keyImport.page.err.parse": "Parse failed",
      "keyImport.page.err.save": "Save failed",
      "keyImport.page.filePicked": "Selected: ",
      "keyImport.picker.empty": "No import formats available.",
      "keyImport.page.label.supports": "Supports: "
    },
    "zh-CN": {
      "keyImport.route.title": "导入私钥",
      "keyImport.menu.title": "导入",
      "keyImport.crumb.wallet": "钱包",
      "keyImport.crumb.title": "导入私钥",
      "keyImport.page.title": "导入私钥",
      "keyImport.page.desc": "选择导入方式，平台不会直接读取你的私钥；私钥始终只通过 Vault 加密保存。",
      "keyImport.page.step.picker": "1. 选择导入方式",
      "keyImport.page.step.input": "2. 输入",
      "keyImport.page.step.confirm": "3. 确认导入",
      "keyImport.page.label.text": "文本",
      "keyImport.page.placeholder.text": "粘贴 WIF 或 hex 私钥",
      "keyImport.page.label.file": "文件",
      "keyImport.page.label.password": "备份文件密码",
      "keyImport.page.placeholder.password": "加密 JSON 文件的密码",
      "keyImport.page.action.clear": "清除",
      "keyImport.page.action.parse": "解析",
      "keyImport.page.action.save": "保存到 Vault",
      "keyImport.page.empty.title": "等待解析",
      "keyImport.page.empty.desc": "解析成功后这里会显示派生地址和确认按钮。",
      "keyImport.page.detected": "检测到：",
      "keyImport.page.derived": "派生地址：",
      "keyImport.page.derivedPending": "等待业务插件回填",
      "keyImport.page.label.label": "标签",
      "keyImport.page.placeholder.label": "例如 主钱包 / 冷钱包",
      "keyImport.page.err.noImporter": "请先选择导入方式",
      "keyImport.page.err.noKey": "未解析出私钥",
      "keyImport.page.err.parse": "解析失败",
      "keyImport.page.err.save": "保存失败",
      "keyImport.page.filePicked": "已选择：",
      "keyImport.picker.empty": "没有可用的导入器。",
      "keyImport.page.label.supports": "支持："
    }
  }
};

export const keyImportPlugin: PluginManifest = {
  id: "key-import",
  name: "Key Import",
  description: "统一导入平台：选择 importer、解析、调用 vault。",
  i18n: keyImportResources,
  dependencies: [
    { capability: "vault.service", reason: "导入私钥需要 vault 提供加解密" },
    { capability: "importer.registry", reason: "依赖 importer 注册表枚举导入器" }
  ],
  setup(ctx) {
    ctx.provide(KEY_IMPORT_CAPABILITY, { version: 1 });

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "key-import.page",
      path: "/import",
      label: { key: "keyImport.route.title", fallback: "Import a key" },
      component: ImportPage,
      inMenu: true,
      menuGroup: "wallets",
      order: 10,
      icon: "Download"
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.key-import",
      label: { key: "keyImport.menu.title", fallback: "Import" },
      routeId: "key-import.page",
      group: "wallets",
      order: 10,
      icon: "Download",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const provider: BreadcrumbProvider = {
      id: "key-import.crumbs",
      order: 100,
      match: (path) => path === "/import",
      resolve: () => [
        { label: { key: "keyImport.crumb.wallet", fallback: "Wallets" }, path: "/" },
        { label: { key: "keyImport.crumb.title", fallback: "Import a key" } }
      ]
    };
    breadcrumbs.register(provider);
  }
};
