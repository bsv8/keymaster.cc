import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
// MSFile manifest 的发布与生命周期证据：默认加载、正式路由、首页投影
// 和 host disable 时的 owner 回收必须使用同一条真实注册路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient, WindowP2pExecutorLaneRegistry, WindowP2pExecutorLaneContext, VaultService, WindowP2pExecutorLane } from "@keymaster/contracts";
import { BUSINESS_REGISTRY_CAPABILITY, type PluginContext, CENTRAL_STORAGE_DECLARATIONS, VAULT_WALLET_STATE_CAPABILITY, MSFILE_SERVICE_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, VAULT_SERVICE_CAPABILITY, WINDOW_P2P_EXECUTOR_CAPABILITY } from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";

import { msfilePlugin, msfileSetup } from "@keymaster/plugin-msfile";
import { MSFILE_BUCKET_SERVICE_CAPABILITY } from "@keymaster/plugin-msfile";

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

  it("registers the formal file route and removes all owned surfaces on revocation", async () => {
    let pageContext!: PluginContext;
    const host = createPluginHost({
      fixtureExcludedCapabilities: ["breadcrumb.registry", "business.registry", "notice.registry"], runtime: "window-main",

      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: TEST_OWNER,
        sessionEpoch: "test-msfile-session:1",
        walletGeneration: "test-msfile-wallet:1",
      },
      coordinatorForPlugin: () => coordinator(),
      runtimeUnitImplementationRegistry: {
        get: (pluginId, unitId) => pluginId === msfilePlugin.id && unitId === msfilePlugin.units?.[0]?.id
          ? msfileSetup
          : pluginId === "page" ? ctx => { pageContext = ctx; return pageSetup(ctx); } : undefined,
      },
      storageBindingAuthority: {
        openOwnerFileStore: async () => (await import("@keymaster/runtime/storage")).createInMemoryModuleFileStore(),
        openOwnerAppStore: async ({ declaration }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          ...(await import("@keymaster/runtime/storage")).withTestStorageBinding(declaration),
        }),
        openPlatformStore: async ({ declaration }) => (await import("@keymaster/runtime")).createInMemoryKeyValueStore({
          ...(await import("@keymaster/runtime/storage")).withTestStorageBinding(declaration),
        }),
        clearStorageRoot: async () => undefined
      }
    });
    const laneRegistry: WindowP2pExecutorLaneRegistry = {
      register: vi.fn((_lane: WindowP2pExecutorLane) => () => undefined),
      attach: vi.fn(async (_context: WindowP2pExecutorLaneContext) => undefined),
      detach: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_laneId: string, _operation: unknown, _signal: AbortSignal) => undefined),
    };
    host.provide(WINDOW_P2P_EXECUTOR_CAPABILITY, laneRegistry);
    host.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({
      snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: undefined, generation: undefined }))()),
      subscribe: () => () => undefined,
    } as unknown as import("@keymaster/contracts").VaultWalletState));
    host.provide(VAULT_SERVICE_CAPABILITY, {} as unknown as VaultService);
    await host.register(pagePlugin);

    await host.register(msfilePlugin);

    expect(host.state("msfile").kind).toBe("enabled");
    const published = host.capabilities.get(MSFILE_SERVICE_CAPABILITY);
    expect(Object.getPrototypeOf(published)).toBeNull();
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.getPrototypeOf(published.connect)).toBeNull();
    expect(Object.isFrozen(published.connect)).toBe(true);
    for (const hidden of ["coordinator", "control", "dataFor", "grantFor", "listeners", "grants", "statCache", "dispose"]) expect(published).not.toHaveProperty(hidden);

    const pages = host.capabilities.get(PAGE_UI_RENDERER_CAPABILITY);
    for (const path of ["/msfile/files", "/msfile/storage", "/settings/local-files"]) {
      expect(pages.hasPage(path)).toBe(true);
      expect(host.routes.byPath(path)).toBeUndefined();
    }
    expect(host.business.listDomains().find((domain) => domain.id === "settings")?.features.map((feature) => feature.id)).toContain("settings.msfile");
    expect(Object.prototype.hasOwnProperty.call(host, "systemSettings")).toBe(false);
    expect(host.breadcrumbs.match("/settings/local-files")?.id).toBe("msfile.settings.crumbs");
    expect(pages.renderHome("main", true)).toBeTruthy();
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);
    expect(host.capabilities.has(MSFILE_BUCKET_SERVICE_CAPABILITY)).toBe(true);
    expect(laneRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ laneId: "msfile" }));

    await host.revoke("msfile", "test revocation");

    expect(host.state("msfile").kind).toBe("blocked");
    expect(pages.hasPage("/msfile/files")).toBe(false);
    expect(pages.hasPage("/msfile/storage")).toBe(false);
    expect(pages.hasPage("/settings/local-files")).toBe(false);
    expect(host.routes.byId("msfile.home.file")).toBeUndefined();
    expect(host.routes.byId("msfile.settings")).toBeUndefined();
    expect(host.business.listDomains().find((domain) => domain.id === "settings")?.features.map((feature) => feature.id)).not.toContain("settings.msfile");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(false);
    await host.dispose();
  });
});
