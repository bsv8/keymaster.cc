import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { disposeVaultDb, vaultDb } from "./vaultDb.js";

const OBSOLETE_LEGACY_STORE = ["vault", "keys", "legacy", "staging"].join("_");

function deleteVaultDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("vault");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase blocked"));
  });
}

function openLegacyVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vault", 6);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("vault_meta")) {
        db.createObjectStore("vault_meta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("vault_keys")) {
        db.createObjectStore("vault_keys", { keyPath: "publicKeyHex" });
      }
      if (!db.objectStoreNames.contains(OBSOLETE_LEGACY_STORE)) {
        db.createObjectStore(OBSOLETE_LEGACY_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

describe("vaultDb", () => {
  beforeEach(async () => {
    disposeVaultDb();
    await deleteVaultDatabase().catch(() => undefined);
  });

  afterEach(async () => {
    disposeVaultDb();
    await deleteVaultDatabase().catch(() => undefined);
  });

  it("drops the obsolete pre-v7 store during schema upgrade", async () => {
    const legacyDb = await openLegacyVaultDb();
    legacyDb.close();

    await vaultDb.listKeys();

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("vault");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(Array.from(db.objectStoreNames)).not.toContain(OBSOLETE_LEGACY_STORE);
    expect(Array.from(db.objectStoreNames)).toContain("vault_keys");
    db.close();
  });
});
