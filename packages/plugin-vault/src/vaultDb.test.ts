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

function openPreCanonicalVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vault", 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("vault_keys", { keyPath: "id" });
      db.createObjectStore("vault_meta", { keyPath: "id" });
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

  it("deletes a key and all WebAuthn sidecars in one transaction", async () => {
    const publicKeyHex = "02".padEnd(66, "a");
    await vaultDb.putKey({
      publicKeyHex,
      label: "legacy",
      address: "",
      network: "main",
      format: "legacy",
      capabilities: [],
      createdAt: new Date().toISOString(),
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00"
    });
    await vaultDb.putSidecar({ publicKeyHex, id: "credential", label: "passkey", credentialIdB64: "credential", prfSaltB64: "salt", rpId: "keymaster.cc", createdAt: new Date().toISOString(), cipherVersion: "webauthn-prf-v1", cipherIvB64: "00", cipherB64: "00" });
    expect(await vaultDb.listSidecars(publicKeyHex)).toHaveLength(1);
    await vaultDb.deleteKeyAndSidecars(publicKeyHex);
    expect(await vaultDb.getKey(publicKeyHex)).toBeUndefined();
    expect(await vaultDb.listSidecars(publicKeyHex)).toHaveLength(0);
  });

  it("creates the sidecar store while upgrading a v1-v4 database", async () => {
    const legacyDb = await openPreCanonicalVaultDb();
    legacyDb.close();
    await vaultDb.listKeys();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("vault");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(Array.from(db.objectStoreNames)).toContain("webauthn_sidecars");
    db.close();
  });

  it("keeps missing legacy cipher fields absent during upgrade", async () => {
    const legacyDb = await openPreCanonicalVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction("vault_keys", "readwrite");
      tx.objectStore("vault_keys").put({
        id: "legacy-no-cipher",
        publicKeyHex: "02".padEnd(66, "a"),
        label: "opaque",
        address: "",
        network: "main",
        format: "legacy",
        capabilities: [],
        createdAt: new Date().toISOString()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    legacyDb.close();

    const records = await vaultDb.listKeys();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record || record.storageVersion === "keyhold-v2") throw new Error("expected opaque legacy record");
    expect(record.cipherSaltB64).toBeUndefined();
    expect(record.cipherIvB64).toBeUndefined();
    expect(record.cipherB64).toBeUndefined();
  });
});
