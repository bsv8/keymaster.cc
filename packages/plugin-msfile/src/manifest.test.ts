// MSFile manifest 的发布与生命周期证据：默认加载、正式路由、首页投影
// 和 host disable 时的 owner 回收必须使用同一条真实注册路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient, WindowP2pExecutorLaneRegistry, WindowP2pExecutorLaneContext, VaultService, WindowP2pExecutorLane } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS, KEYSPACE_SERVICE_CAPABILITY, MSFILE_SERVICE_CAPABILITY, VAULT_SERVICE_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { createKeymasterPluginHost as createPluginHost } from "@keymaster/runtime";
import { msfilePlugin, msfileSetup } from "./manifest.js";
import { MSFILE_BUCKET_SERVICE_CAPABILITY } from "./msfileBucketService.js";

const TEST_OWNER = `02${"11".repeat(32)}`;

function coordinator(): SessionCoordinatorClient {
  return {
    subscribeTopic: vi.fn(() => () => undefined),
    getBootstrapSnapshot: vi.fn(() => ({ vaultStatus: "locked", sessionEpoch: "test" })),
  } as unknown as SessionCoordinatorClient;
}

describe("msfilePlugin manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is enabled by default and cannot be disabled independently of the P2P owner", () => {
    expect(msfilePlugin).toMatchObject({ defaultEnabled: true, canDisable: false });
  });

  it("registers the formal file route and removes all owned surfaces on disable", async () => {
    const host = createPluginHost({
      runtime: "window-main",
      disableConfigPersistence: true,
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: TEST_OWNER,
        sessionEpoch: "test-msfile-session:1",
        bucketGeneration: 1,
      },
      coordinatorForPlugin: () => coordinator(),
      runtimeUnitImplementationRegistry: {
        get: (pluginId, unitId) => pluginId === msfilePlugin.id && unitId === msfilePlugin.units?.[0]?.id
          ? msfileSetup
          : undefined,
      },
      storageBindingAuthority: {
        openOwnerFileStore: async () => ({
          list: async () => ({ files: [] }),
          get: async () => undefined,
          put: async () => ({}),
          delete: async () => undefined,
        }),
        openOwnerAppStore: async ({ declaration }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          ...declaration,
          ownerPublicKeyHex: TEST_OWNER,
          bucketId: "test",
          bucketGeneration: 1
        }),
        openPlatformStore: async ({ declaration }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          ...declaration,
          bucketId: "test",
          bucketGeneration: 1
        }),
        deleteOwnerStorage: async () => undefined
      }
    });
    const laneRegistry: WindowP2pExecutorLaneRegistry = {
      register: vi.fn((_lane: WindowP2pExecutorLane) => () => undefined),
      attach: vi.fn(async (_context: WindowP2pExecutorLaneContext) => undefined),
      detach: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_laneId: string, _operation: unknown, _signal: AbortSignal) => undefined),
    };
    host.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, laneRegistry);
    host.provide(KEYSPACE_SERVICE_CAPABILITY, {
      active: () => ({ activePublicKeyHex: undefined, generation: undefined }),
      onActiveKeyChanged: () => () => undefined,
    } as unknown as import("@keymaster/contracts").KeyspaceService);
    host.provide(VAULT_SERVICE_CAPABILITY, {} as unknown as VaultService);
    host.business.register("home", {
      id: "home",
      label: { key: "test.home", fallback: "Home" },
      order: 0,
      features: [],
    });

    await host.register(msfilePlugin);

    expect(host.state("msfile").kind).toBe("enabled");
    expect(host.routes.byId("msfile.home.file")?.path).toBe("/msfile/files");
    expect(host.routes.byId("msfile.bucket.storage")?.path).toBe("/msfile/storage");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.file-fetch");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.bucket-storage");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);
    expect(host.capabilities.has(MSFILE_BUCKET_SERVICE_CAPABILITY)).toBe(true);
    expect(laneRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ laneId: "msfile" }));

    expect(await host.disable("msfile")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });

    expect(host.routes.byId("msfile.home.file")?.path).toBe("/msfile/files");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.file-fetch");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);
  });
});
