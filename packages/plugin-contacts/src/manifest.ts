// packages/plugin-contacts/src/manifest.ts
// 联系人插件：注册 contacts.service + 页面 + 菜单 + 首页 widget。
// 硬切换 008：联系人按 key namespace 隔离（keyScopedStorages + keyspace 依赖）。
//
// 硬切换 003：route / menu / home widget / breadcrumb 全部走 I18nText。

import type {
  BreadcrumbProvider,
  BreadcrumbRegistry,
  ContactsService,
  HomeRegistry,
  I18nPluginResources,
  KeyspaceService,
  MenuItem,
  MenuRegistry,
  PluginManifest,
  RouteRegistry
} from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { ContactDetailPage } from "./ContactDetailPage.js";
import { ContactPicker } from "./ContactPicker.js";
import { ContactsPage } from "./ContactsPage.js";
import { RecentContactsWidget } from "./RecentContactsWidget.js";
import { createContactsService } from "./contactsService.js";

export const CONTACTS_CAPABILITY = "contacts.service";
export const CONTACTS_PICKER = "contacts.picker";

const contactsResources: I18nPluginResources = {
  namespace: "contacts",
  resources: {
    en: {
      "contacts.route.list": "Contacts",
      "contacts.route.detail": "Contact detail",
      "contacts.menu.list": "Contacts",
      "contacts.home.recent": "Recent contacts",
      "contacts.crumb.tools": "Tools",
      "contacts.crumb.list": "Contacts",
      "contacts.page.title": "Contacts",
      "contacts.page.desc": "Manage frequently used contacts by address.",
      "contacts.page.empty.title": "No contacts yet",
      "contacts.page.empty.desc": "Click \"New\" in the top right to add one.",
      "contacts.page.noKey.title": "Pick a key",
      "contacts.page.noKey.desc": "Switch to any key from the topbar to manage contacts.",
      "contacts.page.col.name": "Name",
      "contacts.page.col.address": "Address",
      "contacts.page.col.tags": "Tags",
      "contacts.page.col.actions": "Actions",
      "contacts.page.action.edit": "Edit",
      "contacts.page.action.delete": "Delete",
      "contacts.page.action.new": "New",
      "contacts.modal.title.new": "New contact",
      "contacts.modal.title.edit": "Edit contact",
      "contacts.modal.label.name": "Name",
      "contacts.modal.label.address": "Address",
      "contacts.modal.label.note": "Note",
      "contacts.modal.label.tags": "Tags (comma-separated)",
      "contacts.modal.action.cancel": "Cancel",
      "contacts.modal.action.save": "Save",
      "contacts.modal.confirmDelete": "Delete ",
      "contacts.modal.dupAddress": "Address already exists: ",
      "contacts.modal.err.load": "Failed to load contacts",
      "contacts.modal.err.save": "Save failed",
      "contacts.modal.err.delete": "Delete failed",
      "contacts.detail.title": "Contacts",
      "contacts.detail.noKey.title": "Pick a key",
      "contacts.detail.noKey.desc": "Switch to any key to view contacts.",
      "contacts.detail.notFound.title": "Contact not found",
      "contacts.detail.notFound.desc": "It may have been deleted, or check the contact id.",
      "contacts.detail.tagsLabel": "Tags: ",
      "contacts.detail.tagsEmpty": "None",
      "contacts.empty.recent": "No contacts yet",
      "contacts.picker.label": "Contacts",
      "contacts.picker.placeholder": "Pick a contact"
    },
    "zh-CN": {
      "contacts.route.list": "联系人",
      "contacts.route.detail": "联系人详情",
      "contacts.menu.list": "联系人",
      "contacts.home.recent": "最近联系人",
      "contacts.crumb.tools": "工具",
      "contacts.crumb.list": "联系人",
      "contacts.page.title": "联系人",
      "contacts.page.desc": "按地址管理常用联系人。",
      "contacts.page.empty.title": "还没有联系人",
      "contacts.page.empty.desc": "点击右上角新增。",
      "contacts.page.noKey.title": "请选择一个 key",
      "contacts.page.noKey.desc": "在顶栏切换到任一 key 后即可管理联系人。",
      "contacts.page.col.name": "名称",
      "contacts.page.col.address": "地址",
      "contacts.page.col.tags": "标签",
      "contacts.page.col.actions": "操作",
      "contacts.page.action.edit": "编辑",
      "contacts.page.action.delete": "删除",
      "contacts.page.action.new": "新增",
      "contacts.modal.title.new": "新增联系人",
      "contacts.modal.title.edit": "编辑联系人",
      "contacts.modal.label.name": "名称",
      "contacts.modal.label.address": "地址",
      "contacts.modal.label.note": "备注",
      "contacts.modal.label.tags": "标签（逗号分隔）",
      "contacts.modal.action.cancel": "取消",
      "contacts.modal.action.save": "保存",
      "contacts.modal.confirmDelete": "删除 ",
      "contacts.modal.dupAddress": "地址已存在：",
      "contacts.modal.err.load": "联系人加载失败",
      "contacts.modal.err.save": "保存失败",
      "contacts.modal.err.delete": "删除失败",
      "contacts.detail.title": "联系人",
      "contacts.detail.noKey.title": "请选择一个 key",
      "contacts.detail.noKey.desc": "切到任一 key 后再查看联系人。",
      "contacts.detail.notFound.title": "未找到联系人",
      "contacts.detail.notFound.desc": "可能已被删除，或确认联系人 id 正确。",
      "contacts.detail.tagsLabel": "标签：",
      "contacts.detail.tagsEmpty": "无",
      "contacts.empty.recent": "还没有联系人",
      "contacts.picker.label": "联系人",
      "contacts.picker.placeholder": "选择联系人"
    }
  }
};

export const contactsPlugin: PluginManifest = {
  id: "contacts",
  name: "Contacts",
  description: "联系人管理（按 key namespace 隔离，地址在 namespace 内唯一）。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [CONTACTS_CAPABILITY, CONTACTS_PICKER],
    displayGroup: "business"
  },
  i18n: contactsResources,
  keyScopedStorages: [
    { storageId: "book", description: "当前 key 的联系人" }
  ],
  dependencies: [
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "联系人按 key namespace 隔离" }
  ],
  setup(ctx) {
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const service = createContactsService({ keyspace });
    ctx.provide<ContactsService>(CONTACTS_CAPABILITY, service);
    ctx.provide<(props: { value?: string; onChange: (a: string) => void }) => JSX.Element>(
      CONTACTS_PICKER,
      ContactPicker
    );

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "contacts.list",
      path: "/contacts",
      label: { key: "contacts.route.list", fallback: "Contacts" },
      component: ContactsPage,
      inMenu: true,
      menuGroup: "tools",
      order: 50,
      icon: "Users"
    });
    routes.register({
      id: "contacts.detail",
      path: "/contacts/:id",
      label: { key: "contacts.route.detail", fallback: "Contact detail" },
      component: ContactDetailPage,
      inMenu: false
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const item: MenuItem = {
      id: "menu.contacts",
      label: { key: "contacts.menu.list", fallback: "Contacts" },
      routeId: "contacts.list",
      group: "tools",
      order: 50,
      icon: "Users",
      visibleWhen: ({ unlocked }) => unlocked
    };
    menus.register(item);

    const home = ctx.get<HomeRegistry>("home.registry");
    home.register({
      id: "contacts.recent",
      title: { key: "contacts.home.recent", fallback: "Recent contacts" },
      component: RecentContactsWidget,
      order: 30,
      size: "sm",
      refreshHint: "realtime"
    });

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const crumbProvider: BreadcrumbProvider = {
      id: "contacts.crumbs",
      order: 300,
      match: (path) => path === "/contacts" || path.startsWith("/contacts/"),
      async resolve(path) {
        if (path === "/contacts") {
          return [
            { label: { key: "contacts.crumb.tools", fallback: "Tools" }, path: "/" },
            { label: { key: "contacts.crumb.list", fallback: "Contacts" } }
          ];
        }
        const id = path.split("/").filter(Boolean).pop() ?? "";
        const list = await service.listContacts();
        const c = list.find((x) => x.id === id);
        return [
          { label: { key: "contacts.crumb.tools", fallback: "Tools" }, path: "/" },
          { label: { key: "contacts.crumb.list", fallback: "Contacts" }, path: "/contacts" },
          { label: c?.name ?? id }
        ];
      }
    };
    breadcrumbs.register(crumbProvider);
    return () => {
      // 硬切换 001：contacts 业务 service 暂未显式 dispose。路由/菜单/面包屑
      // 由 host 回收；service 内部监听由 contacts 自身在 unbind 时清。
      service.dispose?.();
    };
  }
};
