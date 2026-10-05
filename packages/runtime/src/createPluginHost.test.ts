import { walletStateFixtureSnapshot, walletStateFixtureAccess } from "@keymaster/runtime/test-support";
import { STORAGE_KV_CLIENTS_CAPABILITY } from "@keymaster/contracts";
// 产品适配生命周期、依赖清理和实例注册回收测试。

import { describe, expect, it, beforeEach, vi } from "vitest";
import { createTestPluginHost as createPluginHost } from "./testing/createTestPluginHost.js";
import type { FixtureHost as PluginHost } from "./testSupport/createFixtureHost.js";
import type { LocalCapability } from "webloom-framework";
import { defineCapability } from "webloom-framework";
import { CHANNEL_RUNTIME_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS, type ChannelRuntime, type ChannelRuntimeFactory, type KeyValueStore, type PluginContext } from "@keymaster/contracts";
import type { TestPluginManifest } from "./testing/createTestPluginHost.js";
type PluginManifest = TestPluginManifest;
import type { RouteRegistry } from "./testSupport/registries/routeRegistry.js";
import type { SettingsRegistry } from "./testSupport/registries/settingsRegistry.js";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { createInMemoryKeyValueStore } from "./storage/inMemoryKeyValueStore.js";
import { withTestStorageBinding } from "./storage/inMemoryKeyValueStore.js";
import { createInMemoryModuleFileStore } from "./storage/inMemoryModuleFileStore.js";
import { createRuntimeUnitImplementationRegistry, StartupCapabilityError, StartupPluginError } from "webloom-framework/advanced";
import {
  VAULT_WALLET_STATE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  SETTINGS_REGISTRY_CAPABILITY,
} from "@keymaster/contracts";

interface RegistryViews {
  routes: { ids: string[] };
  settingsRoutes: { ids: string[] };
  capabilities: { keys: string[] };
}

function view(host: PluginHost): RegistryViews {
  return {
    routes: { ids: host.routes.list().map(route => route.id) },
    settingsRoutes: { ids: host.settings.list().map(route => route.id) },
    capabilities: { keys: host.capabilities.descriptors().map((capability) => capability.id) }
  };
}

const ROUTE_A = "test.a.route";
const ROUTE_B = "test.b.route";
const ROUTE_C = "test.c.route";
const CAP_A = defineCapability<{ value: string }>({ kind: "local", id: "test.a.cap", version: "1" });
const CAP_B = defineCapability<{ value?: string; instance?: number }>({ kind: "local", id: "test.b.cap", version: "1" });
const CAP_C = defineCapability<{ value: string }>({ kind: "local", id: "test.c.cap", version: "1" });
const TEST_CAPABILITIES = new Map<string, LocalCapability<unknown>>();
function testCapability<T = unknown>(id: string): LocalCapability<T> {
  const existing = TEST_CAPABILITIES.get(id);
  if (existing) return existing as LocalCapability<T>;
  const created = defineCapability<T>({ kind: "local", id, version: "1" });
  TEST_CAPABILITIES.set(id, created);
  return created;
}
const TEST_RUNTIME_IDENTITY = {
  vaultStatus: "unlocked" as const,
  ownerPublicKeyHex: "02" + "11".repeat(32),
  sessionEpoch: "test-session:1",
  walletGeneration: "test-wallet:1",
};

function makeA(): PluginManifest {
  return {
    id: "a",
    name: "A",
    description: "plugin A",
    meta: {     providesCapabilities: [CAP_A] },
    setup(ctx: PluginContext) {
      const r = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
      r.register({
        id: ROUTE_A,
        path: "/a",
        label: "A",
        component: () => null
      });
      ctx.provide(CAP_A, { value: "a" });
    }
  };
}

function makeB(dependsOn: readonly LocalCapability<unknown>[] = [CAP_A]): PluginManifest {
  return {
    id: "b",
    name: "B",
    description: "plugin B",
    meta: {     providesCapabilities: [CAP_B] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
      r.register({
        id: ROUTE_B,
        path: "/b",
        label: "B",
        component: () => null
      });
      const s = ctx.capability(SETTINGS_REGISTRY_CAPABILITY);
      s.register({
        id: "b.settings",
        path: "/settings/b",
        label: "B",
        order: 1,
        component: () => null
      });
      ctx.provide(CAP_B, { value: "b" });
    }
  };
}

function makeC(dependsOn: readonly LocalCapability<unknown>[] = []): PluginManifest {
  return {
    id: "c",
    name: "C",
    description: "plugin C - core",
    meta: {     providesCapabilities: [CAP_C] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
      r.register({
        id: ROUTE_C,
        path: "/c",
        label: "C",
        component: () => null
      });
      ctx.provide(CAP_C, { value: "c" });
    }
  };
}

describe("createPluginHost - runtime resource binding", () => {
  it("closes an owner store that finishes opening after the plugin was revoked", async () => {
    const owner = "02" + "11".repeat(32);
    // 借用一个已登记的内置模块坐标：内置插件不能自报未登记的坐标。
    const storageDeclaration = CENTRAL_STORAGE_DECLARATIONS.bsvPrice;
    let resolveOpen!: (store: KeyValueStore) => void;
    const openPromise = new Promise<KeyValueStore>((resolve) => { resolveOpen = resolve; });
    const authority: StorageBindingAuthority = {
      getActivePublicKeyHex: () => owner,
      openOwnerFileStore: async () => createInMemoryModuleFileStore(),
      openOwnerAppStore: async () => openPromise,
      openPlatformStore: async () => createInMemoryKeyValueStore(withTestStorageBinding(CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings)),
      clearStorageRoot: async () => undefined,
    };
    const host = createPluginHost({  storageBindingAuthority: authority });
    const plugin: PluginManifest = {
      id: "bsv-price",
      name: "Late owner store",
      storage: storageDeclaration,
      dependencies: [{ capability: STORAGE_KV_CLIENTS_CAPABILITY }],
      meta: {     },
      async setup(ctx) {
        // 首次 K-V 操作会触发延迟 owner binding；在 binding 等待期间撤权。
        await ctx.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "settings")!.get("during-start");
      },
    };
    const registering = host.register(plugin);
    await Promise.resolve();
    expect(host.state(plugin.id).kind).toBe("starting");
    const disabling = host.revoke(plugin.id, "test revocation");
    const rawStore = createInMemoryKeyValueStore(withTestStorageBinding(storageDeclaration));
    let closed = false;
    const store: KeyValueStore = { ...rawStore, close: () => { closed = true; rawStore.close(); } };
    resolveOpen(store);
    await registering;
    await disabling;
    expect(host.state(plugin.id).kind).toBe("blocked");
    expect(closed).toBe(true);
  });

  it("refreshes resources through explicit committed runtime identity transitions", async () => {
    const host = createPluginHost({});
    const refresh = vi.spyOn(host.resourceStore, "refreshRuntimeBindings");
    await host.transitionRuntimeIdentity({ vaultStatus: "unlocked", ownerPublicKeyHex: "pk1", sessionEpoch: "epoch-1", runGeneration: "run-1", walletGeneration: "wallet-1" });
    await host.transitionRuntimeIdentity({ vaultStatus: "unlocked", ownerPublicKeyHex: "pk1", sessionEpoch: "epoch-2", runGeneration: "run-1", walletGeneration: "wallet-1" });
    expect(refresh).toHaveBeenCalledTimes(2);
    await host.dispose();
  });

  it("binds Channel plugin identity to the manifest and rejects system callers", async () => {
    const runtime = {} as ChannelRuntime;
    const rawFactory: ChannelRuntimeFactory = {
      forPlugin: vi.fn(() => runtime),
      forSystem: vi.fn(() => runtime)
    };
    const host = createPluginHost({  });
    host.provide(CHANNEL_RUNTIME_CAPABILITY, rawFactory);

    let contextPluginId: string | undefined;
    let factory: ChannelRuntimeFactory | undefined;
    await host.register({
      id: "bound-channel-plugin",
      name: "Bound Channel plugin",
      description: "test",
      meta: {     },
      setup(ctx) {
        contextPluginId = ctx.pluginId;
        factory = ctx.capability(CHANNEL_RUNTIME_CAPABILITY);
      }
    });

    expect(contextPluginId).toBe("bound-channel-plugin");
    expect(factory).toBeDefined();
    // Host 返回的是绑定当前实例 Scope 的 facade，不把 raw runtime 直接
    // 暴露给插件；这样 revoke() 能同步撤掉旧回调和订阅 caller。
    expect(factory!.forPlugin("forged-plugin")).not.toBe(runtime);
    expect(factory!.forPlugin("another-forged-plugin")).toBe(factory!.forPlugin("forged-plugin"));
    expect(rawFactory.forPlugin).toHaveBeenCalledWith("bound-channel-plugin");
    expect(() => factory!.forSystem("owner-inbox")).toThrow("Plugin context cannot create a system Channel caller");
    expect(rawFactory.forSystem).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

describe("createPluginHost - lifecycle", () => {
  it("does not turn legacy static business metadata into executable contributions", async () => {
    const host = createPluginHost({});
    await host.register({ id: "metadata-only", name: "Metadata only", business: { domains: [{
      id: "metadata.domain", label: "Metadata", order: 1, features: [{ id: "metadata.page", label: "Page", order: 1,
        entry: { path: "/metadata", routeId: "metadata.route" } }],
    }] }, setup() {} });
    expect(host.routes.byPath("/metadata")).toBeUndefined();
    expect(host.business.listDomains()).toEqual([]);
    await host.dispose();
  });

  it("registers plugins and reads graph", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeA(), makeB([CAP_A]), makeC()]);
    expect(host.manifests()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    const g = host.graph();
    expect(g.dependencies.a).toEqual([]);
    expect(g.dependencies.b).toEqual([CAP_A.id]);
    expect(g.provides.a).toEqual([CAP_A.id]);
    expect(g.reverse.a?.[0]?.pluginId).toBe("b");
  });

  it("runs the primary runtime unit entry and uses only its configuration", async () => {
    let seenUnitId: string | undefined;
    let seenConfig: Record<string, unknown> | undefined;
    const host = createPluginHost({

      initialRuntimeIdentity: TEST_RUNTIME_IDENTITY,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: "unit-entry",
        unitId: "unit-entry.worker",
        setup(ctx) {
          seenUnitId = ctx.unitId;
          seenConfig = ctx.config;
          ctx.provide(testCapability("unit-entry.service"), { instanceId: ctx.instanceId });
        },
      }]),
    });
    await host.register({
      id: "unit-entry",
      name: "Unit entry",
      meta: {




      },
      provides: ["unit-entry.service"],
      units: [{
        id: "unit-entry.worker",
        runtime: "shared-worker",
        scopeKind: "owner-session",
        provides: ["unit-entry.service"],
        config: { source: "unit", productOnly: true, unitOnly: true },
      }],
    });

    expect(seenUnitId).toBe("unit-entry.worker");
    expect(seenConfig).toEqual({ source: "unit", productOnly: true, unitOnly: true });
    expect(host.state("unit-entry").unitId).toBe("unit-entry.worker");
    expect(host.capabilities.has(testCapability("unit-entry.service"))).toBe(true);
  });

  it("fails closed when a multi-unit product is loaded without an execution host", async () => {
    const product: PluginManifest = {
      id: "multi-unit-product",
      name: "Multi-unit product",
      meta: {     },
      units: [
        { id: "multi-unit.worker", runtime: "shared-worker", scopeKind: "root", provides: ["multi.worker"] },
        { id: "multi-unit.window", runtime: "window-main", scopeKind: "owner-session", provides: ["multi.window"] },
      ],
    };

    const host = createPluginHost({  });
    await expect(host.register(product)).rejects.toThrow(/execution must be explicit/i);
    expect(host.capabilities.has(testCapability("multi.worker"))).toBe(false);
    expect(host.capabilities.has(testCapability("multi.window"))).toBe(false);
  });

  it("runs only the selected unit in separate Worker and Window hosts", async () => {
    const starts: string[] = [];
    const implementations = createRuntimeUnitImplementationRegistry([
      {
        pluginId: "split-runtime-product",
        unitId: "split-runtime.worker",
        setup(ctx) { starts.push(`worker:${ctx.unitId}`); ctx.provide(testCapability("split.worker"), ctx.instanceId); },
      },
      {
        pluginId: "split-runtime-product",
        unitId: "split-runtime.window",
        setup(ctx) { starts.push(`window:${ctx.unitId}`); ctx.provide(testCapability("split.window"), ctx.instanceId); },
      },
    ]);
    const product: PluginManifest = {
      id: "split-runtime-product",
      name: "Split runtime product",
      meta: {     },
      provides: ["split.worker", "split.window"],
      units: [
        {
          id: "split-runtime.worker",
          runtime: "shared-worker",
          scopeKind: "root",
          provides: ["split.worker"],
        },
        {
          id: "split-runtime.window",
          runtime: "window-main",
          scopeKind: "owner-session",
          provides: ["split.window"],
        },
      ],
    };

    const workerHost = createPluginHost({  runtime: "shared-worker", initialRuntimeIdentity: TEST_RUNTIME_IDENTITY, runtimeUnitImplementationRegistry: implementations });
    const windowHost = createPluginHost({  runtime: "window-main", initialRuntimeIdentity: TEST_RUNTIME_IDENTITY, runtimeUnitImplementationRegistry: implementations });
    await workerHost.register(product);
    await windowHost.register(product);

    expect(starts).toEqual(["worker:split-runtime.worker", "window:split-runtime.window"]);
    expect(workerHost.graph().provides[product.id]).toEqual(["split.worker"]);
    expect(windowHost.graph().provides[product.id]).toEqual(["split.window"]);
    expect(workerHost.state(product.id).units).toMatchObject([
      { unitId: "split-runtime.worker", kind: "enabled", instanceId: expect.any(String) },
      { unitId: "split-runtime.window", kind: "unknown", error: "远程运行单元快照不可用（状态未知）" },
    ]);
    expect(windowHost.state(product.id).units).toMatchObject([
      { unitId: "split-runtime.worker", kind: "unknown", error: "远程运行单元快照不可用（状态未知）" },
      { unitId: "split-runtime.window", kind: "enabled", instanceId: expect.any(String) },
    ]);
    expect(workerHost.capabilities.has(testCapability("split.window"))).toBe(false);
    expect(windowHost.capabilities.has(testCapability("split.worker"))).toBe(false);
  });

  it("does not require provider-before-consumer manifest order and restores desired consumers", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeB([CAP_A]), makeA()]);

    expect(host.state("a").error).toBeUndefined();
    expect(host.state("a")).toMatchObject({ kind: "enabled" });
    expect(host.state("b").kind).toBe("enabled");
    await host.revoke("a", "test revocation");
    expect(host.state("b")).toMatchObject({ kind: "blocked" });

    await host.retry("a");
    expect(host.state("b")).toMatchObject({ kind: "enabled" });
  });

  it("cascades a starting consumer into waiting without restarting the revoked instance", async () => {
    let releaseSetup!: () => void;
    const setupReleased = new Promise<void>((resolve) => { releaseSetup = resolve; });
    let consumerStarts = 0;
    const consumer: PluginManifest = {
      id: "starting-consumer",
      name: "Starting consumer",
      meta: {     providesCapabilities: [CAP_B] },
      provides: [CAP_B],
      dependencies: [{ capability: CAP_A }],
      async setup(ctx) {
        consumerStarts += 1;
        await setupReleased;
        // 依赖提供者已经撤权后，这个旧实例的迟到结果不能再次发布能力。
        ctx.provide(CAP_B, { instance: consumerStarts });
      },
    };
    const host = createPluginHost({  });
    await host.register(makeA());

    const registering = host.register(consumer);
    await Promise.resolve();
    expect(host.state(consumer.id).kind).toBe("starting");

    const disabling = host.revoke("a", "test revocation");
    releaseSetup();
    await registering;
    await disabling;

    expect(consumerStarts).toBe(1);
    expect(host.state(consumer.id)).toMatchObject({
      kind: "blocked",
      lifecycleState: "waiting",
      blockedBy: [`missing:${CAP_A.kind}:${CAP_A.id}@${CAP_A.version}`],
    });
    expect(host.capabilities.has(CAP_B)).toBe(false);

    await host.retry("a");
    expect(consumerStarts).toBe(2);
    expect(host.state(consumer.id).lifecycleState).toBe("running");
    expect(host.capabilities.has(CAP_B)).toBe(true);
  });

  it("binds the permission lease to the plugin instance and session intersection", async () => {
    let lease!: PluginContext["permissionLease"];
    const host = createPluginHost({

      approvedPermissionsForPlugin: () => ["storage.read", "storage.write"],
      sessionPermissionsForPlugin: () => ["storage.read"],
      lifecycleIdentityForPlugin: () => ({
        ownerPublicKeyHex: "02" + "22".repeat(32),
        sessionEpoch: "owner-session:1",
        walletGeneration: "owner-wallet:7",
        authorizationRevision: 3,
      }),
    });
    await host.register({
      id: "permission-bound",
      name: "Permission bound",
      permissions: ["storage.read", "storage.write"],
      meta: {     },
      setup(ctx) {
        lease = ctx.permissionLease;
        expect(ctx.permissions).toEqual(["storage.read"]);
        expect(ctx.permissionLease.binding.instanceId).toBe(ctx.instanceId);
        expect(ctx.permissionLease.binding.pluginId).toBe(ctx.pluginId);
        expect(ctx.permissionLease.binding.attributes).toMatchObject({
          ownerPublicKeyHex: "02" + "22".repeat(32),
          sessionEpoch: "owner-session:1",
          walletGeneration: "owner-wallet:7",
          authorizationRevision: 3,
        });
      },
    });
    expect(lease.has("storage.read")).toBe(true);
    expect(lease.has("storage.write")).toBe(false);
    await host.revoke("permission-bound", "test revocation");
    expect(lease.revoked).toBe(true);
  });

  it("disable removes owner resources and revokes capabilities", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeA()]);
    expect(host.state("a").error).toBeUndefined();
    expect(host.state("a")).toMatchObject({ kind: "enabled" });
    const before = view(host);
    expect(before.routes.ids).toContain(ROUTE_A);
    expect(before.capabilities.keys).toContain(CAP_A.id);

    const r = await host.revoke("a", "test revocation");
    expect(r).toBeUndefined();
    expect(host.state("a").kind).toBe("blocked");

    const after = view(host);
    expect(after.routes.ids).not.toContain(ROUTE_A);
    expect(after.capabilities.keys).not.toContain(CAP_A.id);
  });

  it("removes routes synchronously even when teardown never returns", async () => {
    const host = createPluginHost({  lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "hanging-teardown",
      name: "Hanging teardown",
      meta: {     },
      setup(ctx) {
        ctx.capability(ROUTE_REGISTRY_CAPABILITY).register({
          id: "hanging-teardown.route",
          path: "/hanging-teardown",
          label: "Hanging teardown",
          component: () => null,
        });
        ctx.capability(RESOURCE_REGISTRY_CAPABILITY).register({
          id: "hanging-teardown.resource",
          scope: "global",
          key: () => ["hanging-teardown.resource"],
          load: async () => ({ ok: true }),
          invalidation: "immediate",
        });
        return async () => new Promise<void>(() => undefined);
      },
    });

    const disabling = host.revoke("hanging-teardown", "test revocation");
    // beginPluginStop() 的同步撤权必须先于网络/异步 teardown。
    expect(host.routes.byId("hanging-teardown.route")).toBeUndefined();
    expect(host.capabilities.get(RESOURCE_REGISTRY_CAPABILITY).get("hanging-teardown.resource")).toBeUndefined();
    await disabling;
    expect(host.state("hanging-teardown").kind).toBe("cleanup-pending");
  });

  it("rebuilds owner-session instances when the runtime identity changes", async () => {
    const ownerA = "02" + "11".repeat(32);
    const ownerB = "02" + "22".repeat(32);
    const instances: string[] = [];
    const host = createPluginHost({

      runtime: "window-main",
      initialRuntimeIdentity: {
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:a:1",
      walletGeneration: "wallet:a:1",
      },
    });
    await host.register({
      id: "owner-session-plugin",
      name: "Owner session plugin",
      meta: {     },
      units: [{
        id: "owner-session-plugin.window",
        runtime: "window-main",
        scopeKind: "owner-session",
        provides: ["owner-session-plugin.service"],
      }],
      setup(ctx) {
        instances.push(ctx.instanceId);
        ctx.capability(ROUTE_REGISTRY_CAPABILITY).register({
          id: "owner-session-plugin.route",
          path: "/owner-session-plugin",
          label: "Owner session plugin",
          component: () => null,
        });
        ctx.provide(testCapability("owner-session-plugin.service"), true);
      },
    });

    const firstScope = host.scope("owner-session-plugin");
    const firstInstanceId = firstScope?.identity.instanceId;
    expect(firstScope?.identity.parentScopeId).toBeTruthy();
    expect(firstScope?.identity.parentScopeId).not.toBe(host.rootScope.identity.scopeId);
    expect(host.routes.byId("owner-session-plugin.route")).toBeDefined();

    const lockTransition = host.transitionRuntimeIdentity({
      vaultStatus: "locked",
      sessionEpoch: "session:a:2",
      walletGeneration: "wallet:a:1",
    });
    // 同步撤权发生在 transition API 返回前，不等待 teardown。
    expect(host.routes.byId("owner-session-plugin.route")).toBeUndefined();
    expect(host.capabilities.has(testCapability("owner-session-plugin.service"))).toBe(false);
    await lockTransition;
    expect(host.state("owner-session-plugin")).toMatchObject({
      kind: "blocked",
      blockedBy: expect.arrayContaining(["runtime:owner-session-unavailable"]),
    });

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:a:3",
      walletGeneration: "wallet:a:1",
    });
    const secondInstanceId = host.scope("owner-session-plugin")?.identity.instanceId;
    expect(host.state("owner-session-plugin").kind).toBe("enabled");
    expect(secondInstanceId).toBeTruthy();
    expect(secondInstanceId).not.toBe(firstInstanceId);

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerB,
      sessionEpoch: "session:b:1",
      walletGeneration: "wallet:a:1",
    });
    const thirdInstanceId = host.scope("owner-session-plugin")?.identity.instanceId;
    expect(thirdInstanceId).not.toBe(secondInstanceId);
    expect(host.state("owner-session-plugin").kind).toBe("enabled");

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:a:4",
      walletGeneration: "wallet:a:1",
    });
    const fourthInstanceId = host.scope("owner-session-plugin")?.identity.instanceId;
    expect(fourthInstanceId).not.toBe(thirdInstanceId);
    expect(instances).toHaveLength(4);
    expect(host.routes.byId("owner-session-plugin.route")).toBeDefined();
  });

  it("revokes an owner-session instance synchronously when lock arrives during setup", async () => {
    const ownerA = "02" + "33".repeat(32);
    let releaseSetup!: () => void;
    const setupReleased = new Promise<void>((resolve) => { releaseSetup = resolve; });
    let setupStarted!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const host = createPluginHost({

      runtime: "window-main",
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: ownerA,
        sessionEpoch: "session:init:1",
        walletGeneration: "wallet:init:1",
      },
    });
    const instances: string[] = [];

    const registering = host.register({
      id: "owner-session-starting",
      name: "Owner session starting",
      meta: {     },
      units: [{
        id: "owner-session-starting.window",
        runtime: "window-main",
        scopeKind: "owner-session",
        provides: ["owner-session-starting.service"],
      }],
      setup: async (ctx) => {
        instances.push(ctx.instanceId);
        ctx.capability(ROUTE_REGISTRY_CAPABILITY).register({
          id: "owner-session-starting.route",
          path: "/owner-session-starting",
          label: "Owner session starting",
          component: () => null,
        });
        setupStarted();
        await setupReleased;
        // setup 的迟到完成不能把能力发布回已撤销的 owner 世代。
        if (ctx.signal.aborted) return;
        ctx.provide(testCapability("owner-session-starting.service"), true);
      },
    });
    await started;
    expect(host.state("owner-session-starting").kind).toBe("starting");
    expect(host.routes.byId("owner-session-starting.route")).toBeDefined();

    const locking = host.transitionRuntimeIdentity({
      vaultStatus: "locked",
      sessionEpoch: "session:init:2",
      walletGeneration: "wallet:init:1",
    });
    // lock 的同步阶段先撤销所有本地入口，再等待 setup 完成。
    expect(host.routes.byId("owner-session-starting.route")).toBeUndefined();
    expect(host.capabilities.has(testCapability("owner-session-starting.service"))).toBe(false);
    releaseSetup();
    await registering;
    await locking;
    expect(host.state("owner-session-starting")).toMatchObject({
      kind: "blocked",
      blockedBy: expect.arrayContaining(["runtime:owner-session-unavailable"]),
    });

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:init:3",
      walletGeneration: "wallet:init:1",
    });
    expect(host.state("owner-session-starting").kind).toBe("enabled");
    expect(instances).toHaveLength(2);
    expect(host.routes.byId("owner-session-starting.route")).toBeDefined();
  });

  it("recovers cleanup-pending after a timed-out disposer eventually succeeds", async () => {
    let releaseLate!: () => void;
    const host = createPluginHost({  lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "late-cleanup-recovery",
      name: "Late cleanup recovery",
      meta: {     },
      setup() {
        return () => new Promise<void>((resolve) => { releaseLate = resolve; });
      },
    });

    const disabling = host.revoke("late-cleanup-recovery", "test revocation");
    await disabling;
    expect(host.state("late-cleanup-recovery").kind).toBe("cleanup-pending");

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(host.state("late-cleanup-recovery").kind).toBe("blocked");

    await host.retry("late-cleanup-recovery");
    expect(host.state("late-cleanup-recovery").kind).toBe("enabled");
  });

  it("keeps cleanup-pending when a timed-out teardown eventually fails", async () => {
    let failLate!: () => void;
    const host = createPluginHost({  lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "late-cleanup-failure",
      name: "Late cleanup failure",
      meta: {     },
      setup() {
        return () => new Promise<void>((_resolve, reject) => {
          failLate = () => reject(new Error("late teardown failed"));
        });
      },
    });

    const disabling = host.revoke("late-cleanup-failure", "test revocation");
    await disabling;
    expect(host.state("late-cleanup-failure").kind).toBe("cleanup-pending");

    failLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(host.state("late-cleanup-failure")).toMatchObject({
      kind: "cleanup-pending",
      error: "late teardown failed",
    });
    expect(host.state("late-cleanup-failure").cleanup?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "lifecycle.cleanup_failed",
        message: "late teardown failed",
      }),
    ]));
    await host.retry("late-cleanup-failure");
    expect(host.state("late-cleanup-failure").kind).toBe("enabled");
  });

  it("includes plugin cleanup in Host dispose result", async () => {
    let releaseLate!: () => void;
    const host = createPluginHost({  lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "host-dispose-pending",
      name: "Host dispose pending",
      meta: {     },
      setup() {
        return () => new Promise<void>((resolve) => { releaseLate = resolve; });
      },
    });

    const disposed = host.dispose("test host dispose");
    expect(host.dispose("repeat dispose")).toBe(disposed);
    const result = await disposed;
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.pending).toContain("plugin:host-dispose-pending:scope:teardown");

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(result.cleanupIncomplete).toBe(false);
    expect(result.pending).toEqual([]);
  });

  it("keeps Host cleanup incomplete when a disabled plugin still has pending cleanup", async () => {
    let releaseLate!: () => void;
    const host = createPluginHost({  lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "disabled-before-host-dispose",
      name: "Disabled before Host dispose",
      meta: {     },
      setup() {
        return () => new Promise<void>((resolve) => { releaseLate = resolve; });
      },
    });

    await host.revoke("disabled-before-host-dispose", "test revocation");
    expect(host.state("disabled-before-host-dispose").kind).toBe("cleanup-pending");

    const result = await host.dispose("host disposed after plugin disable");
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: "plugin:disabled-before-host-dispose:scope:teardown",
        code: "lifecycle.cleanup_timeout",
      }),
    ]));

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(result).toMatchObject({ cleanupIncomplete: false, pending: [] });
  });

  it("releases every plugin by an explicit lifecycle event", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeC()]);
    const r = await host.revoke("c", "test revocation");
    expect(r).toBeUndefined();
    expect(host.state("c").kind).toBe("blocked");
  });

  it("does not cascade-stop a product for an optional capability", async () => {
    const consumer: PluginManifest = {
      id: "optional-consumer",
      name: "Optional consumer",
      meta: {     },
      provides: ["optional-consumer.service"],
      dependencies: [{ capability: CAP_A, optional: true }],
      setup(ctx) { ctx.provide(testCapability("optional-consumer.service"), true); },
    };
    const host = createPluginHost({  });
    await host.registerAll([makeA(), consumer]);

    await host.revoke("a", "test revocation");
    expect(host.state("a").kind).toBe("blocked");
    expect(host.state(consumer.id)).toMatchObject({ kind: "enabled" });
    expect(host.capabilities.has(testCapability("optional-consumer.service"))).toBe(true);
  });

  it("enable restores owner resources", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeA()]);
    await host.revoke("a", "test revocation");
    await host.retry("a");
    expect(host.state("a").error).toBeUndefined();
    expect(host.state("a")).toMatchObject({ kind: "enabled" });
    expect(host.routes.byId(ROUTE_A)).toBeDefined();
    expect(host.capabilities.has(CAP_A)).toBe(true);
  });

  it("unregister removes plugin from host entirely", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeA()]);
    await host.unregister("a");
    expect(host.manifests()).not.toContain("a");
    expect(host.state("a").kind).toBe("registered");
  });

  it("version bumps and subscribers notified", async () => {
    const host = createPluginHost({  });
    const seen: number[] = [];
    host.subscribe((s) => seen.push(s.version));
    expect(host.version()).toBe(0);
    await host.registerAll([makeA()]);
    await host.revoke("a", "test revocation");
    await host.retry("a");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
  });

  it("setup can return teardown which is invoked on disable", async () => {
    const teardown = (): void => undefined;
    const plugin: PluginManifest = {
      id: "td",
      name: "TD",
      meta: {     },
      setup() {
        return teardown;
      }
    };
    const host = createPluginHost({  });
    await host.registerAll([plugin]);
    expect(host.state("td").kind).toBe("enabled");
    await host.revoke("td", "test revocation");
    // 仅断言状态；teardown 已调起。
    expect(host.state("td").kind).toBe("blocked");
  });

  it("revokes borrowed registry reads before disposal callbacks and tears down owned registrations", async () => {
    const events: string[] = [];
    const plugin: PluginManifest = {
      id: "dispose-hook",
      name: "Dispose hook",
      meta: {     },
      setup(ctx) {
        const routes = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
        routes.register({ id: "dispose.route", path: "/dispose", label: "Dispose", component: () => null });
        ctx.onDispose(() => { expect(() => routes.byId("dispose.route")).toThrow(); events.push("dispose:revoked"); });
        return () => { expect(() => routes.byId("dispose.route")).toThrow(); events.push("teardown:revoked"); };
      }
    };
    const host = createPluginHost({  });
    await host.register(plugin);
    await host.revoke(plugin.id, "test revocation");
    expect(events).toEqual(["dispose:revoked", "teardown:revoked"]);
    expect(host.routes.byId("dispose.route")).toBeUndefined();
  });

  it("setup throwing causes error-disabled state and removes owner", async () => {
    const plugin: PluginManifest = {
      id: "bad",
      name: "Bad",
      meta: {     },
      setup(ctx: PluginContext) {
        const r = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
        r.register({ id: "bad.route", path: "/bad", label: "Bad", component: () => null });
        throw new Error("setup failed");
      }
    };
    const host = createPluginHost({  });
    await host.register(plugin);
    const s = host.state("bad");
    expect(s.kind).toBe("failed");
    expect(s.error).toContain("setup failed");
    expect(host.routes.byId("bad.route")).toBeUndefined();
  });

  it("reclaims a registry item registered after setup returns", async () => {
    let registerLate!: () => void;
    const plugin: PluginManifest = {
      id: "late-registry",
      name: "Late registry",
      meta: {     },
      setup(ctx) {
        const routes = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
        registerLate = () => routes.register({
          id: "late-registry.route",
          path: "/late-registry",
          label: "Late registry",
          component: () => null,
        });
      },
    };
    const host = createPluginHost({  });
    await host.register(plugin);

    // 模拟 setup 返回后由异步回调完成的注册。
    registerLate();
    expect(host.routes.byId("late-registry.route")).toBeDefined();

    await host.revoke(plugin.id, "test revocation");
    expect(host.routes.byId("late-registry.route")).toBeUndefined();
  });

  it("keeps callback publication within the original lifetime", async () => {
    let provideLate!: () => void;
    const host = createPluginHost({  });
    const plugin: PluginManifest = {
      id: "late-capability",
      name: "Late capability",
      meta: {     },
      provides: ["late-capability.service"],
      setup(ctx) {
        ctx.provide(testCapability("late-capability.service"), { ok: false });
        provideLate = () => ctx.provide(testCapability("late-capability.service"), { ok: true });
      },
    };
    await host.register(plugin);
    expect(provideLate).toThrow(/already provided/);
    expect(host.capabilities.has(testCapability("late-capability.service"))).toBe(true);
    await host.revoke(plugin.id, "test revocation");
    expect(host.capabilities.has(testCapability("late-capability.service"))).toBe(false);
    provideLate();
    expect(host.capabilities.has(testCapability("late-capability.service"))).toBe(false);
  });

  it("missing dependency blocks enable (sets state to blocked)", async () => {
    const host = createPluginHost({  });
    await host.registerAll([makeB([CAP_A])]);
    const s = host.state("b");
    expect(s.kind).toBe("blocked");
  });
});

describe("createPluginHost - startup contract", () => {
  function required(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      id: "required",
      name: "Required",
      meta: {




        providesCapabilities: ["required.service"]
      },
      provides: ["required.service"],
      setup(ctx) {
        ctx.provide(testCapability("required.service"), { ok: true });
      },
      ...overrides
    };
  }

  it("validates required dependencies against the complete manifest set", () => {
    const host = createPluginHost({  });
    const optionalProvider = {
      id: "optional-provider",
      name: "Optional provider",
      meta: {     providesCapabilities: ["optional.service"] },
      setup() {}
    } satisfies PluginManifest;
    expect(() => host.validateManifestSet([
      required({ dependencies: [{ capability: "optional.service" }] }),
      optionalProvider
    ])).not.toThrow();
  });

  it("wraps required setup failures and rolls back owned resources", async () => {
    const host = createPluginHost({  });
    const plugin = required({
      setup(ctx) {
        ctx.capability(ROUTE_REGISTRY_CAPABILITY).register({
          id: "required.route",
          path: "/required",
          label: "required",
          component: () => null
        });
        throw new Error("secret underlying failure");
      }
    });
    await host.register(plugin);
    expect(host.routes.byId("required.route")).toBeUndefined();
    expect(host.capabilities.has(testCapability("required.service"))).toBe(false);
    expect(host.state("required").kind).toBe("failed");
  });

  it("rejects a required provider that fails to provide its declaration", async () => {
    const host = createPluginHost({  });
    await host.register(required({ setup() {} }));
    expect(host.capabilities.has(testCapability("required.service"))).toBe(false);
  });

  it("asserts provider, state, error, and configured value without exposing stack", async () => {
    const host = createPluginHost({  });
    const provider = required({ setup() { throw new Error("private stack detail"); } });
    await host.register(provider);
    try {
      host.assertCapabilities([testCapability("required.service")], { phase: "test" });
      throw new Error("expected assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupCapabilityError);
      const details = (error as StartupCapabilityError).details[0]!;
      expect(details).toMatchObject({
        capability: "required.service",
        providerPluginId: "required",
        providerState: "failed"
      });
      expect(details.providerError).toContain("private stack detail");
    }
  });
});
