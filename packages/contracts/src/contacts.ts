// packages/contracts/src/contacts.ts
// 联系人契约：plugin-contacts 实现并通过 "contacts.service" 暴露。
//
// 硬切换 2026-07-09 002：
//   - 联系人 canonical 身份改为 publicKeyHex；
//   - 不再使用 address 作为联系人主键语义；
//   - 联系人归属由 key-scoped DB 表达，不再在联系人行内存 owner 字段；
//   - 不做旧 address -> publicKeyHex 猜测迁移。

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
  /** 硬切换 001：宿主 teardown 时调用。幂等。 */
  dispose?(): void;
}
