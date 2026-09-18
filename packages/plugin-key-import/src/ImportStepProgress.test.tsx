// packages/plugin-key-import/src/ImportStepProgress.test.tsx
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepProgress, type StepDefinition } from "./ImportStepProgress.js";

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({
    t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key
  })
}));

const STEPS: ReadonlyArray<StepDefinition> = [
  { id: "type", labelKey: "step.type", defaultLabel: "桶类型" },
  { id: "parameters", labelKey: "step.parameters", defaultLabel: "桶参数" },
  { id: "password", labelKey: "step.password", defaultLabel: "设置密码" }
];

afterEach(() => cleanup());

describe("StepProgress", () => {
  it("starts each connector at its step and omits the connector after the final step", () => {
    render(<StepProgress steps={STEPS} currentIndex={0} doneUpToIndex={0} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(STEPS.length);
    expect(items[0]?.querySelector(".step-progress__connector")).toBeTruthy();
    expect(items[1]?.querySelector(".step-progress__connector")).toBeTruthy();
    expect(items[2]?.querySelector(".step-progress__connector")).toBeNull();
    expect(items[0]?.classList.contains("step-progress__item--current")).toBe(true);
    expect(items[0]?.querySelector(".step-progress__connector")).toBeTruthy();
  });

  it("keeps the connector after a completed or current step active in the state classes", () => {
    render(<StepProgress steps={STEPS} currentIndex={1} doneUpToIndex={1} />);

    const items = screen.getAllByRole("listitem");
    expect(items[0]?.classList.contains("step-progress__item--done")).toBe(true);
    expect(items[1]?.classList.contains("step-progress__item--current")).toBe(true);
    expect(items[2]?.classList.contains("step-progress__item--upcoming")).toBe(true);
    expect(items[0]?.querySelector(".step-progress__connector")).toBeTruthy();
    expect(items[1]?.querySelector(".step-progress__connector")).toBeTruthy();
  });
});
