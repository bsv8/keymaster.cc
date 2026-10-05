import { walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { createFixtureHost as createPluginHost } from "@keymaster/runtime/test-support";
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
  VAULT_WALLET_STATE_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type PluginManifest,
  type PluginSetup,
  type SessionCoordinatorClient,
} from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { type PluginHost } from "@keymaster/runtime";
import { StartupCapabilityError, StartupPluginError } from "webloom-framework/advanced";
import {
  createInMemoryKeyValueStore,
  createInMemoryModuleFileStore,
  withTestStorageBinding,
} from "@keymaster/runtime/storage";
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
  const open = (declaration: import("@keymaster/contracts").PluginStorageDeclaration) =>
    createInMemoryKeyValueStore(withTestStorageBinding(declaration));
  return {
    getActivePublicKeyHex: () => "02" + "11".repeat(32),
    getWalletGeneration: () => "wallet-test",
    openOwnerFileStore: async () => createInMemoryModuleFileStore(),
    openOwnerAppStore: async ({ declaration }) => open(declaration),
    openPlatformStore: async ({ declaration }) => open(declaration),
    clearStorageRoot: async () => undefined
  };
}

/** 一份合法的平台 K-V 授权：坐标 + 三件世代身份。 */
function platformGrant(platformGrantId: string) {
  return {
    platformGrantId,
    walletGeneration: "wallet-1",
    runGeneration: "run-1",
    ...CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
    sessionEpoch: "epoch" as const,
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
      details: { pluginId: "vault", capabilities: ["vault.service"], state: "failed" }
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
      pluginId: "vault", capabilities: ["vault.service"], state: "failed"
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
  it("keeps storage onboarding until the wallet structure is complete enough to assemble", () => {
    // 单 Key 之后没有远程连接与桶选择：storageReady 表示钱包结构已经完整到
    // 可以继续装配，locked 也算 true——否则 locked 冷启动永远拿不到解锁入口。
    expect(applicationBootstrapPhaseForStorageReadiness(false)).toBe("storage-onboarding");
    expect(applicationBootstrapPhaseForStorageReadiness(true)).toBe("vault-selection");
  });

  it("lets both ready and locked reach vault-selection", () => {
    expect(applicationBootstrapPhaseForStorageStatus("ready")).toBe("vault-selection");
    expect(applicationBootstrapPhaseForStorageStatus("locked")).toBe("vault-selection");
  });

  it("keeps uninitialized on storage onboarding and fails closed on damaged storage", () => {
    expect(applicationBootstrapPhaseForStorageStatus("uninitialized")).toBe("storage-onboarding");
    // corrupt / unsupported / degraded 只能停在恢复门禁，绝不能被折算成
    // 「还没初始化」而提供创建或导入入口去覆盖本地数据。
    expect(applicationBootstrapPhaseForStorageStatus("corrupt")).toBe("storage-onboarding");
    expect(applicationBootstrapPhaseForStorageStatus("unsupported")).toBe("storage-onboarding");
    expect(applicationBootstrapPhaseForStorageStatus("degraded")).toBe("storage-onboarding");
  });
});

describe("Coordinator startup recovery", () => {
  it("only rebinds a platform grant before the remote operation reaches physical I/O", async () => {
    const firstGrant = platformGrant("platform-old");
    // 钱包身份世代变化必须让旧 grant 立即失效，即使重新绑定的仍然是同一个钱包。
    const secondGrant = { ...platformGrant("platform-new"), walletGeneration: "wallet-2" };
    const storageBindPlatform = vi.fn()
      .mockResolvedValueOnce({ status: "ok", value: firstGrant })
      .mockResolvedValueOnce({ status: "ok", value: secondGrant });
    const storagePlatformData = vi.fn()
      .mockResolvedValueOnce({ status: "error", message: "Platform storage wallet generation changed" })
      .mockResolvedValueOnce({ status: "ok", value: { revision: 1 } });
    const store = createCoordinatorPlatformStore(
      { storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient,
      CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
    );

    await expect(store.put("key", { ok: true })).resolves.toEqual({ revision: 1 });
    expect(storageBindPlatform).toHaveBeenCalledTimes(2);
    expect(storagePlatformData.mock.calls.map(([request]) => (request as { platformGrantId: string }).platformGrantId)).toEqual(["platform-old", "platform-new"]);
  });

  it("does not replay a platform write after the final I/O boundary is stale", async () => {
    const grant = platformGrant("platform-one");
    const storageBindPlatform = vi.fn().mockResolvedValue({ status: "ok", value: grant });
    const storagePlatformData = vi.fn().mockResolvedValue({ status: "error", message: "Platform storage binding became stale" });
    const store = createCoordinatorPlatformStore(
      { storageBindPlatform, storagePlatformData } as unknown as SessionCoordinatorClient,
      CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
    );

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
      storageClearRoot: async () => ({ status: "ok", value: undefined })
    });

    const publicClient = createPublicCoordinatorClient(rawClient);
    expect(Object.getPrototypeOf(publicClient)).toBeNull();
    expect(Object.isFrozen(publicClient)).toBe(true);
    expect((publicClient as unknown as Record<string, unknown>).vaultOperation).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageBindOwner).toBeUndefined();
    expect((publicClient as unknown as Record<string, unknown>).storageDeleteOwner).toBeUndefined();

    const storageClient = createStorageCoordinatorClient(rawClient);
    expect(storageClient.storageControl).toBeTypeOf("function");
    expect(storageClient.storageCancel).toBeTypeOf("function");
    expect(storageClient.storageSessionAbort).toBeTypeOf("function");
    // Storage 插件不允许触碰私钥或 Vault 生命周期 RPC。
    expect((storageClient as unknown as Record<string, unknown>).unlock).toBeUndefined();
    expect((storageClient as unknown as Record<string, unknown>).vaultOperation).toBeUndefined();

    const vaultClient = createVaultCoordinatorClient(rawClient);
    expect(vaultClient.vaultOperation).toBeTypeOf("function");
    expect(vaultClient.autolockSettingsUpdate).toBeTypeOf("function");
    expect((vaultClient as unknown as Record<string, unknown>).storageDeleteOwner).toBeUndefined();
    expect((vaultClient as unknown as Record<string, unknown>).storageGrant).toBeUndefined();
    expect((vaultClient as unknown as Record<string, unknown>).storageData).toBeUndefined();
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
        walletGeneration: "wallet-1",
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
      fixtureExcludedCapabilities: WEB_PLUGIN_CATALOG.flatMap(plugin => (plugin.units ?? []).flatMap(unit => (unit.provides ?? []).map(cap => cap.id))),
      storageBindingAuthority: makeStorageBindingAuthority(),
      coordinatorForPlugin: () => coordinatorClient,
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createWebRuntimeUnitImplementationRegistry(WEB_PLUGIN_CATALOG),
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: "02" + "11".repeat(32),
        sessionEpoch: "test-session:1",
        walletGeneration: "wallet-1",
      }
    }));
    host.validateManifestSet([...WEB_PLUGIN_CATALOG]);

    // 按真实装配顺序推进四道门禁。
    //
    // 单 Key 之后第一阶段同时装 Storage 和 Vault（导入 UI 属于 Vault）：locked 冷启动
    // 必须在这一阶段就拿到 Vault capability，否则根本没有解锁入口。因此这条
    // 断言改的是「能力先后顺序」，不再是「Vault 要等第二个阶段」。
    await host.registerAll([...WEB_PLUGIN_CATALOG]);
    expect(host.capabilities.has(VAULT_SERVICE_CAPABILITY)).toBe(true);
    expect(host.capabilities.has(VAULT_WALLET_STATE_CAPABILITY)).toBe(true);
    for (const id of ["key-import", "importer-wif", "importer-hex", "importer-json-file"]) expect(host.getManifest(id)).toBeUndefined();
    const vault = host.capabilities.get(VAULT_SERVICE_CAPABILITY);
    for (const method of ["initialize", "exportKeyHold", "resetWallet", "renameKey", "changePassword", "coordinatorClient"]) expect(method in vault).toBe(false);
    expect(host.getManifest("p2pkh")).toBeDefined();

    expect(host.getManifest("protocol")).toBeDefined();
    expect(host.getManifest("settings")).toBeUndefined();
    expect(host.getManifest("home")).toBeUndefined();
    expect(host.getManifest("workspace")).toBeUndefined();
    expect(host.getManifest("p2pkh")).toBeDefined();

    expect(host.state("p2pkh").kind, JSON.stringify(host.state("p2pkh"))).toBe("enabled");
    expect(host.capabilities.has((await import("@keymaster/plugin-p2pkh")).P2PKH_CAPABILITY)).toBe(true);
    // WOC 装配后必须已经提供链高度读取器（get / 订阅 / 退订），
    // 否则「智能调度」页读不到当前链高度。
    const { CHAIN_HEIGHT_READER_CAPABILITY } = await import("@keymaster/contracts");
    expect(host.capabilities.has(CHAIN_HEIGHT_READER_CAPABILITY)).toBe(true);

    expect(host.state("message").kind).toBe("enabled");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeDefined();
    if (host.state("message").kind !== "enabled") {
      expect(host.state("message").error).toBeTruthy();
    }
  }, 30_000);

  function vaultFixture(setup: PluginSetup = (ctx) => {
    ctx.provide(VAULT_SERVICE_CAPABILITY, {} as never);
    ctx.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({} as never));
  }): { manifest: PluginManifest; setup: PluginSetup } {
    return {
      manifest: {
        id: "vault",
        name: "Vault",

        units: [{
          id: "vault.window",
          runtime: "window-main",
          scopeKind: "root",
          provides: [VAULT_SERVICE_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY],
        }],
      },
      setup
    };
  }

  function createFixtureHost(setups: Record<string, PluginSetup> = {}): PluginHost {
    return trackHost(createPluginHost({

      runtime: "window-main",
      runtimeUnitImplementationRegistry: {
        get: (pluginId) => setups[pluginId],
      },
    }));
  }

  it("rejects required setup failures before startup preflight", async () => {
    const fixture = vaultFixture(() => { throw new Error("sensitive setup detail"); });
    const host = createFixtureHost({ vault: fixture.setup });
    await host.register(fixture.manifest);
    expect(() => assertWebStartupContract(host)).toThrow(StartupCapabilityError);
  });

  it("retries a required plugin whose manifest was recorded before setup failed", async () => {
    let attempts = 0;
    const fixture = vaultFixture((ctx) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Vault setup failure");
      ctx.provide(VAULT_SERVICE_CAPABILITY, {} as never);
      ctx.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateFixtureAccess({} as never));
    });
    const host = createFixtureHost({ vault: fixture.setup });

    await host.register(fixture.manifest);
    expect(host.manifests()).toContain("vault");
    expect(host.state("vault").kind).toBe("failed");
    await expect(host.retry(fixture.manifest.id)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(host.state("vault").kind).toBe("enabled");
    assertWebStartupContract(host);
  });

  it("reports missing provider/capability and does not enter React", () => {
    const host = trackHost(createPluginHost({  }));
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
    expect(WEB_STARTUP_REQUIRED_CAPABILITIES).toEqual([VAULT_SERVICE_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY]);
  });

  it("keeps optional failures isolated while required preflight succeeds", async () => {
    const optionalSetup: PluginSetup = () => { throw new Error("optional failure"); };
    const vault = vaultFixture();
    const host = createFixtureHost({ optional: optionalSetup, vault: vault.setup });
    await host.register({
      id: "optional",
      name: "Optional",

    });
    await host.register(vault.manifest);
    assertWebStartupContract(host);
    expect(host.state("optional").kind).toBe("failed");
  });
});
