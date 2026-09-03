import { describe, expect, it } from "vitest";
import { CHANNEL_RUNTIME_CAPABILITY } from "@keymaster/contracts";
import { messagePlatformPlugin } from "./manifest.js";

describe("messagePlatformPlugin", () => {
  it("depends on the Coordinator Channel path and local key-scoped history", () => {
    expect(messagePlatformPlugin.keyScopedStorages).toEqual([
      { storageId: "history", description: "当前 owner 的本地消息历史" }
    ]);
    const dependencies = messagePlatformPlugin.dependencies ?? [];
    expect(dependencies.map((dependency) => dependency.capability)).toEqual(
      expect.arrayContaining([CHANNEL_RUNTIME_CAPABILITY, "keyspace.service"])
    );
  });
});
