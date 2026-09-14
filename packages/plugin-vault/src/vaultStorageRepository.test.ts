import { describe, expect, it, vi } from "vitest";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import type {
  VaultCatalogHoldAdapter,
  VaultStorageRepository,
  VaultAuthMetadata,
  VaultKeyLifecycleJournalRecord
} from "./coordinator.js";
import type { StorageCatalogKeyIndexRecordV1 } from "@keymaster/contracts";
import {
  createVaultStorageRepository,
  disposeVaultStorageRepository,
  configureVaultStorageRepository,
  getVaultStorageRepository
} from "./storage/vaultStorageRepository.js";

function makeStore(purposeId: string) {
  return createInMemoryKeyValueStore({
    moduleId: "vault",
    purposeId,
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
    bucketId: "vault-test",
    bucketGeneration: 1
  });
}

type TestStores = {
  authMetadata: ReturnType<typeof makeStore>;
  keyIndex: ReturnType<typeof makeStore>;
  keyLifecycleJournals: ReturnType<typeof makeStore>;
};

function makeStores(): TestStores {
  return {
    authMetadata: makeStore("auth-metadata"),
    keyIndex: makeStore("key-index"),
    keyLifecycleJournals: makeStore("key-lifecycle-journals")
  };
}

function makeHold(): VaultCatalogHoldAdapter {
  return {
    readCommitted: vi.fn(),
    readEncryptedSnapshot: vi.fn(),
    encryptPrivateKey: vi.fn(),
    decryptPrivateKey: vi.fn(),
    publish: vi.fn(),
    rotatePassword: vi.fn()
  };
}

function makeRepository(stores: TestStores = makeStores()): VaultStorageRepository {
  return createVaultStorageRepository({ stores, hold: makeHold() });
}

const publicKeyHex = "02".padEnd(66, "a");
const keyIndexRecord: StorageCatalogKeyIndexRecordV1 = {
  format: "keymaster.storage.catalog-key-index",
  publicKeyHex,
  label: "Primary",
  keyFormat: "generated",
  capabilities: ["p2pkh"],
  createdAt: "2026-09-14T00:00:00.000Z"
};

const authMetadata: VaultAuthMetadata = {
  id: "singleton",
  cryptoVersion: "v2",
  kdf: "pbkdf2-sha256",
  iterations: 600_000,
  keyLengthBits: 256,
  saltB64: "00",
  verifierSaltB64: "11",
  verifierIvB64: "22",
  verifierCipherB64: "33",
  createdAt: "2026-09-14T00:00:00.000Z"
};

const secondPublicKeyHex = "03".padEnd(66, "b");

const addLifecycleJournal: VaultKeyLifecycleJournalRecord = {
  format: "keymaster.vault.key-lifecycle-journal",
  version: 1,
  transactionId: "add-1",
  operation: "add",
  publicKeyHex,
  phase: "prepared",
  baseHoldEtag: null,
  committedHoldEtag: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z"
};

const deleteLifecycleJournal: VaultKeyLifecycleJournalRecord = {
  format: "keymaster.vault.key-lifecycle-journal",
  version: 1,
  transactionId: "delete-1",
  operation: "delete",
  publicKeyHex: secondPublicKeyHex,
  phase: "prepared",
  baseHoldEtag: "etag-before-delete",
  committedHoldEtag: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z"
};

describe("Vault V1 purpose-store repository", () => {
  it("keeps auth, public index, and lifecycle transactions in separate stores", async () => {
    const stores = makeStores();
    const repository = makeRepository(stores);

    await repository.putAuthMetadata(authMetadata);
    await repository.replaceKeyIndex([keyIndexRecord]);
    await repository.claimKeyLifecycleJournal(addLifecycleJournal);
    await repository.claimKeyLifecycleJournal(deleteLifecycleJournal);

    await expect(repository.getAuthMetadata()).resolves.toEqual(authMetadata);
    await expect(repository.listKeyIndex()).resolves.toEqual([keyIndexRecord]);
    await expect(repository.listKeyLifecycleJournals(publicKeyHex)).resolves.toEqual([addLifecycleJournal]);
    await expect(repository.listKeyLifecycleJournals(secondPublicKeyHex)).resolves.toEqual([deleteLifecycleJournal]);
    await expect(stores.authMetadata.list({ partition: "auth-metadata" })).resolves.toMatchObject({ entries: [{ key: "singleton" }] });
    await expect(stores.keyIndex.list({ partition: "key-index" })).resolves.toMatchObject({ entries: [{ key: "keys/" + publicKeyHex }] });
    await expect(stores.keyLifecycleJournals.list({ partition: "key-lifecycle-journals" })).resolves.toMatchObject({ entries: [
      { key: "journals/" + publicKeyHex },
      { key: "journals/" + secondPublicKeyHex },
    ] });

    await expect(repository.claimKeyLifecycleJournal({
      ...addLifecycleJournal,
      transactionId: "add-2",
    })).rejects.toMatchObject({ code: "storage_conflict" });

    const committedAdd = { ...addLifecycleJournal, phase: "hold-committed" as const, committedHoldEtag: "etag-after-add" };
    await repository.updateKeyLifecycleJournal(committedAdd);
    await expect(repository.getKeyLifecycleJournal(publicKeyHex)).resolves.toEqual(committedAdd);

    await repository.deleteKeyLifecycleJournal(publicKeyHex, committedAdd.transactionId);
    await expect(repository.getKeyLifecycleJournal(publicKeyHex)).resolves.toBeUndefined();
    await expect(repository.listKeyLifecycleJournals()).resolves.toEqual([deleteLifecycleJournal]);
  });

  it("rejects unsupported fields instead of allowing secret records into metadata stores", async () => {
    const repository = makeRepository();
    await expect(repository.replaceKeyIndex([{
      ...keyIndexRecord,
      privateKey: "must-not-persist"
    } as never])).rejects.toThrow(/not supported/);
    await expect(repository.listKeyIndex()).resolves.toEqual([]);
  });

  it("requires all final purpose bindings and exposes the Hold adapter separately", () => {
    const stores = makeStores();
    const hold = makeHold();
    const repository = createVaultStorageRepository({ stores, hold });
    expect(repository.hold).toBe(hold);
    expect(() => createVaultStorageRepository({
      stores: { ...stores, keyIndex: makeStore("vault-keys") },
      hold
    })).toThrow(/key-index/);
  });

  it("does not close borrowed handles and does not update memory after a failed write", async () => {
    const stores = makeStores();
    const close = vi.spyOn(stores.authMetadata, "close");
    const repository = makeRepository(stores);
    vi.spyOn(stores.authMetadata, "put").mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(repository.putAuthMetadata(authMetadata)).rejects.toThrow("storage unavailable");
    await expect(repository.getAuthMetadata()).resolves.toBeUndefined();
    disposeVaultStorageRepository();
    expect(close).not.toHaveBeenCalled();

    configureVaultStorageRepository({ stores, hold: makeHold() });
    expect(getVaultStorageRepository()).toBeDefined();
    disposeVaultStorageRepository();
    expect(close).not.toHaveBeenCalled();
  });
});
