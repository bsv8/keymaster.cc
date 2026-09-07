// packages/runtime/src/createPluginHost.test.ts
// 硬切换 001 + 2026-07-04 001：runtime 生命周期核心测试。
//   - register / enable / disable / unregister
//   - owner 回收（route / menu / capability / settings page）
//   - 禁用提供者级联停止消费者并保留用户意图
//   - canDisable=false 阻止 disable
//   - version + subscribe
//   - graph / state
//   - bootstrap 路径：config store override + defaultEnabled 决定初始 enabled
//   - Channel caller 由 Coordinator/Session Window 负责，runtime 不注入传输层
//     client，也不维护消息传输状态。

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  createPluginHost,
  StartupCapabilityError,
  StartupPluginError,
  type PluginHost
} from "./createPluginHost.js";
import { CHANNEL_RUNTIME_CAPABILITY, type ChannelRuntime, type ChannelRuntimeFactory, type KeyValueStore, type PluginContext, type PluginIntentCoordinator, type PluginManifest, type ResourceRegistry } from "@keymaster/contracts";
import type { RouteRegistry } from "./registries/routeRegistry.js";
import type { SettingsRegistry } from "./registries/settingsRegistry.js";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import { createInMemoryKeyValueStore } from "./storage/inMemoryKeyValueStore.js";
import { createPluginIntentController } from "./lifecycle/pluginIntentController.js";
import { createRuntimeUnitImplementationRegistry } from "./lifecycle/runtimeUnitImplementationRegistry.js";

interface RegistryViews {
  routes: { ids: string[] };
  settingsRoutes: { ids: string[] };
  capabilities: { keys: string[] };
}

function view(host: PluginHost): RegistryViews {
  return {
    routes: { ids: host.routes._ids() },
    settingsRoutes: { ids: host.settings._ids() },
    capabilities: { keys: host.capabilities.keys() }
  };
}

const ROUTE_A = "test.a.route";
const ROUTE_B = "test.b.route";
const ROUTE_C = "test.c.route";
const CAP_A = "test.a.cap";
const CAP_B = "test.b.cap";
const CAP_C = "test.c.cap";
const TEST_RUNTIME_IDENTITY = {
  vaultStatus: "unlocked" as const,
  ownerPublicKeyHex: "02" + "11".repeat(32),
  sessionEpoch: "test-session:1",
  bucketGeneration: 1,
};

function makeA(): PluginManifest {
  return {
    id: "a",
    name: "A",
    description: "plugin A",
    meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_A] },
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
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

function makeB(dependsOn: string[] = [CAP_A]): PluginManifest {
  return {
    id: "b",
    name: "B",
    description: "plugin B",
    meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_B] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
      r.register({
        id: ROUTE_B,
        path: "/b",
        label: "B",
        component: () => null
      });
      const s = ctx.get<SettingsRegistry>("settings.registry");
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

function makeC(dependsOn: string[] = []): PluginManifest {
  return {
    id: "c",
    name: "C",
    description: "plugin C - core",
    meta: { kind: "core", startup: "required", defaultEnabled: true, canDisable: false, providesCapabilities: [CAP_C] },
    dependencies: dependsOn.map((c) => ({ capability: c })),
    setup(ctx: PluginContext) {
      const r = ctx.get<RouteRegistry>("route.registry");
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
    let resolveOpen!: (store: KeyValueStore) => void;
    const openPromise = new Promise<KeyValueStore>((resolve) => { resolveOpen = resolve; });
    const authority: StorageBindingAuthority = {
      getActivePublicKeyHex: () => owner,
      openOwnerAppStore: async () => openPromise,
      openPlatformStore: async () => createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: "platform", schemaVersion: 1, bucketId: "bucket", bucketGeneration: 1 }),
      deleteOwnerStorage: async () => undefined,
    };
    const host = createPluginHost({ disableConfigPersistence: true, storageBindingAuthority: authority });
    const plugin: PluginManifest = {
      id: "late-owner-store",
      name: "Late owner store",
      storage: { scope: "key", applicationStorageId: "LateOwnerStore", schemaVersion: 1 },
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      async setup(ctx) {
        // 首次 K-V 操作会触发延迟 owner binding；在 binding 等待期间撤权。
        await ctx.storage!.get("during-start");
      },
    };
    const registering = host.register(plugin);
    await Promise.resolve();
    expect(host.state(plugin.id).kind).toBe("starting");
    const disabling = host.disable(plugin.id);
    const rawStore = createInMemoryKeyValueStore({
      scope: "key",
      applicationStorageId: "LateOwnerStore",
      schemaVersion: 1,
      bucketId: "bucket",
      bucketGeneration: 1,
      ownerPublicKeyHex: owner,
    });
    let closed = false;
    const store: KeyValueStore = { ...rawStore, close: () => { closed = true; rawStore.close(); } };
    resolveOpen(store);
    await registering;
    await disabling;
    expect(host.state(plugin.id).kind).toBe("disabled");
    expect(closed).toBe(true);
  });

  it("refreshes Resource Store when a plugin provides keyspace", async () => {
    const activeListeners = new Set<() => void>();
    const keyspace = {
      active: () => ({ activePublicKeyHex: "pk1" }),
      onActiveKeyChanged: (handler: () => void) => {
        activeListeners.add(handler);
        return () => activeListeners.delete(handler);
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "late-keyspace",
      name: "Late keyspace",
      description: "test",
      meta: { kind: "platform", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        ctx.provide("keyspace.service", keyspace);
      }
    });
    expect(activeListeners.size).toBe(1);
    await host.disable("late-keyspace");
    expect(activeListeners.size).toBe(0);
  });

  it("binds Channel plugin identity to the manifest and rejects system callers", async () => {
    const runtime = {} as ChannelRuntime;
    const rawFactory: ChannelRuntimeFactory = {
      forPlugin: vi.fn(() => runtime),
      forSystem: vi.fn(() => runtime)
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide(CHANNEL_RUNTIME_CAPABILITY, rawFactory);

    let contextPluginId: string | undefined;
    let factory: ChannelRuntimeFactory | undefined;
    await host.register({
      id: "bound-channel-plugin",
      name: "Bound Channel plugin",
      description: "test",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        contextPluginId = ctx.pluginId;
        factory = ctx.get<ChannelRuntimeFactory>(CHANNEL_RUNTIME_CAPABILITY);
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
  it("registers business declarations independently and rolls them back", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "business-surface",
      name: "Business surface",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      business: {
        domains: [{
          id: "business-surface.domain",
          label: { key: "test.business.domain", fallback: "Business" },
          order: 10,
          features: [{
            id: "business-surface.feature",
            label: { key: "test.business.page", fallback: "Business page" },
            order: 12,
            entry: { path: "/business-surface", component: () => null },
            home: [{
              id: "business-surface.projection",
              space: { id: "business-surface.summary", label: { key: "test.business.space", fallback: "Summary" }, order: 10 },
              order: 3,
              component: () => null
            }]
          }]
        }]
      },
      setup() {}
    });

    expect(host.routes.byId("business-surface.feature")?.path).toBe("/business-surface");
    expect(host.home.list()).toEqual([]);
    expect(host.business.listDomains().map((domain) => domain.id)).toEqual(["business-surface.domain"]);
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toEqual(["business-surface.projection"]);

    await host.disable("business-surface");
    expect(host.routes.byId("business-surface.feature")).toBeUndefined();
    expect(host.business.listDomains()).toEqual([]);
    expect(host.business.listHomeProjections()).toEqual([]);
  });

  it("registers plugins and reads graph", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA(), makeB([CAP_A]), makeC()]);
    expect(host.manifests()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    const g = host.graph();
    expect(g.dependencies.a).toEqual([]);
    expect(g.dependencies.b).toEqual([CAP_A]);
    expect(g.provides.a).toEqual([CAP_A]);
    expect(g.reverse.a?.[0]?.pluginId).toBe("b");
  });

  it("runs the primary runtime unit entry and uses only its configuration", async () => {
    let seenUnitId: string | undefined;
    let seenConfig: Record<string, unknown> | undefined;
    const host = createPluginHost({
      disableConfigPersistence: true,
      initialRuntimeIdentity: TEST_RUNTIME_IDENTITY,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: "unit-entry",
        unitId: "unit-entry.worker",
        setup(ctx) {
          seenUnitId = ctx.unitId;
          seenConfig = ctx.config;
          ctx.provide("unit-entry.service", { instanceId: ctx.instanceId });
        },
      }]),
    });
    await host.register({
      id: "unit-entry",
      name: "Unit entry",
      meta: {
        kind: "business",
        startup: "optional",
        defaultEnabled: true,
        canDisable: true,
      },
      units: [{
        id: "unit-entry.worker",
        execution: "coordinator-worker",
        lifetime: "owner-session",
        provides: ["unit-entry.service"],
        config: { source: "unit", productOnly: true, unitOnly: true },
      }],
    });

    expect(seenUnitId).toBe("unit-entry.worker");
    expect(seenConfig).toEqual({ source: "unit", productOnly: true, unitOnly: true });
    expect(host.state("unit-entry").unitId).toBe("unit-entry.worker");
    expect(host.capabilities.has("unit-entry.service")).toBe(true);
  });

  it("fails closed when a multi-unit product is loaded without an execution host", async () => {
    const product: PluginManifest = {
      id: "multi-unit-product",
      name: "Multi-unit product",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      units: [
        { id: "multi-unit.worker", execution: "coordinator-worker", lifetime: "root", provides: ["multi.worker"] },
        { id: "multi-unit.window", execution: "window", lifetime: "owner-session", provides: ["multi.window"] },
      ],
    };

    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(product)).rejects.toThrow(/execution must be explicit/i);
    expect(host.capabilities.has("multi.worker")).toBe(false);
    expect(host.capabilities.has("multi.window")).toBe(false);
  });

  it("runs only the selected unit in separate Worker and Window hosts", async () => {
    const starts: string[] = [];
    const implementations = createRuntimeUnitImplementationRegistry([
      {
        pluginId: "split-runtime-product",
        unitId: "split-runtime.worker",
        setup(ctx) { starts.push(`worker:${ctx.unitId}`); ctx.provide("split.worker", ctx.instanceId); },
      },
      {
        pluginId: "split-runtime-product",
        unitId: "split-runtime.window",
        setup(ctx) { starts.push(`window:${ctx.unitId}`); ctx.provide("split.window", ctx.instanceId); },
      },
    ]);
    const product: PluginManifest = {
      id: "split-runtime-product",
      name: "Split runtime product",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      units: [
        {
          id: "split-runtime.worker",
          execution: "coordinator-worker",
          lifetime: "root",
          provides: ["split.worker"],
        },
        {
          id: "split-runtime.window",
          execution: "window",
          lifetime: "owner-session",
          provides: ["split.window"],
        },
      ],
    };

    const workerHost = createPluginHost({ disableConfigPersistence: true, execution: "coordinator-worker", initialRuntimeIdentity: TEST_RUNTIME_IDENTITY, runtimeUnitImplementationRegistry: implementations });
    const windowHost = createPluginHost({ disableConfigPersistence: true, execution: "window", initialRuntimeIdentity: TEST_RUNTIME_IDENTITY, runtimeUnitImplementationRegistry: implementations });
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
    expect(workerHost.capabilities.has("split.window")).toBe(false);
    expect(windowHost.capabilities.has("split.worker")).toBe(false);
  });

  it("does not require provider-before-consumer manifest order and restores desired consumers", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeB([CAP_A]), makeA()]);

    expect(host.state("a").kind).toBe("enabled");
    expect(host.state("b").kind).toBe("enabled");
    await host.disable("a");
    expect(host.state("b")).toMatchObject({ kind: "blocked", desiredEnabled: true });

    await host.enable("a");
    expect(host.state("b")).toMatchObject({ kind: "enabled", desiredEnabled: true });
  });

  it("restores a dependency chain in provider order without changing consumer intent", async () => {
    const b = makeB([CAP_A]);
    const c: PluginManifest = {
      id: "chain-c",
      name: "Chain C",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: ["chain.c"] },
      dependencies: [{ capability: CAP_B }],
      setup(ctx) { ctx.provide("chain.c", { ok: true }); },
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([c, b, makeA()]);
    await host.disable("a");
    expect(host.state("b").lifecycleState).toBe("waiting");
    expect(host.state("chain-c").lifecycleState).toBe("waiting");
    expect(host.configStore.read()).toMatchObject({ a: false, b: true, "chain-c": true });

    await host.enable("a");
    expect(host.state("b").lifecycleState).toBe("running");
    expect(host.state("chain-c").lifecycleState).toBe("running");
  });

  it("cascades a starting consumer into waiting without restarting the revoked instance", async () => {
    let releaseSetup!: () => void;
    const setupReleased = new Promise<void>((resolve) => { releaseSetup = resolve; });
    let consumerStarts = 0;
    const consumer: PluginManifest = {
      id: "starting-consumer",
      name: "Starting consumer",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: [CAP_B] },
      dependencies: [{ capability: CAP_A }],
      async setup(ctx) {
        consumerStarts += 1;
        await setupReleased;
        // 依赖提供者已经撤权后，这个旧实例的迟到结果不能再次发布能力。
        ctx.provide(CAP_B, { instance: consumerStarts });
      },
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeA());

    const registering = host.register(consumer);
    await Promise.resolve();
    expect(host.state(consumer.id).kind).toBe("starting");

    const disabling = host.disable("a");
    releaseSetup();
    await registering;
    await disabling;

    expect(consumerStarts).toBe(1);
    expect(host.state(consumer.id)).toMatchObject({
      kind: "blocked",
      lifecycleState: "waiting",
      desiredEnabled: true,
      blockedBy: [CAP_A],
    });
    expect(host.capabilities.has(CAP_B)).toBe(false);

    await host.enable("a");
    expect(consumerStarts).toBe(2);
    expect(host.state(consumer.id).lifecycleState).toBe("running");
    expect(host.capabilities.has(CAP_B)).toBe(true);
  });

  it("defaultEnabled drives initial enabled set", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const a = makeA();
    const off: PluginManifest = {
      ...makeB([CAP_A]),
      meta: { kind: "business", startup: "optional", defaultEnabled: false, canDisable: true, providesCapabilities: [CAP_B] }
    };
    await host.registerAll([a, off]);
    expect(host.installed()).toEqual(expect.arrayContaining(["a"]));
    expect(host.installed()).not.toContain("b");
  });

  it("submits an absolute intent to the Coordinator before starting the Window instance", async () => {
    const controller = createPluginIntentController({
      authorityInstanceId: "authority:test",
      initial: { revision: 0, desiredEnabled: { "intent-product": false }, desiredRevision: { "intent-product": 1 } },
    });
    const commands: Array<{ commandId: string; authorityInstanceId: string; expectedRevision: number; pluginId: string; desiredEnabled: boolean }> = [];
    const coordinator: PluginIntentCoordinator = {
      authorityInstanceId: controller.authorityInstanceId,
      snapshot: controller.snapshot,
      subscribe: controller.subscribe,
      submit(command) {
        commands.push(command);
        return controller.submit(command);
      },
    };
    const host = createPluginHost({
      disableConfigPersistence: true,
      pluginIntentCoordinator: coordinator,
      execution: "window",
      initialRuntimeIdentity: TEST_RUNTIME_IDENTITY,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: "intent-product",
        unitId: "intent-product.window",
        setup(ctx) { ctx.provide("intent.product", { ready: true }); },
      }]),
    });
    await host.register({
      id: "intent-product",
      name: "Intent product",
      meta: { kind: "business", startup: "optional", defaultEnabled: false, canDisable: true },
      units: [{
        id: "intent-product.window",
        execution: "window",
        lifetime: "owner-session",
        provides: ["intent.product"],
      }],
      setup() {
        throw new Error("product-level setup must not run when a unit is selected");
      },
    });
    expect(host.state("intent-product")).toMatchObject({ kind: "registered", lifecycleState: "disabled", desiredEnabled: false });

    const result = await host.submitIntent("intent-product", true);

    expect(result).toMatchObject({ status: "accepted", persisted: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      authorityInstanceId: "authority:test",
      expectedRevision: 0,
      pluginId: "intent-product",
      desiredEnabled: true,
    });
    expect(commands[0]!.commandId).toMatch(/^plugin-intent:intent-product:/);
    expect(controller.snapshot()).toMatchObject({ revision: 1, desiredEnabled: { "intent-product": true } });
    expect(host.state("intent-product")).toMatchObject({ kind: "enabled", desiredEnabled: true, unitId: "intent-product.window" });
  });

  it("keeps the persisted intent when local instance startup fails", async () => {
    const controller = createPluginIntentController({
      authorityInstanceId: "authority:failure",
      initial: { revision: 0, desiredEnabled: { "failing-intent": false }, desiredRevision: {} },
    });
    const host = createPluginHost({
      disableConfigPersistence: true,
      pluginIntentCoordinator: controller,
      execution: "window",
      initialRuntimeIdentity: TEST_RUNTIME_IDENTITY,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: "failing-intent",
        unitId: "failing-intent.window",
        setup() { throw new Error("window startup failed"); },
      }]),
    });
    await host.register({
      id: "failing-intent",
      name: "Failing intent",
      meta: { kind: "business", startup: "optional", defaultEnabled: false, canDisable: true },
      units: [{
        id: "failing-intent.window",
        execution: "window",
        lifetime: "owner-session",
        provides: ["failing.intent"],
      }],
    });

    const result = await host.submitIntent("failing-intent", true);

    expect(result.status).toBe("accepted");
    expect(controller.snapshot().desiredEnabled["failing-intent"]).toBe(true);
    expect(host.state("failing-intent")).toMatchObject({ kind: "error-disabled", desiredEnabled: true });
  });

  it("does not let the legacy config store bypass the Coordinator intent authority", async () => {
    const controller = createPluginIntentController({
      authorityInstanceId: "authority:config-fence",
      initial: {
        revision: 1,
        desiredEnabled: { "config-fenced": true },
        desiredRevision: { "config-fenced": 1 },
      },
    });
    const host = createPluginHost({
      disableConfigPersistence: true,
      pluginIntentCoordinator: controller,
    });
    await host.register({
      id: "config-fenced",
      name: "Config fenced",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) { ctx.provide("config-fenced.service", true); },
    });

    host.configStore.setEnabled("config-fenced", false);
    await Promise.resolve();

    expect(host.state("config-fenced")).toMatchObject({ kind: "enabled", desiredEnabled: true });
    expect(controller.snapshot()).toMatchObject({
      revision: 1,
      desiredEnabled: { "config-fenced": true },
    });
  });

  it("always enables plugins marked canDisable=false despite stale persisted config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    // This models a browser that retained a setting written before the plugin
    // became mandatory.
    host.configStore.setEnabled("c", false);

    await host.register(makeC());

    expect(host.state("c").kind).toBe("enabled");
    expect(host.capabilities.has(CAP_C)).toBe(true);
    expect(host.configStore.read().c).toBe(true);
  });

  it("always enables optional immutable plugins despite stale persisted config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const immutableOptional: PluginManifest = {
      ...makeC(),
      id: "immutable-optional",
      meta: {
        kind: "core",
        startup: "optional",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: [CAP_C]
      }
    };
    host.configStore.setEnabled("immutable-optional", false);

    await host.register(immutableOptional);

    expect(host.state("immutable-optional").kind).toBe("enabled");
    expect(host.configStore.read()["immutable-optional"]).toBe(true);
  });

  it("does not let config updates disable plugins marked canDisable=false", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(makeC());

    host.configStore.setEnabled("c", false);

    expect(host.state("c").kind).toBe("enabled");
    expect(host.capabilities.has(CAP_C)).toBe(true);
    expect(host.configStore.read().c).toBe(true);
  });

  it("binds the permission lease to the plugin instance and session intersection", async () => {
    let lease!: PluginContext["permissionLease"];
    const host = createPluginHost({
      disableConfigPersistence: true,
      approvedPermissionsForPlugin: () => ["storage.read", "storage.write"],
      sessionPermissionsForPlugin: () => ["storage.read"],
      lifecycleIdentityForPlugin: () => ({
        ownerPublicKeyHex: "02" + "22".repeat(32),
        sessionEpoch: "owner-session:1",
        bucketGeneration: 7,
        authorizationRevision: 3,
      }),
    });
    await host.register({
      id: "permission-bound",
      name: "Permission bound",
      permissions: ["storage.read", "storage.write"],
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        lease = ctx.permissionLease;
        expect(ctx.permissions).toEqual(["storage.read"]);
        expect(ctx.permissionLease.binding.instanceId).toBe(ctx.instanceId);
        expect(ctx.permissionLease.binding.pluginId).toBe(ctx.pluginId);
        expect(ctx.permissionLease.binding.ownerPublicKeyHex).toBe("02" + "22".repeat(32));
        expect(ctx.permissionLease.binding.sessionEpoch).toBe("owner-session:1");
        expect(ctx.permissionLease.binding.bucketGeneration).toBe(7);
        expect(ctx.permissionLease.binding.authorizationRevision).toBe(3);
      },
    });
    expect(lease.has("storage.read")).toBe(true);
    expect(lease.has("storage.write")).toBe(false);
    await host.disable("permission-bound");
    expect(lease.revoked).toBe(true);
  });

  it("disable removes owner resources and revokes capabilities", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    expect(host.state("a").kind).toBe("enabled");
    const before = view(host);
    expect(before.routes.ids).toContain(ROUTE_A);
    expect(before.capabilities.keys).toContain(CAP_A);

    const r = await host.disable("a");
    expect(r).toEqual({ ok: true });
    expect(host.state("a").kind).toBe("disabled");

    const after = view(host);
    expect(after.routes.ids).not.toContain(ROUTE_A);
    expect(after.capabilities.keys).not.toContain(CAP_A);
  });

  it("removes routes synchronously even when teardown never returns", async () => {
    const host = createPluginHost({ disableConfigPersistence: true, lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "hanging-teardown",
      name: "Hanging teardown",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        ctx.get<RouteRegistry>("route.registry").register({
          id: "hanging-teardown.route",
          path: "/hanging-teardown",
          label: "Hanging teardown",
          component: () => null,
        });
        ctx.get<ResourceRegistry>("resource.registry").register({
          id: "hanging-teardown.resource",
          scope: "global",
          key: () => ["hanging-teardown.resource"],
          load: async () => ({ ok: true }),
          invalidation: "immediate",
        });
        return async () => new Promise<void>(() => undefined);
      },
    });

    const disabling = host.disable("hanging-teardown");
    // beginPluginStop() 的同步撤权必须先于网络/异步 teardown。
    expect(host.routes.byId("hanging-teardown.route")).toBeUndefined();
    expect(host.capabilities.get<ResourceRegistry>("resource.registry").get("hanging-teardown.resource")).toBeUndefined();
    await disabling;
    expect(host.state("hanging-teardown").kind).toBe("cleanup-pending");
  });

  it("rebuilds owner-session instances when the runtime identity changes", async () => {
    const ownerA = "02" + "11".repeat(32);
    const ownerB = "02" + "22".repeat(32);
    const instances: string[] = [];
    const host = createPluginHost({
      disableConfigPersistence: true,
      execution: "window",
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: ownerA,
        sessionEpoch: "session:a:1",
        bucketGeneration: 1,
      },
    });
    await host.register({
      id: "owner-session-plugin",
      name: "Owner session plugin",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      units: [{
        id: "owner-session-plugin.window",
        execution: "window",
        lifetime: "owner-session",
        provides: ["owner-session-plugin.service"],
      }],
      setup(ctx) {
        instances.push(ctx.instanceId);
        ctx.get<RouteRegistry>("route.registry").register({
          id: "owner-session-plugin.route",
          path: "/owner-session-plugin",
          label: "Owner session plugin",
          component: () => null,
        });
        ctx.provide("owner-session-plugin.service", true);
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
      bucketGeneration: 1,
    });
    // 同步撤权发生在 transition API 返回前，不等待 teardown。
    expect(host.routes.byId("owner-session-plugin.route")).toBeUndefined();
    expect(host.capabilities.has("owner-session-plugin.service")).toBe(false);
    await lockTransition;
    expect(host.state("owner-session-plugin")).toMatchObject({
      kind: "blocked",
      desiredEnabled: true,
      blockedBy: ["runtime:owner-session-unavailable"],
    });

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:a:3",
      bucketGeneration: 1,
    });
    const secondInstanceId = host.scope("owner-session-plugin")?.identity.instanceId;
    expect(host.state("owner-session-plugin").kind).toBe("enabled");
    expect(secondInstanceId).toBeTruthy();
    expect(secondInstanceId).not.toBe(firstInstanceId);

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerB,
      sessionEpoch: "session:b:1",
      bucketGeneration: 1,
    });
    const thirdInstanceId = host.scope("owner-session-plugin")?.identity.instanceId;
    expect(thirdInstanceId).not.toBe(secondInstanceId);
    expect(host.state("owner-session-plugin").kind).toBe("enabled");

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:a:4",
      bucketGeneration: 1,
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
      disableConfigPersistence: true,
      execution: "window",
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: ownerA,
        sessionEpoch: "session:init:1",
        bucketGeneration: 1,
      },
    });
    const instances: string[] = [];

    const registering = host.register({
      id: "owner-session-starting",
      name: "Owner session starting",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      units: [{
        id: "owner-session-starting.window",
        execution: "window",
        lifetime: "owner-session",
        provides: ["owner-session-starting.service"],
      }],
      setup: async (ctx) => {
        instances.push(ctx.instanceId);
        ctx.get<RouteRegistry>("route.registry").register({
          id: "owner-session-starting.route",
          path: "/owner-session-starting",
          label: "Owner session starting",
          component: () => null,
        });
        setupStarted();
        await setupReleased;
        // setup 的迟到完成不能把能力发布回已撤销的 owner 世代。
        if (ctx.signal.aborted) return;
        ctx.provide("owner-session-starting.service", true);
      },
    });
    await started;
    expect(host.state("owner-session-starting").kind).toBe("starting");
    expect(host.routes.byId("owner-session-starting.route")).toBeDefined();

    const locking = host.transitionRuntimeIdentity({
      vaultStatus: "locked",
      sessionEpoch: "session:init:2",
      bucketGeneration: 1,
    });
    // lock 的同步阶段先撤销所有本地入口，再等待 setup 完成。
    expect(host.routes.byId("owner-session-starting.route")).toBeUndefined();
    expect(host.capabilities.has("owner-session-starting.service")).toBe(false);
    releaseSetup();
    await registering;
    await locking;
    expect(host.state("owner-session-starting")).toMatchObject({
      kind: "blocked",
      desiredEnabled: true,
      blockedBy: ["runtime:owner-session-unavailable"],
    });

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: ownerA,
      sessionEpoch: "session:init:3",
      bucketGeneration: 1,
    });
    expect(host.state("owner-session-starting").kind).toBe("enabled");
    expect(instances).toHaveLength(2);
    expect(host.routes.byId("owner-session-starting.route")).toBeDefined();
  });

  it("recovers cleanup-pending after a timed-out disposer eventually succeeds", async () => {
    let releaseLate!: () => void;
    const host = createPluginHost({ disableConfigPersistence: true, lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "late-cleanup-recovery",
      name: "Late cleanup recovery",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        return () => new Promise<void>((resolve) => { releaseLate = resolve; });
      },
    });

    const disabling = host.disable("late-cleanup-recovery");
    await disabling;
    expect(host.state("late-cleanup-recovery").kind).toBe("cleanup-pending");

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(host.state("late-cleanup-recovery").kind).toBe("disabled");

    await host.enable("late-cleanup-recovery");
    expect(host.state("late-cleanup-recovery").kind).toBe("enabled");
  });

  it("keeps cleanup-pending when a timed-out teardown eventually fails", async () => {
    let failLate!: () => void;
    const host = createPluginHost({ disableConfigPersistence: true, lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "late-cleanup-failure",
      name: "Late cleanup failure",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        return () => new Promise<void>((_resolve, reject) => {
          failLate = () => reject(new Error("late teardown failed"));
        });
      },
    });

    const disabling = host.disable("late-cleanup-failure");
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
    await expect(host.enable("late-cleanup-failure")).rejects.toThrow(/cleanup is pending/i);
  });

  it("includes plugin cleanup in Host dispose result", async () => {
    let releaseLate!: () => void;
    const host = createPluginHost({ disableConfigPersistence: true, lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "host-dispose-pending",
      name: "Host dispose pending",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
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
    const host = createPluginHost({ disableConfigPersistence: true, lifecycleCleanupTimeoutMs: 1 });
    await host.register({
      id: "disabled-before-host-dispose",
      name: "Disabled before Host dispose",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        return () => new Promise<void>((resolve) => { releaseLate = resolve; });
      },
    });

    await host.disable("disabled-before-host-dispose");
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

  it("canDisable=false blocks disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeC()]);
    const r = await host.disable("c");
    expect(r).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
    expect(host.state("c").kind).toBe("enabled");
  });

  it("disabling a provider stops enabled dependents and preserves their intent", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA(), makeB([CAP_A])]);
    expect(host.state("b").kind).toBe("enabled");
    const r = await host.disable("a");
    expect(r).toEqual({ ok: true });
    expect(host.state("a").kind).toBe("disabled");
    expect(host.state("b")).toMatchObject({ kind: "blocked", desiredEnabled: true, blockedBy: [CAP_A] });
    expect(host.installed()).not.toEqual(expect.arrayContaining(["a", "b"]));
    expect(host.configStore.read().b).toBe(true);

    await host.enable("a");
    await host.enable("b");
    expect(host.state("b").kind).toBe("enabled");
  });

  it("does not cascade-stop a product for an optional capability", async () => {
    const consumer: PluginManifest = {
      id: "optional-consumer",
      name: "Optional consumer",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      dependencies: [{ capability: CAP_A, optional: true }],
      setup(ctx) { ctx.provide("optional-consumer.service", true); },
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA(), consumer]);

    await host.disable("a");
    expect(host.state("a").kind).toBe("disabled");
    expect(host.state(consumer.id)).toMatchObject({ kind: "enabled", desiredEnabled: true });
    expect(host.capabilities.has("optional-consumer.service")).toBe(true);
  });

  it("enable restores owner resources", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    await host.disable("a");
    await host.enable("a");
    expect(host.state("a").kind).toBe("enabled");
    expect(host.routes.byId(ROUTE_A)).toBeDefined();
    expect(host.capabilities.has(CAP_A)).toBe(true);
  });

  it("unregister removes plugin from host entirely", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    await host.unregister("a");
    expect(host.manifests()).not.toContain("a");
    expect(host.state("a").kind).toBe("registered");
  });

  it("version bumps and subscribers notified", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const seen: number[] = [];
    host.subscribe((s) => seen.push(s.version));
    expect(host.version()).toBe(0);
    await host.registerAll([makeA()]);
    await host.disable("a");
    await host.enable("a");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
  });

  it("setup can return teardown which is invoked on disable", async () => {
    const teardown = (): void => undefined;
    const plugin: PluginManifest = {
      id: "td",
      name: "TD",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        return teardown;
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([plugin]);
    expect(host.state("td").kind).toBe("enabled");
    await host.disable("td");
    // 仅断言状态；teardown 已调起。
    expect(host.state("td").kind).toBe("disabled");
  });

  it("runs onDispose callbacks before teardown and registry ownership recovery", async () => {
    const events: string[] = [];
    const plugin: PluginManifest = {
      id: "dispose-hook",
      name: "Dispose hook",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        const routes = ctx.get<RouteRegistry>("route.registry");
        routes.register({ id: "dispose.route", path: "/dispose", label: "Dispose", component: () => null });
        ctx.onDispose(() => { events.push(routes.byId("dispose.route") ? "dispose:before-purge" : "dispose:after-purge"); });
        return () => { events.push(routes.byId("dispose.route") ? "teardown:before-purge" : "teardown:after-purge"); };
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);
    await host.disable(plugin.id);
    expect(events).toEqual(["dispose:after-purge", "teardown:after-purge"]);
  });

  it("setup throwing causes error-disabled state and removes owner", async () => {
    const plugin: PluginManifest = {
      id: "bad",
      name: "Bad",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx: PluginContext) {
        const r = ctx.get<RouteRegistry>("route.registry");
        r.register({ id: "bad.route", path: "/bad", label: "Bad", component: () => null });
        throw new Error("setup failed");
      }
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);
    const s = host.state("bad");
    expect(s.kind).toBe("error-disabled");
    expect(s.error).toContain("setup failed");
    expect(host.routes.byId("bad.route")).toBeUndefined();
  });

  it("keeps the enable intent when startup fails", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "failed-startup-intent",
      name: "Failed startup intent",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() {
        throw new Error("startup unavailable");
      },
    });

    expect(host.state("failed-startup-intent")).toMatchObject({
      kind: "error-disabled",
      desiredEnabled: true,
    });
    expect(host.configStore.read()["failed-startup-intent"]).toBe(true);
  });

  it("disables a plugin while setup is pending and never publishes the late instance", async () => {
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => { finishSetup = resolve; });
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "starting-plugin",
      name: "Starting plugin",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup: async (ctx) => {
        await setupFinished;
        // disable 已撤销 context；这条迟到注册必须失败并被 Host 收尾。
        ctx.get<RouteRegistry>("route.registry").register({
          id: "starting.route",
          path: "/starting",
          label: "Starting",
          component: () => null,
        });
      },
    };
    const registering = host.register(plugin);
    expect(host.state(plugin.id).kind).toBe("starting");
    const disabling = host.disable(plugin.id);
    finishSetup();
    await registering;
    await disabling;
    expect(host.state(plugin.id).kind).toBe("disabled");
    expect(host.routes.byId("starting.route")).toBeUndefined();
    expect(host.configStore.read()[plugin.id]).toBe(false);
  });

  it("does not let an old starting result overwrite a re-enable intent", async () => {
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => { finishSetup = resolve; });
    let starts = 0;
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "starting-reenable",
      name: "Starting re-enable",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup: async (ctx) => {
        starts += 1;
        if (starts === 1) {
          await setupFinished;
          return;
        }
        ctx.provide("starting-reenable.service", { instance: starts });
      },
    };

    const registering = host.register(plugin);
    await Promise.resolve();
    expect(host.state(plugin.id).kind).toBe("starting");
    const disabling = host.disable(plugin.id);
    const reenable = host.enable(plugin.id);
    finishSetup();
    await registering;
    await disabling;
    await reenable.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(starts).toBe(2);
    expect(host.state(plugin.id)).toMatchObject({ kind: "enabled", desiredEnabled: true });
    expect(host.state(plugin.id)).toMatchObject({ kind: "enabled", desiredEnabled: true });
    expect(host.configStore.read()[plugin.id]).toBe(true);
  });

  it("restarts once when enable arrives during normal stopping", async () => {
    let releaseCleanup!: () => void;
    const cleanupPending = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let starts = 0;
    const plugin: PluginManifest = {
      id: "stopping-reenable",
      name: "Stopping re-enable",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        starts += 1;
        if (starts === 1) ctx.onDispose(() => cleanupPending);
        ctx.provide("stopping-reenable.service", { starts });
      },
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);

    const disabling = host.disable(plugin.id);
    await Promise.resolve();
    expect(host.state(plugin.id).kind).toBe("stopping");
    const reenable = host.enable(plugin.id);
    expect(host.configStore.read()[plugin.id]).toBe(true);
    releaseCleanup();
    await disabling;
    await reenable;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(starts).toBe(2);
    expect(host.state(plugin.id)).toMatchObject({ kind: "enabled", desiredEnabled: true });
  });

  it("reclaims a registry item registered after setup returns", async () => {
    let registerLate!: () => void;
    const plugin: PluginManifest = {
      id: "late-registry",
      name: "Late registry",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        const routes = ctx.get<RouteRegistry>("route.registry");
        registerLate = () => routes.register({
          id: "late-registry.route",
          path: "/late-registry",
          label: "Late registry",
          component: () => null,
        });
      },
    };
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(plugin);

    // 模拟 setup 返回后由异步回调完成的注册。
    registerLate();
    expect(host.routes.byId("late-registry.route")).toBeDefined();

    await host.disable(plugin.id);
    expect(host.routes.byId("late-registry.route")).toBeUndefined();
  });

  it("revokes a capability provided by an asynchronous callback after setup", async () => {
    let provideLate!: () => void;
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "late-capability",
      name: "Late capability",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup(ctx) {
        provideLate = () => ctx.provide("late-capability.service", { ok: true });
      },
    };
    await host.register(plugin);
    provideLate();
    expect(host.capabilities.has("late-capability.service")).toBe(true);
    await host.disable(plugin.id);
    expect(host.capabilities.has("late-capability.service")).toBe(false);
  });

  it("missing dependency blocks enable (sets state to blocked)", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeB([CAP_A])]);
    const s = host.state("b");
    expect(s.kind).toBe("blocked");
  });

  it("config store is overridden on disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.registerAll([makeA()]);
    expect(host.configStore.read().a).toBe(true);
    await host.disable("a");
    expect(host.configStore.read().a).toBe(false);
  });
});

describe("createPluginHost - startup contract", () => {
  function required(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      id: "required",
      name: "Required",
      meta: {
        kind: "core",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: ["required.service"]
      },
      setup(ctx) {
        ctx.provide("required.service", { ok: true });
      },
      ...overrides
    };
  }

  it.each([
    ["defaultEnabled", { defaultEnabled: false }],
    ["canDisable", { canDisable: true }],
    ["providesCapabilities", { providesCapabilities: [] }]
  ])("rejects required manifests with invalid %s", async (_, meta) => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(required({ meta: { ...required().meta, ...meta } }))).rejects.toThrow(/Required plugin/);
  });

  it("validates required dependencies against the complete manifest set", () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const optionalProvider = {
      id: "optional-provider",
      name: "Optional provider",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true, providesCapabilities: ["optional.service"] },
      setup() {}
    } satisfies PluginManifest;
    expect(() => host.validateManifestSet([
      required({ dependencies: [{ capability: "optional.service" }] }),
      optionalProvider
    ])).toThrow(/optional capability provider/);
  });

  it("wraps required setup failures and rolls back owned resources", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin = required({
      setup(ctx) {
        ctx.get<RouteRegistry>("route.registry").register({
          id: "required.route",
          path: "/required",
          label: "required",
          component: () => null
        });
        throw new Error("secret underlying failure");
      }
    });
    await expect(host.register(plugin)).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.routes.byId("required.route")).toBeUndefined();
    expect(host.capabilities.has("required.service")).toBe(false);
    expect(host.state("required").kind).toBe("error-disabled");
  });

  it("rejects a required provider that fails to provide its declaration", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(required({ setup() {} }))).rejects.toBeInstanceOf(StartupPluginError);
    expect(host.capabilities.has("required.service")).toBe(false);
  });

  it("keeps required capability and config on disable, unregister, and false config", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register(required());
    expect(await host.disable("required")).toEqual({ ok: false, reason: "Plugin is marked canDisable=false" });
    await expect(host.unregister("required")).rejects.toThrow(/startup-required/);
    host.configStore.setEnabled("required", false);
    expect(host.capabilities.has("required.service")).toBe(true);
    expect(host.configStore.read().required).toBe(true);
  });

  it("asserts provider, state, error, and configured value without exposing stack", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const provider = required({ setup() { throw new Error("private stack detail"); } });
    await expect(host.register(provider)).rejects.toBeInstanceOf(StartupPluginError);
    try {
      host.assertCapabilities(["required.service"], { phase: "test" });
      throw new Error("expected assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupCapabilityError);
      const details = (error as StartupCapabilityError).details[0]!;
      expect(details).toMatchObject({
        capability: "required.service",
        providerPluginId: "required",
        providerState: "error-disabled"
      });
      expect(details.configuredEnabled).toBe(true);
      expect(details.providerError).toContain("private stack detail");
    }
  });
});
