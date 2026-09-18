import { describe, expect, it } from "vitest";
import {
  CENTRAL_STORAGE_DECLARATIONS,
  SYSTEM_STORAGE_DECLARATIONS,
  assertSystemStorageDeclaration,
  systemStorageDeclarationFor,
  systemStorageDeclarationForPurpose,
} from "./systemStorageDeclarations.js";

describe("central storage declarations", () => {
  it("requires a named purpose for modules with multiple scopes or purposes", () => {
    expect(systemStorageDeclarationFor("poker")).toBeUndefined();
    expect(systemStorageDeclarationForPurpose("poker", "settings")).toEqual(CENTRAL_STORAGE_DECLARATIONS.pokerSettings);
    expect(systemStorageDeclarationForPurpose("poker", "session-history")).toEqual(CENTRAL_STORAGE_DECLARATIONS.pokerSessionHistory);
    expect(systemStorageDeclarationForPurpose("poker", "missing")).toBeUndefined();
    expect(SYSTEM_STORAGE_DECLARATIONS.webrtc).toHaveLength(2);
    expect(systemStorageDeclarationFor("webrtc")).toBeUndefined();
  });

  it("rejects an unregistered platform or built-in declaration", () => {
    expect(() => assertSystemStorageDeclaration("unknown-plugin", {
      moduleId: "unknown-plugin",
      purposeId: "state",
      scope: "owner",
      authority: "built-in-module",
      model: "kv",
      schemaVersion: 1,
    })).toThrow(/unauthorized storage declaration/iu);

    expect(() => assertSystemStorageDeclaration("contacts", {
      ...CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook,
      purposeId: "forged-purpose",
    })).toThrow(/unauthorized storage declaration/iu);
  });

  it("leaves verified third-party authority to its independent identity boundary", () => {
    expect(() => assertSystemStorageDeclaration("unknown-app", {
      moduleId: "unknown-app",
      purposeId: "files",
      scope: "owner",
      authority: "third-party-app",
      model: "kv",
      schemaVersion: 1,
    })).not.toThrow();
  });

  it("keeps MSFile settings on the owner file formats", () => {
    expect(SYSTEM_STORAGE_DECLARATIONS.msfile).toHaveLength(2);
    expect(CENTRAL_STORAGE_DECLARATIONS.msfilesFiles).toMatchObject({
      moduleId: "msfiles",
      purposeId: "",
      scope: "owner",
      model: "files",
    });
    expect(CENTRAL_STORAGE_DECLARATIONS.appSettingsFiles).toMatchObject({
      moduleId: "app",
      purposeId: "app-settings",
      scope: "owner",
      model: "files",
    });
    // 旧桶级 K-V 声明必须彻底移除，避免新旧两套路径并存。
    expect(Object.values(CENTRAL_STORAGE_DECLARATIONS).some((declaration) => declaration.moduleId === "msfile")).toBe(false);
  });
});
