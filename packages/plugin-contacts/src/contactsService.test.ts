import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { ActiveKeyState, KeyValueStore } from "@keymaster/contracts";
import { createContactsService } from "./contactsService.js";

const OWNER = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

describe("ContactsService wire values", () => {
  it("omits an empty optional note before owner K-V transport", async () => {
    const writes: unknown[] = [];
    const storage = {
      ...CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook,
      bucketId: "test",
      bucketGeneration: 1,
      ownerPublicKeyHex: OWNER,
      model: "kv" as const,
      async get() { return undefined; },
      async list() { return { revision: 0, entries: [] }; },
      async put(_key: string, value: unknown) {
        writes.push(value);
        return { key: "contact/test", revision: 1, updatedAt: Date.now() };
      },
      async delete() { return undefined; },
      async commit() { return { revision: 1, commitId: "commit-1", committedAt: Date.now() }; },
      close() { return undefined; },
    } as unknown as KeyValueStore;

    const service = createContactsService({ keyspace: keyspace(), storage });
    await service.addContact({ publicKeyHex: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Alice" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(expect.objectContaining({ name: "Alice", tags: [] }));
    expect(writes[0]).not.toHaveProperty("note");
    service.dispose?.();
  });
});
