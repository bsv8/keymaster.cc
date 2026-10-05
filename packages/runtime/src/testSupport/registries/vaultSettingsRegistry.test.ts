import { describe, expect, it } from "vitest";
import { createVaultSettingsRegistry } from "./vaultSettingsRegistry.js";

const Component = () => null;

describe("vault settings registry", () => {
  it("orders embedded plugin workspaces and unregisters them", () => {
    const registry = createVaultSettingsRegistry();
    registry.register({ id: "z.late", label: { key: "z", fallback: "Late" }, component: Component, order: 20 });
    registry.register({ id: "a.early", label: { key: "a", fallback: "Early" }, component: Component, order: 10 });

    expect(registry.list().map((section) => section.id)).toEqual(["a.early", "z.late"]);
    registry.unregister("a.early");
    expect(registry.list().map((section) => section.id)).toEqual(["z.late"]);
  });
});
