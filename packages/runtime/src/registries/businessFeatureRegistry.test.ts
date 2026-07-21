import { describe, expect, it } from "vitest";
import { createBusinessFeatureRegistry } from "./businessFeatureRegistry.js";

const component = () => null;
const domain = (id: string, order: number, owner = "assets") => ({
  id, label: { key: `${id}.label`, fallback: id }, order,
  features: [{
    id: `${id}.feature`, label: { key: `${id}.feature`, fallback: "Feature" }, order: 1,
    entry: { path: `/${id}`, component },
    home: [{ id: `${id}.projection`, space: { id: `${owner}.portfolio` as `${string}.${string}`, label: { key: `${owner}.portfolio`, fallback: "Portfolio" }, order: 10 }, order: 2, component }]
  }]
});

describe("business feature registry", () => {
  it("sorts domains and features by declared local weights", () => {
    const registry = createBusinessFeatureRegistry();
    registry.register("assets", domain("late", 20));
    registry.register("assets", domain("early", 10));
    expect(registry.listDomains().map((item) => item.id)).toEqual(["early", "late"]);
    expect(registry.listFeatures().map((item) => item.id)).toEqual(["early.feature", "late.feature"]);
  });

  it("rejects ids and conflicting or foreign spaces, and unregisters owner content", () => {
    const registry = createBusinessFeatureRegistry();
    registry.register("assets", domain("assets", 1));
    expect(() => registry.register("other", domain("assets", 2, "other"))).toThrow(/domain id/);
    expect(() => registry.register("other", domain("foreign", 2, "assets"))).toThrow(/must be namespaced/);
    registry.unregisterDomain("assets");
    expect(registry.listFeatures()).toEqual([]);
    expect(registry.listHomeProjections()).toEqual([]);
  });
});
