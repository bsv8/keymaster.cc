import { describe, expect, it } from "vitest";
import { CHANNEL_RUNTIME_CAPABILITY } from "@keymaster/contracts";
import { bsvPricePlugin } from "./manifest.js";

describe("bsvPricePlugin", () => {
  it("declares the Coordinator Channel runtime as its only transport dependency", () => {
    const dependencies = bsvPricePlugin.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toContain(CHANNEL_RUNTIME_CAPABILITY);
    expect(dependencies.map((dependency) => dependency.capability)).not.toContain("broadcast.core");
    expect(bsvPricePlugin.description).toContain("Channel");
  });
});
