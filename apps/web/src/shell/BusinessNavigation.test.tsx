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
      id: "settings.application-settings",
      label: { key: "settings.applicationSettings.title", fallback: "Application settings" },
      order: 20,
      entry: {
        path: "/settings/apps",
        component: () => null,
        activeWhen: (path: string) => path.startsWith("/settings/apps/")
      }
    };
    expect(isBusinessFeatureActive(feature, "/settings/apps/bsv-price")).toBe(true);
    expect(isBusinessFeatureActive(feature, "/settings/plugins")).toBe(false);
  });
});
