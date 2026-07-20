import { describe, expect, it } from "vitest";
import { countRender, getRenderCount, resetRenderCounters } from "./renderCounter.js";

describe("renderCounter", () => {
  it("counts and resets test renders", () => {
    resetRenderCounters();
    countRender("test.component");
    countRender("test.component");
    expect(getRenderCount("test.component")).toBe(2);
    resetRenderCounters();
    expect(getRenderCount("test.component")).toBe(0);
  });
});
