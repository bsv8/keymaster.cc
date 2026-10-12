import { describe, expect, it, vi } from "vitest";
import type { CapabilityClient } from "webloom-framework";
import { createIndexedDbWalletStore } from "../local/indexedDbWalletStore.js";
import { createPlatformRootStore } from "../storage-access/platform-root/platformRootStore.js";
import { StorageBrowseCoordinator } from "./storageBrowseCoordinator.js";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY, type StorageBrowsePrivateRequest } from "./storageBrowsePrivateCapability.js";
import { StorageBrowseRpcProxy } from "./storageBrowseRpcProxy.js";

async function harness() {
  const store = createIndexedDbWalletStore({ databaseName: `browse-proxy-${crypto.randomUUID()}` });
  await store.put("notes.txt", new TextEncoder().encode("hello"));
  const state = { walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1", unlocked: true };
  const root = createPlatformRootStore({
    identity: { bsvNetwork: "main", publicKeyHex: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
    store, generations: () => state,
  });
  const coordinator = new StorageBrowseCoordinator({
    root: () => ({ store: root, token: root }), generations: () => state,
    isUnlocked: () => state.unlocked, isPeerOpen: () => true, isPeerRevoked: () => false, withReadLease: task => task(),
  });
  const call = vi.fn(async (request: StorageBrowsePrivateRequest) => {
    try {
      const { requestId: _id, ...response } = await coordinator.execute({ ...request, clientId: "page", requestId: crypto.randomUUID() }, "page");
      return response;
    } catch (error) {
      return { sessionEpoch: state.sessionEpoch, ack: { status: "error", code: (error as { code: string }).code, message: (error as Error).message } };
    }
  });
  const proxy = new StorageBrowseRpcProxy({
    client: () => ({ call }) as unknown as CapabilityClient<typeof STORAGE_PRIVATE_BROWSE_CAPABILITY>,
    sessionEpoch: () => state.sessionEpoch,
  });
  return { state, coordinator, call, proxy, close() { proxy.dispose(); coordinator.dropBinding(); store.close(); } };
}

describe("Storage browse proxy recovery", () => {
  it("lists on the first request after a lock/unlock cycle using a new session", async () => {
    const h = await harness();
    try {
      await expect(h.proxy.list({ prefix: "" })).resolves.toMatchObject({ entries: [{ path: "notes.txt" }] });
      const previous = h.proxy.currentSession()!;
      h.state.unlocked = false;
      h.state.sessionEpoch = "locked";
      h.coordinator.revokeAll();
      h.state.unlocked = true;
      h.state.sessionEpoch = "epoch-2";
      h.call.mockClear();
      await expect(h.proxy.list({ prefix: "" })).resolves.toMatchObject({ entries: [{ path: "notes.txt" }] });
      expect(h.proxy.currentSession()!.browseSessionId).not.toBe(previous.browseSessionId);
      expect(h.call.mock.calls.map(([request]) => request.kind)).toEqual(["storage.browse.open", "storage.browse.data"]);
      expect(h.call.mock.calls[1]?.[0]).toMatchObject({ expectedSessionEpoch: "epoch-2", data: { browseSessionId: h.proxy.currentSession()!.browseSessionId } });
    } finally { h.close(); }
  });

  it("recovers a revoked session without an epoch event for listing and preview", async () => {
    const h = await harness();
    try {
      await h.proxy.list({ prefix: "" });
      h.coordinator.revokeAll();
      await expect(h.proxy.list({ prefix: "" })).resolves.toMatchObject({ entries: [{ path: "notes.txt" }] });
      h.coordinator.revokeAll();
      await expect(h.proxy.preview({ path: "notes.txt" })).resolves.toMatchObject({ path: "notes.txt", format: "text" });
    } finally { h.close(); }
  });

  it("refuses reads while locked and recovers on unlock", async () => {
    const h = await harness();
    try {
      await h.proxy.list({ prefix: "" });
      h.state.unlocked = false;
      h.coordinator.revokeAll();
      await expect(h.proxy.list({ prefix: "" })).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(h.proxy.currentSession()).toBeUndefined();
      h.state.unlocked = true;
      await expect(h.proxy.list({ prefix: "" })).resolves.toMatchObject({ entries: [{ path: "notes.txt" }] });
    } finally { h.close(); }
  });

  it("does not replay an old cursor against a replacement session", async () => {
    const h = await harness();
    try {
      await h.proxy.list({ prefix: "" });
      h.coordinator.revokeAll();
      h.call.mockClear();
      await expect(h.proxy.list({ prefix: "", cursor: "old-cursor" })).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(h.call).toHaveBeenCalledTimes(1);
      expect(h.proxy.currentSession()).toBeUndefined();
    } finally { h.close(); }
  });

  it("discards a late open from the old epoch without replacing the new session", async () => {
    let epoch = "epoch-1";
    const response = (sessionEpoch: string) => ({ sessionEpoch, ack: { status: "ok" as const }, operationResult: {
      browseSessionId: sessionEpoch, walletGeneration: "wallet-1", sessionEpoch, runGeneration: "run-1",
    } });
    let finish!: (value: ReturnType<typeof response>) => void;
    const call = vi.fn(async (request: StorageBrowsePrivateRequest) => request.kind === "storage.browse.open"
      ? response(request.expectedSessionEpoch) : { sessionEpoch: epoch, ack: { status: "ok" as const } });
    call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const proxy = new StorageBrowseRpcProxy({
      client: () => ({ call }) as unknown as CapabilityClient<typeof STORAGE_PRIVATE_BROWSE_CAPABILITY>, sessionEpoch: () => epoch,
    });
    try {
      const old = proxy.openSession();
      const rejected = expect(old).rejects.toMatchObject({ code: "storage_unavailable" });
      epoch = "epoch-2";
      const current = await proxy.openSession();
      finish(response("epoch-1"));
      await rejected;
      expect(proxy.currentSession()).toEqual(current);
      expect(call).toHaveBeenCalledWith({ kind: "storage.browse.close", browseSessionId: "epoch-1" }, {});
    } finally { proxy.dispose(); }
  });
});
