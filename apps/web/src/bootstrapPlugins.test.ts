// apps/web/src/bootstrapPlugins.test.ts
// 启动装配层的挂死探测测试。
//
// 覆盖：
//   1. protocol 注册永久 pending 时，装配层会在时限后抛出明确错误；
//   2. 普通插件描述保持通用文案；
//   3. 正常注册不会被误判成超时。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, PluginSetup, SessionCoordinatorClient } from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { createKeymasterPluginHost as createPluginHost, type PluginHost } from "@keymaster/runtime";
import { StartupCapabilityError, StartupPluginError } from "webloom-framework";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import {
  connectCoordinatorWithStartupRetry,
  createPublicCoordinatorClient,
  createCoordinatorPlatformStore,
  createStorageCoordinatorClient,
  createVaultCoordinatorClient,
  describeBootstrapStep,
  waitForCoordinatorServiceBridge,
  registerPluginWithTimeout
} from "./bootstrapPlugins.js";
import { assertWebStartupContract, WEB_STARTUP_REQUIRED_CAPABILITIES } from "./bootstrapPlugins.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { createWebRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementations.js";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  localStorage.clear();
});

function makePlugin(id: string): PluginManifest {
  return {
    id,
    name: id,
    description: `${id} plugin`
  } as PluginManifest;
}

function makeHost(registerImpl: (plugin: PluginManifest) => Promise<void>): PluginHost {
  return {
    register: registerImpl
  } as PluginHost;
}

function makeStorageBindingAuthority(): StorageBindingAuthority {
  const open = (scope: "key" | "platform", applicationStorageId: string, ownerPublicKeyHex = "") => createInMemoryKeyValueStore({
    scope,
    ownerPublicKeyHex,
    applicationStorageId,
    schemaVersion: 1,
    bucketId: "test-memory",
    bucketGeneration: 1
  });
  return {
    openOwnerAppStore: async ({ declaration }) => open("key", declaration.applicationStorageId, "02" + "11".repeat(32)),
    openPlatformStore: async ({ applicationStorageId }) => open("platform", applicationStorageId),
    deleteOwnerStorage: async () => undefined
  };
}

describe("bootstrapPlugins hang detection", () => {
  it("adds protocol-specific platform K-V hint to startup step description", () => {
    expect(describeBootstrapStep("protocol")).toBe(
      'plugin "protocol" (opening platform K-V "protocol")'
    );
    expect(describeBootstrapStep("vault")).toBe('plugin "vault"');
  });

  it("turns permanently pending protocol bootstrap into explicit timeout error", async () => {
    vi.useFakeTimers();
    const host = makeHost(() => new Promise<void>(() => undefined));
    const promise = registerPluginWithTimeout(host, makePlugin("protocol"), 1_500);
    const assertion = expect(promise).rejects.toThrow(
      'Bootstrap timed out while registering plugin "protocol" (opening platform K-V "protocol") after 1500ms'
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
  });

  it("lets successful registration finish before timeout", async () => {
    vi.useFakeTimers();
    const host = makeHost(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        })
    );
    const promise = registerPluginWithTimeout(host, makePlugin("settings"), 1_500);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("Coordinator startup recovery", () => {
  it("does not release owner consumers before the service bridge is ready", async () => {
    let ready = false;
    const bridge = {
      get state() { return ready ? "ready" : "handshaking"; },
      services: () => ready ? [
        { capabilityId: "coordinator.owner-storage", contractVersion: "1.0.0", status: "ready", grantId: "owner-grant" },
        { capabilityId: "coordinator.crypto", contractVersion: "1.0.0", status: "ready", grantId: "crypto-grant" },
      ] : [],
    } as unknown as import("webloom-framework").RemoteServiceBridge;
    const waiting = waitForCoordinatorServiceBridge(() => bridge, 100);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ready).toBe(false);
    ready = true;
    await expect(waiting).resolves.toBe(bridge);
  });

  it("only rebinds a platform grant before the remote operation reaches physical I/O", async () => {
    const firstGrant = { platformGrantId: "platform-old", bucketId: "bucket", bucketGeneration: 1, applicationStorageId: "settings", schemaVersion: 1, sessionEpoch: "epoch", clientId: "test" };
    const secondGrant = { ...firstGrant, platformGrantId: "platform-new", bucketGeneration: 2 };
    const storageBindPlatform = vi.fn()
      .mockResolvedValueOnce({ status: "ok", value: firstGrant })
      .mockResolvedValueOnce({ status: "ok", value: secondGrant });
    const storagePlatformData = vi.fn()
      .mockResolvedValueOnce({ status: "error", message: "Platform storage bucket generation changed" })
      .mockResolvedValueOnce({ status: "ok", value: { revision: 1 } });
    const store = createCoordinatorPlatformStore({ storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient, "settings");

    await expect(store.put("key", { ok: true })).resolves.toEqual({ revision: 1 });
    expect(storageBindPlatform).toHaveBeenCalledTimes(2);
    expect(storagePlatformData.mock.calls.map(([request]) => (request as { platformGrantId: string }).platformGrantId)).toEqual(["platform-old", "platform-new"]);
  });

  it("does not replay a platform write after the final I/O boundary is stale", async () => {
    const grant = { platformGrantId: "platform-one", bucketId: "bucket", bucketGeneration: 1, applicationStorageId: "settings", schemaVersion: 1, sessionEpoch: "epoch", clientId: "test" };
    const storageBindPlatform = vi.fn().mockResolvedValue({ status: "ok", value: grant });
    const storagePlatformData = vi.fn().mockResolvedValue({ status: "error", message: "Platform storage binding became stale" });
    const store = createCoordinatorPlatformStore({ storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient, "settings");

    await expect(store.put("key", { ok: true })).rejects.toThrow("Platform storage binding became stale");
    expect(storageBindPlatform).toHaveBeenCalledTimes(1);
    expect(storagePlatformData).toHaveBeenCalledTimes(1);
  });

  it("uses frozen null-prototype coordinator facades for each trust boundary", () => {
    const rawClient = Object.create({
      vaultOperation: () => undefined,
      storageBindOwner: () => undefined,
      storageDeleteOwner: () => undefined
    }) as SessionCoordinatorClient;
    Object.assign(rawClient, {
      connect: async () => undefined,
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ keys: [] }),
      getSessionEpoch: () => "test",
      getActivePublicKeyHex: () => undefined,
      subscribeTopic: () => () => undefined,
      storageControl: async () => ({ status: "ok", value: "ready" }),
      storageGrant: async () => ({ status: "ok", value: "grant" }),
      storageData: async () => ({ status: "ok", value: undefined }),
      storageCancel: async () => ({ status: "ok" }),
      storageSessionAbort: async () => ({ status: "ok" }),
      refreshStorageBootstrap: vi.fn(async () => undefined)
    });

    const publicClient = createPublicCoordinatorClient(rawClient);
    expect(Object.getPrototypeOf(publicClient)).toBeNull();
    expect(Object.isFrozen(publicClient)).toBe(true);
    expect((publicClient as unknown as Record<string, unknown>).vaultOperation).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageBindOwner).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageDeleteOwner).toBeUndefined();

    const storageClient = createStorageCoordinatorClient(rawClient);
    expect(storageClient.storageControl).toBeTypeOf("function");
    expect(storageClient.refreshStorageBootstrap).toBeTypeOf("function");
    expect((storageClient as unknown as Record<string, unknown>).vaultOperation).toBeUndefined();

    const vaultClient = createVaultCoordinatorClient(rawClient);
    expect(vaultClient.vaultOperation).toBeTypeOf("function");
    expect((vaultClient as unknown as Record<string, unknown>).storageDeleteOwner).toBeUndefined();
  });

  it("disconnects a failed first attempt and retries once", async () => {
    vi.useFakeTimers();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("worker load failed"))
      .mockResolvedValueOnce(undefined);
    const disconnect = vi.fn();

    const pending = connectCoordinatorWithStartupRetry({ connect, disconnect }, 200);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("preserves the second failure for the fatal startup path", async () => {
    vi.useFakeTimers();
    const finalError = new Error("worker still unavailable");
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("worker load failed"))
      .mockRejectedValueOnce(finalError);
    const disconnect = vi.fn();

    const pending = connectCoordinatorWithStartupRetry({ connect, disconnect }, 200);
    const assertion = expect(pending).rejects.toBe(finalError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("web startup capability contract", () => {
  it("loads the real web catalog with the message contact action", async () => {
    const coordinatorClient = {
      connect: async () => undefined,
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({
        keys: [],
        vaultStatus: "unlocked",
        sessionEpoch: "test-session:1",
        activePublicKeyHex: undefined,
        storageBucketGeneration: 1,
      }),
      subscribeTopic: () => () => undefined,
      storageControl: async () => ({ status: "ok", value: "ready" }),
      storageGrant: async () => ({ status: "ok", value: "grant" }),
      storageData: async () => ({ status: "ok", value: undefined }),
      storageCancel: async () => ({ status: "ok" }),
      storageSessionAbort: async () => ({ status: "ok" }),
      unlock: async () => ({ ok: false }), lock: async () => ({ ok: false }),
      activateKey: async () => ({ ok: false }), vaultOperation: async () => ({ ok: false }),
      crypto: async () => ({ ack: { ok: false } }), backgroundCancelByKey: async () => ({ ok: false }),
      p2pkhProviderConfigGet: async () => ({ status: "ok", value: {} }),
      p2pkhProviderConfigUpdate: async () => ({ status: "ok" }),
      p2pkhProvidersGet: async () => ({ status: "ok", value: { main: {}, test: {}, generation: 0 } }),
      p2pkhProvidersUpdate: async () => ({ status: "ok" }),
      p2pkhSettingsUpdate: async () => ({ status: "ok" })
    } as unknown as SessionCoordinatorClient;
    const host = createPluginHost({
      disableConfigPersistence: true,
      storageBindingAuthority: makeStorageBindingAuthority(),
      coordinatorForPlugin: () => coordinatorClient,
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createWebRuntimeUnitImplementationRegistry(WEB_PLUGIN_CATALOG),
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: "02" + "11".repeat(32),
        sessionEpoch: "test-session:1",
        bucketGeneration: 1,
      }
    });
    const stage = (name: string) => WEB_PLUGIN_CATALOG.filter((plugin) => plugin.meta.bootstrapStage === name);
    host.validateManifestSet([...WEB_PLUGIN_CATALOG]);

    // 按真实装配顺序推进四道门禁：Owner 插件（含 P2PKH）不能在
    // Vault capability 建立前进入 Host；Connect 应用必须最后才注册。
    await host.registerAll(stage("storage-onboarding"));
    expect(host.getManifest("vault")).toBeUndefined();
    expect(host.getManifest("p2pkh")).toBeUndefined();

    await host.registerAll(stage("vault-selection"));
    expect(host.capabilities.has("vault.service")).toBe(true);
    expect(host.capabilities.has("keyspace.service")).toBe(true);
    expect(host.getManifest("p2pkh")).toBeUndefined();

    await host.registerAll(stage("owner-apps-ready"));
    expect(host.state("p2pkh").kind).toBe("enabled");
    expect(host.capabilities.has("p2pkh.service")).toBe(true);

    await host.registerAll(stage("connect-apps-ready"));
    expect(host.state("message").kind).toBe("enabled");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeDefined();
    if (host.state("message").kind !== "enabled") {
      expect(host.state("message").error).toBeTruthy();
    }
  }, 30_000);

  function vaultFixture(setup: PluginSetup = (ctx) => {
    ctx.provide("vault.service", {});
    ctx.provide("keyspace.service", {});
  }): { manifest: PluginManifest; setup: PluginSetup } {
    return {
      manifest: {
        id: "vault",
        name: "Vault",
        meta: {
          kind: "core",
          startup: "required",
          defaultEnabled: true,
          canDisable: false,
          providesCapabilities: ["vault.service", "keyspace.service"]
        },
      },
      setup
    };
  }

  function createFixtureHost(setups: Record<string, PluginSetup> = {}): PluginHost {
    return createPluginHost({
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: {
        get: (pluginId) => setups[pluginId],
      },
    });
  }

  it("keeps Vault enabled while runtime config is stored outside localStorage", async () => {
    localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 1, value: { vault: false } }));
    const fixture = vaultFixture();
    const host = createFixtureHost({ vault: fixture.setup });
    await host.register(fixture.manifest);
    assertWebStartupContract(host);
    expect(host.capabilities.has("vault.service")).toBe(true);
    expect(host.configStore.read().vault).toBe(true);
    expect(JSON.parse(localStorage.getItem("keymaster.plugins.runtime")!).version).toBe(1);
  });

  it("rejects required setup failures before startup preflight", async () => {
    const fixture = vaultFixture(() => { throw new Error("sensitive setup detail"); });
    const host = createFixtureHost({ vault: fixture.setup });
    await expect(host.register(fixture.manifest))
      .rejects.toBeInstanceOf(StartupPluginError);
    expect(() => assertWebStartupContract(host)).toThrow(StartupCapabilityError);
  });

  it("retries a required plugin whose manifest was recorded before setup failed", async () => {
    let attempts = 0;
    const fixture = vaultFixture((ctx) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Vault setup failure");
      ctx.provide("vault.service", {});
      ctx.provide("keyspace.service", {});
    });
    const host = createFixtureHost({ vault: fixture.setup });

    await expect(host.register(fixture.manifest)).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.manifests()).toContain("vault");
    expect(host.state("vault").kind).toBe("error-disabled");
    await expect(host.register(fixture.manifest)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(host.state("vault").kind).toBe("enabled");
    assertWebStartupContract(host);
  });

  it("reports missing provider/capability and does not enter React", () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    expect(() => assertWebStartupContract(host)).toThrow(/vault\.service/);
    try {
      assertWebStartupContract(host);
    } catch (error) {
      const details = (error as StartupCapabilityError).details;
      expect(details[0]).toMatchObject({
        capability: "vault.service",
        providerPluginId: undefined,
        providerState: undefined
      });
    }
    expect(WEB_STARTUP_REQUIRED_CAPABILITIES).toEqual(["vault.service", "keyspace.service"]);
  });

  it("keeps optional failures isolated while required preflight succeeds", async () => {
    const optionalSetup: PluginSetup = () => { throw new Error("optional failure"); };
    const vault = vaultFixture();
    const host = createFixtureHost({ optional: optionalSetup, vault: vault.setup });
    await host.register({
      id: "optional",
      name: "Optional",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
    });
    await host.register(vault.manifest);
    assertWebStartupContract(host);
    expect(host.state("optional").kind).toBe("error-disabled");
  });
});
