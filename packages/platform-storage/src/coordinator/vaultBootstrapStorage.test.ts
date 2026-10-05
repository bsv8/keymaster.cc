import { expect, it, vi } from "vitest";
import { WALLET_KEYHOLD_PATH, WALLET_META_PATH } from "@keymaster/contracts";
import { WALLET_INITIALIZATION_PATH, type WalletStore } from "@keymaster/contracts/storage-internal";
import { createVaultBootstrapStorage } from "./vaultBootstrapStorage.js";

it("denies other namespaces before physical I/O and preserves the atomic initialization boundary", async () => {
  const get = vi.fn(), put = vi.fn(), batch = vi.fn(async () => ({ paths: [], committedAt: "now" }));
  const backend = { get, put, batch, readMeta: vi.fn(), resetWallet: vi.fn() } as unknown as WalletStore;
  const ports = createVaultBootstrapStorage(backend);
  expect(() => ports.keys.get("apps/other/secret")).toThrow("Vault key path is not allowed");
  expect(() => ports.keys.put(WALLET_META_PATH, new Uint8Array())).toThrow("Vault key path is not allowed");
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  const operations = [WALLET_KEYHOLD_PATH, WALLET_META_PATH, WALLET_INITIALIZATION_PATH].map(path => ({ type: "put" as const, path, bytes: new Uint8Array([1]) }));
  expect(() => ports.lifecycle.batch({ operations: operations.slice(0, 2) })).toThrow("Vault initialization paths are not allowed");
  expect(() => ports.lifecycle.batch({ operations: [...operations.slice(0, 2), { ...operations[2]!, path: "apps/other/secret" }] })).toThrow("Vault initialization paths are not allowed");
  expect(batch).not.toHaveBeenCalled();
  await ports.lifecycle.batch({ operations });
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch).toHaveBeenCalledWith({ operations }, undefined);
  expect(Object.keys(ports.keys)).toEqual(["get", "put"]);
  expect(Object.keys(ports.lifecycle)).toEqual(["readMeta", "batch", "resetWallet"]);
});
