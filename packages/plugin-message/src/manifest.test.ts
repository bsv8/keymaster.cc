import { describe, expect, it } from "vitest";
import { CHANNEL_RUNTIME_CAPABILITY } from "@keymaster/contracts";
import { messagePlatformPlugin } from "./manifest.js";

describe("messagePlatformPlugin", () => {
  it("depends on the Coordinator Channel path and owner Message storage", () => {
    expect(messagePlatformPlugin.storage).toEqual(
      { scope: "key", applicationStorageId: "Messages", schemaVersion: 1 }
    );
    const dependencies = messagePlatformPlugin.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toEqual(
      expect.arrayContaining([CHANNEL_RUNTIME_CAPABILITY, "keyspace.service"])
    );
  });
});
