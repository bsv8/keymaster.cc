import { walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
import { describe, expect, it } from "vitest";
import type { VaultLifecycleSnapshot, ModuleFileStore } from "@keymaster/contracts";
import { createContactsService } from "./contactsService.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function walletState() {
  const state: VaultLifecycleSnapshot = walletStateFixtureSnapshot({ activePublicKeyHex: OWNER });
  return {
    snapshot: () => state,
    subscribe: () => () => undefined,
  };
}

/** 内存 owner 文件根：只模拟 CAS 语义与相对路径,不引入第二套持久化模型。 */
function memoryFileStore(): ModuleFileStore & { puts: Array<{ path: string; text: string }> } {
  const files = new Map<string, Uint8Array>();
  const puts: Array<{ path: string; text: string }> = [];
  const encode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const stamp = () => new Date().toISOString();
  return {
    puts,
    walletGeneration: "test-wallet",
    sessionEpoch: "test-epoch",
    runGeneration: "test-run",
    list: async (input = {}) => ({
      files: [...files.entries()]
        .filter(([path]) => (input.prefix === undefined || input.prefix === "" ? true : path.startsWith(input.prefix)))
        .map(([path, bytes]) => ({ path, size: bytes.byteLength, revision: "r1", lastModified: stamp() })),
    }),
    get: async (path) => files.has(path)
      ? { path, bytes: new Uint8Array(files.get(path)!), revision: "r1", lastModified: stamp() }
      : undefined,
    put: async (path, bytes, condition = {}) => {
      if (condition.ifNoneMatch === true && files.has(path)) throw Object.assign(new Error("目标已存在"), { code: "storage_conflict" });
      puts.push({ path, text: encode(bytes) });
      files.set(path, new Uint8Array(bytes));
      return { revision: "r1", lastModified: stamp() };
    },
    delete: async (path) => { files.delete(path); },
    getRange: async (path, range) => files.has(path)
      ? { path, bytes: new Uint8Array(files.get(path)!).slice(range.offset, range.offset + range.length), revision: "r1", lastModified: stamp() }
      : undefined,
    batch: async (input) => {
      for (const operation of input.operations) {
        if (operation.type === "put") files.set(operation.path, new Uint8Array(operation.bytes));
        else files.delete(operation.path);
      }
      return { paths: input.operations.map((operation) => operation.path), committedAt: stamp() };
    },
    close: () => { files.clear(); },
  };
}

describe("ContactsService 文件写入", () => {
  it("省略空的可选备注字段", async () => {
    const storage = memoryFileStore();
    const service = createContactsService({ walletState: walletState(), storage });
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
    const service = createContactsService({ walletState: walletState(), storage });
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


describe("Contacts presence teardown", () => {
  it("clears presence without reading an already revoked wallet view", () => {
    let revoked = false;
    const state = walletState();
    const service = createContactsService({ storage: memoryFileStore(), walletState: {
      ...state, snapshot: () => { if (revoked) throw new Error("wallet Scope revoked"); return state.snapshot(); },
    } });
    revoked = true;
    expect(() => service.resetPresence?.()).not.toThrow();
    expect(() => service.dispose?.()).not.toThrow();
  });
});
