import { describe, expect, it } from "vitest";
import type { ActiveKeyState, OwnerFileStore } from "@keymaster/contracts";
import { createContactsService } from "./contactsService.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function keyspace() {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => state,
    selected: () => state.activePublicKeyHex,
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined,
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
  };
}

/** 内存 owner 文件根：只模拟 CAS 语义与相对路径,不引入第二套持久化模型。 */
function memoryFileStore(): OwnerFileStore & { puts: Array<{ path: string; text: string }> } {
  const files = new Map<string, Uint8Array>();
  const puts: Array<{ path: string; text: string }> = [];
  const encode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    puts,
    list: async (input = {}) => ({
      files: [...files.entries()]
        .filter(([path]) => (input.prefix === undefined || input.prefix === "" ? true : path.startsWith(input.prefix)))
        .map(([path, bytes]) => ({ path, size: bytes.byteLength })),
    }),
    get: async (path) => files.has(path)
      ? { path, bytes: new Uint8Array(files.get(path)!) }
      : undefined,
    put: async (path, bytes, condition = {}) => {
      if (condition.ifNoneMatch === "*" && files.has(path)) throw Object.assign(new Error("目标已存在"), { code: "storage_conflict" });
      puts.push({ path, text: encode(bytes) });
      files.set(path, new Uint8Array(bytes));
      return {};
    },
    delete: async (path) => { files.delete(path); },
  };
}

describe("ContactsService 文件写入", () => {
  it("省略空的可选备注字段", async () => {
    const storage = memoryFileStore();
    const service = createContactsService({ keyspace: keyspace(), storage });
    await service.addContact({ publicKeyHex: ALICE, name: "Alice" });

    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]!.path).toBe(`${ALICE}.json`);
    const document = JSON.parse(storage.puts[0]!.text) as Record<string, unknown>;
    expect(document).toMatchObject({ format: "keymaster.contact", version: 1, publicKeyHex: ALICE, name: "Alice", tags: [] });
    expect(document).not.toHaveProperty("note");
    service.dispose?.();
  });

  it("重复公钥被拒绝,改名时移动文件", async () => {
    const storage = memoryFileStore();
    const service = createContactsService({ keyspace: keyspace(), storage });
    await service.addContact({ publicKeyHex: ALICE, name: "Alice" });
    await expect(service.addContact({ publicKeyHex: ALICE, name: "Alice 2" })).rejects.toThrow();
    expect(storage.puts).toHaveLength(1);

    const renamed = await service.updateContact(ALICE, { publicKeyHex: BOB, name: "Bob", tags: ["朋友"] });
    expect(renamed).toMatchObject({ publicKeyHex: BOB, name: "Bob", tags: ["朋友"], createdAt: expect.any(String) });
    await expect(service.findByPublicKeyHex(ALICE)).resolves.toBeUndefined();
    await expect(service.findByPublicKeyHex(BOB)).resolves.toMatchObject({ name: "Bob" });
    await expect(service.listContacts()).resolves.toEqual([expect.objectContaining({ publicKeyHex: BOB })]);

    await service.removeContact(BOB);
    await expect(service.listContacts()).resolves.toEqual([]);
    service.dispose?.();
  });
});
