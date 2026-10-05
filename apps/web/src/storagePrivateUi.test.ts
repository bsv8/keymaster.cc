import { createFixtureHost as createKeymasterPluginHost } from "@keymaster/runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { defineCapability } from "webloom-framework";

import { storagePlatformPlugin, storagePlatformSetup } from "@keymaster/platform-storage";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";

describe("Storage private UI", () => {
  it("registers its own page without publishing the global browser, and removes the page on revocation", async () => {
    const unsubscribe = vi.fn();
    const coordinator = { subscribeTopic: () => unsubscribe };
    const formerPublicBrowser = defineCapability({
      kind: "local", id: "storage.browse-service", version: "1",
    });
    const host = createKeymasterPluginHost({
      fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main",
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: "02" + "11".repeat(32),
        sessionEpoch: "storage-private-ui:1",
        walletGeneration: "storage-private-ui:1",
      },
      coordinatorForPlugin: () => coordinator,
      runtimeUnitImplementationRegistry: {
        get: (id) => id === "storage" ? storagePlatformSetup : id === "page" ? pageSetup : undefined,
      },
    });
    await host.registerAll([storagePlatformPlugin, pagePlugin]);
    const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
    expect(host.state("storage").kind).toBe("enabled");
    expect(pages.hasPage("/settings/storage")).toBe(true);
    expect(host.routes.byPath("/settings/storage")).toBeUndefined();
    expect(host.capabilities.has(formerPublicBrowser)).toBe(false);
    expect(() => host.capabilities.get(formerPublicBrowser)).toThrow();
    expect(storagePlatformPlugin.units.flatMap((unit) => unit.provides ?? [])
      .some((capability) => capability.id === formerPublicBrowser.id)).toBe(false);

    await host.revoke("storage", "test revocation");
    expect(pages.hasPage("/settings/storage")).toBe(false);
    expect(host.business.listDomains().some((domain) => domain.id === "storage")).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await host.dispose();
  });
});
