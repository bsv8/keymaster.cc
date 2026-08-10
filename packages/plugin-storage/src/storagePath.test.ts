import { describe, expect, it } from "vitest";
import { buildNamespaceRoot, buildKeyForContext } from "./storageNamespace.js";
import { StoragePathError, assertKeyInRoot, normalizeDirectoryPath, normalizeProviderPrefix } from "./storagePath.js";

const identity = {
  version: 1 as const,
  publisherPublicKeyHex: `02${"11".repeat(32)}`,
  appId: "app-a",
  appName: "App A",
  identityDigestHex: "aa".repeat(32)
};

describe("storage namespace and path guards", () => {
  it("keeps publisher/app/root boundaries explicit", () => {
    const root = buildNamespaceRoot("tenant/", identity);
    expect(root).toBe(`tenant/${identity.publisherPublicKeyHex}/app-a/`);
    expect(buildKeyForContext(root, "docs/a.txt")).toBe(`${root}docs/a.txt`);
    expect(() => assertKeyInRoot(root, `tenant/${identity.publisherPublicKeyHex}/app-aa/file`)).toThrow(StoragePathError);
  });

  it.each(["../app-b/x", "/publisher/app-b/x", "a//b", "a/./b", "a\\b", "a\u0000b", "a\u2215b"]) (
    "rejects traversal or separator attack: %s",
    (value) => expect(() => buildKeyForContext(`${identity.publisherPublicKeyHex}/app-a/`, value)).toThrow(StoragePathError)
  );

  it("does not repair repeated separators", () => {
    expect(normalizeProviderPrefix("tenant/ok/")).toBe("tenant/ok/");
    expect(() => normalizeProviderPrefix("tenant//")).toThrow();
    expect(() => normalizeDirectoryPath("docs//")).toThrow();
  });
});
