// packages/contracts/src/contacts.ts
// 联系人契约：plugin-contacts 实现并通过 "contacts.service" 暴露。
//
// 硬切换 2026-07-09 002：
//   - 联系人 canonical 身份改为 publicKeyHex；
//   - 不再使用 address 作为联系人主键语义；
//   - 联系人归属由 key-scoped K-V 表达，不再在联系人行内存 owner 字段；
//   - 不做旧 address -> publicKeyHex 猜测迁移。

import type { I18nText } from "./i18n.js";

export const CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY = "contacts.public-key-action.registry";

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

/** 联系人。 */
export interface Contact {
  id: string;
  /** 联系人身份：压缩公钥 hex。 */
  publicKeyHex: string;
  name: string;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

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
  /** 更新。 */
  updateContact(id: string, input: ContactInput): Promise<Contact>;
  /** 删除。 */
  removeContact(id: string): Promise<void>;
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
