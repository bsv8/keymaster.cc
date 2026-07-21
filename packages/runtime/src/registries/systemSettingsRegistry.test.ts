import { describe, expect, it } from "vitest";
import { createSystemSettingsRegistry } from "./systemSettingsRegistry.js";

const Component = () => null;

describe("system settings registry", () => {
  it("orders hook groups and their plugin items deterministically", () => {
    const registry = createSystemSettingsRegistry();
    registry.register({
      id: "plugin-b.second",
      group: { id: "network", label: { key: "network", fallback: "Network" }, order: 20 },
      label: { key: "second", fallback: "Second" },
      component: Component,
      order: 20
    });
    registry.register({
      id: "plugin-a.first",
      group: { id: "language", label: { key: "language", fallback: "Language" }, order: 10 },
      label: { key: "first", fallback: "First" },
      component: Component,
      order: 10
    });
    registry.register({
      id: "plugin-c.network-first",
      group: { id: "network", label: { key: "network", fallback: "Network" }, order: 20 },
      label: { key: "network-first", fallback: "Network first" },
      component: Component,
      order: 10
    });

    expect(registry.list().map((item) => item.id)).toEqual([
      "plugin-a.first",
      "plugin-c.network-first",
      "plugin-b.second"
    ]);
  });

  it("rejects conflicting declarations for the same hook group", () => {
    const registry = createSystemSettingsRegistry();
    registry.register({
      id: "plugin-a.one",
      group: { id: "network", label: { key: "network", fallback: "Network" }, order: 10 },
      label: { key: "one", fallback: "One" },
      component: Component,
      order: 10
    });

    expect(() => registry.register({
      id: "plugin-b.two",
      group: { id: "network", label: { key: "network", fallback: "Network" }, order: 20 },
      label: { key: "two", fallback: "Two" },
      component: Component,
      order: 10
    })).toThrow('System settings group "network" has conflicting definitions');
  });
});
