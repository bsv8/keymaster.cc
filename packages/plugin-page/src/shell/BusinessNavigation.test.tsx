import { describe, expect, it } from "vitest";
import { isBusinessFeatureActive, sortBusinessDomains } from "./BusinessNavigation.js";

describe("BusinessNavigation", () => {
  it("uses declared Domain order and stable id tie-break", () => {
    expect(sortBusinessDomains([
      { id: "z", order: 10 }, { id: "a", order: 10 }, { id: "b", order: 1 }
    ]).map((domain) => domain.id)).toEqual(["b", "a", "z"]);
  });

  it("keeps a parent entry active for its declared child paths", () => {
    const feature = {
      id: "home.example",
      label: { key: "example.route.lobby", fallback: "Example lobby" },
      order: 30,
      entry: {
        path: "/example",
        routeId: "example.lobby",
        activeWhen: (path: string) => path.startsWith("/example/")
      }
    };
    expect(isBusinessFeatureActive(feature, "/example/table/abc")).toBe(true);
    expect(isBusinessFeatureActive(feature, "/settings/plugins")).toBe(false);
  });

  it("matches direct settings entries by exact path", () => {
    const feature = {
      id: "settings.bsv-price",
      label: { key: "bsv-price.menu", fallback: "BSV Price" },
      order: 20,
      entry: {
        path: "/settings/bsv-price",
        routeId: "bsv-price.settings"
      }
    };
    expect(isBusinessFeatureActive(feature, "/settings/bsv-price")).toBe(true);
    expect(isBusinessFeatureActive(feature, "/settings/plugins")).toBe(false);
  });
});
