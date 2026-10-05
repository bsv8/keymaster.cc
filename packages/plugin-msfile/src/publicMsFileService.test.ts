import { expect, it, vi } from "vitest";
import { createLifecycleScope } from "webloom-framework";
import type { MsFileCoordinatorControl, MsFileStatResult } from "@keymaster/contracts";
import { MsFileServiceProxy } from "./msfileServiceProxy.js";
import { createPublicMsFileService } from "./publicMsFileService.js";
it("hides Coordinator and private proxy methods at runtime, including its prototype and connect child", async () => {
  const control = vi.fn(async () => ({ status: "ok", value: undefined }));
  const coordinator = { subscribeTopic: () => () => {}, msfileControl: control } as unknown as MsFileCoordinatorControl;
  const internal = new MsFileServiceProxy(coordinator);
  const scope = createLifecycleScope({ kind: "runtime-unit" });
  const view = createPublicMsFileService(internal, () => scope.assertActive());
  for (const value of [view, view.connect]) {
    expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.get(value, "coordinator")).toBeUndefined();
    expect(Reflect.get(value, "control")).toBeUndefined();
    expect(Reflect.get(value, "dispose")).toBeUndefined();
  }
  expect(Reflect.get(internal, "coordinator")).toBeUndefined();
  expect(Reflect.get(Object.getPrototypeOf(internal), "control")).toBeUndefined();
  await view.updateGlobalPriceSettings({ seedPriceSatoshis: "0", fullBlockPriceSatoshis: "0" } as never);
  expect(control).toHaveBeenCalledOnce();
  scope.revoke();
  expect(() => view.status()).toThrow();
  expect(() => view.updateGlobalPriceSettings({} as never)).toThrow();
  expect(() => view.connect.stat({} as never, { seedHashHex: "ab".repeat(32) })).toThrow();
  expect(control).toHaveBeenCalledOnce();
  internal.dispose(); await scope.dispose();
});
it("rejects a pending public read after provider withdrawal, while retaining session identity", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const coordinator = { subscribeTopic: () => () => {}, msfileData: () => pending } as unknown as MsFileCoordinatorControl;
  const internal = new MsFileServiceProxy(coordinator);
  const scope = createLifecycleScope({ kind: "runtime-unit" });
  const view = createPublicMsFileService(internal, () => scope.assertActive());
  const result = view.stat({ seedHashHex: "ab".repeat(32) });
  scope.revoke();
  finish({ status: "ok", value: { seedHashHex: "ab".repeat(32), sources: [] } satisfies MsFileStatResult });
  await expect(result).rejects.toThrow();
  internal.dispose(); await scope.dispose();
});
