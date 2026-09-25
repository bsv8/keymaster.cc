// apps/web/src/bootstrapPlugins.test.ts
// 启动装配层的挂死探测测试。
//
// 覆盖：
//   1. protocol 注册永久 pending 时，装配层会在时限后抛出明确错误；
//   2. 普通插件描述保持通用文案；
//   3. 正常注册不会被误判成超时。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CENTRAL_STORAGE_DECLARATIONS,
  KEYSPACE_SERVICE_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type PluginManifest,
  type PluginSetup,
  type SessionCoordinatorClient,
} from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { createKeymasterPluginHost as createPluginHost, type PluginHost } from "@keymaster/runtime";
import { StartupCapabilityError, StartupPluginError } from "webloom-framework/advanced";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import {
  connectCoordinatorWithStartupRetry,
  applicationBootstrapPhaseForStorageReadiness,
  applicationBootstrapPhaseForStorageStatus,
  bootstrapPhaseForContext,
  CoordinatorStartupError,
  createPublicCoordinatorClient,
  createCoordinatorPlatformStore,
  createStorageCoordinatorClient,
  createVaultCoordinatorClient,
  describeBootstrapStep,
  getBootstrapErrorContext,
  registerPluginWithTimeout
} from "./bootstrapPlugins.js";
import { assertWebStartupContract, WEB_STARTUP_REQUIRED_CAPABILITIES } from "./bootstrapPlugins.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { createWebRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementations.js";
import { withBootstrapErrorContext } from "./bootstrapErrorContext.js";

const activeHosts = new Set<PluginHost>();

function trackHost<T extends PluginHost>(host: T): T {
  activeHosts.add(host);
  return host;
}

afterEach(async () => {
  vi.useRealTimers();
  const hosts = [...activeHosts];
  activeHosts.clear();
  await Promise.all(hosts.map((host) => host.dispose().catch(() => undefined)));
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
  const open = (declaration: import("@keymaster/contracts").PluginStorageDeclaration, ownerPublicKeyHex = "") => createInMemoryKeyValueStore({
    ...declaration,
    ...(declaration.scope === "owner" ? { ownerPublicKeyHex } : {}),
    bucketId: "test-memory",
    bucketGeneration: 1
  });
  return {
    openOwnerFileStore: async () => ({
      list: async () => ({ files: [] }),
      get: async () => undefined,
      put: async () => ({}),
      delete: async () => undefined,
    }),
    openOwnerAppStore: async ({ declaration }) => open(declaration, "02" + "11".repeat(32)),
    openPlatformStore: async ({ declaration }) => open(declaration),
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
    const promise = registerPluginWithTimeout(host, makePlugin("protocol"), 1_500, "storage-onboarding");
    const assertion = expect(promise).rejects.toThrow(
      'Bootstrap timed out while registering plugin "protocol" (opening platform K-V "protocol") after 1500ms'
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;

    try {
      await promise;
    } catch (error) {
      expect(getBootstrapErrorContext(error)).toMatchObject({
        stage: "storage-onboarding",
        pluginId: "protocol",
        operation: "register-plugin",
        context: { timeoutMs: 1_500 }
      });
      expect(bootstrapPhaseForContext(getBootstrapErrorContext(error)))
        .toBe("pre-bootstrap.storage-onboarding");
    }
  });

  it("preserves structured plugin diagnostics while adding stage context", async () => {
    const original = Object.assign(new Error("private setup detail"), {
      name: "StartupPluginError",
      details: { pluginId: "vault", capabilities: ["vault.service"], state: "error-disabled" }
    });
    const host = makeHost(() => Promise.reject(original));

    await expect(registerPluginWithTimeout(host, makePlugin("vault"), 1_500, "vault-selection"))
      .rejects.toBe(original);
    expect(getBootstrapErrorContext(original)).toMatchObject({
      stage: "vault-selection",
      pluginId: "vault",
      operation: "register-plugin"
    });
    expect(original.name).toBe("StartupPluginError");
    expect(original.details).toEqual({
      pluginId: "vault", capabilities: ["vault.service"], state: "error-disabled"
    });
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

describe("application bootstrap phase projection", () => {
  it("keeps storage onboarding while storage readiness is still false", () => {
    // session.state can report booting -> uninitialized before the user has
    // selected a storage backend. That identity event must not advance the
    // application gate past storage onboarding.
    expect(applicationBootstrapPhaseForStorageReadiness(false)).toBe("storage-onboarding");
    expect(applicationBootstrapPhaseForStorageReadiness(true)).toBe("vault-selection");
  });

  it("keeps an existing selected bucket on the authentication page", () => {
    expect(applicationBootstrapPhaseForStorageStatus("unselected")).toBe("storage-onboarding");
    expect(applicationBootstrapPhaseForStorageStatus("authentication")).toBe("storage-authentication");
    expect(applicationBootstrapPhaseForStorageStatus("ready")).toBe("vault-selection");
    expect(applicationBootstrapPhaseForStorageReadiness(false, true)).toBe("storage-authentication");
  });
});

describe("Coordinator startup recovery", () => {
  it("only rebinds a platform grant before the remote operation reaches physical I/O", async () => {
    const firstGrant = { platformGrantId: "platform-old", bucketId: "bucket", bucketGeneration: 1, ...CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads, sessionEpoch: "epoch", clientId: "test" };
    const secondGrant = { ...firstGrant, platformGrantId: "platform-new", bucketGeneration: 2 };
    const storageBindPlatform = vi.fn()
      .mockResolvedValueOnce({ status: "ok", value: firstGrant })
      .mockResolvedValueOnce({ status: "ok", value: secondGrant });
    const storagePlatformData = vi.fn()
      .mockResolvedValueOnce({ status: "error", message: "Platform storage bucket generation changed" })
      .mockResolvedValueOnce({ status: "ok", value: { revision: 1 } });
    const store = createCoordinatorPlatformStore({ storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient, CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads);

    await expect(store.put("key", { ok: true })).resolves.toEqual({ revision: 1 });
    expect(storageBindPlatform).toHaveBeenCalledTimes(2);
    expect(storagePlatformData.mock.calls.map(([request]) => (request as { platformGrantId: string }).platformGrantId)).toEqual(["platform-old", "platform-new"]);
  });

  it("does not replay a platform write after the final I/O boundary is stale", async () => {
    const grant = { platformGrantId: "platform-one", bucketId: "bucket", bucketGeneration: 1, ...CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads, sessionEpoch: "epoch", clientId: "test" };
    const storageBindPlatform = vi.fn().mockResolvedValue({ status: "ok", value: grant });
    const storagePlatformData = vi.fn().mockResolvedValue({ status: "error", message: "Platform storage binding became stale" });
    const store = createCoordinatorPlatformStore({ storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient, CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads);

    await expect(store.put("key", { ok: true })).rejects.toThrow("Platform storage binding became stale");
    expect(storageBindPlatform).toHaveBeenCalledTimes(1);
    expect(storagePlatformData).toHaveBeenCalledTimes(1);
  });

  it("uses frozen null-prototype coordinator facades for each trust boundary", () => {
    const rawClient = Object.create({
      vaultOperation: () => undefined,
      autolockSettingsUpdate: () => undefined,
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
    expect(vaultClient.autolockSettingsUpdate).toBeTypeOf("function");
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

  it("preserves the first pre-ready diagnostic with a second retry failure", async () => {
    vi.useFakeTimers();
    const firstError = new Error("Coordinator SharedWorker failed before publishing a ready Runtime snapshot; inspect the Worker console");
    const finalError = new Error("worker still unavailable");
    const connect = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(finalError);
    const disconnect = vi.fn();

    const pending = connectCoordinatorWithStartupRetry({ connect, disconnect }, 200);
    const assertion = expect(pending).rejects.toBeInstanceOf(CoordinatorStartupError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    try {
      await pending;
    } catch (error) {
      expect(error).toMatchObject({ firstError, retryError: finalError });
      expect(error).toBeInstanceOf(CoordinatorStartupError);
      expect((error as Error).message).toContain("inspect the Worker console");
      expect((error as Error).message).toContain("worker still unavailable");
      expect(getBootstrapErrorContext(error)).toMatchObject({
        stage: "coordinator",
        operation: "connect-coordinator",
        context: { retryAttempt: 2, retryDelayMs: 200 }
      });
      expect(bootstrapPhaseForContext(getBootstrapErrorContext(error)))
        .toBe("pre-bootstrap.coordinator");
    }
  });

  it("uses an explicit fallback for errors without bootstrap context", () => {
    expect(bootstrapPhaseForContext(undefined)).toBe("pre-bootstrap.fallback");
    expect(bootstrapPhaseForContext({ stage: "bootstrap", operation: "bootstrap" }))
      .toBe("pre-bootstrap.fallback");
    expect(bootstrapPhaseForContext(undefined)).not.toBe("pre-bootstrap.plugins");
  });

  it("keeps the innermost plugin context when wrappers are nested", async () => {
    const original = new Error("plugin failure");
    const nested = withBootstrapErrorContext(
      { stage: "owner-apps-ready", operation: "register-stage" },
      () => withBootstrapErrorContext(
        { stage: "owner-apps-ready", pluginId: "msfile", operation: "register-plugin" },
        () => Promise.reject(original)
      )
    );

    await expect(nested).rejects.toBe(original);
    expect(getBootstrapErrorContext(original)).toMatchObject({
      stage: "owner-apps-ready",
      pluginId: "msfile",
      operation: "register-plugin"
    });
  });

  it.each([
    ["vault-selection", "pre-bootstrap.vault-selection"],
    ["owner-apps-ready", "pre-bootstrap.owner-apps-ready"],
    ["connect-apps-ready", "pre-bootstrap.connect-apps-ready"],
    ["storage-status", "pre-bootstrap.storage-status"],
    ["window-app", "pre-bootstrap.window-app"],
    ["transport", "pre-bootstrap.transport"]
  ] as const)("maps %s to its fatal phase", (stage, phase) => {
    expect(bootstrapPhaseForContext({ stage, operation: "test" })).toBe(phase);
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
      getChainHeightSnapshot: () => ({ height: 0, network: "main", available: false, revision: 0 }),
      storageControl: async () => ({ status: "ok", value: "ready" }),
      storageGrant: async () => ({ status: "ok", value: "grant" }),
      storageData: async () => ({ status: "ok", value: undefined }),
      storageCancel: async () => ({ status: "ok" }),
      storageSessionAbort: async () => ({ status: "ok" }),
      unlock: async () => ({ ok: false }), lock: async () => ({ ok: false }),
      activateKey: async () => ({ ok: false }), vaultOperation: async () => ({ ok: false }),
      crypto: async () => ({ ack: { ok: false } }), backgroundCancelByKey: async () => ({ ok: false }),
      autolockSettingsUpdate: async () => ({ status: "accepted" }),
      p2pkhProviderConfigGet: async () => ({ status: "ok", value: {} }),
      p2pkhProviderConfigUpdate: async () => ({ status: "ok" }),
      p2pkhUtxosGet: async () => ({ status: "ok", value: { available: false, items: [] } }),
      p2pkhUtxosRefresh: async () => ({ status: "ok", value: { available: false, items: [] } }),
      p2pkhSettingsUpdate: async () => ({ status: "ok" })
    } as unknown as SessionCoordinatorClient;
    const host = trackHost(createPluginHost({
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
    }));
    const stage = (name: string) => WEB_PLUGIN_CATALOG.filter((plugin) => plugin.bootstrapStage === name);
    host.validateManifestSet([...WEB_PLUGIN_CATALOG]);

    // 按真实装配顺序推进四道门禁：Owner 插件（含 P2PKH）不能在
    // Vault capability 建立前进入 Host；Connect 应用必须最后才注册。
    await host.registerAll(stage("storage-onboarding"));
    expect(host.getManifest("vault")).toBeUndefined();
    expect(host.getManifest("p2pkh")).toBeUndefined();

    await host.registerAll(stage("vault-selection"));
    expect(host.capabilities.has(VAULT_SERVICE_CAPABILITY)).toBe(true);
    expect(host.capabilities.has(KEYSPACE_SERVICE_CAPABILITY)).toBe(true);
    expect(host.getManifest("p2pkh")).toBeUndefined();

    await host.registerAll(stage("owner-apps-ready"));
    expect(host.state("p2pkh").kind).toBe("enabled");
    expect(host.capabilities.has((await import("@keymaster/plugin-p2pkh")).P2PKH_CAPABILITY)).toBe(true);
    // WOC 装配后必须已经提供链高度读取器（get / 订阅 / 退订），
    // 否则「智能调度」页读不到当前链高度。
    const { CHAIN_HEIGHT_READER_CAPABILITY } = await import("@keymaster/contracts");
    expect(host.capabilities.has(CHAIN_HEIGHT_READER_CAPABILITY)).toBe(true);

    await host.registerAll(stage("connect-apps-ready"));
    expect(host.state("message").kind).toBe("enabled");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeDefined();
    if (host.state("message").kind !== "enabled") {
      expect(host.state("message").error).toBeTruthy();
    }
  }, 30_000);

  function vaultFixture(setup: PluginSetup = (ctx) => {
    ctx.provide(VAULT_SERVICE_CAPABILITY, {} as never);
    ctx.provide(KEYSPACE_SERVICE_CAPABILITY, {} as never);
  }): { manifest: PluginManifest; setup: PluginSetup } {
    return {
      manifest: {
        id: "vault",
        name: "Vault",
        kind: "core",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        bootstrapStage: "vault-selection",
        displayGroup: "platform",
        units: [{
          id: "vault.window",
          runtime: "window-main",
          scopeKind: "root",
          provides: [VAULT_SERVICE_CAPABILITY, KEYSPACE_SERVICE_CAPABILITY],
        }],
      },
      setup
    };
  }

  function createFixtureHost(setups: Record<string, PluginSetup> = {}): PluginHost {
    return trackHost(createPluginHost({
      disableConfigPersistence: true,
      runtime: "window-main",
      runtimeUnitImplementationRegistry: {
        get: (pluginId) => setups[pluginId],
      },
    }));
  }

  it("keeps required Vault enabled with an in-memory runtime projection", async () => {
    const fixture = vaultFixture();
    const host = createFixtureHost({ vault: fixture.setup });
    await host.register(fixture.manifest);
    assertWebStartupContract(host);
    expect(host.capabilities.has(VAULT_SERVICE_CAPABILITY)).toBe(true);
    expect(host.configStore.read().vault).toBe(true);
    expect(localStorage.length).toBe(0);
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
      ctx.provide(VAULT_SERVICE_CAPABILITY, {} as never);
      ctx.provide(KEYSPACE_SERVICE_CAPABILITY, {} as never);
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
    const host = trackHost(createPluginHost({ disableConfigPersistence: true }));
    expect(() => assertWebStartupContract(host)).toThrow(/vault\.service/);
    try {
      assertWebStartupContract(host);
    } catch (error) {
      const details = (error as StartupCapabilityError).details;
      expect(details[0]).toMatchObject({
        capability: VAULT_SERVICE_CAPABILITY,
        providerPluginId: undefined,
        providerState: undefined
      });
    }
    expect(WEB_STARTUP_REQUIRED_CAPABILITIES).toEqual([VAULT_SERVICE_CAPABILITY, KEYSPACE_SERVICE_CAPABILITY]);
  });

  it("keeps optional failures isolated while required preflight succeeds", async () => {
    const optionalSetup: PluginSetup = () => { throw new Error("optional failure"); };
    const vault = vaultFixture();
    const host = createFixtureHost({ optional: optionalSetup, vault: vault.setup });
    await host.register({
      id: "optional",
      name: "Optional",
      kind: "business", startup: "optional", defaultEnabled: true, canDisable: true,
      bootstrapStage: "connect-apps-ready", displayGroup: "business",
    });
    await host.register(vault.manifest);
    assertWebStartupContract(host);
    expect(host.state("optional").kind).toBe("error-disabled");
  });
});
