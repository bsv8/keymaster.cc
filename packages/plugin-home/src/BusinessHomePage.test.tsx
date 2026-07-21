import { describe, expect, it } from "vitest";
import { groupBusinessProjections } from "./BusinessHomePage.js";

describe("BusinessHomePage projection spaces", () => {
  it("groups and orders independent business spaces", () => {
    const make = (id: string, space: string, order: number) => ({ id, space: { id: space, order } });
    expect(groupBusinessProjections([
      make("b", "apps.applications", 20), make("a", "assets.portfolio", 10), make("c", "apps.applications", 20)
    ]).map((group) => group.map((item) => item.id))).toEqual([["a"], ["b", "c"]]);
  });
});
