import { describe, expect, it } from "vitest";
import { createMenuRegistry } from "./menuRegistry.js";

describe("createMenuRegistry", () => {
  it("preserves legacy group/order semantics", () => {
    const registry = createMenuRegistry();
    registry.register({ id: "system", label: "System", group: "system", order: 1 });
    registry.register({ id: "wallet-late", label: "Wallet late", group: "wallets", order: 20 });
    registry.register({ id: "overview", label: "Overview", group: "home", order: 99 });
    registry.register({ id: "wallet-early", label: "Wallet early", group: "wallets", order: 5 });

    expect(registry.list().map((item) => item.id)).toEqual([
      "overview",
      "system",
      "wallet-early",
      "wallet-late",
    ]);
  });

  it("does not normalize legacy groups into business sections", () => {
    const registry = createMenuRegistry();
    registry.register({ id: "legacy", label: "Legacy", group: "wallets", order: 1 });

    expect(registry.list()[0]).toEqual(expect.objectContaining({ group: "wallets" }));
  });
});
