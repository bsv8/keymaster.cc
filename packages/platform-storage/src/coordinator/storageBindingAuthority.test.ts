import { describe, expect, it, vi } from "vitest";
import type { RemoteServiceBridge, RemoteServiceProxy } from "webloom-framework";
import type { StorageBindingCoordinatorClient, StorageOwnerGrant, StoragePlatformGrant } from "@keymaster/contracts/storage-internal";
import { createStorageBindingAuthority } from "./storageBindingAuthority.js";

const OWNER = "02" + "11".repeat(32);

function grant(): StorageOwnerGrant {
  return {
    storageGrantId: "owner-grant:1",
    bucketId: "bucket:1",
    bucketGeneration: 1,
    ownerPublicKeyHex: OWNER.toLowerCase(),
    applicationStorageId: "Background",
    ownerStorageGeneration: 1,
    sessionEpoch: "session:1",
  };
}

describe("storage binding authority service bridge", () => {
  it("uses the Coordinator MessagePort proxy for owner K-V data and never falls back when required", async () => {
    const directOwnerData = vi.fn();
    const proxyCall = vi.fn(async (request: unknown) => {
      const type = (request as { type: string }).type;
      return type === "owner.get" ? { key: "hello", value: "world", revision: 1 } : { key: "hello", revision: 1 };
    });
    const proxy = {
      reference: {
        capabilityId: "coordinator.owner-storage",
        runtime: "shared-worker",
        contractVersion: "1.0.0",
        runtimeInstanceId: "runtime:1",
        serviceInstanceId: "service:1",
        attributes: {
          authorityInstanceId: "authority:1",
          scopeId: "scope:1",
          handoverGeneration: 1,
          sessionEpoch: "session:1",
          ownerPublicKeyHex: OWNER.toLowerCase(),
          ownerGeneration: 1,
        },
        status: "ready",
        grantId: "service-grant:1",
        authorizationRevision: 1,
      },
      revoked: false,
      call: proxyCall as unknown as RemoteServiceProxy["call"],
      revoke: vi.fn(),
    } satisfies RemoteServiceProxy;
    const client = {
      getActivePublicKeyHex: () => OWNER,
      storageBindOwner: vi.fn(async () => ({ status: "ok", value: grant(), sessionEpoch: "session:1" })),
      storageOwnerData: directOwnerData,
      storageBindPlatform: vi.fn(),
      storagePlatformData: vi.fn(),
      storageDeleteOwner: vi.fn(),
    } as unknown as StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined };
    const bridge = {
      getProxy: vi.fn(() => proxy),
    } as unknown as RemoteServiceBridge;

    const authority = createStorageBindingAuthority(client, {
      serviceBridge: bridge,
      requireServiceBridge: true,
    });
    const store = await authority.openOwnerAppStore({
      pluginId: "background",
      declaration: { scope: "key", applicationStorageId: "Background", schemaVersion: 1 },
    });

    await expect(store.put("hello", "world")).resolves.toMatchObject({ revision: 1 });
    await expect(store.get("hello")).resolves.toMatchObject({ value: "world" });
    expect(proxyCall).toHaveBeenCalledTimes(2);
    expect(directOwnerData).not.toHaveBeenCalled();
    store.close();
    expect(proxy.revoke).toHaveBeenCalledWith("owner storage handle closed");
  });

  it("只在远端授权校验尚未进入物理 I/O 时重绑 platform grant", async () => {
    const firstGrant: StoragePlatformGrant = {
      platformGrantId: "platform-grant:old",
      bucketId: "bucket:1",
      bucketGeneration: 1,
      applicationStorageId: "protocol",
      schemaVersion: 1,
      sessionEpoch: "session:1",
    };
    const nextGrant: StoragePlatformGrant = { ...firstGrant, platformGrantId: "platform-grant:new" };
    const bind = vi.fn()
      .mockResolvedValueOnce({ status: "ok", value: firstGrant, sessionEpoch: "session:1" })
      .mockResolvedValueOnce({ status: "ok", value: nextGrant, sessionEpoch: "session:1" });
    const data = vi.fn()
      .mockResolvedValueOnce({ status: "error", message: "Platform storage grant is invalid" })
      .mockResolvedValueOnce({ status: "ok", value: { key: "hello", value: "world", revision: 1 }, sessionEpoch: "session:1" });
    const client = {
      getActivePublicKeyHex: () => OWNER,
      storageBindOwner: vi.fn(),
      storageOwnerData: vi.fn(),
      storageBindPlatform: bind,
      storagePlatformData: data,
      storageDeleteOwner: vi.fn(),
    } as unknown as StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined };

    const store = await createStorageBindingAuthority(client).openPlatformStore({
      pluginId: "protocol",
      applicationStorageId: "protocol",
      schemaVersion: 1,
    });

    await expect(store.get("hello")).resolves.toMatchObject({ value: "world" });
    expect(bind).toHaveBeenCalledTimes(2);
    expect(data).toHaveBeenNthCalledWith(1, expect.objectContaining({ platformGrantId: "platform-grant:old" }));
    expect(data).toHaveBeenNthCalledWith(2, expect.objectContaining({ platformGrantId: "platform-grant:new" }));
  });

  it("物理 I/O 已可能开始时不重放 platform 写入", async () => {
    const platformGrant: StoragePlatformGrant = {
      platformGrantId: "platform-grant:one-shot",
      bucketId: "bucket:1",
      bucketGeneration: 1,
      applicationStorageId: "protocol",
      schemaVersion: 1,
      sessionEpoch: "session:1",
    };
    const bind = vi.fn(async () => ({ status: "ok", value: platformGrant, sessionEpoch: "session:1" }));
    const data = vi.fn(async () => ({ status: "error", message: "Platform storage binding became stale" }));
    const client = {
      getActivePublicKeyHex: () => OWNER,
      storageBindOwner: vi.fn(),
      storageOwnerData: vi.fn(),
      storageBindPlatform: bind,
      storagePlatformData: data,
      storageDeleteOwner: vi.fn(),
    } as unknown as StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined };
    const store = await createStorageBindingAuthority(client).openPlatformStore({ pluginId: "protocol", applicationStorageId: "protocol", schemaVersion: 1 });

    await expect(store.put("one-shot", "value")).rejects.toThrow("Platform storage binding became stale");
    expect(bind).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledTimes(1);
  });
});
