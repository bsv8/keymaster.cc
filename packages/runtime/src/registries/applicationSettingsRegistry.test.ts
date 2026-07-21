import { describe, expect, it } from "vitest";
import { createApplicationSettingsRegistry } from "./applicationSettingsRegistry.js";

describe("application settings registry", () => {
  it("orders entries and removes them by id", () => {
    const registry = createApplicationSettingsRegistry();
    registry.register({ id: "z.settings", path: "/settings/apps/z", label: { key: "z", fallback: "Z" }, order: 20 });
    registry.register({ id: "a.settings", path: "/settings/apps/a", label: { key: "a", fallback: "A" }, order: 10 });
    expect(registry.list().map((item) => item.id)).toEqual(["a.settings", "z.settings"]);
    registry.unregister("a.settings");
    expect(registry.list().map((item) => item.id)).toEqual(["z.settings"]);
  });
});
