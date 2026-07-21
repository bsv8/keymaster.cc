import { describe, expect, it } from "vitest";
import { keyImportPlugin } from "./manifest.js";
import { createTestHost } from "./testSupport/createTestHost.js";

describe("key-import manifest", () => {
  it("embeds import in Key management instead of registering /import or a menu item", async () => {
    const { host } = createTestHost();

    await host.register(keyImportPlugin);

    expect(host.vaultSettings.list().map((section) => section.id)).toEqual(["key-import.import"]);
    expect(host.routes.byPath("/import")).toBeUndefined();

    await host.disable("key-import");
    expect(host.vaultSettings.list()).toEqual([]);
  });
});
