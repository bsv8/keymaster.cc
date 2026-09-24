import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BsvChainSettingsPage } from "./bsvChain.js";

vi.mock("@keymaster/plugin-p2pkh/settings-page", () => ({
  P2pkhSettingsPage: () => <div>P2PKH settings content</div>
}));

vi.mock("@keymaster/plugin-woc/settings-page", () => ({
  WocSettingsPage: () => <div>WOC settings content</div>
}));

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
    })
  };
});

afterEach(() => cleanup());

describe("BsvChainSettingsPage", () => {
  it("combines P2PKH and WOC settings under one page", () => {
    render(<BsvChainSettingsPage />);

    expect(screen.getByRole("heading", { name: "BSV Chain" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "P2PKH" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "WOC" })).toBeTruthy();
    expect(screen.getByText("P2PKH settings content")).toBeTruthy();
    expect(screen.getByText("WOC settings content")).toBeTruthy();
  });
});
