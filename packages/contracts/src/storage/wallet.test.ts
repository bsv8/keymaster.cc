import { describe, expect, it } from "vitest";
import {
  WALLET_KEYHOLD_PATH,
  WALLET_META_PATH,
  buildWalletStorageRoot,
  isPlatformReservedPath,
  isThirdPartyAppPath,
  normalizeAppStorageName,
  normalizeRelativeStoragePath,
  resolveAppStorageNameConflict,
  validateWalletMeta,
} from "./wallet.js";

const PUBLISHER = "02" + "ab".repeat(32);

describe("wallet meta", () => {
  it("accepts a complete meta document and returns a copy", () => {
    const walletGeneration = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const meta = validateWalletMeta({
      format: "keymaster.wallet-meta",
      version: 1,
      schemaVersion: 1,
      initialized: true,
      walletGeneration,
      createdAt,
    });
    expect(meta).toEqual({
      format: "keymaster.wallet-meta",
      version: 1,
      schemaVersion: 1,
      initialized: true,
      walletGeneration,
      createdAt,
    });
  });

  it("rejects incomplete, unversioned and unknown-field documents", () => {
    const base = {
      format: "keymaster.wallet-meta",
      version: 1,
      schemaVersion: 1,
      initialized: true,
      walletGeneration: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    // 初始化记录不完整时必须进入错误态,不能被当作一个空钱包。
    expect(() => validateWalletMeta({ ...base, walletGeneration: undefined })).toThrow();
    expect(() => validateWalletMeta({ ...base, format: "keymaster.storage.catalog.v2" })).toThrow();
    expect(() => validateWalletMeta({ ...base, schemaVersion: 0 })).toThrow();
    expect(() => validateWalletMeta({ ...base, initialized: "yes" })).toThrow();
    expect(() => validateWalletMeta({ ...base, walletGeneration: "not-a-uuid" })).toThrow();
    expect(() => validateWalletMeta({ ...base, extra: true })).toThrow();
  });
});

describe("logical storage roots", () => {
  it("plans system, built-in module and third-party app roots", () => {
    expect(buildWalletStorageRoot({ authority: "platform-only", moduleId: "coordinator", purposeId: "settings" })).toBe(
      ".keymaster/system/coordinator/settings/"
    );
    expect(buildWalletStorageRoot({ authority: "built-in-module", moduleId: "p2pkh", purposeId: "" })).toBe("p2pkh/");
    expect(buildWalletStorageRoot({ authority: "built-in-module", moduleId: "contacts", purposeId: "address-book" })).toBe(
      "contacts/address-book/"
    );
    expect(
      buildWalletStorageRoot({ authority: "third-party-app", moduleId: "app", purposeId: "", appStorageName: "notes" })
    ).toBe("apps/notes/");
  });

  it("never emits a bucket id or wallet owner public key prefix", () => {
    const roots = [
      buildWalletStorageRoot({ authority: "platform-only", moduleId: "protocol", purposeId: "sessions" }),
      buildWalletStorageRoot({ authority: "built-in-module", moduleId: "messages", purposeId: "" }),
      buildWalletStorageRoot({ authority: "third-party-app", moduleId: "app", purposeId: "", appStorageName: "notes" }),
    ];
    for (const root of roots) {
      expect(root).not.toMatch(/[0-9a-f]{64}/u);
      expect(root.toLowerCase()).not.toContain("bucket");
    }
  });

  it("requires a registered name for third-party app storage", () => {
    expect(() => buildWalletStorageRoot({ authority: "third-party-app", moduleId: "app", purposeId: "" })).toThrow();
    expect(() =>
      buildWalletStorageRoot({
        authority: "third-party-app",
        moduleId: "app",
        purposeId: "sub",
        appStorageName: "notes",
      })
    ).toThrow();
  });
});

describe("third-party app storage names", () => {
  it("normalizes display names so a stable directory survives renames", () => {
    expect(normalizeAppStorageName("Notes")).toBe("notes");
    expect(normalizeAppStorageName("ＭｙＡｐｐ")).toBe("myapp");
  });

  it("assigns a stable identity suffix when different identities request one name", () => {
    const first = resolveAppStorageNameConflict({ requestedName: "notes", publisherPublicKeyHex: PUBLISHER, appId: "app-one" });
    const again = resolveAppStorageNameConflict({ requestedName: "notes", publisherPublicKeyHex: PUBLISHER, appId: "app-one" });
    const otherIdentity = resolveAppStorageNameConflict({
      requestedName: "notes",
      publisherPublicKeyHex: "03" + "cd".repeat(32),
      appId: "app-one",
    });
    const otherApp = resolveAppStorageNameConflict({ requestedName: "notes", publisherPublicKeyHex: PUBLISHER, appId: "app-two" });
    // 同一身份重复登记得到同一个目录:重命名不会移动数据。
    expect(again).toBe(first);
    // 同一发布者的不同 appId 默认隔离;不同身份同名也绝不共享目录。
    expect(otherIdentity).not.toBe(first);
    expect(otherApp).not.toBe(first);
    expect(first.startsWith("notes-")).toBe(true);
  });
});

describe("relative path normalization", () => {
  it("rejects absolute paths and parent traversal", () => {
    for (const invalid of ["../x", "a/../../x", "/x", "", "a//b", "a/./b", "a\\b"]) {
      expect(() => normalizeRelativeStoragePath(invalid)).toThrow();
    }
  });

  it("keeps business identifiers and non-ascii names intact", () => {
    expect(normalizeRelativeStoragePath("contacts/联系人01.json")).toBe("contacts/联系人01.json");
    expect(normalizeRelativeStoragePath("p2pkh/testnet/tx/abc.json")).toBe("p2pkh/testnet/tx/abc.json");
  });
});

describe("reserved areas", () => {
  it("marks key.json and the system area as platform reserved", () => {
    expect(WALLET_KEYHOLD_PATH).toBe("key.json");
    expect(WALLET_META_PATH).toBe(".keymaster/meta");
    expect(isPlatformReservedPath("key.json")).toBe(true);
    expect(isPlatformReservedPath(".keymaster/meta")).toBe(true);
    expect(isPlatformReservedPath(".keymaster/system/coordinator/settings/current")).toBe(true);
    expect(isPlatformReservedPath("contacts/联系人01.json")).toBe(false);
  });

  it("recognizes the third-party app root", () => {
    expect(isThirdPartyAppPath("apps/notes/data.json")).toBe(true);
    expect(isThirdPartyAppPath("contacts/a.json")).toBe(false);
  });
});
