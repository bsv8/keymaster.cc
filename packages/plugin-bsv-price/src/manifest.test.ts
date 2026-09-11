import { describe, expect, it } from "vitest";
import { capabilityDescriptor, CHANNEL_RUNTIME_CAPABILITY } from "@keymaster/contracts";
import { bsvPricePlugin } from "./manifest.js";

describe("bsvPricePlugin", () => {
  it("declares the Coordinator Channel runtime as its only transport dependency", () => {
    const dependencies = bsvPricePlugin.units?.find((unit) => unit.runtime === "window-main")?.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toContainEqual(capabilityDescriptor(CHANNEL_RUNTIME_CAPABILITY));
    expect(dependencies.map((dependency) => dependency.capability)).not.toContain("broadcast.core");
    expect(bsvPricePlugin.description).toContain("Channel");
  });
});
