import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@keymaster/contracts";
import { createPluginHost } from "@keymaster/runtime";
import { createTransferFeatureCapability } from "./transferFeature.js";

describe("transfer feature contributor lifecycle", () => {
  it("removes contributor content through ctx.onDispose when disabled", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const owner: PluginManifest = {
      id: "transfer-owner-test",
      name: "Transfer owner test",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: ["feature.transfer"] },
      setup(ctx) { ctx.provide("feature.transfer", createTransferFeatureCapability()); }
    };
    const contributor: PluginManifest = {
      id: "transfer-contributor-test",
      name: "Transfer contributor test",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      dependencies: [{ capability: "feature.transfer" }],
      setup(ctx) {
        const feature = ctx.get<ReturnType<typeof createTransferFeatureCapability>>("feature.transfer");
        const off = feature.registerSource({ id: "contributor.source", order: 1, label: "Contributor source" });
        ctx.onDispose(off);
      }
    };
    await host.registerAll([owner, contributor]);
    const feature = host.capabilities.get<ReturnType<typeof createTransferFeatureCapability>>("feature.transfer");
    expect(feature.listSources().map((source) => source.id)).toEqual(["contributor.source"]);
    expect((await host.disable(contributor.id)).ok).toBe(true);
    expect(feature.listSources()).toEqual([]);
  });
});
