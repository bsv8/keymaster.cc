import { describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient, OwnerAppStorageGrant } from "@keymaster/contracts";
import { StorageRpcProxy } from "./storageRpcProxy.js";

const context: OwnerAppStorageGrant = {
  connectSessionId: "session-a", transportOrigin: "https://app.example",
  appIdentity: { version: 1, publisherPublicKeyHex: "02" + "11".repeat(32), appId: "app-a", appName: "App A", identityDigestHex: "aa".repeat(32) },
  bucketId: "bucket", bucketGeneration: 1, ownerPublicKeyHex: "02" + "33".repeat(32),
  applicationStorageId: "app-storage-a", sessionEpoch: "epoch-a"
};

function coordinator() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribeTopic: vi.fn((_topic: string, listener: (event: unknown) => void) => { listeners.add(listener); listener({ topic: "storage.state", sessionEpoch: "epoch-a", status: "ready", summary: null, capabilities: null }); return () => listeners.delete(listener); }),
    storageGrant: vi.fn(async () => ({ status: "ok", value: "grant-a", sessionEpoch: "epoch-a" })),
    storageData: vi.fn(async (data: unknown) => ({ status: "ok", value: { path: (data as { input?: { path?: string } }).input?.path ?? "file" }, sessionEpoch: "epoch-a" })),
    storageControl: vi.fn(async () => ({ status: "ok", value: null, sessionEpoch: "epoch-a" })),
    storageCancel: vi.fn(async () => ({ status: "ok" })),
    storageSessionAbort: vi.fn(async () => ({ status: "ok" })),
  } as unknown as SessionCoordinatorClient;
}

describe("StorageRpcProxy grant boundary", () => {
  it("preserves the Coordinator provider diagnostic for the settings UI", async () => {
    const client = coordinator();
    vi.spyOn(client, "storageControl").mockResolvedValue({ status: "error", code: "storage_unavailable", message: "Storage provider CORS request failed" });
    const proxy = new StorageRpcProxy(client);

    await expect(proxy.probeProvider({
      providerId: "cloudflare-r2",
      connection: { accountId: "ab".repeat(16), endpointVariant: "default", bucket: "bucket" },
      credentials: { mode: "replace", accessKeyId: "access", secretAccessKey: "secret" }
    })).rejects.toThrow("Storage provider CORS request failed");
    proxy.dispose();
  });

  it("registers an opaque grant and never sends OwnerAppStorageGrant on data RPC", async () => {
    const client = coordinator();
    const proxy = new StorageRpcProxy(client);
    await proxy.list(context, { prefix: "docs" });
    expect(client.storageGrant).toHaveBeenCalledWith(context);
    const request = vi.mocked(client.storageData).mock.calls[0]?.[0] as { grantId?: string; context?: unknown };
    expect(request.grantId).toBe("grant-a");
    expect(request.context).toBeUndefined();
    proxy.dispose();
  });

  it("reuses the grant for the same verified session binding", async () => {
    const client = coordinator();
    const proxy = new StorageRpcProxy(client);
    await proxy.list(context, {});
    await proxy.list(context, {});
    expect(client.storageGrant).toHaveBeenCalledTimes(1);
    proxy.dispose();
  });

  it("clears grants on epoch change and retries after rejected grant", async () => {
    const client = coordinator();
    let rejectGrant = true;
    vi.spyOn(client, "storageGrant").mockImplementation(async () => rejectGrant ? ({ status: "error", code: "storage_identity_required", message: "invalid" } as never) : ({ status: "ok", value: "grant-b", sessionEpoch: "epoch-b" }));
    const proxy = new StorageRpcProxy(client);
    await expect(proxy.list(context, {})).rejects.toThrow();
    rejectGrant = false;
    await proxy.list(context, {});
    expect(client.storageGrant).toHaveBeenCalledTimes(2);
    const listener = (client.subscribeTopic as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls[0]?.[1] as ((event: unknown) => void);
    listener({ topic: "storage.state", sessionEpoch: "epoch-b", status: "ready", summary: null, capabilities: null });
    await proxy.list(context, {});
    expect(client.storageGrant).toHaveBeenCalledTimes(3);
    proxy.dispose();
  });

  it("maps pre-abort to storage_unavailable and cancels capability probes", async () => {
    const client = coordinator();
    const controller = new AbortController(); controller.abort();
    const proxy = new StorageRpcProxy(client);
    await expect(proxy.list(context, { signal: controller.signal })).rejects.toMatchObject({ code: "storage_unavailable" });
    const probeController = new AbortController();
    const probe = proxy.probeConditionalCapabilities(probeController.signal);
    probeController.abort();
    await probe;
    expect(client.storageControl).toHaveBeenCalledWith({ type: "cancel-probe" });
    proxy.dispose();
  });
});
