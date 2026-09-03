import { describe, expect, it } from "vitest";
import { createSystemStatusRegistry } from "./systemStatusRegistry.js";

const Component = () => null;

describe("system status registry", () => {
  it("orders registered system modules and rejects duplicate hooks", () => {
    const registry = createSystemStatusRegistry();
    registry.register({
      id: "module-a.status",
      path: "/system/module-a",
      label: { key: "module-a", fallback: "Module A" },
      component: Component,
      order: 20
    });
    registry.register({
      id: "module-b.status",
      path: "/system/module-b",
      label: { key: "module-b", fallback: "Module B" },
      component: Component,
      order: 10
    });

    expect(registry.list().map((module) => module.id)).toEqual([
      "module-b.status",
      "module-a.status"
    ]);
    expect(() => registry.register({
      id: "module-b.status",
      path: "/system/module-b",
      label: { key: "module-b", fallback: "Module B" },
      component: Component,
      order: 10
    })).toThrow('System status module id "module-b.status" is already registered');
  });
});
