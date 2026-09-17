// Contacts 文件仓储：一人一文件 `contacts/address-book/<公钥>.json`。
//
// 规则（KeymasterFormats《联系人文件》）：
//   - 文件名 = 小写 publicKeyHex + ".json"，文件内容自带 publicKeyHex 交叉校验；
//   - 新增：文件已存在则拒绝（ifNoneMatch 原生 CAS）；
//   - 更新/删除：只动当前这一个文件；
//   - 损坏文件跳过并提示，不影响其它联系人；没有索引、没有跨文件事务。

import type { BorrowedOwnerFileStore, Contact, ContactInput } from "@keymaster/contracts";
import { CONTACT_FILE_FORMAT, CONTACT_FILE_LIMITS, CONTACT_FILE_VERSION } from "@keymaster/contracts";

const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;
const CONTACT_KEYS = ["createdAt", "format", "name", "note", "publicKeyHex", "tags", "updatedAt", "version"] as const;

export interface ContactsListResult {
  /** 解析成功的联系人。 */
  contacts: Contact[];
  /** 损坏或与文件名不一致、被跳过的文件名（不含路径前缀）。 */
  invalidFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function contactFileName(publicKeyHex: string): string {
  return `${publicKeyHex.toLowerCase()}.json`;
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : undefined;
}

/** 严格解析联系人文件；失败返回 undefined（调用方跳过该文件）。 */
export function parseContactFile(bytes: Uint8Array, expectedPublicKeyHex: string): Contact | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTACT_FILE_LIMITS.maxBytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (Object.keys(parsed).some((key) => !(CONTACT_KEYS as readonly string[]).includes(key))) return undefined;
  if (parsed.format !== CONTACT_FILE_FORMAT || parsed.version !== CONTACT_FILE_VERSION) return undefined;
  const publicKeyHex = parsed.publicKeyHex;
  if (typeof publicKeyHex !== "string" || !PUBLIC_KEY_PATTERN.test(publicKeyHex)) return undefined;
  if (publicKeyHex.toLowerCase() !== expectedPublicKeyHex.toLowerCase()) return undefined;
  const name = parsed.name;
  if (typeof name !== "string" || name.length === 0 || name.length > CONTACT_FILE_LIMITS.maxNameLength) return undefined;
  let note: string | undefined;
  if (parsed.note !== undefined) {
    if (typeof parsed.note !== "string" || parsed.note.length > CONTACT_FILE_LIMITS.maxNoteLength) return undefined;
    if (parsed.note.length > 0) note = parsed.note;
  }
  const tags = parsed.tags;
  if (!Array.isArray(tags) || tags.length > CONTACT_FILE_LIMITS.maxTags) return undefined;
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > CONTACT_FILE_LIMITS.maxTagLength) return undefined;
  }
  const createdAt = parseIsoDate(parsed.createdAt);
  const updatedAt = parseIsoDate(parsed.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return undefined;
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return undefined;
  return {
    publicKeyHex: publicKeyHex.toLowerCase(),
    name,
    ...(note === undefined ? {} : { note }),
    tags: [...tags] as string[],
    createdAt,
    updatedAt,
  };
}

/** 序列化为文件字节（键序固定，便于人工查看与测试）。 */
export function serializeContactFile(contact: Contact): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    format: CONTACT_FILE_FORMAT,
    version: CONTACT_FILE_VERSION,
    publicKeyHex: contact.publicKeyHex.toLowerCase(),
    name: contact.name,
    ...(contact.note === undefined || contact.note.length === 0 ? {} : { note: contact.note }),
    tags: contact.tags,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  }, null, 2)}\n`);
}

/** Repository 只接收 Host 已绑定的 Contacts owner 文件句柄。 */
export function createContactsRepository(files: BorrowedOwnerFileStore) {
  async function getContact(publicKeyHex: string): Promise<Contact | undefined> {
    const normalized = publicKeyHex.toLowerCase();
    if (!PUBLIC_KEY_PATTERN.test(normalized)) return undefined;
    const object = await files.get(contactFileName(normalized));
    return object ? parseContactFile(object.bytes, normalized) : undefined;
  }

  async function listAll(): Promise<ContactsListResult> {
    const contacts: Contact[] = [];
    const invalidFiles: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await files.list(cursor === undefined ? { prefix: "" } : { prefix: "", cursor });
      for (const file of page.files) {
        const expected = file.path.endsWith(".json") ? file.path.slice(0, -".json".length) : undefined;
        if (expected === undefined || !PUBLIC_KEY_PATTERN.test(expected)) {
          invalidFiles.push(file.path);
          continue;
        }
        const object = await files.get(file.path);
        const contact = object ? parseContactFile(object.bytes, expected) : undefined;
        if (contact) contacts.push(contact);
        else invalidFiles.push(file.path);
      }
      cursor = page.nextCursor;
    } while (cursor);
    contacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.publicKeyHex.localeCompare(right.publicKeyHex));
    return { contacts, invalidFiles };
  }

  return {
    getStore(): BorrowedOwnerFileStore { return files; },
    close(): void { /* Host owns the borrowed file handle. */ },
    async list(): Promise<ContactsListResult> { return listAll(); },
    async get(publicKeyHex: string): Promise<Contact | undefined> { return getContact(publicKeyHex); },
    async findByPublicKeyHex(publicKeyHex: string): Promise<Contact | undefined> { return getContact(publicKeyHex); },
    async findByPublicKeyHexes(publicKeyHexes: string[]): Promise<Contact[]> {
      const wanted = new Set(publicKeyHexes.filter(Boolean).map((key) => key.trim().toLowerCase()));
      return (await listAll()).contacts.filter((contact) => wanted.has(contact.publicKeyHex));
    },
    /** 新增：文件已存在（含并发创建）时抛 storage_conflict。 */
    async create(contact: Contact): Promise<void> {
      await files.put(contactFileName(contact.publicKeyHex), serializeContactFile(contact), { ifNoneMatch: "*" });
    },
    /** 覆盖写入（更新或改名后的目标文件）。 */
    async put(contact: Contact): Promise<void> {
      await files.put(contactFileName(contact.publicKeyHex), serializeContactFile(contact));
    },
    async remove(publicKeyHex: string): Promise<void> {
      await files.delete(contactFileName(publicKeyHex));
    }
  };
}

export type ContactsRepositoryHandle = ReturnType<typeof createContactsRepository>;

/** 供服务层复用的输入规范化（去空白、校验长度）。 */
export function normalizeContactInput(input: ContactInput): { publicKeyHex: string; name: string; note?: string; tags: string[] } {
  const publicKeyHex = input.publicKeyHex.trim().toLowerCase();
  if (!PUBLIC_KEY_PATTERN.test(publicKeyHex)) throw new Error("publicKeyHex is required");
  const name = input.name.trim();
  if (!name || name.length > CONTACT_FILE_LIMITS.maxNameLength) throw new Error("Name is required");
  const note = input.note?.trim();
  if (note !== undefined && note.length > CONTACT_FILE_LIMITS.maxNoteLength) throw new Error("Note is too long");
  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (tags.length > CONTACT_FILE_LIMITS.maxTags || tags.some((tag) => tag.length > CONTACT_FILE_LIMITS.maxTagLength)) {
    throw new Error("Tags are invalid");
  }
  return {
    publicKeyHex,
    name,
    ...(note ? { note } : {}),
    tags,
  };
}
