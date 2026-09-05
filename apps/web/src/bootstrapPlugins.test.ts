// apps/web/src/bootstrapPlugins.test.ts
// 启动装配层的挂死探测测试。
//
// 覆盖：
//   1. protocol 注册永久 pending 时，装配层会在时限后抛出明确错误；
//   2. 普通插件描述保持通用文案；
//   3. 正常注册不会被误判成超时。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, SessionCoordinatorClient } from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { createPluginHost, StartupCapabilityError, StartupPluginError, type PluginHost } from "@keymaster/runtime";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import {
  connectCoordinatorWithStartupRetry,
  createPublicCoordinatorClient,
  createStorageCoordinatorClient,
  createVaultCoordinatorClient,
  describeBootstrapStep,
  registerPluginWithTimeout
} from "./bootstrapPlugins.js";
import { assertWebStartupContract, WEB_STARTUP_REQUIRED_CAPABILITIES } from "./bootstrapPlugins.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";

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
      storageSessionAbort: async () => ({ status: "ok" })
    });

    const publicClient = createPublicCoordinatorClient(rawClient);
    expect(Object.getPrototypeOf(publicClient)).toBeNull();
    expect(Object.isFrozen(publicClient)).toBe(true);
    expect((publicClient as unknown as Record<string, unknown>).vaultOperation).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageBindOwner).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageDeleteOwner).toBeUndefined();

    const storageClient = createStorageCoordinatorClient(rawClient);
    expect(storageClient.storageControl).toBeTypeOf("function");
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
      getBootstrapSnapshot: () => ({ keys: [], activePublicKeyHex: undefined }),
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
      coordinatorForPlugin: () => coordinatorClient
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

  function vaultFixture(setup: PluginManifest["setup"] = (ctx) => {
    ctx.provide("vault.service", {});
    ctx.provide("keyspace.service", {});
  }): PluginManifest {
    return {
      id: "vault",
      name: "Vault",
      meta: {
        kind: "core",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: ["vault.service", "keyspace.service"]
      },
      setup
    };
  }

  it("keeps Vault enabled while runtime config is stored outside localStorage", async () => {
    localStorage.setItem("keymaster.plugins.runtime", JSON.stringify({ version: 1, value: { vault: false } }));
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(vaultFixture());
    assertWebStartupContract(host);
    expect(host.capabilities.has("vault.service")).toBe(true);
    expect(host.configStore.read().vault).toBe(true);
    expect(JSON.parse(localStorage.getItem("keymaster.plugins.runtime")!).version).toBe(1);
  });

  it("rejects required setup failures before startup preflight", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(vaultFixture(() => { throw new Error("sensitive setup detail"); })))
      .rejects.toBeInstanceOf(StartupPluginError);
    expect(() => assertWebStartupContract(host)).toThrow(StartupCapabilityError);
  });

  it("retries a required plugin whose manifest was recorded before setup failed", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    let attempts = 0;
    const manifest = vaultFixture((ctx) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Vault setup failure");
      ctx.provide("vault.service", {});
      ctx.provide("keyspace.service", {});
    });

    await expect(host.register(manifest)).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.manifests()).toContain("vault");
    expect(host.state("vault").kind).toBe("error-disabled");
    await expect(host.register(manifest)).resolves.toBeUndefined();
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
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "optional",
      name: "Optional",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() { throw new Error("optional failure"); }
    });
    await host.register(vaultFixture());
    assertWebStartupContract(host);
    expect(host.state("optional").kind).toBe("error-disabled");
  });
});
