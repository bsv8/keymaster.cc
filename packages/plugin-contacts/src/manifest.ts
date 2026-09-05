// packages/plugin-contacts/src/manifest.ts
// 联系人插件：注册 contacts.service + 页面 + 菜单 + 首页 widget。
// 硬切换：联系人按 owner/App K-V namespace 隔离。
//
// 硬切换 003：route / menu / home widget / breadcrumb 全部走 I18nText。

import type {
  BusinessFeatureRegistry,
  BreadcrumbProvider,
  BreadcrumbRegistry,
  ContactPresence,
  ContactPresenceMap,
  ContactsService,
  I18nPluginResources,
  KeyspaceService,
  MessageBus,
  SessionCoordinatorClient,
  PluginManifest,
  ResourceRegistry,
  RouteRegistry,
  Contact
} from "@keymaster/contracts";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  CONTACTS_COORDINATOR_CONTROL_CAPABILITY,
  type ContactsCoordinatorControl,
} from "@keymaster/contracts";
import { ContactDetailPage } from "./ContactDetailPage.js";
import { ContactsEditor } from "./ContactsEditor.js";
import { ContactPicker } from "./ContactPicker.js";
import { ContactsPage } from "./ContactsPage.js";
import { RecentContactsWidget } from "./RecentContactsWidget.js";
import { createContactsService } from "./contactsService.js";
import { CONTACTS_SCHEMA_VERSION, CONTACTS_STORAGE_ID } from "./storage/contactsRepository.js";

export const CONTACTS_CAPABILITY = "contacts.service";
export const CONTACTS_PICKER = "contacts.picker";
export const CONTACTS_EDITOR = "contacts.editor";

export const contactsResources: I18nPluginResources = {
  namespace: "contacts",
  resources: {
    en: {
      "contacts.route.list": "Contacts",
      "contacts.route.detail": "Contact detail",
      "contacts.menu.list": "Contacts",
      "contacts.domain.label": "Contacts",
      "contacts.home.recent": "Recent contacts",
      "contacts.crumb.tools": "Tools",
      "contacts.crumb.list": "Contacts",
      "contacts.page.title": "Contacts",
      "contacts.page.desc": "Manage frequently used contacts by publicKeyHex.",
      "contacts.page.empty.title": "No contacts yet",
      "contacts.page.empty.desc": "Click \"New\" in the top right to add one.",
      "contacts.page.noKey.title": "Pick a key",
      "contacts.page.noKey.desc": "Switch to any key from the topbar to manage contacts.",
      "contacts.page.err.load": "Failed to load contacts",
      "contacts.page.confirmDelete": "Delete ",
      "contacts.page.err.delete": "Delete failed",
      "contacts.page.col.name": "Name",
      "contacts.page.col.publicKeyHex": "Public key",
      "contacts.page.col.tags": "Tags",
      "contacts.page.col.presence": "Status",
      "contacts.presence.online": "Online",
      "contacts.presence.offline": "Offline",
      "contacts.page.col.actions": "Actions",
      "contacts.page.action.edit": "Edit",
      "contacts.page.action.delete": "Delete",
      "contacts.page.actionFailed": "Action failed",
      "contacts.page.action.new": "New",
      "contacts.modal.title.new": "New contact",
      "contacts.modal.title.edit": "Edit contact",
      "contacts.modal.label.publicKeyHex": "Contact publicKeyHex",
      "contacts.modal.label.name": "Name",
      "contacts.modal.label.note": "Note",
      "contacts.modal.label.tags": "Tags (comma-separated)",
      "contacts.modal.action.cancel": "Cancel",
      "contacts.modal.action.save": "Save",
      "contacts.modal.confirmDelete": "Delete ",
      "contacts.modal.err.load": "Failed to load contacts",
      "contacts.modal.err.save": "Save failed",
      "contacts.modal.err.delete": "Delete failed",
      "contacts.editor.err.load": "Failed to load contact",
      "contacts.editor.err.notFound": "Contact not found",
      "contacts.editor.err.publicKeyHex": "publicKeyHex is required",
      "contacts.editor.err.name": "Name is required",
      "contacts.editor.err.duplicate": "Contact already exists: ",
      "contacts.editor.err.keyChanged": "Active key changed. Please reopen the editor.",
      "contacts.editor.err.save": "Save failed",
      "contacts.detail.title": "Contacts",
      "contacts.detail.desc": "Contact identity and saved details.",
      "contacts.detail.identity": "Identity",
      "contacts.detail.publicKeyHex": "Public key",
      "contacts.detail.details": "Contact details",
      "contacts.detail.note": "Note",
      "contacts.detail.noteEmpty": "No note added.",
      "contacts.detail.createdAt": "Created",
      "contacts.detail.updatedAt": "Last updated",
      "contacts.detail.noKey.title": "Pick a key",
      "contacts.detail.noKey.desc": "Switch to any key to view contacts.",
      "contacts.detail.notFound.title": "Contact not found",
      "contacts.detail.notFound.desc": "It may have been deleted, or check the contact id.",
      "contacts.detail.tagsLabel": "Tags: ",
      "contacts.detail.tagsEmpty": "None",
      "contacts.empty.recent": "No contacts yet",
      "contacts.picker.label": "Contacts",
      "contacts.picker.placeholder": "Pick a contact"
      ,"contacts.task.presence": "Contact presence probe"
      ,"contacts.task.presence.description": "Update contact online state with the fixed Ping/Pong protocol."
    },
    "zh-CN": {
      "contacts.route.list": "联系人",
      "contacts.route.detail": "联系人详情",
      "contacts.menu.list": "联系人",
      "contacts.domain.label": "联系人",
      "contacts.home.recent": "最近联系人",
      "contacts.crumb.tools": "工具",
      "contacts.crumb.list": "联系人",
      "contacts.page.title": "联系人",
      "contacts.page.desc": "按 publicKeyHex 管理常用联系人。",
      "contacts.page.empty.title": "还没有联系人",
      "contacts.page.empty.desc": "点击右上角新增。",
      "contacts.page.noKey.title": "请选择一个 key",
      "contacts.page.noKey.desc": "在顶栏切换到任一 key 后即可管理联系人。",
      "contacts.page.err.load": "联系人加载失败",
      "contacts.page.confirmDelete": "删除 ",
      "contacts.page.err.delete": "删除失败",
      "contacts.page.col.name": "名称",
      "contacts.page.col.publicKeyHex": "公钥",
      "contacts.page.col.tags": "标签",
      "contacts.page.col.presence": "状态",
      "contacts.presence.online": "在线",
      "contacts.presence.offline": "失联",
      "contacts.page.col.actions": "操作",
      "contacts.page.action.edit": "编辑",
      "contacts.page.action.delete": "删除",
      "contacts.page.actionFailed": "操作失败",
      "contacts.page.action.new": "新增",
      "contacts.modal.title.new": "新增联系人",
      "contacts.modal.title.edit": "编辑联系人",
      "contacts.modal.label.publicKeyHex": "联系人 publicKeyHex",
      "contacts.modal.label.name": "名称",
      "contacts.modal.label.note": "备注",
      "contacts.modal.label.tags": "标签（逗号分隔）",
      "contacts.modal.action.cancel": "取消",
      "contacts.modal.action.save": "保存",
      "contacts.modal.confirmDelete": "删除 ",
      "contacts.modal.err.load": "联系人加载失败",
      "contacts.modal.err.save": "保存失败",
      "contacts.modal.err.delete": "删除失败",
      "contacts.editor.err.load": "联系人加载失败",
      "contacts.editor.err.notFound": "未找到联系人",
      "contacts.editor.err.publicKeyHex": "publicKeyHex 不能为空",
      "contacts.editor.err.name": "名称不能为空",
      "contacts.editor.err.duplicate": "联系人已存在：",
      "contacts.editor.err.keyChanged": "active key 已切换，请重新打开编辑器。",
      "contacts.editor.err.save": "保存失败",
      "contacts.detail.title": "联系人",
      "contacts.detail.desc": "联系人身份与已保存的信息。",
      "contacts.detail.identity": "身份信息",
      "contacts.detail.publicKeyHex": "公钥",
      "contacts.detail.details": "联系人资料",
      "contacts.detail.note": "备注",
      "contacts.detail.noteEmpty": "暂无备注",
      "contacts.detail.createdAt": "创建时间",
      "contacts.detail.updatedAt": "最近更新",
      "contacts.detail.noKey.title": "请选择一个 key",
      "contacts.detail.noKey.desc": "切到任一 key 后再查看联系人。",
      "contacts.detail.notFound.title": "未找到联系人",
      "contacts.detail.notFound.desc": "可能已被删除，或确认联系人 id 正确。",
      "contacts.detail.tagsLabel": "标签：",
      "contacts.detail.tagsEmpty": "无",
      "contacts.empty.recent": "还没有联系人",
      "contacts.picker.label": "联系人",
      "contacts.picker.placeholder": "选择联系人"
      ,"contacts.task.presence": "联系人在线探测"
      ,"contacts.task.presence.description": "使用固定 Ping/Pong 协议更新联系人在线状态。"
    }
  }
};

export const contactsPlugin: PluginManifest = {
  id: "contacts",
  name: "Contacts",
  description: "联系人管理（按 key namespace 隔离，身份字段为 publicKeyHex）。",
  meta: {
    kind: "business",
    startup: "optional",
    bootstrapStage: "owner-apps-ready",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [CONTACTS_CAPABILITY, CONTACTS_PICKER, CONTACTS_EDITOR, CONTACTS_COORDINATOR_CONTROL_CAPABILITY],
    displayGroup: "business"
  },
  i18n: contactsResources,
  storage: {
    scope: "key",
    applicationStorageId: CONTACTS_STORAGE_ID,
    schemaVersion: CONTACTS_SCHEMA_VERSION
  },
  dependencies: [
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "联系人按 key namespace 隔离" },
    { capability: "route.registry", reason: "注册联系人页面" },
    { capability: "business.registry", reason: "接入首页业务导航" }
    ,{ capability: "contacts.public-key-action.registry", reason: "显示联系人公钥操作" }
  ],
  setup(ctx) {
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const messageBus = ctx.get<MessageBus>("runtime.messageBus");
    const coordinator = ctx.coordinator as ContactsCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Contacts Coordinator control is unavailable");
    ctx.provide(CONTACTS_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    // 页面侧只保留联系人 CRUD；Ping/Pong 与唯一后台任务均归 Coordinator Worker。
    const service = createContactsService({ keyspace, messageBus, storage: ctx.storage });
    ctx.provide<ContactsService>(CONTACTS_CAPABILITY, service);
    const resources = ctx.get<ResourceRegistry>("resource.registry");
    resources.register<Contact[], readonly string[]>({
      id: "contacts.list",
      scope: "active-key",
      key: (_args, context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => service.listContacts(),
      subscribe: (_args, _context, invalidate) => {
        const offChange = service.onChange(invalidate);
        const offActive = keyspace.onActiveKeyChanged(invalidate);
        return () => { offChange(); offActive(); };
      },
      invalidation: "immediate"
    });
    resources.register<Contact | undefined, readonly string[]>({
      id: "contacts.detail",
      scope: "active-key",
      key: (args, context) => ["contacts.detail", context.activePublicKeyHex ?? "none", args[0] ?? ""],
      load: async (args) => (await service.listContacts()).find((contact) => contact.id === args[0]),
      subscribe: (_args, _context, invalidate) => {
        const offChange = service.onChange(invalidate);
        const offActive = keyspace.onActiveKeyChanged(invalidate);
        return () => { offChange(); offActive(); };
      },
      invalidation: "immediate"
    });
    resources.register<ContactPresenceMap, readonly string[]>({
      id: "contacts.presence",
      scope: "active-key",
      key: (_args, context) => ["contacts.presence", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        if (!context.activePublicKeyHex) return {};
        const contacts = await service.listContacts();
        const snapshotResult = await coordinator.contactsPresenceSnapshot();
        const snapshot = snapshotResult.status === "ok" ? snapshotResult.value : {};
        const presence: Record<string, ContactPresence> = {};
        for (const contact of contacts) {
          const publicKeyHex = contact.publicKeyHex.trim().toLowerCase();
          presence[publicKeyHex] = snapshot[publicKeyHex] ?? { publicKeyHex, state: "offline" };
        }
        return presence;
      },
      subscribe: (_args, _context, invalidate) => {
        const offChange = service.onChange(invalidate);
        const offActive = keyspace.onActiveKeyChanged(invalidate);
        const offCoordinatorPresence = coordinator.subscribeTopic("contacts.presence", invalidate);
        const offSession = coordinator.subscribeTopic("session.state", invalidate);
        return () => { offChange(); offActive(); offCoordinatorPresence(); offSession(); };
      },
      equals: (previous, next) => {
        if (previous === next) return true;
        const previousKeys = Object.keys(previous ?? {});
        const nextKeys = Object.keys(next ?? {});
        if (previousKeys.length !== nextKeys.length) return false;
        return nextKeys.every((key) => {
          const before = previous?.[key];
          const after = next?.[key];
          return before?.publicKeyHex === after?.publicKeyHex
            && before?.state === after?.state
            && before?.lastPongAtMs === after?.lastPongAtMs;
        });
      },
      invalidation: "immediate"
    });
    ctx.provide<(props: { value?: string; onChange: (a: string) => void }) => JSX.Element>(
      CONTACTS_PICKER,
      ContactPicker
    );
    ctx.provide<typeof ContactsEditor>(CONTACTS_EDITOR, ContactsEditor);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "contacts.list",
      path: "/contacts",
      label: { key: "contacts.route.list", fallback: "Contacts" },
      component: ContactsPage
    });
    routes.register({
      id: "contacts.detail",
      path: "/contacts/:id",
      label: { key: "contacts.route.detail", fallback: "Contact detail" },
      component: ContactDetailPage
    });

    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    business.registerFeature("contacts", "home", {
      id: "home.contacts",
      label: { key: "contacts.route.list", fallback: "Contacts" },
      order: 60,
      icon: "Users",
      entry: {
        path: "/contacts",
        routeId: "contacts.list",
        visibleWhen: ({ unlocked }) => unlocked,
        activeWhen: (path) => path.startsWith("/contacts/")
      },
      home: [{ id: "contacts.recent", space: { id: "contacts.shortcuts", label: { key: "contacts.domain.label", fallback: "Contacts" }, order: 500 }, order: 30, component: RecentContactsWidget }]
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
        let c;
        try {
          const list = await service.listContacts();
          c = list.find((x) => x.id === id);
        } catch {
          c = undefined;
        }
        return [
          { label: { key: "contacts.crumb.tools", fallback: "Tools" }, path: "/" },
          { label: { key: "contacts.crumb.list", fallback: "Contacts" }, path: "/contacts" },
          { label: c?.name ?? id }
        ];
      }
    };
    breadcrumbs.register(crumbProvider);
    return () => {
      service.dispose?.();
    };
  }
};
