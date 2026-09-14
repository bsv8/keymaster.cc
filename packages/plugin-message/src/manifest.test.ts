import { describe, expect, it } from "vitest";
import { capabilityDescriptor, CENTRAL_STORAGE_DECLARATIONS, CHANNEL_RUNTIME_CAPABILITY, KEYSPACE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { messagePlatformPlugin } from "./manifest.js";

describe("messagePlatformPlugin", () => {
  it("depends on the Coordinator Channel path and owner Message storage", () => {
    const unit = messagePlatformPlugin.units?.find((candidate) => candidate.runtime === "window-main");
    expect(unit?.storage).toEqual(
      CENTRAL_STORAGE_DECLARATIONS.messageHistory
    );
    const dependencies = unit?.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toEqual(
      expect.arrayContaining([
        capabilityDescriptor(CHANNEL_RUNTIME_CAPABILITY),
        capabilityDescriptor(KEYSPACE_SERVICE_CAPABILITY),
      ])
    );
  });
});
