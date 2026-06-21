// packages/contracts/src/contacts.ts
// 联系人契约：plugin-contacts 实现并通过 "contacts.service" 暴露。
//
// 硬切换 001 收口：联系人归属字段统一改为 publicKeyHex（平台 owning
// key 公钥），不再使用 `publicKeyHash`。联系人是本地真值，因此
// plugin-contacts 必须做一次性迁移（见 plugin-contacts/contactsDb）。

/** 联系人。 */
export interface Contact {
  id: string;
  name: string;
  address: string;
  note?: string;
  tags: string[];
  /**
   * 联系人归属的 owning key 公钥 hex（平台公开身份）。这是联系人"属于
   * 哪把 key"的归属字段,不是链上 hash。
   *
   * 实际存储按 key namespace 拆分到不同 DB；publicKeyHex 作为展示字段
   * 供 UI 提示"这是哪把 key 的联系人"。
   */
  publicKeyHex?: string;
  createdAt: string;
  updatedAt: string;
}

/** 联系人输入。 */
export interface ContactInput {
  name: string;
  address: string;
  note?: string;
  tags?: string[];
}

/** 联系人错误。 */
export type ContactsError = "duplicate-address" | "not-found" | "validation";

/** 联系人服务。 */
export interface ContactsService {
  /** 新增；address 已存在时抛错。 */
  addContact(input: ContactInput): Promise<Contact>;
  /** 更新。 */
  updateContact(id: string, input: ContactInput): Promise<Contact>;
  /** 删除。 */
  removeContact(id: string): Promise<void>;
  /** 列出全部。 */
  listContacts(): Promise<Contact[]>;
  /** 按地址查找。第一版约定 address 唯一。 */
  findByAddress(address: string): Promise<Contact | undefined>;
  /** 订阅变化。 */
  onChange(handler: () => void): () => void;
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}
