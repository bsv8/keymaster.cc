import { describe, expect, it } from "vitest";
import { sortBusinessDomains } from "./BusinessNavigation.js";

describe("BusinessNavigation", () => {
  it("uses declared Domain order and stable id tie-break", () => {
    expect(sortBusinessDomains([
      { id: "z", order: 10 }, { id: "a", order: 10 }, { id: "b", order: 1 }
    ]).map((domain) => domain.id)).toEqual(["b", "a", "z"]);
  });
});
