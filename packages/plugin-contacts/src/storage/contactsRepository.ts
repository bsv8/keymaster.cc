// Contacts 统一 K-V Repository。
// 联系人只通过 Host 绑定的 owner/App 句柄访问，不暴露 Provider 或物理路径。

import type { BorrowedKeyValueStore, Contact } from "@keymaster/contracts";

const PARTITION = "contacts";
const PREFIX = "contact/";

async function listValues(store: BorrowedKeyValueStore): Promise<Contact[]> {
  const result: Contact[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
    result.push(...page.entries.map((entry) => entry.value as unknown as Contact));
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

/** Repository 只接收 Host 已绑定的 Contacts owner/App K-V 句柄。 */
export function createContactsRepository(store: BorrowedKeyValueStore) {
  const key = (id: string) => `${PREFIX}${id}`;
  return {
    getStore(): BorrowedKeyValueStore { return store; },
    close(): void { /* Host owns the borrowed storage handle. */ },
    async list(): Promise<Contact[]> { return listValues(store); },
    async get(id: string): Promise<Contact | undefined> { return (await store.get<Contact>(key(id), { partition: PARTITION }))?.value; },
    async findByPublicKeyHex(publicKeyHex: string): Promise<Contact | undefined> { return (await listValues(store)).find((item) => item.publicKeyHex === publicKeyHex); },
    async findByPublicKeyHexes(publicKeyHexes: string[]): Promise<Contact[]> {
      const wanted = new Set(publicKeyHexes.filter(Boolean));
      return (await listValues(store)).filter((item) => wanted.has(item.publicKeyHex));
    },
    async put(contact: Contact): Promise<void> { await store.put(key(contact.id), contact, { partition: PARTITION }); },
    async remove(id: string): Promise<void> { await store.delete(key(id), { partition: PARTITION }); }
  };
}

export type ContactsRepositoryHandle = ReturnType<typeof createContactsRepository>;
