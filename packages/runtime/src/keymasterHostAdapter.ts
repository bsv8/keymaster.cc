import { INSTANCE_REGISTRY_BINDING } from "./instanceRegistry.js";
import { isIssuedKeymasterConsumer, rememberIssuedConsumer } from "./consumerAuthority.js";
// Keymaster Host Adapter。
//
// WebLoom 负责通用的产品、运行单元、依赖、Scope、权限租约和清理状态机；
// 本适配器只负责把 Keymaster 的 Registry、i18n、Storage、Coordinator
// 和旧插件 Context 接回 WebLoom。领域字段不会进入 WebLoom。

import type {
  ChannelRuntimeFactory,
  PluginContext as KeymasterPluginContext,
  PluginManifest,
  PluginPermission,
  PluginSetup,
  PluginStorageDeclaration,
  ResourceDefinition as KeymasterResourceDefinition,
  ResourceRegistry as KeymasterResourceRegistry,
  RuntimeIdentityTransition,
  RuntimeUnitDescriptor,
  RuntimeVaultStatus,
} from "@keymaster/contracts";
import {
  CHANNEL_RUNTIME_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  OWNED_RESOURCE_ACCESS_CAPABILITY,
  RUNTIME_DIAGNOSTICS_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  validatePluginStorageDeclaration,
  assertSystemStorageDeclaration,
} from "@keymaster/contracts";
import type {
  CreatePluginHostOptions as LegacyCreatePluginHostOptions,
  PluginHost as LegacyPluginHost,
} from "./pluginHostContract.js";
import { bindWebLoomHost } from "./pluginHostContract.js";
import { createI18nService } from "./i18n/createI18nService.js";
import { createScopedChannelRuntime } from "./lifecycle/scopedChannelRuntime.js";
import {
  createMessageBus,
  capabilityKey,
} from "webloom-framework";
import { createPluginHost as createWebLoomPluginHost, createResourceRegistry, createRuntimeUnitImplementationRegistry, registerOwnedResource, bridgeForRuntimeHandle, type ContributionAdapter, type PluginHost as WebLoomPluginHost, type RuntimeUnitParentScopeInput, type HostCapabilityRegistration } from "webloom-framework/advanced";
import {
  type LifecycleScope,
  type MessageBus as KeymasterMessageBus,
  type PluginContext as WebLoomPluginContext,
  type PluginManifest as WebLoomPluginManifest,
  type ResourceDefinition as WebLoomResourceDefinition,
  type ResourceRegistry as WebLoomResourceRegistry,
  type RuntimeUnitImplementationRegistry as WebLoomRuntimeUnitImplementationRegistry,
  type RuntimeKind,
  type RuntimeHandle,
} from "webloom-framework";
import type { CapabilityDescriptor } from "webloom-framework";
import type { Capability, CapabilityClient, LocalCapability, LocalServiceOf } from "webloom-framework";

const keymasterRemoteRuntimeAttachers = new WeakMap<LegacyPluginHost, (runtime: RuntimeHandle, slotId: string) => () => void>();

/** 在 WindowApp 接管既有 Host 后绑定 SharedWorker Runtime。 */
export function attachKeymasterRemoteRuntime(host: LegacyPluginHost, runtime: RuntimeHandle, slotId = "default"): () => void {
  const attach = keymasterRemoteRuntimeAttachers.get(host);
  if (!attach) throw new Error("Keymaster PluginHost is not ready for a remote Runtime");
  return attach(runtime, slotId);
}

/**
 * 为仍使用 Keymaster ResourceDefinition 的领域装配点绑定 owner。
 *
 * WebLoom 的 `registerOwnedResource` 只接受 WebLoom ResourceDefinition；资产
 * 工作区还需要 `active-key` 与领域 ResourceContext，因此这里由 Adapter 负责
 * 调用同一个 WebLoom-backed registry 的 owner 入口，避免业务代码直接接触
 * 运行时内部字段。
 */
export function registerKeymasterOwnedResource<T, TArgs extends readonly string[]>(
  registry: KeymasterResourceRegistry,
  ownerId: string,
  definition: KeymasterResourceDefinition<T, TArgs>,
): void {
  const registerForOwner = (registry as KeymasterResourceRegistry & {
    _registerForOwner?: <TValue, TDefinitionArgs extends readonly string[]>(
      owner: string,
      item: KeymasterResourceDefinition<TValue, TDefinitionArgs>,
    ) => void;
  })._registerForOwner;
  if (!registerForOwner) {
    throw new Error("Keymaster resource registry does not support owner-bound registration");
  }
  registerForOwner(ownerId, definition);
}

/** 适配器暴露的 Keymaster 领域 Scope 属性。 */
export interface KeymasterRuntimeScopeAttributes extends Readonly<Record<string, unknown>> {
  /** Vault 当前生命周期状态。 */
  readonly vaultStatus?: RuntimeVaultStatus;
  /** 当前 owner 公钥；仅作为绑定元数据。 */
  readonly ownerPublicKeyHex?: string;
  /** owner/session 运行世代。 */
  readonly sessionEpoch?: string;
  /** 钱包身份世代；重置或初始化后变化。 */
  readonly walletGeneration?: string;
  /** 当前授权策略修订。 */
  readonly authorizationRevision?: number;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function currentUnit(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
): RuntimeUnitDescriptor | undefined {
  const units = manifest.units ?? [];
  if (units.length === 0) return undefined;
  const matches = runtime === undefined
    ? units
    : units.filter((unit) => unit.runtime === runtime);
  return matches.length === 1 ? matches[0] : undefined;
}

function dependenciesOfManifest(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
): NonNullable<RuntimeUnitDescriptor["dependencies"]> {
  const unit = currentUnit(manifest, runtime);
  if (unit) return [...(unit.dependencies ?? [])];
  return [];
}

function providesOfManifest(manifest: PluginManifest, runtime: RuntimeKind | undefined): CapabilityDescriptor[] {
  const unit = currentUnit(manifest, runtime);
  if (unit) return [...(unit.provides ?? [])];
  return [];
}

function attributesFromRuntimeIdentity(
  identity: RuntimeIdentityTransition | undefined,
): KeymasterRuntimeScopeAttributes {
  if (!identity) return Object.freeze({});
  return Object.freeze({
    vaultStatus: identity.vaultStatus,
    ...(identity.ownerPublicKeyHex ? { ownerPublicKeyHex: identity.ownerPublicKeyHex } : {}),
    sessionEpoch: identity.sessionEpoch,
    ...(identity.runGeneration ? { runGeneration: identity.runGeneration } : {}),
    ...(identity.walletGeneration !== undefined ? { walletGeneration: identity.walletGeneration } : {}),
  });
}

/** 把 Keymaster ResourceDefinition 适配为 WebLoom ResourceDefinition。 */
function adaptResourceDefinition<T>(
  definition: KeymasterResourceDefinition<T, readonly string[]>,
  getActivePublicKeyHex: () => string | undefined,
): WebLoomResourceDefinition<T, readonly string[]> {
  const context = (input: import("webloom-framework").ResourceContext) => ({
    capability: input.capability,
    optionalCapability: input.optionalCapability,
    activePublicKeyHex: getActivePublicKeyHex(),
    ownerId: input.ownerId,
  });
  return {
    id: definition.id,
    scope: definition.scope === "active-key" ? "context" : definition.scope,
    key: (args, input) => definition.key(args, context(input)),
    load: (args, input, signal) => definition.load(args, context(input), signal),
    ...(definition.subscribe ? {
      subscribe: (args: readonly string[], input: import("webloom-framework").ResourceContext, invalidate: () => void) =>
        definition.subscribe!(args, context(input), invalidate),
    } : {}),
    ...(definition.equals ? { equals: (left: T | undefined, right: T | undefined) =>
      left === undefined || right === undefined ? Object.is(left, right) : definition.equals!(left, right) } : {}),
    invalidation: definition.invalidation,
  };
}

/** 为旧插件提供带 owner 转换的 Resource Registry 视图。 */
function createLegacyResourceRegistry(
  target: WebLoomResourceRegistry,
  getActivePublicKeyHex: () => string | undefined,
  definitions: Map<string, KeymasterResourceDefinition<unknown, readonly string[]>>,
): KeymasterResourceRegistry {
  const ownedIds = new Map<string, Set<string>>();
  const registerForOwner = <T, TArgs extends readonly string[]>(
    ownerId: string,
    definition: KeymasterResourceDefinition<T, TArgs>,
  ): void => {
    const normalized = definition as KeymasterResourceDefinition<T, readonly string[]>;
    const adapted = adaptResourceDefinition(normalized, getActivePublicKeyHex);
    if (ownerId) registerOwnedResource(target, ownerId, adapted);
    else target.register(adapted);
    definitions.set(definition.id, definition as KeymasterResourceDefinition<unknown, readonly string[]>);
    if (ownerId) {
      const ids = ownedIds.get(ownerId) ?? new Set<string>();
      ids.add(definition.id);
      ownedIds.set(ownerId, ids);
    }
  };
  const unregister = (id: string): void => {
    target.unregister(id);
    definitions.delete(id);
    for (const [ownerId, ids] of ownedIds) {
      ids.delete(id);
      if (ids.size === 0) ownedIds.delete(ownerId);
    }
  };
  const revokeOwner = (ownerId: string): void => {
    const ids = ownedIds.get(ownerId);
    if (!ids) return;
    for (const id of [...ids]) unregister(id);
    ownedIds.delete(ownerId);
  };
  return {
    register<T, TArgs extends readonly string[]>(definition: KeymasterResourceDefinition<T, TArgs>): void {
      registerForOwner("", definition);
    },
    unregister,
    get<T, TArgs extends readonly string[]>(id: string) {
      return definitions.get(id) as KeymasterResourceDefinition<T, TArgs> | undefined;
    },
    _ids: () => target._ids(),
    _registerForOwner: registerForOwner,
    _revokeOwner: revokeOwner,
    _owns: (ownerId: string, id: string) => ownedIds.get(ownerId)?.has(id) === true,
  } as KeymasterResourceRegistry & {
    _registerForOwner: typeof registerForOwner;
    _revokeOwner: typeof revokeOwner;
    _owns(ownerId: string, id: string): boolean;
  };
}

/** 创建领域 Registry，并将它们作为 WebLoom 的内建 capability 注入。 */
/** Keymaster Host Adapter 的完整装配入口。 */
export function createKeymasterPluginHost(
  options: LegacyCreatePluginHostOptions = {},
): LegacyPluginHost {
  // 未指定时保留“无执行宿主”语义：单一运行单元可按自身 Runtime 选择，
  // 多运行单元必须在校验边界显式指定，不能静默偏向 Window。
  const hostRuntime = options.runtime;
  const messageBus = createMessageBus();
  const webResourceRegistry = createResourceRegistry();
  const resourceDefinitions = new Map<string, KeymasterResourceDefinition<unknown, readonly string[]>>();
  const legacyResourceRegistry = createLegacyResourceRegistry(
    webResourceRegistry,
    () => currentActivePublicKeyHex(),
    resourceDefinitions,
  );
  const i18n = createI18nService({
    initialResources: options.initialI18nResources,
    debug: options.i18nDebug,
  });

  const manifests = new Map<string, PluginManifest>();
  const remoteRuntimes = new Map(Object.entries(options.remoteRuntimes ?? {}));
  if (options.remoteRuntime) {
    if (remoteRuntimes.has("default")) throw new Error("Duplicate default Runtime slot");
    remoteRuntimes.set("default", options.remoteRuntime);
  }
  // A live RuntimeHandle is the sole authority for cross-runtime service and
  // unit state. Legacy callbacks remain only for callers that have not yet
  // connected a RuntimeHandle; they never compete with one.
  const readRemoteRuntimeSnapshots = (): import("webloom-framework/advanced").RuntimeUnitSnapshot[] => {
    if (remoteRuntimes.size > 0) {
      return [...remoteRuntimes.values()].flatMap(runtime => runtime.state().units).map((unit) => ({
        pluginId: unit.pluginId,
        unitId: unit.unitId,
        runtime: unit.runtime,
        ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}),
        state: unit.state,
      }));
    }
    return (options.runtimeUnitSnapshots?.() ?? []).map((snapshot) => ({
      pluginId: snapshot.productId,
      unitId: snapshot.unitId,
      runtime: snapshot.runtime,
      instanceId: snapshot.instanceId,
      state: snapshot.state === "ready" ? "enabled" as const : "failed" as const,
    }));
  };
  let coreHost: WebLoomPluginHost | undefined;
  let runtimeIdentity: RuntimeIdentityTransition | undefined = options.initialRuntimeIdentity
    ? { ...options.initialRuntimeIdentity }
    : undefined;
  const runtimeParentScopes = new Map<RuntimeUnitDescriptor["scopeKind"], {
    key: string;
    scope: LifecycleScope;
  }>();
  let transitionPromise: Promise<void> | undefined;

  function currentActivePublicKeyHex(): string | undefined {
    return runtimeIdentity?.ownerPublicKeyHex ?? undefined;
  }

  function runtimeUnitUnavailableReason(pluginId: string, unitId: string): string | undefined {
    const unit = manifests.get(pluginId)?.units?.find((candidate) => candidate.id === unitId);
    if (!unit) return undefined;
    if ((unit.scopeKind === "owner-session" || unit.scopeKind === "connect-session")
      && (runtimeIdentity?.vaultStatus !== "unlocked" || !runtimeIdentity.ownerPublicKeyHex)) {
      return `runtime:${unit.scopeKind}-unavailable`;
    }
    // 原生显式 retry 可能与已有 reconcile 并发；提供方处于 starting
    // 不等于已发布同 realm 的 local 服务。只以实际注册为启动条件。
    const missingLocal = coreHost && unit.dependencies?.find(dependency =>
      !dependency.optional && dependency.source !== "peer"
      && dependency.capability.kind === "local" && dependency.sourceRuntime === unit.runtime
      && !coreHost!.capabilities.has(dependency.capability)
      && coreHost!.graph().providers[capabilityKey(dependency.capability)]?.some(id => coreHost!.state(id).kind === "starting"));
    if (missingLocal) return `missing:local:${missingLocal.capability.id}@${missingLocal.capability.version}`;
    return undefined;
  }

  function runtimeUnitParentScope(input: RuntimeUnitParentScopeInput): LifecycleScope | undefined {
    const unit = manifests.get(input.pluginId)?.units?.find((candidate) => candidate.id === input.unitId);
    const scopeKind = unit?.scopeKind ?? "root";
    if (scopeKind === "root") return undefined;
    const root = coreHost?.rootScope;
    if (!root) return undefined;
    const attributes = attributesFromRuntimeIdentity(runtimeIdentity);
    const key = scopeKind === "storage"
      ? `storage:${attributes.walletGeneration ?? "unknown"}:${attributes.runGeneration ?? "unknown"}`
      : `${scopeKind}:${attributes.ownerPublicKeyHex ?? "none"}:${attributes.sessionEpoch ?? "none"}:${attributes.runGeneration ?? "unknown"}`;
    const existing = runtimeParentScopes.get(scopeKind);
    if (existing?.scope.state === "active" && existing.key === key) return existing.scope;
    if (existing?.scope.state === "active") {
      existing.scope.revoke("runtime identity changed");
      void existing.scope.dispose({
        reason: "runtime identity changed",
        timeoutMs: options.lifecycleCleanupTimeoutMs,
      }).catch(() => undefined);
    }
    const scope = root.child(scopeKind, { attributes });
    runtimeParentScopes.set(scopeKind, { key, scope });
    return scope;
  }

  function scopedRegistry<T extends object>(resolved: unknown, consumer: import("webloom-framework").PluginConsumer, scope: LifecycleScope): T | undefined {
    if (!resolved || typeof resolved !== "object") return undefined;
    const bind = (resolved as { [INSTANCE_REGISTRY_BINDING]?: (consumer: import("webloom-framework").PluginConsumer, scope: LifecycleScope) => T })[INSTANCE_REGISTRY_BINDING];
    return typeof bind === "function" ? bind(consumer, scope) : undefined;
  }

  function createLegacyContext(
    context: WebLoomPluginContext,
    manifest: PluginManifest,
  ): KeymasterPluginContext {
    rememberIssuedConsumer(context.consumer, context.scope);
    const scopedCache = new Map<string, { source: unknown; view: unknown }>();
    let scopedChannelFactory: ChannelRuntimeFactory | undefined;
    const ownedResourceIds = new Set<string>();
    const resourceRegistryInternal = legacyResourceRegistry as KeymasterResourceRegistry & {
      _registerForOwner?: <T, TArgs extends readonly string[]>(
        ownerId: string,
        definition: KeymasterResourceDefinition<T, TArgs>,
      ) => void;
      _revokeOwner?: (ownerId: string) => void;
    };
    const scopedResourceRegistry: KeymasterResourceRegistry = {
      register<T, TArgs extends readonly string[]>(definition: KeymasterResourceDefinition<T, TArgs>): void {
        context.scope.assertActive();
        resourceRegistryInternal._registerForOwner?.(context.instanceId, definition);
        ownedResourceIds.add(definition.id);
      },
      unregister(id: string): void {
        context.scope.assertActive();
        if (!ownedResourceIds.has(id)) {
          throw new Error(`Resource definition "${id}" is not owned by plugin instance "${context.instanceId}"`);
        }
        legacyResourceRegistry.unregister(id);
        ownedResourceIds.delete(id);
      },
      get<T, TArgs extends readonly string[]>(id: string) {
        context.scope.assertActive();
        return ownedResourceIds.has(id) ? legacyResourceRegistry.get<T, TArgs>(id) : undefined;
      },
      _ids: () => { context.scope.assertActive(); return [...ownedResourceIds]; },
    };
    // 旧 Resource Registry 的定义必须在同步 revoke 阶段消失，不能等待
    // teardown 或 Resource Store 的异步清理。
    context.scope.onRevoke(() => {
      resourceRegistryInternal._revokeOwner?.(context.instanceId);
      ownedResourceIds.clear();
    });
    const extension = {};
    const capability = <C extends Capability>(
      requested: C,
    ): CapabilityClient<C> => {
      context.scope.assertActive();
      const resolved = context.capability(requested);
      const key = requested.id;
      if (key === RUNTIME_MESSAGE_BUS.id) return context.messageBus as CapabilityClient<C>;
      if (key === RESOURCE_REGISTRY_CAPABILITY.id) return scopedResourceRegistry as CapabilityClient<C>;
      if (key === CHANNEL_RUNTIME_CAPABILITY.id) {
        if (!scopedChannelFactory) {
          const factory = context.capability(CHANNEL_RUNTIME_CAPABILITY);
          const scopedRuntime = createScopedChannelRuntime(factory.forPlugin(manifest.id), context.scope);
          scopedChannelFactory = {
            forPlugin: (_claimedPluginId: string) => scopedRuntime,
            forSystem: (_claimedSystemId: string) => {
              throw new Error("Plugin context cannot create a system Channel caller");
            },
          };
        }
        return scopedChannelFactory as CapabilityClient<C>;
      }
      const cached = scopedCache.get(key);
      if (cached?.source === resolved) return cached.view as CapabilityClient<C>;
      const facade = scopedRegistry<object>(resolved, context.consumer, context.scope);
      if (facade) {
        scopedCache.set(key, { source: resolved, view: facade });
        return facade as CapabilityClient<C>;
      }
      return resolved as CapabilityClient<C>;
    };
    const optionalCapability = <C extends Capability>(
      requested: C,
    ): CapabilityClient<C> | undefined => {
      const resolved = context.optionalCapability(requested);
      return resolved === undefined ? undefined : capability(requested);
    };
    const legacyContext: KeymasterPluginContext = {
      ...context,
      permissionLease: (() => {
        const legacyIdentity = options.lifecycleIdentityForPlugin?.(manifest.id, context.unitId) ?? {};
        const binding = Object.freeze({
          ...context.permissionLease.binding,
          ...legacyIdentity,
          attributes: Object.freeze({
            ...context.permissionLease.binding.attributes,
            ...legacyIdentity,
          }),
        });
        return {
          ...context.permissionLease,
          binding,
          // 展开对象会把原租约的 getter 固化成布尔值；这里保留动态撤权状态。
          get revoked() { return context.permissionLease.revoked; },
        };
      })(),
      extension,
      capability,
      optionalCapability,
      provide<C extends LocalCapability<unknown>>(requested: C, value: LocalServiceOf<C>): void {
        context.provide(requested, value);

      },
      messageBus: context.messageBus,
    };
    return legacyContext;
  }

  function wrapSetup(manifest: PluginManifest, setup: PluginSetup): import("webloom-framework").PluginSetup {
    return async (context: WebLoomPluginContext) => {
      if (manifest.i18n) {
        i18n.registerResources(context.instanceId, manifest.i18n);
        context.onDispose(() => i18n.unregisterResources(context.instanceId));
      }
      const result = await setup(createLegacyContext(context, manifest));
      return typeof result === "function" ? async () => { await result(); } : async () => undefined;
    };
  }

  // WindowApp 的 registerPlugins() 会在 Host 创建后追加当前 realm 的原生
  // WebLoom 实现，因此这里不能只暴露旧 Keymaster registry 的只读 get()。
  // 动态实现保存在独立覆盖层：它们使用原生 WebLoom PluginContext；只有
  // Keymaster 静态 catalog 的旧 setup 才需要 wrapSetup() 领域适配。
  const dynamicImplementationRegistry = createRuntimeUnitImplementationRegistry();
  const implementationRegistry = {
    get(pluginId, unitId) {
      const dynamicSetup = dynamicImplementationRegistry.get(pluginId, unitId);
      if (dynamicSetup) return dynamicSetup;
      const manifest = manifests.get(pluginId);
      if (!manifest) return undefined;
      const setup = options.runtimeUnitImplementationRegistry?.get(pluginId, unitId) as PluginSetup | undefined;
      return setup ? wrapSetup(manifest, setup) : undefined;
    },
    getCapabilities(pluginId, unitId) {
      const dynamicCapabilities = dynamicImplementationRegistry.getCapabilities?.(pluginId, unitId);
      if (dynamicCapabilities !== undefined) return dynamicCapabilities;
      const suppliedRegistry = options.runtimeUnitImplementationRegistry as WebLoomRuntimeUnitImplementationRegistry | undefined;
      return suppliedRegistry?.getCapabilities?.(pluginId, unitId);
    },
    register(implementation: Parameters<typeof dynamicImplementationRegistry.register>[0]) {
      dynamicImplementationRegistry.register(implementation);
    },
    unregister(pluginId: string, unitId: string) {
      dynamicImplementationRegistry.unregister(pluginId, unitId);
    },
  } satisfies WebLoomRuntimeUnitImplementationRegistry & {
    register: typeof dynamicImplementationRegistry.register;
    unregister: typeof dynamicImplementationRegistry.unregister;
  };

  const legacyBuiltinCapabilities: HostCapabilityRegistration[] = [
    { capability: RESOURCE_REGISTRY_CAPABILITY, value: legacyResourceRegistry },
    { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, value: {
      bind(consumer: import("webloom-framework").PluginConsumer, scope: LifecycleScope) {
        if (!isIssuedKeymasterConsumer(consumer, scope)) throw new Error("Resource access requires an issued consumer and its Scope");
        scope.assertActive();
        if (consumer.status !== "active") throw new Error("Resource consumer has been revoked");
        consumer.capability(OWNED_RESOURCE_ACCESS_CAPABILITY);
        const owns = (id: string) => (legacyResourceRegistry as KeymasterResourceRegistry & { _owns(owner: string, id: string): boolean })._owns(consumer.instanceId, id);
        const assert = (id: string) => {
          scope.assertActive();
          if (consumer.status !== "active" || !owns(id)) {
            throw new Error(`Resource "${id}" is not owned by the live consuming instance`);
          }
        };
        return Object.freeze({
          isActive: () => scope.state === "active" && consumer.status === "active",
          ensure<T>(id: string, args: readonly string[]) { assert(id); return coreHost!.resourceStore.ensure<T>(id, args); },
          read<T>(id: string, args: readonly string[]) { assert(id); return coreHost!.resourceStore.read<T>(id, args); },
          invalidate(id: string, args: readonly string[]) { assert(id); coreHost!.resourceStore.invalidate(id, args); },
          subscribe(id: string, args: readonly string[], listener: () => void) {
            assert(id);
            const changed = () => {
              if (consumer.status === "active" && owns(id)) listener();
            };
            let offRecord = coreHost!.resourceStore.subscribe(id, args, changed);
            // 框架刷新运行时绑定或身份会清除资源记录。受限视图必须重新
            // 订阅新记录，否则可选提供方退出后仍挂载的 UI 会永久保留旧数据。
            const offContext = legacyResourceRegistry.get(id)?.scope === "global" ? coreHost!.resourceStore.subscribeContext(() => {
              offRecord();
              if (consumer.status !== "active" || !owns(id)) return;
              offRecord = coreHost!.resourceStore.subscribe(id, args, changed);
              changed();
            }) : () => {};
            const off = () => { offContext(); offRecord(); };
            const removeRevokeListener = scope.onRevoke(off);
            return () => { removeRevokeListener(); off(); };
          },
        });
      },
    } satisfies import("@keymaster/contracts").OwnedResourceAccess },
    { capability: RUNTIME_DIAGNOSTICS_CAPABILITY, value: {
      bind(consumer: import("webloom-framework").PluginConsumer, scope: LifecycleScope) {
        if (!isIssuedKeymasterConsumer(consumer, scope)) throw new Error("Diagnostics requires an issued consumer and its Scope");
        const assert = () => { scope.assertActive(); if (consumer.status !== "active") throw new Error("Diagnostics consumer has been revoked"); };
        assert();
        consumer.capability(RUNTIME_DIAGNOSTICS_CAPABILITY);
        return Object.freeze({
          revision() { assert(); return coreHost!.version(); },
          snapshot() {
            assert();
            return { graph: legacyGraph(), plugins: [...manifests.values()].map(manifest => {
              const state = legacyState(manifest.id);
              return { id: manifest.id, name: manifest.name, description: manifest.description, kind: state.kind,
                error: state.error, blockedBy: state.blockedBy,
                units: state.units?.map(unit => ({ unitId: unit.unitId, kind: unit.kind, error: unit.error })),
              };
            }) };
          },
          subscribe(listener: () => void) {
            assert();
            const off = coreHost!.subscribe(() => { if (consumer.status === "active") listener(); });
            const removeRevokeListener = scope.onRevoke(off);
            return () => { removeRevokeListener(); off(); };
          },
          async retry(pluginId: string) {
            assert();
            if (!manifests.has(pluginId)) throw new Error(`Unknown diagnostics plugin "${pluginId}"`);
            await legacyHost.retry(pluginId);
            assert();
          },
        });
      },
    } satisfies import("@keymaster/contracts").RuntimeDiagnosticsAccess },
    { capability: RUNTIME_MESSAGE_BUS, value: messageBus },
    { capability: I18N_SERVICE_CAPABILITY, value: i18n },
  ];


  coreHost = createWebLoomPluginHost({
    runtime: hostRuntime,
    privateCapabilities: options.privateCapabilities,
    runtimeSlotBindings: options.runtimeSlotBindings,
    rootAttributes: attributesFromRuntimeIdentity(runtimeIdentity),
    runtimeUnitAvailability: ({ pluginId, unitId }) => runtimeUnitUnavailableReason(pluginId, unitId),
    runtimeUnitAttributes: ({ pluginId, unitId }) => ({
      ...attributesFromRuntimeIdentity(runtimeIdentity),
      ...(options.lifecycleIdentityForPlugin?.(pluginId, unitId) ?? {}),
    }),
    runtimeUnitParentScope,
    capabilities: [...legacyBuiltinCapabilities, ...(options.capabilities ?? [])],
    resourceRegistry: webResourceRegistry,
    resourceCapabilityResolver: <C extends Capability>(requested: C): CapabilityClient<C> | undefined => {
      return coreHost?.optionalCapability(requested);
    },
    messageBus,
    contextExtension: () => ({}),
    manifestValidator: (manifest) => {
      const source = manifests.get(manifest.id);
      if (source) validateKeymasterManifest(source, options.runtime, manifests.values());
    },
    permissionPolicy: ({ pluginId, unitId, requested, identity }) => {
      const requestedPermissions = requested as readonly PluginPermission[];
      const approved = options.approvedPermissionsForPlugin?.(pluginId, requestedPermissions) ?? [];
      return {
        approved,
        sessionConstraints: options.sessionPermissionsForPlugin?.(pluginId, requestedPermissions),
        binding: {
          ...(options.permissionBindingForPlugin?.(pluginId, unitId, requestedPermissions) ?? {}),
          ...(identity.attributes.authorizationRevision !== undefined
            ? { policyRevision: identity.attributes.authorizationRevision as number }
            : {}),
        },
      };
    },

    runtimeUnitImplementationRegistry: implementationRegistry,
    lifecycleCleanupTimeoutMs: options.lifecycleCleanupTimeoutMs,
  });

  const remoteRuntimeSubscriptions = new Map<string, () => void>();
  const attachRemoteRuntime = (nextRuntime: RuntimeHandle, slotId: string): (() => void) => {
    if (!slotId.trim()) throw new Error("Runtime slot id must be non-empty");
    const replaced = remoteRuntimeSubscriptions.has(slotId);
    // 连接变化是具体消费实例的运行条件变化。桥围栏旧 RPC 后，由框架
    // revoke/retry 重建绑定该槽位的实例；其他槽位的消费实例继续存活。
    const affected = replaced ? [...manifests.values()].filter(manifest => {
      const unit = currentUnit(manifest, hostRuntime);
      if (!unit) return false;
      const prefix = `${manifest.id}\0${unit.id}`;
      return Object.entries(options.runtimeSlotBindings ?? {}).some(([key, value]) =>
        value === slotId && (key === prefix || key.startsWith(prefix + "\0")));
    }).map(manifest => manifest.id) : [];
    const revocations = affected.map(id => coreHost!.revoke(id, "Runtime slot connection replaced"));
    remoteRuntimeSubscriptions.get(slotId)?.();
    remoteRuntimeSubscriptions.delete(slotId);
    remoteRuntimes.set(slotId, nextRuntime);
    // 框架按槽位替换 bridge 并围栏旧连接；其它槽位保留自己的服务/实例。
    const binding = coreHost!.attachRemote(bridgeForRuntimeHandle(nextRuntime), slotId);
    const unsubscribe = nextRuntime.subscribe(() => {
      if (remoteRuntimes.get(slotId) !== nextRuntime) return;
      coreHost?.refreshRuntimeUnitSnapshots();
      void coreHost?.reconcile().catch(() => undefined);
    });
    remoteRuntimeSubscriptions.set(slotId, unsubscribe);
    void Promise.all(revocations).then(async () => {
      if (remoteRuntimeSubscriptions.get(slotId) !== unsubscribe) return;
      for (const id of affected) await coreHost!.retry(id);
    }).catch(() => undefined);
    coreHost?.refreshRuntimeUnitSnapshots();
    void coreHost?.reconcile().catch(() => undefined);
    return () => {
      if (remoteRuntimeSubscriptions.get(slotId) !== unsubscribe) return;
      unsubscribe();
      remoteRuntimeSubscriptions.delete(slotId);
      remoteRuntimes.delete(slotId);
      coreHost!.detachRemote("Runtime slot detached", binding);
    };
  };
  for (const [slotId, runtime] of remoteRuntimes) attachRemoteRuntime(runtime, slotId);

  function legacyState(pluginId: string): ReturnType<LegacyPluginHost["state"]> {
    const manifest = manifests.get(pluginId);
    if (!manifest) return { id: pluginId, kind: "registered" };
    const current = coreHost!.state(pluginId);
    const declaredUnits = manifest.units ?? [];
    if (declaredUnits.length === 0) return current as ReturnType<LegacyPluginHost["state"]>;
    const selected = currentUnit(manifest, hostRuntime);
    const snapshots = remoteRuntimes.size > 0
      ? [...remoteRuntimes.values()].flatMap(runtime => runtime.state().units).map((unit) => ({
          productId: unit.pluginId,
          unitId: unit.unitId,
          runtime: unit.runtime,
          instanceId: unit.instanceId,
          // 契约状态已二值化：未就绪一律表达为 failed，由 reasons 解释。
          state: unit.state === "enabled" ? "ready" as const : "failed" as const,
          error: unit.state === "failed" ? "远程运行单元失败" : undefined,
        }))
      : (options.runtimeUnitSnapshots?.() ?? []);
    const units = declaredUnits.map((declared) => {
      const isSelected = selected?.id === declared.id;
      const remote = isSelected || declared.runtime === hostRuntime
        ? undefined
        : snapshots.find((snapshot) => snapshot.productId === manifest.id && snapshot.unitId === declared.id);
      const remoteKind = remote
        ? remote.state === "ready" ? "enabled" : "failed"
        : "unknown";
      return {
        pluginId: manifest.id,
        unitId: declared.id,
        runtime: declared.runtime,
        ...(isSelected && current.instanceId
          ? { instanceId: current.instanceId }
          : remote?.instanceId ? { instanceId: remote.instanceId } : {}),
        kind: isSelected ? current.kind : remoteKind,
        error: isSelected
          ? current.error
          : remote?.error ?? (remote ? undefined : "远程运行单元快照不可用（状态未知）"),
        ...(isSelected && current.cleanup ? { cleanup: current.cleanup } : {}),
      };
    });
    return {
      ...current,
      unitId: current.unitId ?? selected?.id ?? manifest.id,
      units,
    } as ReturnType<LegacyPluginHost["state"]>;
  }

  function legacyGraph(): import("@keymaster/contracts").PluginGraph {
    const graph = coreHost!.graph();
    const ids = (values: readonly CapabilityDescriptor[]): string[] => values.map((value) => value.id);
    return {
      plugins: [...graph.plugins],
      dependencies: Object.fromEntries(
        Object.entries(graph.dependencies).map(([pluginId, values]) => [pluginId, ids(values)]),
      ),
      optionalDependencies: Object.fromEntries(
        Object.entries(graph.optionalDependencies).map(([pluginId, values]) => [pluginId, ids(values)]),
      ),
      provides: Object.fromEntries(
        Object.entries(graph.provides).map(([pluginId, values]) => [pluginId, ids(values)]),
      ),
      reverse: Object.fromEntries(
        Object.entries(graph.reverse).map(([pluginId, values]) => [
          pluginId,
          values.map((value) => ({ ...value, capabilities: ids(value.capabilities) })),
        ]),
      ),
      providers: Object.fromEntries(
        Object.entries(graph.providers).map(([capability, pluginIds]) => [capability, [...pluginIds]]),
      ),
      cycles: graph.cycles.map((cycle) => [...cycle]),
      units: Object.fromEntries(Object.entries(graph.units).map(([unitKey, unit]) => [unitKey, {
        ...unit,
        dependencies: ids(unit.dependencies),
        provides: ids(unit.provides),
      }])),
    };
  }

  function convertManifest(manifest: PluginManifest): WebLoomPluginManifest {
    const units = manifest.units?.map((unit) => ({
      id: unit.id,
      runtime: unit.runtime,
      dependencies: unit.dependencies,
      provides: unit.provides,
      privateProvides: unit.privateProvides,
      permissions: unit.permissions,
      config: unit.config,
      contribution: unit.business,
    }));
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      ...(units ? { units } : {}),
    };
  }

  function updateManifestMap(plugins: readonly PluginManifest[]): void {
    for (const plugin of plugins) manifests.set(plugin.id, plugin);
  }

  let legacyDisposePromise: ReturnType<LegacyPluginHost["dispose"]> | undefined;
  function projectLegacyCleanupResult(
    result: Awaited<ReturnType<LegacyPluginHost["dispose"]>>,
    scopeOwners: ReadonlyMap<string, string>,
  ): Awaited<ReturnType<LegacyPluginHost["dispose"]>> {
    const projectResourceId = (resourceId: string): string => {
      for (const [scopeId, pluginId] of scopeOwners) {
        const prefix = `child:${scopeId}:`;
        const index = resourceId.indexOf(prefix);
        if (index >= 0) {
          return `plugin:${pluginId}:${resourceId.slice(index + prefix.length)}`;
        }
      }
      return resourceId;
    };
    // The WebLoom result is deliberately live: late cleanup can settle after
    // Host.dispose() resolves.  Keep the legacy projection live as well;
    // spreading the arrays here would freeze a stale cleanup-pending snapshot
    // in callers that retain the returned result object.
    const projected = { ...result } as Awaited<ReturnType<LegacyPluginHost["dispose"]>>;
    Object.defineProperties(projected, {
      attempted: { enumerable: true, get: () => result.attempted },
      released: { enumerable: true, get: () => result.released },
      pending: { enumerable: true, get: () => result.pending.map(projectResourceId) },
      errors: {
        enumerable: true,
        get: () => result.errors.map((issue) => ({ ...issue, resourceId: projectResourceId(issue.resourceId) })),
      },
      cleanupIncomplete: { enumerable: true, get: () => result.cleanupIncomplete },
    });
    return projected;
  }

  const legacyHost: LegacyPluginHost = {
    capabilities: coreHost.capabilities,
    messageBus: coreHost.messageBus,
    i18n,
    resourceStore: coreHost.resourceStore,
    rootScope: coreHost.rootScope,
    taskScheduler: coreHost.taskScheduler,
    installed: () => coreHost!.installed().filter((pluginId) => coreHost!.state(pluginId).kind === "enabled"),
    manifests: () => coreHost!.manifests(),
    state: legacyState,
    scope: (pluginId) => coreHost!.scope(pluginId),
    refreshRuntimeUnitSnapshots: () => coreHost!.refreshRuntimeUnitSnapshots(),
    graph: legacyGraph,
    version: () => coreHost!.version(),
    subscribe: (listener) => coreHost!.subscribe(listener),
    getManifest: (pluginId) => manifests.get(pluginId),
    reverseDeps: (pluginId) => coreHost!.reverseDeps(pluginId).map((value) => ({
      ...value,
      capabilities: value.capabilities.map((capability) => capability.id),
    })),
    validateManifestSet(plugins) {
      for (const plugin of plugins) validateKeymasterManifest(plugin, options.runtime, plugins);
      coreHost!.validateManifestSet(plugins.map(convertManifest));
    },
    provide(key, value) {
      coreHost!.provide(key, value);
    },
    async register(plugin) {
      validateKeymasterManifest(plugin, options.runtime, manifests.values());
      updateManifestMap([plugin]);
      if (coreHost!.getManifest(plugin.id)) return;
      await coreHost!.register(convertManifest(plugin));
    },
    async registerAll(plugins) {
      for (const plugin of plugins) validateKeymasterManifest(plugin, options.runtime, plugins);
      updateManifestMap(plugins);
      await coreHost!.registerAll(plugins.map(convertManifest));
    },
    retry: (pluginId) => coreHost!.retry(pluginId),
    revoke: (pluginId, reason) => {
      return coreHost!.revoke(pluginId, reason);
    },
    unregister: async (pluginId) => {
      if (coreHost!.getManifest(pluginId)) {
          // 撤销条件先围栏实例，防止清理期间的 reconcile 重新启动待删除单元。
        await coreHost!.revoke(pluginId, "plugin unregistered");
      }
      await coreHost!.unregister(pluginId);
      manifests.delete(pluginId);
    },
    dispose: (reason) => {
      if (legacyDisposePromise) return legacyDisposePromise;
      for (const unsubscribe of remoteRuntimeSubscriptions.values()) unsubscribe();
      remoteRuntimeSubscriptions.clear();
      remoteRuntimes.clear();
      keymasterRemoteRuntimeAttachers.delete(legacyHost);
      const scopeOwners = new Map<string, string>();
      for (const [pluginId] of manifests) {
        const scope = coreHost!.scope(pluginId);
        if (scope) scopeOwners.set(scope.identity.scopeId, pluginId);
        const cleanup = coreHost!.state(pluginId).cleanup as { scopeId?: string } | undefined;
        if (cleanup?.scopeId) scopeOwners.set(cleanup.scopeId, pluginId);
      }
      // 先同步围栏全部实例，再结清已排队的 reconcile；清理等待不能
      // 留下可调用的旧 consumer，也不能让排队任务在 dispose 中重新启动。
      const revocations = coreHost!.installed().map(id => coreHost!.revoke(id, reason ?? "Host disposed"));
      legacyDisposePromise = Promise.allSettled(revocations)
        .then(() => coreHost!.reconcile().catch(() => undefined))
        .then(() => coreHost!.dispose(reason))
        .then((result) => projectLegacyCleanupResult(result, scopeOwners));
      return legacyDisposePromise;
    },
    assertCapabilities: (capabilities, extra) => coreHost!.assertCapabilities(capabilities, extra),
    transitionRuntimeIdentity,
    resourceRegistry: legacyResourceRegistry,
  };

  bindWebLoomHost(legacyHost, coreHost);
  keymasterRemoteRuntimeAttachers.set(legacyHost, attachRemoteRuntime);
  return legacyHost;

  async function transitionRuntimeIdentity(next: RuntimeIdentityTransition): Promise<void> {
    if (!next.sessionEpoch) throw new Error("Runtime identity sessionEpoch is required");
    if (next.vaultStatus === "unlocked" && !next.ownerPublicKeyHex) {
      throw new Error("Unlocked runtime identity requires ownerPublicKeyHex");
    }
    const previous = transitionPromise;
    const run = async (): Promise<void> => {
      if (runtimeIdentityKey(runtimeIdentity) === runtimeIdentityKey(next)) return;
      const previousIdentity = runtimeIdentity;
      const runChanged = previousIdentity?.runGeneration !== next.runGeneration;
      const storageChanged = runChanged || (previousIdentity?.walletGeneration ?? "unknown")
        !== (next.walletGeneration ?? "unknown");
      const ownerChanged = runChanged || previousIdentity?.vaultStatus !== next.vaultStatus
        || (previousIdentity?.ownerPublicKeyHex ?? "") !== (next.ownerPublicKeyHex ?? "")
        || previousIdentity?.sessionEpoch !== next.sessionEpoch;
      const toSuspend: { pluginId: string; scopeKind: RuntimeUnitDescriptor["scopeKind"]; shouldRestart: boolean }[] = [];
      for (const [pluginId, manifest] of [...manifests].reverse()) {
        const unit = currentUnit(manifest, hostRuntime);
        if (!unit) continue;
        const identityBound = unit.scopeKind === "storage"
          ? storageChanged
          : unit.scopeKind === "owner-session" || unit.scopeKind === "connect-session"
            ? ownerChanged
            : false;
        if (identityBound) {
          // suspend() 会保留用户意图；只为原本想运行的实例安排重启，
          // 身份变化撤销旧实例，满足新身份条件后重新创建。
          toSuspend.push({
            pluginId,
            scopeKind: unit.scopeKind,
            shouldRestart: true,
          });
        }
      }
      runtimeIdentity = { ...next };
      // 先撤销旧实例，再等待清理；只在新钱包/会话条件就绪后重建。
      // 存储尚未绑定时维持 blocked，等待下一次带世代的身份事件。
      const storageReadyForIdentity = next.walletGeneration !== undefined;
      // 全部旧实例同步围栏后才开始等待，避免新会话消费者短暂读取
      // 尚未撤销的旧会话提供方，或在提供方异步重建期间提前启动。
      await Promise.all(toSuspend.map(item => coreHost!.revoke(item.pluginId, "runtime identity changed")));
      for (const item of toSuspend) {
        if (item.shouldRestart && (item.scopeKind === "storage" ? storageReadyForIdentity : next.vaultStatus === "unlocked")) {
          // 在新身份下重建本地实例。
          await coreHost!.retry(item.pluginId);
        }
      }
      // 锁定期间保留 owner-session 的阻塞状态；解锁后再协调依赖。
      if (next.vaultStatus === "unlocked") await coreHost!.reconcile();
      // Global resources must load after the new contributions have committed.
      coreHost!.resourceStore.refreshRuntimeBindings();
    };
    const settled = (previous ? previous.catch(() => undefined).then(run) : run()).finally(() => {
      if (transitionPromise === settled) transitionPromise = undefined;
    });
    transitionPromise = settled;
    return settled;
  }
}

function runtimeIdentityKey(identity: RuntimeIdentityTransition | undefined): string {
  if (!identity) return "none";
  return `${identity.vaultStatus}|${identity.ownerPublicKeyHex ?? ""}|${identity.sessionEpoch}|${identity.walletGeneration ?? "unknown"}|${identity.runGeneration ?? "unknown"}`;
}

function validateKeymasterManifest(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
  manifestSet: Iterable<PluginManifest>,
): void {
  if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") {
    throw new Error("Plugin id must be a non-empty string");
  }
  const units = manifest.units ?? [];
  if (units.length > 1 && runtime === undefined) {
    throw new Error(`Plugin "${manifest.id}" execution must be explicit for multi-unit manifests`);
  }
  if (runtime !== undefined && units.filter(unit => unit.runtime === runtime).length > 1) throw new Error(`Plugin "${manifest.id}" has ambiguous runtime units for "${runtime}"`);
  const unitIds = new Set<string>();
  for (const unit of units) {
    if (!unit.id || unitIds.has(unit.id)) throw new Error(`Plugin "${manifest.id}" has duplicate or empty runtime unit id`);
    unitIds.add(unit.id);
    if (!unit.runtime || !unit.scopeKind) throw new Error(`Plugin "${manifest.id}" runtime unit "${unit.id}" is incomplete`);
  }
  const declarations = [manifest.storage, ...(manifest.storages ?? []), ...units.flatMap((unit) => [unit.storage, ...(unit.storages ?? [])])].filter(
    (value): value is PluginStorageDeclaration => value !== undefined,
  );
  for (const declaration of declarations) {
    validatePluginStorageDeclaration(declaration);
    assertSystemStorageDeclaration(manifest.id, declaration);
  }
  for (const unit of units) {
    if (unit.storage && unit.storages) throw new Error(`Plugin "${manifest.id}" runtime unit "${unit.id}" cannot declare both storage and storages`);
    const purposes = (unit.storages ?? []).map((declaration) => declaration.purposeId);
    if (new Set(purposes).size !== purposes.length) throw new Error(`Plugin "${manifest.id}" runtime unit "${unit.id}" has duplicate storage purposes`);
  }
}
