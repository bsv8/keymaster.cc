import { setupContactUriActions } from "./setupUriActions.js";
import { URI_ACTION_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { CONTACTS_PRESENCE_CHANNEL_CAPABILITY } from "@keymaster/contracts";
import { createInstanceRegistryService } from "@keymaster/runtime";
import { createContactPublicKeyActionRegistry } from "./registries/contactPublicKeyActionRegistry.js";
import { STORAGE_FILE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { bindContactsUi } from "./ContactsResourceContext.js";
import { OWNED_RESOURCE_ACCESS_CAPABILITY } from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
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
  ContactsPresenceReader,
  ContactsService,
  I18nPluginResources,
  VaultWalletState,
  SessionCoordinatorClient,
  PluginManifest,
  PluginSetup,
  ResourceRegistry,
  Contact
} from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import {
  CONTACTS_SERVICE_CAPABILITY,
  CONTACTS_PRESENCE_READER_CAPABILITY,
  CONTACTS_PICKER_CAPABILITY,
  CONTACTS_EDITOR_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import {
  VAULT_WALLET_STATE_CAPABILITY,
  CONTACTS_COORDINATOR_CONTROL_CAPABILITY,
  type ContactsCoordinatorControl,
} from "@keymaster/contracts";
import { ContactDetailPage } from "./ContactDetailPage.js";
import { ContactsEditor } from "./ContactsEditor.js";
import { ContactPicker } from "./ContactPicker.js";
import { ContactsPage } from "./ContactsPage.js";
import { RecentContactsWidget } from "./RecentContactsWidget.js";
import { createContactsService } from "./contactsService.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

/** Compatibility-free product names for the shared contract exports. */
export const CONTACTS_CAPABILITY = CONTACTS_SERVICE_CAPABILITY;
export const CONTACTS_PICKER = CONTACTS_PICKER_CAPABILITY;
export const CONTACTS_EDITOR = CONTACTS_EDITOR_CAPABILITY;

export const contactsResources: I18nPluginResources = {
  namespace: "contacts",
  resources: {
    en: {
      "contacts.uri.action": "View or save contact", "contacts.uri.loading": "Loading contact…", "contacts.uri.loadError": "Unable to load contact.", "contacts.uri.notSaved": "This contact is not saved yet.", "contacts.uri.edit": "Edit contact", "contacts.uri.save": "Save contact", "contacts.uri.done": "Done",
      "contacts.route.list": "Contacts",
      "contacts.route.detail": "Contact detail",
      "contacts.menu.list": "Contacts",
      "contacts.domain.label": "Contacts",
      "contacts.home.recent": "Recent contacts",
      "contacts.home.unavailable": "Contacts are temporarily unavailable for this session.",
      "contacts.crumb.tools": "Tools",
      "contacts.crumb.list": "Contacts",
      "contacts.page.title": "Contacts",
      "contacts.locked.title": "Wallet is locked",
      "contacts.locked.description": "Unlock to manage contacts again.",
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
      "contacts.uri.action": "查看或保存联系人", "contacts.uri.loading": "正在查询联系人…", "contacts.uri.loadError": "无法读取联系人。", "contacts.uri.notSaved": "该联系人尚未保存。", "contacts.uri.edit": "编辑联系人", "contacts.uri.save": "保存联系人", "contacts.uri.done": "完成",
      "contacts.route.list": "联系人",
      "contacts.route.detail": "联系人详情",
      "contacts.menu.list": "联系人",
      "contacts.domain.label": "联系人",
      "contacts.home.recent": "最近联系人",
      "contacts.home.unavailable": "当前会话暂时无法提供联系人服务。",
      "contacts.crumb.tools": "工具",
      "contacts.crumb.list": "联系人",
      "contacts.page.title": "联系人",
      "contacts.locked.title": "钱包已锁定",
      "contacts.locked.description": "解锁后可继续管理联系人。",
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

const contactsPluginDefinition = {
  id: "contacts",
  name: "Contacts",
  description: "联系人管理（按 key namespace 隔离，身份字段为 publicKeyHex）。",

  units: [
    {
      id: "contacts.window",
      runtime: "window-main",
      scopeKind: "owner-session",
      provides: [CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
        capabilityDescriptor(CONTACTS_CAPABILITY),
        capabilityDescriptor(CONTACTS_PICKER),
        capabilityDescriptor(CONTACTS_EDITOR),
        capabilityDescriptor(CONTACTS_PRESENCE_READER_CAPABILITY),
        capabilityDescriptor(CONTACTS_COORDINATOR_CONTROL_CAPABILITY),
      ],
      storage: CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook,
      dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "声明存储客户端及用途授权" },
      { capability: CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main", reason: "声明本插件的受限 Coordinator 连接" },
      { capability: RUNTIME_MESSAGE_BUS, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "UI 读取所属实例资源" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      { capability: URI_ACTION_REGISTRY_CAPABILITY, optional: true, reason: "注册公钥 URI 内部业务 UI" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "window-main", reason: "联系人按 key namespace 隔离" },
        { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册联系人页面" },
        { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "接入首页业务导航" },
      ]),
    },
    {
      id: "contacts.coordinator-worker",
      runtime: "shared-worker",
      scopeKind: "owner-session",
      storage: CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook,
      dependencies: defineRuntimeUnitDependencies([
        { capability: CONTACTS_PRESENCE_CHANNEL_CAPABILITY, sourceRuntime: "shared-worker", reason: "固定 Ping/Pong 在线探测 Channel" },
        { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "shared-worker", reason: "联系人地址簿的受限文件客户端" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "shared-worker", reason: "联系人所属钱包身份" },
        ]),
    },
  ],
  i18n: contactsResources,
  setup(ctx) {
  ctx.provide(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, createInstanceRegistryService(createContactPublicKeyActionRegistry(), CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, undefined, ctx.scope));

    const walletState = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const messageBus = ctx.capability(RUNTIME_MESSAGE_BUS);
    const coordinator = ctx.capability(CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(ctx.consumer, ctx.scope) as ContactsCoordinatorControl | undefined;
    if (!coordinator) throw new Error("Contacts Coordinator control is unavailable");
    ctx.provide(CONTACTS_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    // 页面侧只保留联系人 CRUD；Ping/Pong 与唯一后台任务均归 Coordinator Worker。
    const service = createContactsService({ walletState, messageBus, storage: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "address-book") });
    ctx.provide(CONTACTS_CAPABILITY, service);
    setupContactUriActions(ctx);
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    resources.register<Contact[], readonly string[]>({
      id: "contacts.list",
      scope: "active-key",
      key: (_args, context) => ["contacts.list", context.activePublicKeyHex ?? "none"],
      load: async () => service.listContacts(),
      subscribe: (_args, _context, invalidate) => {
        const offChange = service.onChange(invalidate);
        const offActive = walletState.subscribe(invalidate);
        return () => { offChange(); offActive(); };
      },
      invalidation: "immediate"
    });
    resources.register<Contact | undefined, readonly string[]>({
      id: "contacts.detail",
      scope: "active-key",
      key: (args, context) => ["contacts.detail", context.activePublicKeyHex ?? "none", args[0] ?? ""],
      load: async (args) => (await service.listContacts()).find((contact) => contact.publicKeyHex === args[0]),
      subscribe: (_args, _context, invalidate) => {
        const offChange = service.onChange(invalidate);
        const offActive = walletState.subscribe(invalidate);
        return () => { offChange(); offActive(); };
      },
      invalidation: "immediate"
    });
    const presenceReader: ContactsPresenceReader = {
      async snapshot() {
        ctx.scope.assertActive();
        const contacts = await service.listContacts();
        const result = await coordinator.contactsPresenceSnapshot();
        ctx.scope.assertActive();
        const snapshot = result.status === "ok" ? result.value : {};
        const presence: Record<string, ContactPresence> = {};
        for (const contact of contacts) {
          const publicKeyHex = contact.publicKeyHex.trim().toLowerCase();
          presence[publicKeyHex] = snapshot[publicKeyHex] ?? { publicKeyHex, state: "offline" };
        }
        return presence;
      },
      subscribe(invalidate) {
        ctx.scope.assertActive();
        const offChange = service.onChange(invalidate);
        const offActive = walletState.subscribe(invalidate);
        const offPresence = coordinator.subscribeTopic("contacts.presence", invalidate);
        const offSession = coordinator.subscribeTopic("session.state", invalidate);
        let disposed = false;
        let removeRevoke = () => {};
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          offChange(); offActive(); offPresence(); offSession(); removeRevoke();
        };
        removeRevoke = ctx.scope.onRevoke(dispose);
        return dispose;
      },
    };
    ctx.provide(CONTACTS_PRESENCE_READER_CAPABILITY, presenceReader);
    resources.register<ContactPresenceMap, readonly string[]>({
      id: "contacts.presence", scope: "active-key",
      key: (_args, context) => ["contacts.presence", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => context.activePublicKeyHex ? presenceReader.snapshot() : {},
      subscribe: (_args, _context, invalidate) => presenceReader.subscribe(invalidate),
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
    ctx.provide(CONTACTS_PICKER, bindContactsUi(ctx, ContactPicker));
    ctx.provide(CONTACTS_EDITOR, bindContactsUi(ctx, ContactsEditor));

    const actions = ctx.capability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
    resources.register({
      id: "contacts.public-key-actions",
      scope: "active-key",
      key: (_args, context) => ["contacts.public-key-actions", context.activePublicKeyHex ?? "none"],
      load: async () => actions.list(),
      subscribe: (_args, _context, invalidate) => actions.subscribe(invalidate),
      invalidation: "immediate",
    });
    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const List = bindContactsUi(ctx, ContactsPage);
    const Detail = bindContactsUi(ctx, ContactDetailPage);
    pages.view.register({ kind: "page", id: "contacts.list", path: "/contacts",
      label: { key: "contacts.route.list", fallback: "Contacts" }, render: () => createElement(List) });
    pages.view.register({ kind: "page", id: "contacts.detail", path: "/contacts/:id",
      label: { key: "contacts.route.detail", fallback: "Contact detail" }, render: location => createElement(Detail, { location }) });

    pages.view.register({ kind: "home", slot: "main", id: "contacts.recent", label: "contacts", space: { id: "contacts.shortcuts", label: { key: "contacts.domain.label", fallback: "Contacts" }, order: 500 }, order: 30, render: () => createElement(bindContactsUi(ctx, RecentContactsWidget)) });
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
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
    });

    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
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
          c = list.find((x) => x.publicKeyHex === id.toLowerCase());
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
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: contactsSetup, ...contactsPlugin } = contactsPluginDefinition;
export { contactsSetup, contactsPlugin };
