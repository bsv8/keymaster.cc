import { describe, expect, it } from "vitest";
import {
  BSV_PRICE_READER_CAPABILITY,
  capabilityDescriptor,
  CHANNEL_RUNTIME_CAPABILITY
} from "@keymaster/contracts";
import { bsvPricePlugin, BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";

describe("bsvPricePlugin", () => {
  it("declares the Coordinator Channel runtime as its only transport dependency", () => {
    const dependencies = bsvPricePlugin.units?.find((unit) => unit.runtime === "window-main")?.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toContainEqual(capabilityDescriptor(CHANNEL_RUNTIME_CAPABILITY));
    expect(dependencies.map((dependency) => dependency.capability)).not.toContain("broadcast.core");
    expect(bsvPricePlugin.description).toContain("Channel");
  });

  it("provides both the full service and the cross-package reader capability", () => {
    const provides = bsvPricePlugin.units?.find((unit) => unit.runtime === "window-main")?.provides ?? [];
    expect(provides).toContainEqual(capabilityDescriptor(BSV_PRICE_SERVICE_CAPABILITY));
    expect(provides).toContainEqual(capabilityDescriptor(BSV_PRICE_READER_CAPABILITY));
  });
});
