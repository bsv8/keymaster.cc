// packages/contracts/src/contacts.ts
// 联系人契约：plugin-contacts 实现并通过 "contacts.service" 暴露。

/** 联系人。 */
export interface Contact {
  id: string;
  name: string;
  address: string;
  note?: string;
  tags: string[];
  /**
   * 硬切换 008：联系人归属的 key namespace（公钥 hash hex）。
   * 实际存储按 key namespace 拆分到不同 DB；publicKeyHash 作为展示字段
   * 供 UI 提示"这是哪把 key 的联系人"。
   */
  publicKeyHash?: string;
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
}
