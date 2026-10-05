import { describe, expect, it } from "vitest";
import { createContactPublicKeyActionRegistry } from "./contactPublicKeyActionRegistry.js";

const action = (id: string, order: number) => ({
  id, order, label: { key: id, fallback: id }, run: () => undefined
});

describe("contact public-key action registry", () => {
  it("sorts by order then id and supports get", () => {
    const registry = createContactPublicKeyActionRegistry();
    registry.register(action("z", 10));
    registry.register(action("a", 10));
    registry.register(action("b", 1));
    expect(registry.list().map((item) => item.id)).toEqual(["b", "a", "z"]);
    expect(registry.get("a")?.id).toBe("a");
  });

  it("rejects duplicate and missing unregister", () => {
    const registry = createContactPublicKeyActionRegistry();
    registry.register(action("same", 1));
    expect(() => registry.register(action("same", 2))).toThrow(/already registered/);
    expect(() => registry.unregister("missing")).toThrow(/not registered/);
    registry.unregister("same");
    expect(registry._ids()).toEqual([]);
  });
});
