import { describe, expect, it } from "vitest";
import { createHomeRegistry } from "./homeRegistry.js";

describe("createHomeRegistry", () => {
  it("preserves legacy order and slot semantics", () => {
    const registry = createHomeRegistry();
    registry.register({ id: "status", title: "Status", component: () => null, slot: "aside", order: 1 });
    registry.register({ id: "portfolio-late", title: "Portfolio late", component: () => null, slot: "main", order: 20 });
    registry.register({ id: "portfolio-early", title: "Portfolio early", component: () => null, slot: "main", order: 5 });

    expect(registry.list().map((widget) => widget.id)).toEqual([
      "status", "portfolio-early", "portfolio-late"
    ]);
    expect(registry.list().find((widget) => widget.id === "status")).toEqual(
      expect.objectContaining({ slot: "aside" })
    );
  });
});
