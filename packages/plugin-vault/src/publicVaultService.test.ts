import { describe, expect, it, vi } from "vitest";
import { createPublicVaultService } from "./publicVaultService.js";
import type { InternalVaultService } from "./internalVaultService.js";

describe("Vault public boundary", () => {
  it("publishes only approved methods without an internal-service prototype", async () => {
    const internal = new Proxy({ marker: "internal" }, { get: (target, name) => name === "marker" ? target.marker : vi.fn(function (this: { marker: string }) { return this.marker; }) }) as unknown as InternalVaultService;
    const published = createPublicVaultService(internal);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.getPrototypeOf(published)).toBe(null);
    for (const name of ["initialize", "exportKeyHold", "changePassword", "renameKey", "resetWallet", "coldStart", "storageControl", "vaultOperation", "coordinatorClient", "mirror", "dispose"]) {
      expect(name in published).toBe(false);
    }
    expect(await published.getCurrentKey()).toBe("internal");
  });
});
