import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RuntimeDiagnosticsView } from "@keymaster/contracts";
import { SettingsDiagnosticsProvider, useSettingsDiagnostics } from "./SettingsDiagnosticsContext.js";
afterEach(cleanup);
it("does not read a revoked public diagnostics view during React's final snapshot check", () => {
  let active = true;
  let notify = () => {};
  let reads = 0;
  const assert = () => { if (!active) throw new Error("revoked diagnostics"); reads++; };
  const view: RuntimeDiagnosticsView = {
    revision() { assert(); return 1; },
    subscribe(listener) { assert(); notify = listener; return () => {}; },
    snapshot() { assert(); return { graph: { plugins: [], dependencies: {}, provides: {}, reverse: {} }, plugins: [] }; },
    async retry() { assert(); },
  };
  function Panel() { const diagnostics = useSettingsDiagnostics(); return <div>{diagnostics.plugins.length} plugins</div>; }
  render(<SettingsDiagnosticsProvider view={view} isActive={() => active}><Panel /></SettingsDiagnosticsProvider>);
  const before = reads;
  act(() => { active = false; notify(); });
  expect(screen.getByText("0 plugins")).toBeTruthy();
  expect(reads).toBe(before);
  expect(() => view.snapshot()).toThrow("revoked diagnostics");
});
