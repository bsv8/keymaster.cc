import { describe, expect, it } from "vitest";
import { createSystemStatusRegistry } from "./systemStatusRegistry.js";

const Component = () => null;

describe("system status registry", () => {
  it("orders registered system modules and rejects duplicate hooks", () => {
    const registry = createSystemStatusRegistry();
    registry.register({
      id: "appmsg.status",
      path: "/system/appmsg",
      label: { key: "appmsg", fallback: "AppMsg" },
      component: Component,
      order: 20
    });
    registry.register({
      id: "broadcast.status",
      path: "/system/broadcast",
      label: { key: "broadcast", fallback: "Broadcast" },
      component: Component,
      order: 10
    });

    expect(registry.list().map((module) => module.id)).toEqual([
      "broadcast.status",
      "appmsg.status"
    ]);
    expect(() => registry.register({
      id: "broadcast.status",
      path: "/system/broadcast",
      label: { key: "broadcast", fallback: "Broadcast" },
      component: Component,
      order: 10
    })).toThrow('System status module id "broadcast.status" is already registered');
  });
});
