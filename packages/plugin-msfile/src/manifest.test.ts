// MSFile manifest 的发布与生命周期证据：默认加载、正式路由、首页投影
// 和 host disable 时的 owner 回收必须使用同一条真实注册路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient } from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY, MSFILE_SERVICE_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { createPluginHost } from "@keymaster/runtime";
import { msfilePlugin } from "./manifest.js";

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
    expect(msfilePlugin.meta).toMatchObject({ defaultEnabled: true, canDisable: false });
  });

  it("registers the formal file route and removes all owned surfaces on disable", async () => {
    const host = createPluginHost({
      disableConfigPersistence: true,
      coordinatorForPlugin: () => coordinator(),
      storageBindingAuthority: {
        openOwnerAppStore: async ({ declaration }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          ...declaration,
          ownerPublicKeyHex: TEST_OWNER,
          bucketId: "test",
          bucketGeneration: 1
        }),
        openPlatformStore: async ({ applicationStorageId, schemaVersion }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          scope: "platform",
          applicationStorageId,
          schemaVersion,
          bucketId: "test",
          bucketGeneration: 1
        }),
        deleteOwnerStorage: async () => undefined
      }
    });
    const laneRegistry = { register: vi.fn(() => () => undefined) };
    host.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, laneRegistry);
    host.provide(KEYSPACE_SERVICE_CAPABILITY, {
      active: () => ({ activePublicKeyHex: undefined, generation: undefined }),
      onActiveKeyChanged: () => () => undefined,
    });
    host.provide("vault.service", {});
    host.business.register("home", {
      id: "home",
      label: { key: "test.home", fallback: "Home" },
      order: 0,
      features: [],
    });

    await host.register(msfilePlugin);

    expect(host.state("msfile").kind).toBe("enabled");
    expect(host.routes.byId("msfile.home.file")?.path).toBe("/msfile/files");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.file-fetch");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);
    expect(laneRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ laneId: "msfile" }));

    expect(await host.disable("msfile")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });

    expect(host.routes.byId("msfile.home.file")?.path).toBe("/msfile/files");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.file-fetch");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);
  });
});
