// packages/contracts/src/contacts.ts
// 联系人契约：plugin-contacts 实现并通过 "contacts.service" 暴露。
//
// 硬切换 2026-07-09 002：
//   - 联系人 canonical 身份改为 publicKeyHex；
//   - 不再使用 address 作为联系人主键语义；
//   - 联系人归属由 key-scoped K-V 表达，不再在联系人行内存 owner 字段；
//   - 不做旧 address -> publicKeyHex 猜测迁移。

import { defineCapability } from "webloom-framework";
import type { I18nText } from "./i18n.js";

/** 联系人选择器的公共组件参数。 */
export interface ContactPickerProps {
  value?: string;
  onChange: (publicKeyHex: string) => void;
  placeholder?: string;
}

/** 联系人编辑器的公共组件参数。 */
export interface ContactsEditorProps {
  open: boolean;
  mode: "create" | "edit";
  publicKeyHex?: string;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
}

export type ContactPickerComponent = (props: ContactPickerProps) => import("react").ReactElement | null;
export type ContactsEditorComponent = (props: ContactsEditorProps) => import("react").ReactElement | null;

export const CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY = defineCapability<ContactPublicKeyActionRegistry>({
  kind: "local",
  id: "contacts.public-key-action.registry",
  version: "1",
});

export interface ContactPublicKeyActionInput {
  readonly publicKeyHex: string;
}

export interface ContactPublicKeyAction {
  readonly id: string;
  readonly label: I18nText;
  readonly icon?: string;
  readonly order: number;
  readonly run: (input: ContactPublicKeyActionInput) => void | Promise<void>;
}

export interface ContactPublicKeyActionRegistry {
  register(action: ContactPublicKeyAction): void;
  unregister(id: string): void;
  list(): ContactPublicKeyAction[];
  get(id: string): ContactPublicKeyAction | undefined;
  _ids(): string[];
}

/**
 * 联系人（内存投影）。
 *
 * 没有 id：canonical 身份就是 `publicKeyHex`，文件名与路由都用它
 * （见 KeymasterFormats《联系人文件》）。
 */
export interface Contact {
  /** 联系人身份：压缩公钥 hex（小写）。 */
  publicKeyHex: string;
  name: string;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 联系人文件格式标识与版本（`contacts/address-book/<公钥>.json`）。 */
export const CONTACT_FILE_FORMAT = "keymaster.contact";
export const CONTACT_FILE_VERSION = 1;
/** 联系人文件硬限制；与格式规范一致。 */
export const CONTACT_FILE_LIMITS = Object.freeze({
  /** 单个文件最多 16 KiB。 */
  maxBytes: 16 * 1024,
  /** 名称 1~128 字符。 */
  maxNameLength: 128,
  /** 备注最多 1024 字符；空字符串视为省略。 */
  maxNoteLength: 1024,
  /** 最多 32 个标签。 */
  maxTags: 32,
  /** 单个标签 1~64 字符。 */
  maxTagLength: 64,
});

/** 联系人输入。 */
export interface ContactInput {
  publicKeyHex: string;
  name: string;
  note?: string;
  tags?: string[];
}

/** 联系人错误。 */
export type ContactsError = "duplicate-publicKeyHex" | "not-found" | "validation";

/** 联系人在线状态；状态只由有效 Pong 与 TTL 推导，不写入联系人实体。 */
export type ContactPresenceState = "online" | "offline";

/** 联系人在线状态的内存投影。 */
export interface ContactPresence {
  /** 联系人压缩公钥 hex。 */
  publicKeyHex: string;
  /** 当前状态。未探测、超时、锁定、断线均为 offline。 */
  state: ContactPresenceState;
  /** 最近一次有效 Pong 的本地接收时间（Unix 毫秒）；没有则省略。 */
  lastPongAtMs?: number;
}

/** 当前 active key 下联系人在线状态的资源快照；不写入联系人实体。 */
export type ContactPresenceMap = Readonly<Record<string, ContactPresence>>;

/** 联系人服务。 */
export interface ContactsService {
  /** 新增；publicKeyHex 已存在时抛错。 */
  addContact(input: ContactInput): Promise<Contact>;
  /** 更新；`publicKeyHex` 是当前身份，`input.publicKeyHex` 变化时等价于改名（移动文件）。 */
  updateContact(publicKeyHex: string, input: ContactInput): Promise<Contact>;
  /** 删除；`publicKeyHex` 是 canonical 身份。 */
  removeContact(publicKeyHex: string): Promise<void>;
  /** 列出全部。 */
  listContacts(): Promise<Contact[]>;
  /** 按 publicKeyHex 查找。第一版约定 publicKeyHex 唯一。 */
  findByPublicKeyHex(publicKeyHex: string): Promise<Contact | undefined>;
  /** 批量按 publicKeyHex 查找。返回已命中的联系人。 */
  findByPublicKeyHexes(publicKeyHexes: string[]): Promise<Contact[]>;
  /** 订阅变化。 */
  onChange(handler: () => void): () => void;
  /** 获取内存在线状态；不会触发网络请求。 */
  getPresence?(publicKeyHex: string): ContactPresence;
  /** 订阅 Ping/Pong 在线状态变化。 */
  onPresenceChange?(handler: (presence: ContactPresence) => void): () => void;
  /** 仅 Coordinator 调用：记录已完成关系校验的 Pong，不再由 Contacts 二次解析/关联。 */
  recordVerifiedPong?(input: { contactPublicKeyHex: string; receivedAtMs?: number }): void;
  /** 启动一轮有界 Ping 探测；由后台任务调用。 */
  probePresence?(input?: { signal?: AbortSignal }): Promise<void>;
  /** 清除当前 owner 的内存在线证据，并通知 presence resource。 */
  resetPresence?(): void;
  /** 读取当前 owner 的在线状态快照；只读内存证据与本地联系人 K-V，不触发网络。 */
  getPresenceSnapshot?(): Promise<ContactPresenceMap>;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}

/** 联系人服务的唯一 typed capability 身份。 */
export const CONTACTS_SERVICE_CAPABILITY = defineCapability<ContactsService>({
  kind: "local",
  id: "contacts.service",
  version: "1",
});

/** 联系人选择器 capability。 */
export const CONTACTS_PICKER_CAPABILITY = defineCapability<ContactPickerComponent>({
  kind: "local",
  id: "contacts.picker",
  version: "1",
});

/** 联系人编辑器 capability。 */
export const CONTACTS_EDITOR_CAPABILITY = defineCapability<ContactsEditorComponent>({
  kind: "local",
  id: "contacts.editor",
  version: "1",
});
