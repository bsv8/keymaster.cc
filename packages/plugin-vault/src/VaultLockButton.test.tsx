import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VaultLockButton } from "./VaultLockButton.js";

const fixture = vi.hoisted(() => ({
  pending: [] as {id: string; channelId: string; owner: string; purpose: string; operation: string}[],
  payment: vi.fn(),
  getCurrentKey: vi.fn(async () => ({label: "Test wallet", format: "keymaster.software-key", publicKeyHex: "02abcd"})),
}));
vi.mock("./VaultInternalContext.js", () => ({useInternalVault: () => fixture}));
vi.mock("./VaultResourceContext.js", () => ({useVaultResources: () => ({})}));
vi.mock("@keymaster/runtime", () => ({
  usePluginI18n: () => ({t: (_key: string, options: {defaultValue: string}) => options.defaultValue}),
  useResourceView: () => ({data: {status: "unlocked"}}),
}));
afterEach(() => {cleanup(); vi.useRealTimers();});
test("new requests open the wallet; closing leaves requests pending and another request reopens it", async () => {
  vi.useFakeTimers();
  fixture.pending = [];
  fixture.payment.mockImplementation(async ({action}: {action: string}) => action === "pending" ? fixture.pending : []);
  render(<VaultLockButton/>);
  await act(async () => {});
  const toggle = screen.getByRole("button", {name: "我的钱包"});
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fixture.pending = [{id: "first", channelId: "channel.one", owner: "app", purpose: "registration", operation: "channel.one"}];
  await act(async () => {await vi.advanceTimersByTimeAsync(500);});
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", {name: /^注册签名渠道/})).toBeTruthy();
  expect(screen.queryByText("Test wallet")).toBeNull();
  expect(screen.queryByText("软件钱包")).toBeNull();
  expect(screen.queryByText("02abcd")).toBeNull();
  expect(screen.queryByRole("button", {name: "消费渠道与额度"})).toBeNull();
  fireEvent.keyDown(document, {key: "Escape"});
  await act(async () => {await vi.advanceTimersByTimeAsync(500);});
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(fixture.payment.mock.calls.some(([command]) => command.action === "answer")).toBe(false);
  fixture.pending = [...fixture.pending, {id: "second", channelId: "channel.two", owner: "app", purpose: "signature", operation: "channel.two"}];
  await act(async () => {await vi.advanceTimersByTimeAsync(500);});
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByRole("button", {name: "批准"})).toHaveLength(2);
  fireEvent.pointerDown(document.body);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
