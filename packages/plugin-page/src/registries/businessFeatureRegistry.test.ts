import { describe, expect, it } from "vitest";
import { createBusinessFeatureRegistry } from "./businessFeatureRegistry.js";

const domain = (id: string, order: number, owner = "assets") => ({
  id, label: { key: `${id}.label`, fallback: id }, order,
  features: [{
    id: `${id}.feature`, label: { key: `${id}.feature`, fallback: "Feature" }, order: 1,
    entry: { path: `/${id}`, routeId: `${id}.route` }
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
    expect(() => registry.registerFeature("other", "assets", { ...domain("invalid", 1).features[0]!, home: [] } as never)).toThrow(/navigation metadata/);
    registry.unregisterDomain("assets");
    expect(registry.listFeatures()).toEqual([]);
  });

  it("keeps appended features visible when the target domain is registered first", () => {
    const registry = createBusinessFeatureRegistry();
    registry.register("assets", {
      id: "assets",
      label: { key: "assets.label", fallback: "Wallet" },
      order: 20,
      features: []
    });
    registry.registerFeature("token-bsv21", "assets", {
      id: "assets.bsv21",
      label: { key: "bsv21.menu.mint", fallback: "Create BSV-21" },
      order: 25,
      entry: { path: "/assets/bsv21/create", routeId: "fixture.route" }
    });

    expect(registry.listDomains().find((item) => item.id === "assets")?.features.map((item) => item.id))
      .toEqual(["assets.bsv21"]);
  });

  it("lets another plugin append an entry before the target domain is registered", () => {
    const registry = createBusinessFeatureRegistry();
    registry.registerFeature("vault", "settings", {
      id: "settings.vault",
      label: { key: "vault.settings", fallback: "Key management" },
      order: 15,
      entry: { path: "/settings/vault", routeId: "fixture.route" }
    });

    // 未加载 settings 域前，入口不应被导航读取到。
    expect(registry.listFeatures()).toEqual([]);

    registry.register("settings", domain("settings", 900, "settings"));
    expect(registry.listDomains().find((item) => item.id === "settings")?.features.map((item) => item.id))
      .toEqual(["settings.feature", "settings.vault"]);

    registry.unregisterFeature("settings.vault");
    expect(registry.listFeatures().map((item) => item.id)).toEqual(["settings.feature"]);
  });

  it("keeps appended entries pending when their domain unloads", () => {
    const registry = createBusinessFeatureRegistry();
    registry.register("settings", domain("settings", 900, "settings"));
    registry.registerFeature("vault", "settings", {
      id: "settings.vault",
      label: { key: "vault.settings", fallback: "Key management" },
      order: 15,
      entry: { path: "/settings/vault", routeId: "fixture.route" }
    });

    registry.unregisterDomain("settings");
    expect(registry.listFeatures()).toEqual([]);
    registry.register("settings", domain("settings", 900, "settings"));
    expect(registry.listFeatures().map((item) => item.id)).toEqual(["settings.feature", "settings.vault"]);
  });

  it("shows appended home entries once the home domain loads, in their declared order", () => {
    const registry = createBusinessFeatureRegistry();
    registry.registerFeature("message", "home", {
      id: "home.messages", label: { key: "message.menu", fallback: "Messages" }, order: 70,
      entry: { path: "/messages", routeId: "fixture.route" }
    });
    registry.registerFeature("contacts", "home", {
      id: "home.contacts", label: { key: "contacts.menu", fallback: "Contacts" }, order: 60,
      entry: { path: "/contacts", routeId: "fixture.route" }
    });
    registry.registerFeature("apps", "home", {
      id: "home.apps", label: { key: "apps.menu", fallback: "Apps" }, order: 50,
      entry: { path: "/apps", routeId: "fixture.route" }
    });
    registry.register("home", domain("home", 0, "home"));

    expect(registry.listDomains()[0]?.features.map((feature) => feature.id))
      .toEqual(["home.feature", "home.apps", "home.contacts", "home.messages"]);
  });
});
