// apps/web/src/App.protocol.test.tsx
// 验证施工单 001 协议 V1：App.tsx 顶层特例。
//   - path 命中 /protocol/v1/popup → 渲染协议入口；
//   - path 命中时**不**被 LockedShell / UnlockedShell 吃掉；
//   - 其它路径仍走原壳层逻辑。
//
// 这是本次落地里最关键的 app 级改动之一。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { App } from "./App.js";

// 把 Runtime 状态做成可注入的 stub：避免引入完整 plugin host。
const runtimeState = vi.hoisted(() => ({
  vault: "unlocked" as "booting" | "uninitialized" | "locked" | "unlocked",
  ready: true
}));

vi.mock("@keymaster/runtime", () => ({
  useRuntimeStatus: () => ({ vault: runtimeState.vault, ready: runtimeState.ready }),
  useI18n: () => ({
    t: (key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? key,
    language: () => "en"
  })
}));

vi.mock("@keymaster/plugin-protocol", () => ({
  ProtocolPopupPage: () => <div data-testid="protocol-popup">protocol</div>
}));

vi.mock("./shell/LockedShell.js", () => ({
  LockedShell: () => <div data-testid="locked-shell">locked</div>
}));

vi.mock("./shell/UnlockedShell.js", () => ({
  UnlockedShell: () => <div data-testid="unlocked-shell">unlocked</div>
}));

function setPath(path: string) {
  window.history.replaceState(null, "", path);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  setPath("/");
  runtimeState.vault = "unlocked";
  runtimeState.ready = true;
});

describe("App protocol path", () => {
  it("renders ProtocolPopupPage at /protocol/v1/popup when vault unlocked", () => {
    runtimeState.vault = "unlocked";
    setPath("/protocol/v1/popup");
    render(<App />);
    expect(screen.getByTestId("protocol-popup")).toBeTruthy();
  });

  it("renders ProtocolPopupPage at /protocol/v1/popup when vault locked", () => {
    runtimeState.vault = "locked";
    setPath("/protocol/v1/popup");
    render(<App />);
    // 关键：locked 状态也走协议入口，不被 LockedShell 吃掉。
    expect(screen.getByTestId("protocol-popup")).toBeTruthy();
    expect(screen.queryByTestId("locked-shell")).toBeNull();
  });

  it("renders ProtocolPopupPage at /protocol/v1/popup when vault uninitialized", () => {
    runtimeState.vault = "uninitialized";
    setPath("/protocol/v1/popup");
    render(<App />);
    expect(screen.getByTestId("protocol-popup")).toBeTruthy();
    expect(screen.queryByTestId("locked-shell")).toBeNull();
  });

  it("renders LockedShell when vault locked and path is not protocol", () => {
    runtimeState.vault = "locked";
    setPath("/");
    render(<App />);
    expect(screen.getByTestId("locked-shell")).toBeTruthy();
    expect(screen.queryByTestId("protocol-popup")).toBeNull();
  });

  it("renders UnlockedShell when vault unlocked and path is not protocol", () => {
    runtimeState.vault = "unlocked";
    setPath("/");
    render(<App />);
    expect(screen.getByTestId("unlocked-shell")).toBeTruthy();
    expect(screen.queryByTestId("protocol-popup")).toBeNull();
  });
});
