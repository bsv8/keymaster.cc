import { describe, expect, it, vi } from "vitest";
import { deriveThirdPartyStorageModuleId } from "@keymaster/contracts";
import type { PendingPasswordRotationViewV1, SessionCoordinatorClient, OwnerAppStorageGrant, StorageBucketPasswordRotationResumeResultV1 } from "@keymaster/contracts";
import { StorageRpcProxy } from "./storageRpcProxy.js";

const context: OwnerAppStorageGrant = {
  connectSessionId: "session-a", transportOrigin: "https://app.example",
  appIdentity: { version: 1, publisherPublicKeyHex: "02" + "11".repeat(32), appId: "app-a", appName: "App A", identityDigestHex: "aa".repeat(32) },
  bucketId: "bucket", bucketGeneration: 1, ownerPublicKeyHex: "02" + "33".repeat(32),
  moduleId: deriveThirdPartyStorageModuleId("02" + "11".repeat(32), "app-a"), purposeId: "files", sessionEpoch: "epoch-a"
};

function coordinator() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribeTopic: vi.fn((_topic: string, listener: (event: unknown) => void) => { listeners.add(listener); listener({ topic: "storage.state", sessionEpoch: "epoch-a", status: "ready", summary: null, capabilities: null }); return () => listeners.delete(listener); }),
    storageGrant: vi.fn(async () => ({ status: "ok", value: "grant-a", sessionEpoch: "epoch-a" })),
    storageData: vi.fn(async (data: unknown) => ({ status: "ok", value: { path: (data as { input?: { path?: string } }).input?.path ?? "file" }, sessionEpoch: "epoch-a" })),
    storageControl: vi.fn(async () => ({ status: "ok", value: null, sessionEpoch: "epoch-a" })),
    refreshStorageBootstrap: vi.fn(async () => undefined),
    storageCancel: vi.fn(async () => ({ status: "ok" })),
    storageSessionAbort: vi.fn(async () => ({ status: "ok" })),
  } as unknown as SessionCoordinatorClient;
}

describe("StorageRpcProxy grant boundary", () => {
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

  it("routes current bucket rename through the Coordinator control plane", async () => {
    const client = coordinator();
    const proxy = new StorageRpcProxy(client);

    await proxy.renameBucket("新名称");

    expect(client.storageControl).toHaveBeenCalledWith({ type: "rename-bucket", label: "新名称" });
    proxy.dispose();
  });

  it("通过 Coordinator 暴露待恢复轮转并提交恢复命令", async () => {
    const client = coordinator();
    const rotation: PendingPasswordRotationViewV1 = {
      format: "keymaster.storage.password-rotation-view",
      version: 1,
      operationId: "rotation-proxy-001",
      bucketId: "bucket-proxy-001",
      backend: "local",
      phase: "manifest-unconfirmed",
      createdAt: 1,
      updatedAt: 2,
    };
    const resumeResult = { ok: true, outcome: "completed", bucket: {} } as unknown as StorageBucketPasswordRotationResumeResultV1;
    vi.mocked(client.storageControl).mockImplementation(async (control) => {
      if (control.type === "list-pending-password-rotations") {
        return { status: "ok", value: [rotation], sessionEpoch: "epoch-a" } as never;
      }
      if (control.type === "resume-bucket-password-rotation") {
        return { status: "ok", value: resumeResult, sessionEpoch: "epoch-a" } as never;
      }
      return { status: "ok", value: null, sessionEpoch: "epoch-a" } as never;
    });
    const proxy = new StorageRpcProxy(client);

    await expect(proxy.listPendingPasswordRotations()).resolves.toEqual([rotation]);
    await expect(proxy.resumeBucketPasswordRotation("rotation-proxy-001", "old-password", "new-password"))
      .resolves.toBe(resumeResult);
    expect(client.storageControl).toHaveBeenNthCalledWith(1, { type: "list-pending-password-rotations" });
    expect(client.storageControl).toHaveBeenNthCalledWith(2, {
      type: "resume-bucket-password-rotation",
      operationId: "rotation-proxy-001",
      oldPassword: "old-password",
      newPassword: "new-password",
    });
    proxy.dispose();
  });

  it("refreshes the public bucket bootstrap bridge before first bucket unlock", async () => {
    const client = coordinator();
    const proxy = new StorageRpcProxy(client);

    await proxy.unlockBucket("bucket-password");

    expect(client.refreshStorageBootstrap).toHaveBeenCalledTimes(1);
    expect(client.storageControl).toHaveBeenCalledWith({ type: "unlock-bucket", password: "bucket-password" });
    const refreshOrder = vi.mocked(client.refreshStorageBootstrap!).mock.invocationCallOrder[0];
    const unlockOrder = vi.mocked(client.storageControl).mock.invocationCallOrder[0];
    expect(refreshOrder).toBeDefined();
    expect(unlockOrder).toBeDefined();
    expect(refreshOrder!).toBeLessThan(unlockOrder!);
    proxy.dispose();
  });
});
