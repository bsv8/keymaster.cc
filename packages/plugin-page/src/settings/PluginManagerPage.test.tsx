// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BUILTIN_PLUGIN_PRODUCT_IDS } from "@keymaster/contracts";
import { PluginManagerPage } from "./PluginManagerPage.js";
vi.mock("@keymaster/runtime", () => ({ usePluginI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./SettingsDiagnosticsContext.js", () => ({ useSettingsDiagnostics: () => ({ plugins: [{ id: "protocol", kind: "enabled" }], retry: vi.fn() }) }));
afterEach(cleanup);

describe("plugin dependency explorer", () => {
  it("shows a graph without enabled labels and opens keyboard-accessible function details", () => {
    render(<PluginManagerPage />);
    // 节点数跟随中央产品目录，新增产品时这条断言不需要改魔法数字。
    expect(document.querySelectorAll("[data-plugin-id]")).toHaveLength(BUILTIN_PLUGIN_PRODUCT_IDS.length);
    expect(screen.queryByText("enabled")).toBeNull();
    const node = document.querySelector('[data-plugin-id="protocol"]')!;
    (node as SVGElement).focus();
    fireEvent.keyDown(node, { key: "Enter" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("vault.service").length).toBeGreaterThan(0);
    fireEvent.change(within(dialog).getByLabelText("pluginManager.graph.functionSearch"), { target: { value: "verifyPassword" } });
    expect(within(dialog).getAllByText("verifyPassword()").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("unlock()")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "pluginManager.graph.incoming" }));
    fireEvent.change(within(dialog).getByLabelText("pluginManager.graph.functionSearch"), { target: { value: "launchAppView" } });
    expect(within(dialog).getAllByText("launchAppView()").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "pluginManager.graph.close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(node);
  });
  it("can reveal and hide Page links while keeping Page in the function details", () => {
    render(<PluginManagerPage />);
    expect(document.querySelectorAll('[data-dependency-provider="page"]')).toHaveLength(0);
    const toggle = screen.getByRole("checkbox", { name: "pluginManager.graph.showPage" });
    fireEvent.click(toggle);
    expect(document.querySelectorAll('[data-dependency-provider="page"]').length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(document.querySelectorAll('[data-dependency-provider="page"]')).toHaveLength(0);
    fireEvent.click(document.querySelector('[data-plugin-id="apps"]')!);
    expect(within(screen.getByRole("dialog")).getAllByText("register()").length).toBeGreaterThan(0);
  });
  it("can independently reveal and hide Vault links without filtering method details", () => {
    render(<PluginManagerPage />);
    expect(document.querySelectorAll('[data-dependency-provider="vault"]')).toHaveLength(0);
    const vault = screen.getByRole("checkbox", { name: "pluginManager.graph.showVault" });
    fireEvent.click(vault);
    expect(document.querySelectorAll('[data-dependency-provider="vault"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-dependency-provider="page"]')).toHaveLength(0);
    fireEvent.click(vault);
    expect(document.querySelectorAll('[data-dependency-provider="vault"]')).toHaveLength(0);
    fireEvent.click(document.querySelector('[data-plugin-id="protocol"]')!);
    expect(within(screen.getByRole("dialog")).getAllByText("verifyPassword()").length).toBeGreaterThan(0);
  });
  it("can search the overview and reports an empty search", () => {
    render(<PluginManagerPage />);
    fireEvent.change(screen.getByLabelText("pluginManager.graph.search"), { target: { value: "unknown-plugin" } });
    expect(screen.getByRole("status").textContent).toBe("pluginManager.graph.empty");
    expect(document.querySelector('[data-plugin-id="vault"]')?.classList.contains("is-dimmed")).toBe(true);
  });
});
