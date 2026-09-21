// Keymaster Host Adapter。
//
// WebLoom 负责通用的产品、运行单元、依赖、Scope、权限租约和清理状态机；
// 本适配器只负责把 Keymaster 的 Registry、i18n、Storage、Coordinator
// 和旧插件 Context 接回 WebLoom。领域字段不会进入 WebLoom。

import type {
  AssetDataInvalidationEvent,
  AssetDataNotifier,
  AssetRegistry,
  AssetRegistry as KeymasterAssetRegistry,
  AssetDataNotifier as KeymasterAssetDataNotifier,
  ApplicationSettingsRegistry,
  BreadcrumbRegistry,
  BusinessFeatureRegistry,
  ChannelRuntime,
  ChannelRuntimeFactory,
  CommandRegistry,
  ContactPublicKeyActionRegistry,
  I18nPluginResources,
  I18nService,
  ImporterRegistry,
  KeyValueStore,
  NoticeRegistry,
  PluginContext as KeymasterPluginContext,
  PluginDependency,
  PluginBusinessContribution,
  PluginManifest,
  PluginPermission,
  PluginSetup,
  PluginStorageDeclaration,
  ResourceDefinition as KeymasterResourceDefinition,
  ResourceRegistry as KeymasterResourceRegistry,
  RuntimeIdentityTransition,
  RuntimeUnitDescriptor,
  RuntimeVaultStatus,
  SettingsRegistry,
  SystemSettingsRegistry,
  SystemStatusRegistry,
  TopbarRegistry,
  TransferRegistry,
  VaultSettingsRegistry,
  HomeRegistry,
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_STATUS_REGISTRY_CAPABILITY,
  VAULT_SETTINGS_REGISTRY_CAPABILITY,
  APPLICATION_SETTINGS_REGISTRY_CAPABILITY,
  HOME_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  COMMAND_REGISTRY_CAPABILITY,
  IMPORTER_REGISTRY_CAPABILITY,
  TRANSFER_REGISTRY_CAPABILITY,
  ASSET_REGISTRY_CAPABILITY,
  TOKEN_REGISTRY_CAPABILITY,
  COLLECTIBLE_REGISTRY_CAPABILITY,
  COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY_TYPED,
  NOTICE_REGISTRY_TYPED_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  validatePluginStorageDeclaration,
  assertSystemStorageDeclaration,
} from "@keymaster/contracts";
import {
  STORAGE_BINDING_AUTHORITY_CAPABILITY,
  type StorageBindingAuthority,
} from "@keymaster/contracts/storage-internal";
import type { OwnerAppStore } from "@keymaster/contracts/storage";
import type {
  CreatePluginHostOptions as LegacyCreatePluginHostOptions,
  PluginHost as LegacyPluginHost,
} from "./pluginHostContract.js";
import { bindWebLoomHost } from "./pluginHostContract.js";
import type { PluginConfigStore as LegacyPluginConfigStore } from "./pluginConfigStoreContract.js";
import { createPluginConfigStore } from "./pluginConfigStore.js";
import { createI18nService } from "./i18n/createI18nService.js";
import { createScopedChannelRuntime } from "./lifecycle/scopedChannelRuntime.js";
import {
  createScopedRegistryFacade,
  type CreateScopedRegistryFacadeOptions,
} from "webloom-framework/advanced";
import { createRouteRegistry } from "./registries/routeRegistry.js";
import { createBreadcrumbRegistry } from "./registries/breadcrumbRegistry.js";
import { createSettingsRegistry } from "./registries/settingsRegistry.js";
import { createSystemSettingsRegistry } from "./registries/systemSettingsRegistry.js";
import { createSystemStatusRegistry } from "./registries/systemStatusRegistry.js";
import { createVaultSettingsRegistry } from "./registries/vaultSettingsRegistry.js";
import { createApplicationSettingsRegistry } from "./registries/applicationSettingsRegistry.js";
import { createHomeRegistry } from "./registries/homeRegistry.js";
import { createBusinessFeatureRegistry } from "./registries/businessFeatureRegistry.js";
import { createCommandRegistry } from "./registries/commandRegistry.js";
import { createImporterRegistry } from "./registries/importerRegistry.js";
import { createTransferRegistry } from "./registries/transferRegistry.js";
import { createContactPublicKeyActionRegistry } from "./registries/contactPublicKeyActionRegistry.js";
import { createAssetRegistry } from "./registries/assetRegistry.js";
import { createTokenRegistry } from "./registries/tokenRegistry.js";
import { createCollectibleRegistry } from "./registries/collectibleRegistry.js";
import { createCollectibleTransferRegistry } from "./registries/collectibleTransferRegistry.js";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createTopbarRegistry } from "./registries/topbarRegistry.js";
import { createNoticeRegistry } from "./registries/noticeRegistry.js";
import {
  createMessageBus,
  capabilityKey,
} from "webloom-framework";
import {
  createPluginHost as createWebLoomPluginHost,
  createResourceRegistry,
  createRuntimeUnitImplementationRegistry,
  registerOwnedResource,
  bridgeForRuntimeHandle,
  type PluginConfigStore as WebLoomPluginConfigStore,
  type ContributionAdapter,
  type PluginHost as WebLoomPluginHost,
  type RuntimeUnitParentScopeInput,
  type HostCapabilityRegistration,
} from "webloom-framework/advanced";
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

const keymasterRemoteRuntimeAttachers = new WeakMap<LegacyPluginHost, (runtime: RuntimeHandle) => void>();

/** 在 WindowApp 接管既有 Host 后绑定 SharedWorker Runtime。 */
export function attachKeymasterRemoteRuntime(host: LegacyPluginHost, runtime: RuntimeHandle): void {
  const attach = keymasterRemoteRuntimeAttachers.get(host);
  if (!attach) throw new Error("Keymaster PluginHost is not ready for a remote Runtime");
  attach(runtime);
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
  /** Storage bucket 运行世代。 */
  readonly bucketGeneration?: number;
  /** 当前授权策略修订。 */
  readonly authorizationRevision?: number;
}

const TOPBAR_REGISTRY_KEY = TOPBAR_REGISTRY_CAPABILITY.id;

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

function storagesOfManifest(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
): PluginStorageDeclaration[] {
  const unit = currentUnit(manifest, runtime);
  if (unit) return unit.storages ? [...unit.storages] : unit.storage ? [unit.storage] : [];
  return manifest.storages ? [...manifest.storages] : manifest.storage ? [manifest.storage] : [];
}

function startupPolicy(manifest: PluginManifest): {
  startup: "required" | "optional";
  defaultEnabled: boolean;
  canDisable: boolean;
} {
  const startup = manifest.startup;
  const defaultEnabled = manifest.defaultEnabled;
  const canDisable = manifest.canDisable;
  return { startup, defaultEnabled, canDisable };
}

function attributesFromRuntimeIdentity(
  identity: RuntimeIdentityTransition | undefined,
): KeymasterRuntimeScopeAttributes {
  if (!identity) return Object.freeze({});
  return Object.freeze({
    vaultStatus: identity.vaultStatus,
    ...(identity.ownerPublicKeyHex ? { ownerPublicKeyHex: identity.ownerPublicKeyHex } : {}),
    sessionEpoch: identity.sessionEpoch,
    ...(identity.bucketGeneration !== undefined ? { bucketGeneration: identity.bucketGeneration } : {}),
  });
}

function isStaleOwnerStorageBinding(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "storage_unavailable" || code === "storage_identity_required") return true;
  return /owner storage (?:handle|grant|binding) .*?(?:stale|invalid|changed)|owner storage .*unavailable|owner storage owner changed|owner storage bucket generation changed/i.test(errorMessage(error));
}

/** 创建资产数据失效通知器；资产内容仍由 Keymaster 领域插件定义。 */
function createAssetDataNotifier(): AssetDataNotifier {
  const listeners = new Set<(event: AssetDataInvalidationEvent) => void>();
  const pending = new Map<string, AssetDataInvalidationEvent>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) {
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* 观察者不能改变失效结果。 */ }
      }
    }
  };
  return {
    emit(event) {
      const key = `${event.providerId}:${event.publicKeyHex ?? "none"}`;
      const previous = pending.get(key);
      pending.set(key, previous ? {
        ...previous,
        kinds: [...new Set([...previous.kinds, ...event.kinds])],
        revision: Math.max(previous.revision, event.revision),
        ...(previous.utxoSeqs || event.utxoSeqs ? {
          utxoSeqs: {
            ...(previous.utxoSeqs?.main !== undefined || event.utxoSeqs?.main !== undefined
              ? { main: Math.max(previous.utxoSeqs?.main ?? 0, event.utxoSeqs?.main ?? 0) }
              : {}),
            ...(previous.utxoSeqs?.test !== undefined || event.utxoSeqs?.test !== undefined
              ? { test: Math.max(previous.utxoSeqs?.test ?? 0, event.utxoSeqs?.test ?? 0) }
              : {}),
          },
        } : {}),
      } : event);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 创建延迟 owner Storage 句柄；领域 authority 仍在最终 I/O 边界复核绑定。 */
function createDeferredOwnerAppStore(
  authority: StorageBindingAuthority,
  pluginId: string,
  declaration: PluginStorageDeclaration,
  scope: import("webloom-framework").LifecycleScope,
): KeyValueStore {
  let closed = false;
  let ownerPublicKeyHex: string | undefined;
  let bucketGeneration: number | undefined;
  let current: OwnerAppStore | undefined;

  const invalidateCurrent = (): void => {
    current?.close();
    current = undefined;
    ownerPublicKeyHex = undefined;
    bucketGeneration = undefined;
  };

  const removeScopeRevoke = scope.onRevoke(() => {
    closed = true;
    invalidateCurrent();
  });
  scope.onDispose(() => {
    removeScopeRevoke();
    closed = true;
    invalidateCurrent();
  }, "owner-storage");

  async function resolve(): Promise<OwnerAppStore> {
    scope.assertActive();
    if (closed) throw new Error("Owner storage handle is closed");
    const activeOwner = authority.getActivePublicKeyHex?.()?.toLowerCase();
    const ownerChanged = authority.getActivePublicKeyHex !== undefined
      && (!activeOwner || ownerPublicKeyHex !== activeOwner);
    if (!current || !ownerPublicKeyHex || ownerChanged || bucketGeneration !== current.bucketGeneration) {
      invalidateCurrent();
      const opened = await authority.openOwnerAppStore({ pluginId, declaration });
      try {
        scope.assertActive();
        if (!opened.ownerPublicKeyHex) throw new Error("Owner storage binding has no owner");
        const latestOwner = authority.getActivePublicKeyHex?.()?.toLowerCase();
        if (latestOwner && opened.ownerPublicKeyHex.toLowerCase() !== latestOwner) {
          throw new Error("Owner storage owner changed while opening binding");
        }
        current = opened;
        ownerPublicKeyHex = opened.ownerPublicKeyHex.toLowerCase();
        bucketGeneration = opened.bucketGeneration;
      } catch (error) {
        opened.close();
        throw error;
      }
    }
    scope.assertActive();
    return current;
  }

  const run = async <T>(operation: (store: OwnerAppStore) => Promise<T>): Promise<T> => {
    const store = await resolve();
    const boundOwner = ownerPublicKeyHex;
    const boundBucket = bucketGeneration;
    try {
      scope.assertActive();
      const result = await operation(store);
      scope.assertActive();
      if (current !== store || ownerPublicKeyHex !== boundOwner || bucketGeneration !== boundBucket) {
        throw new Error("Owner storage binding changed while operation was running");
      }
      return result;
    } catch (error) {
      if (isStaleOwnerStorageBinding(error)) invalidateCurrent();
      throw error;
    }
  };

  return {
    get bucketId() { return current?.bucketId ?? "pending"; },
    get bucketGeneration() { return current?.bucketGeneration ?? 0; },
    get ownerPublicKeyHex() { return ownerPublicKeyHex ?? ""; },
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
    scope: declaration.scope,
    authority: declaration.authority,
    model: "kv",
    schemaVersion: declaration.schemaVersion,
    get: async (key, options) => run((store) => store.get(key, options)),
    list: async (input) => run((store) => store.list(input)),
    put: async (key, value, condition) => run((store) => store.put(key, value, condition)),
    delete: async (key, condition) => { await run((store) => store.delete(key, condition)); },
    commit: async (input) => run((store) => store.commit(input)),
    close: () => {
      if (closed) return;
      closed = true;
      invalidateCurrent();
    },
  };
}

/** 创建延迟 owner 文件句柄（model: "files"）；authority 在最终 I/O 边界复核绑定。 */
function createDeferredOwnerFileStore(
  authority: StorageBindingAuthority,
  pluginId: string,
  declaration: PluginStorageDeclaration,
  scope: import("webloom-framework").LifecycleScope,
): import("@keymaster/contracts").OwnerFileStore {
  let closed = false;
  let current: import("@keymaster/contracts").OwnerFileStore | undefined;

  const invalidateCurrent = (): void => {
    current = undefined;
  };

  const removeScopeRevoke = scope.onRevoke(() => {
    closed = true;
    invalidateCurrent();
  });
  scope.onDispose(() => {
    removeScopeRevoke();
    closed = true;
    invalidateCurrent();
  }, "owner-file-storage");

  async function resolve(): Promise<import("@keymaster/contracts").OwnerFileStore> {
    scope.assertActive();
    if (closed) throw new Error("Owner file storage handle is closed");
    if (!current) {
      current = await authority.openOwnerFileStore({ pluginId, declaration });
      scope.assertActive();
      if (closed) {
        current = undefined;
        throw new Error("Owner file storage handle is closed");
      }
    }
    return current;
  }

  const run = async <T>(operation: (store: import("@keymaster/contracts").OwnerFileStore) => Promise<T>): Promise<T> => {
    const store = await resolve();
    try {
      scope.assertActive();
      const result = await operation(store);
      scope.assertActive();
      return result;
    } catch (error) {
      if (isStaleOwnerStorageBinding(error)) invalidateCurrent();
      throw error;
    }
  };

  return {
    list: (input) => run((store) => store.list(input)),
    get: (path, options) => run((store) => store.get(path, options)),
    put: (path, bytes, condition) => run((store) => store.put(path, bytes, condition)),
    delete: (path, options) => { return run((store) => store.delete(path, options)); },
  };
}

function requireStorageBindingAuthority(
  options: LegacyCreatePluginHostOptions,
  host: WebLoomPluginHost,
  pluginId: string,
): StorageBindingAuthority {
  const authority = options.storageBindingAuthority
    ?? (host.capabilities.has(STORAGE_BINDING_AUTHORITY_CAPABILITY)
      ? host.capabilities.get(STORAGE_BINDING_AUTHORITY_CAPABILITY)
      : undefined);
  if (!authority) throw new Error(`Plugin "${pluginId}" requires the storage binding authority`);
  return authority;
}

async function bindStorageDeclaration(
  options: LegacyCreatePluginHostOptions,
  host: WebLoomPluginHost,
  pluginId: string,
  declaration: PluginStorageDeclaration,
  scope: import("webloom-framework").LifecycleScope,
): Promise<KeyValueStore | undefined> {
  const authority = requireStorageBindingAuthority(options, host, pluginId);
  if (declaration.scope === "bucket") {
    return authority.openPlatformStore({ pluginId, declaration });
  }
  return createDeferredOwnerAppStore(authority, pluginId, declaration, scope);
}

function borrowKeyValueStore(store: KeyValueStore): import("@keymaster/contracts").BorrowedKeyValueStore {
  return {
    get bucketId() { return store.bucketId; },
    get bucketGeneration() { return store.bucketGeneration; },
    get ownerPublicKeyHex() { return store.ownerPublicKeyHex; },
    get moduleId() { return store.moduleId; },
    get purposeId() { return store.purposeId; },
    get scope() { return store.scope; },
    get authority() { return store.authority; },
    get model() { return store.model; },
    get schemaVersion() { return store.schemaVersion; },
    get: (key, input) => store.get(key, input),
    list: (input) => store.list(input),
    put: (key, value, condition) => store.put(key, value, condition),
    delete: (key, condition) => store.delete(key, condition),
    commit: (input) => store.commit(input),
  };
}

/** 把 Keymaster ResourceDefinition 适配为 WebLoom ResourceDefinition。 */
function adaptResourceDefinition<T>(
  definition: KeymasterResourceDefinition<T, readonly string[]>,
  getActivePublicKeyHex: () => string | undefined,
): WebLoomResourceDefinition<T, readonly string[]> {
  const context = (input: import("webloom-framework").ResourceContext) => ({
    getCapability: <T>(capability: string | CapabilityDescriptor) =>
      input.getCapability<T>(typeof capability === "string" ? capability : capability.id),
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
    ...(definition.equals ? { equals: definition.equals } : {}),
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
  } as KeymasterResourceRegistry & {
    _registerForOwner: typeof registerForOwner;
    _revokeOwner: typeof revokeOwner;
  };
}

/** 创建领域 Registry，并将它们作为 WebLoom 的内建 capability 注入。 */
function createKeymasterCapabilities(): {
  capabilities: Record<string, unknown>;
  routes: import("./registries/routeRegistry.js").RouteRegistry;
  breadcrumbs: import("./registries/breadcrumbRegistry.js").BreadcrumbRegistry;
  settings: import("./registries/settingsRegistry.js").SettingsRegistry;
  systemSettings: import("./registries/systemSettingsRegistry.js").SystemSettingsRegistry;
  systemStatus: import("./registries/systemStatusRegistry.js").SystemStatusRegistry;
  vaultSettings: import("./registries/vaultSettingsRegistry.js").VaultSettingsRegistry;
  applicationSettings: import("./registries/applicationSettingsRegistry.js").ApplicationSettingsRegistry;
  home: import("./registries/homeRegistry.js").HomeRegistry;
  business: import("./registries/businessFeatureRegistry.js").BusinessFeatureRegistry;
  commands: import("./registries/commandRegistry.js").CommandRegistry;
  importers: import("./registries/importerRegistry.js").ImporterRegistry;
  transfers: import("./registries/transferRegistry.js").TransferRegistry;
  contactPublicKeyActions: ReturnType<typeof createContactPublicKeyActionRegistry>;
  assets: import("./registries/assetRegistry.js").AssetRegistry;
  tokens: import("./registries/tokenRegistry.js").TokenRegistry;
  collectibles: import("./registries/collectibleRegistry.js").CollectibleRegistry;
  collectibleTransfer: import("./registries/collectibleTransferRegistry.js").CollectibleTransferRegistry;
  protectedOutpoints: import("./registries/protectedOutpointRegistry.js").ProtectedOutpointRegistry;
  topbar: import("./registries/topbarRegistry.js").TopbarRegistry;
  notice: NoticeRegistry;
  assetDataNotifier: AssetDataNotifier;
} {
  const routes = createRouteRegistry();
  const breadcrumbs = createBreadcrumbRegistry();
  const settings = createSettingsRegistry();
  const systemSettings = createSystemSettingsRegistry();
  const systemStatus = createSystemStatusRegistry();
  const vaultSettings = createVaultSettingsRegistry();
  const applicationSettings = createApplicationSettingsRegistry();
  const home = createHomeRegistry();
  const business = createBusinessFeatureRegistry();
  const commands = createCommandRegistry();
  const importers = createImporterRegistry();
  const transfers = createTransferRegistry();
  const contactPublicKeyActions = createContactPublicKeyActionRegistry();
  const assets = createAssetRegistry();
  const tokens = createTokenRegistry();
  const collectibles = createCollectibleRegistry();
  const collectibleTransfer = createCollectibleTransferRegistry();
  const protectedOutpoints = createProtectedOutpointRegistry();
  const topbar = createTopbarRegistry();
  const notice = createNoticeRegistry();
  const assetDataNotifier = createAssetDataNotifier();

  const capabilities: Record<string, unknown> = {
    "route.registry": routes,
    "breadcrumb.registry": breadcrumbs,
    "settings.registry": settings,
    "system-settings.registry": systemSettings,
    "system-status.registry": systemStatus,
    "vault-settings.registry": vaultSettings,
    "application-settings.registry": applicationSettings,
    "home.registry": home,
    "business.registry": business,
    "command.registry": commands,
    "importer.registry": importers,
    "transfer.registry": transfers,
    "contacts.public-key-action.registry": contactPublicKeyActions,
    "asset.registry": assets,
    "token.registry": tokens,
    "collectible.registry": collectibles,
    "collectible-transfer.registry": collectibleTransfer,
    "protected-outpoint.registry": protectedOutpoints,
    [TOPBAR_REGISTRY_KEY]: topbar,
    "notice.registry": notice,
    [ASSET_DATA_NOTIFIER_CAPABILITY.id]: assetDataNotifier,
  };
  return {
    capabilities,
    routes,
    breadcrumbs,
    settings,
    systemSettings,
    systemStatus,
    vaultSettings,
    applicationSettings,
    home,
    business,
    commands,
    importers,
    transfers,
    contactPublicKeyActions,
    assets,
    tokens,
    collectibles,
    collectibleTransfer,
    protectedOutpoints,
    topbar,
    notice,
    assetDataNotifier,
  };
}

/** 旧业务 manifest 的 business 声明适配器。 */
function createBusinessContributionAdapter(
  registries: ReturnType<typeof createKeymasterCapabilities>,
  hooks: {
    onRouteRegistered?: (pluginId: string, routeId: string) => void;
    onRouteRevoked?: (pluginId: string, routeId: string) => void;
  } = {},
): ContributionAdapter {
  const { routes, business } = registries;
  return {
    name: "keymaster.business",
    register(input) {
      const contribution = input.contribution as PluginBusinessContribution | undefined;
      if (!contribution || typeof contribution !== "object" || !Array.isArray(contribution.domains)) return undefined;
      const registeredDomains: string[] = [];
      const registeredFeatures: string[] = [];
      const registeredRoutes: string[] = [];
      for (const domain of contribution.domains) {
        for (const feature of domain.features) {
          const route = feature.entry.routeId ? routes.byId(feature.entry.routeId) : routes.byPath(feature.entry.path);
          if (feature.entry.routeId && !route) {
            throw new Error(`Business feature "${feature.id}" references missing route "${feature.entry.routeId}"`);
          }
          if (route && route.path !== feature.entry.path) {
            throw new Error(`Business feature "${feature.id}" route path conflicts with its reference`);
          }
          if (route && !feature.entry.routeId) {
            throw new Error(`Business feature "${feature.id}" must explicitly declare routeId for existing route "${feature.entry.path}"`);
          }
          if (!route) {
            if (!feature.entry.component) {
              throw new Error(`Business feature "${feature.id}" must provide component for a new route`);
            }
            routes.register({
              id: feature.id,
              path: feature.entry.path,
              label: feature.label,
              component: feature.entry.component,
            });
            registeredRoutes.push(feature.id);
            hooks.onRouteRegistered?.(input.pluginId, feature.id);
          }
          for (const view of feature.views ?? []) {
            if (routes.byPath(view.path)) {
              throw new Error(`Business feature view "${view.id}" path "${view.path}" conflicts with an existing route`);
            }
            routes.register({ id: view.id, path: view.path, label: view.label, component: view.component });
            registeredRoutes.push(view.id);
            hooks.onRouteRegistered?.(input.pluginId, view.id);
          }
        }
        business.register(input.pluginId, domain);
        registeredDomains.push(domain.id);
        registeredFeatures.push(...domain.features.map((feature: PluginBusinessContribution["domains"][number]["features"][number]) => feature.id));
      }
      return {
        revoke() {
          // 贡献入口必须先同步消失；业务 Registry 的注销顺序与旧 Host 保持一致。
          for (const id of [...registeredFeatures].reverse()) {
            try { business.unregisterFeature(id); } catch { /* 幂等清理。 */ }
          }
          for (const id of [...registeredDomains].reverse()) {
            try { business.unregisterDomain(id); } catch { /* 幂等清理。 */ }
          }
          for (const id of [...registeredRoutes].reverse()) {
            try {
              routes.unregister(id);
              hooks.onRouteRevoked?.(input.pluginId, id);
            } catch { /* 幂等清理。 */ }
          }
        },
        dispose() {
          // revoke 已完成同步注销；这里保留幂等句柄，兼容异步适配器协议。
        },
      };
    },
  };
}

/** Keymaster Host Adapter 的完整装配入口。 */
export function createKeymasterPluginHost(
  options: LegacyCreatePluginHostOptions = {},
): LegacyPluginHost {
  // 未指定时保留“无执行宿主”语义：单一运行单元可按自身 Runtime 选择，
  // 多运行单元必须在校验边界显式指定，不能静默偏向 Window。
  const hostRuntime = options.runtime;
  const domain = createKeymasterCapabilities();
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
  const configStore = createPluginConfigStore({
    readOnly: options.disableConfigPersistence,
    initial: options.initialPluginConfig,
  });

  const manifests = new Map<string, PluginManifest>();
  let remoteRuntime = options.remoteRuntime;
  // A live RuntimeHandle is the sole authority for cross-runtime service and
  // unit state. Legacy callbacks remain only for callers that have not yet
  // connected a RuntimeHandle; they never compete with one.
  const readRemoteRuntimeSnapshots = (): import("webloom-framework/advanced").RuntimeUnitSnapshot[] => {
    if (remoteRuntime) {
      return remoteRuntime.state().units.map((unit) => ({
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
      state: snapshot.state === "ready"
        ? "enabled" as const
        : snapshot.state === "starting"
          ? "starting" as const
          : "error-disabled" as const,
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
  let removeHostKeyspaceListener: (() => void) | undefined;
  let transitionPromise: Promise<void> | undefined;

  function currentActivePublicKeyHex(): string | undefined {
    if (coreHost?.capabilities.has(KEYSPACE_SERVICE_CAPABILITY)) {
      try {
        const keyspace = coreHost.capabilities.get(KEYSPACE_SERVICE_CAPABILITY);
        return keyspace.active().activePublicKeyHex;
      } catch {
        // keyspace 还未启动时退回当前 Coordinator 身份快照。
      }
    }
    return runtimeIdentity?.ownerPublicKeyHex ?? undefined;
  }

  function runtimeUnitUnavailableReason(pluginId: string, unitId: string): string | undefined {
    const unit = manifests.get(pluginId)?.units?.find((candidate) => candidate.id === unitId);
    if (!unit) return undefined;
    if ((unit.scopeKind === "owner-session" || unit.scopeKind === "connect-session")
      && (runtimeIdentity?.vaultStatus !== "unlocked" || !runtimeIdentity.ownerPublicKeyHex)) {
      return `runtime:${unit.scopeKind}-unavailable`;
    }
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
      ? `storage:${attributes.bucketGeneration ?? "unknown"}`
      : `${scopeKind}:${attributes.ownerPublicKeyHex ?? "none"}:${attributes.sessionEpoch ?? "none"}`;
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

  function bindHostKeyspace(value: unknown): void {
    removeHostKeyspaceListener?.();
    removeHostKeyspaceListener = undefined;
    const keyspace = value as {
      onActiveKeyChanged?: (listener: () => void) => () => void;
    } | undefined;
    if (keyspace?.onActiveKeyChanged) {
      removeHostKeyspaceListener = keyspace.onActiveKeyChanged(() => {
        coreHost?.resourceStore.refreshRuntimeBindings();
      });
    }
    coreHost?.resourceStore.refreshRuntimeBindings();
  }

  const registryRules = new Map<string, CreateScopedRegistryFacadeOptions>([
    ["route.registry", { name: "route.registry" }],
    ["breadcrumb.registry", { name: "breadcrumb.registry" }],
    ["settings.registry", { name: "settings.registry" }],
    ["system-settings.registry", { name: "system-settings.registry" }],
    ["system-status.registry", { name: "system-status.registry" }],
    ["vault-settings.registry", { name: "vault-settings.registry" }],
    ["application-settings.registry", { name: "application-settings.registry" }],
    ["home.registry", { name: "home.registry" }],
    ["command.registry", { name: "command.registry" }],
    ["importer.registry", { name: "importer.registry" }],
    ["transfer.registry", { name: "transfer.registry" }],
    ["contacts.public-key-action.registry", { name: "contacts.public-key-action.registry" }],
    ["asset.registry", { name: "asset.registry" }],
    ["token.registry", { name: "token.registry" }],
    ["collectible.registry", { name: "collectible.registry" }],
    ["collectible-transfer.registry", { name: "collectible-transfer.registry" }],
    ["protected-outpoint.registry", { name: "protected-outpoint.registry" }],
    [TOPBAR_REGISTRY_KEY, { name: TOPBAR_REGISTRY_KEY }],
    ["notice.registry", {
      name: "notice.registry",
      registrations: [{ method: "upsert", idArgument: 0, unregisterMethod: "dismiss" }],
    }],
    ["business.registry", {
      name: "business.registry",
      registrations: [
        {
          method: "register",
          idArgument: 1,
          unregisterMethod: "unregisterDomain",
          unregisterArgument: 0,
          bindPluginIdArgument: 0,
        },
        {
          method: "registerFeature",
          idArgument: 2,
          unregisterMethod: "unregisterFeature",
          unregisterArgument: 0,
          bindPluginIdArgument: 0,
        },
      ],
    }],
    ["window-p2p.executor", { name: "window-p2p.executor", registrations: [{ method: "register" }] }],
  ]);

  /**
   * 领域路由仍由 Keymaster Registry 持有，但禁用动作需要在同步撤权前
   * 离开当前页面。这里记录“本插件实例注册了哪些路由”，不把路由语义
   * 泄漏到 WebLoom 通用 Host。
   */
  const routeOwners = new Map<string, Set<string>>();
  const settingsRouteOwners = new Map<string, Set<string>>();

  function rememberRouteOwner(
    owners: Map<string, Set<string>>,
    pluginId: string,
    routeId: string,
  ): void {
    const ids = owners.get(pluginId) ?? new Set<string>();
    ids.add(routeId);
    owners.set(pluginId, ids);
  }

  function forgetRouteOwner(
    owners: Map<string, Set<string>>,
    pluginId: string,
    routeId: string,
  ): void {
    const ids = owners.get(pluginId);
    if (!ids) return;
    ids.delete(routeId);
    if (ids.size === 0) owners.delete(pluginId);
  }

  function registryDefinitionId(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  function scopedLegacyRegistry<T extends object>(
    key: string,
    scope: import("webloom-framework").LifecycleScope,
    pluginId: string,
  ): T | undefined {
    const target = domain.capabilities[key];
    const rules = registryRules.get(key);
    if (!target || !rules || typeof target !== "object") return undefined;
    const facade = createScopedRegistryFacade(
      target,
      scope,
      rules,
    ) as T;

    const owners = key === "route.registry"
      ? routeOwners
      : key === "settings.registry" ? settingsRouteOwners : undefined;
    if (!owners) return facade;

    const registrationRules = rules.registrations ?? [
      { method: "register", idArgument: 0, unregisterMethod: "unregister" },
    ];
    const byRegistrationMethod = new Map(registrationRules.map((rule) => [rule.method, rule]));
    const byUnregisterMethod = new Map(
      registrationRules
        .filter((rule) => rule.unregisterMethod)
        .map((rule) => [rule.unregisterMethod as string, rule]),
    );
    const ownedByThisScope = new Set<string>();
    const removeScopeOwnership = scope.onRevoke(() => {
      for (const routeId of ownedByThisScope) forgetRouteOwner(owners, pluginId, routeId);
      ownedByThisScope.clear();
    });
    scope.onDispose(() => {
      removeScopeOwnership();
    }, `keymaster.${key}.ownership`);

    return new Proxy(facade, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        const registrationRule = byRegistrationMethod.get(property);
        if (registrationRule) {
          return (...args: unknown[]) => {
            const result = (value as (...input: unknown[]) => unknown)(...args);
            const id = registryDefinitionId(args[registrationRule.idArgument ?? 0]);
            if (id) {
              rememberRouteOwner(owners, pluginId, id);
              ownedByThisScope.add(id);
            }
            return result;
          };
        }
        const unregisterRule = byUnregisterMethod.get(property);
        if (unregisterRule) {
          return (...args: unknown[]) => {
            const result = (value as (...input: unknown[]) => unknown)(...args);
            const id = registryDefinitionId(
              args[unregisterRule.unregisterArgument ?? unregisterRule.idArgument ?? 0],
            );
            if (id) {
              forgetRouteOwner(owners, pluginId, id);
              ownedByThisScope.delete(id);
            }
            return result;
          };
        }
        return value;
      },
    }) as T;
  }

  function createLegacyContext(
    context: WebLoomPluginContext,
    manifest: PluginManifest,
    storage: import("@keymaster/contracts").BorrowedKeyValueStore | undefined,
    storages: ReadonlyMap<string, import("@keymaster/contracts").BorrowedKeyValueStore>,
    files: ReadonlyMap<string, import("@keymaster/contracts").BorrowedOwnerFileStore>,
  ): KeymasterPluginContext {
    const scopedCache = new Map<string, unknown>();
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
        return legacyResourceRegistry.get<T, TArgs>(id);
      },
      _ids: () => [...ownedResourceIds],
    };
    // 旧 Resource Registry 的定义必须在同步 revoke 阶段消失，不能等待
    // teardown 或 Resource Store 的异步清理。
    context.scope.onRevoke(() => {
      resourceRegistryInternal._revokeOwner?.(context.instanceId);
      ownedResourceIds.clear();
    });
    const coordinator = options.coordinatorForPlugin?.(manifest.id);
    let removeKeyspaceListener: (() => void) | undefined;
    context.scope.onDispose(() => {
      removeKeyspaceListener?.();
      removeKeyspaceListener = undefined;
    }, "keyspace-resource-binding");
    const extension = {
      storage,
      storageFor: (purposeId: string) => {
        const selected = storages.get(purposeId);
        if (!selected) throw new Error(`Plugin "${manifest.id}" did not declare storage purpose "${purposeId}" for this runtime unit`);
        return selected;
      },
      filesFor: (purposeId: string) => {
        const selected = files.get(purposeId);
        if (!selected) throw new Error(`Plugin "${manifest.id}" did not declare file storage purpose "${purposeId}" for this runtime unit`);
        return selected;
      },
      coordinator,
    };
    const capability = <C extends Capability>(
      requested: C,
    ): CapabilityClient<C> => {
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
      if (cached) return cached as CapabilityClient<C>;
      const facade = scopedLegacyRegistry<object>(key, context.scope, manifest.id);
      if (facade) {
        scopedCache.set(key, facade);
        return facade as CapabilityClient<C>;
      }
      return context.capability(requested) as CapabilityClient<C>;
    };
    const optionalCapability = <C extends Capability>(
      requested: C,
    ): CapabilityClient<C> | undefined => {
      try { return capability(requested); } catch { return undefined; }
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
      storage,
      storageFor: extension.storageFor,
      filesFor: extension.filesFor,
      coordinator,
      extension,
      capability,
      optionalCapability,
      provide<C extends LocalCapability<unknown>>(requested: C, value: LocalServiceOf<C>): void {
        context.provide(requested, value);
        if (requested.id !== KEYSPACE_SERVICE_CAPABILITY.id) return;
        removeKeyspaceListener?.();
        removeKeyspaceListener = undefined;
        const keyspace = value as {
          onActiveKeyChanged?: (listener: () => void) => () => void;
        } | undefined;
        if (keyspace?.onActiveKeyChanged) {
          removeKeyspaceListener = keyspace.onActiveKeyChanged(() => {
            coreHost?.resourceStore.refreshRuntimeBindings();
          });
        }
        coreHost?.resourceStore.refreshRuntimeBindings();
      },
      messageBus: context.messageBus,
    };
    return legacyContext;
  }

  function wrapSetup(manifest: PluginManifest, setup: PluginSetup): import("webloom-framework").PluginSetup {
    return async (context: WebLoomPluginContext) => {
      if (manifest.i18n) {
        i18n.registerResources(manifest.id, manifest.i18n);
        context.onDispose(() => i18n.unregisterResources(manifest.id));
      }
      const declared = storagesOfManifest(manifest, options.runtime);
      const bound = new Map<string, import("@keymaster/contracts").BorrowedKeyValueStore>();
      const boundFiles = new Map<string, import("@keymaster/contracts").BorrowedOwnerFileStore>();
      for (const declaration of declared) {
        if (declaration.model === "files") {
          const ownedFiles = createDeferredOwnerFileStore(requireStorageBindingAuthority(options, coreHost!, manifest.id), manifest.id, declaration, context.scope);
          boundFiles.set(declaration.purposeId, ownedFiles);
          continue;
        }
        let owned = await bindStorageDeclaration(options, coreHost!, manifest.id, declaration, context.scope);
        if (!owned) continue;
        owned = context.scope.track(owned, (value) => value.close(), `storage:${declaration.purposeId}`);
        bound.set(declaration.purposeId, borrowKeyValueStore(owned));
      }
      const storage = declared.length === 1 ? bound.get(declared[0]!.purposeId) : undefined;
      const result = await setup(createLegacyContext(context, manifest, storage, bound, boundFiles));
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
    { capability: ROUTE_REGISTRY_CAPABILITY, value: domain.routes },
    { capability: BREADCRUMB_REGISTRY_CAPABILITY, value: domain.breadcrumbs },
    { capability: SETTINGS_REGISTRY_CAPABILITY, value: domain.settings },
    { capability: SYSTEM_SETTINGS_REGISTRY_CAPABILITY, value: domain.systemSettings },
    { capability: SYSTEM_STATUS_REGISTRY_CAPABILITY, value: domain.systemStatus },
    { capability: VAULT_SETTINGS_REGISTRY_CAPABILITY, value: domain.vaultSettings },
    { capability: APPLICATION_SETTINGS_REGISTRY_CAPABILITY, value: domain.applicationSettings },
    { capability: HOME_REGISTRY_CAPABILITY, value: domain.home },
    { capability: BUSINESS_REGISTRY_CAPABILITY, value: domain.business },
    { capability: COMMAND_REGISTRY_CAPABILITY, value: domain.commands },
    { capability: IMPORTER_REGISTRY_CAPABILITY, value: domain.importers },
    { capability: TRANSFER_REGISTRY_CAPABILITY, value: domain.transfers },
    { capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, value: domain.contactPublicKeyActions },
    { capability: ASSET_REGISTRY_CAPABILITY, value: domain.assets },
    { capability: TOKEN_REGISTRY_CAPABILITY, value: domain.tokens },
    { capability: COLLECTIBLE_REGISTRY_CAPABILITY, value: domain.collectibles },
    { capability: COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY, value: domain.collectibleTransfer },
    { capability: PROTECTED_OUTPOINT_REGISTRY_CAPABILITY_TYPED, value: domain.protectedOutpoints },
    { capability: TOPBAR_REGISTRY_CAPABILITY, value: domain.topbar },
    { capability: NOTICE_REGISTRY_TYPED_CAPABILITY, value: domain.notice },
    { capability: ASSET_DATA_NOTIFIER_CAPABILITY, value: domain.assetDataNotifier },
    { capability: RESOURCE_REGISTRY_CAPABILITY, value: legacyResourceRegistry },
    { capability: RUNTIME_MESSAGE_BUS, value: messageBus },
    { capability: I18N_SERVICE_CAPABILITY, value: i18n },
  ];
  if (options.storageBindingAuthority) {
    legacyBuiltinCapabilities.push({ capability: STORAGE_BINDING_AUTHORITY_CAPABILITY, value: options.storageBindingAuthority });
  }

  domain.settings.setRoutePathProbe((path) => domain.routes.byPath(path) !== undefined);

  coreHost = createWebLoomPluginHost({
    runtime: hostRuntime,
    rootAttributes: attributesFromRuntimeIdentity(runtimeIdentity),
    runtimeUnitAvailability: ({ pluginId, unitId }) => runtimeUnitUnavailableReason(pluginId, unitId),
    runtimeUnitAttributes: ({ pluginId, unitId }) => ({
      ...attributesFromRuntimeIdentity(runtimeIdentity),
      ...(options.lifecycleIdentityForPlugin?.(pluginId, unitId) ?? {}),
    }),
    runtimeUnitParentScope,
    capabilities: legacyBuiltinCapabilities,
    resourceRegistry: webResourceRegistry,
    resourceCapabilityResolver: <T>(id: string): T | undefined => {
      const legacy = domain.capabilities[id];
      if (legacy !== undefined) return legacy as T;
      const registration = coreHost?.capabilities.registrations().find(
        (entry) => entry.capability.id === id,
      );
      return registration?.value as T | undefined;
    },
    messageBus,
    configStore: {
      read: () => configStore.read(),
      setEnabled: (pluginId, enabled) => configStore.setEnabled(pluginId, enabled),
      subscribe: (listener) => configStore.subscribe((snapshot) => listener(snapshot)),
    } satisfies WebLoomPluginConfigStore,
    contextExtension: ({ pluginId }) => ({
      coordinator: options.coordinatorForPlugin?.(pluginId),
    }),
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
    pluginIntentCoordinator: options.pluginIntentCoordinator,
    capabilityBridge: remoteRuntime ? bridgeForRuntimeHandle(remoteRuntime) : undefined,
    runtimeUnitImplementationRegistry: implementationRegistry,
    contributionAdapters: [createBusinessContributionAdapter(domain, {
      onRouteRegistered: (pluginId, routeId) => rememberRouteOwner(routeOwners, pluginId, routeId),
      onRouteRevoked: (pluginId, routeId) => forgetRouteOwner(routeOwners, pluginId, routeId),
    })],
    lifecycleCleanupTimeoutMs: options.lifecycleCleanupTimeoutMs,
  });

  let removeRemoteRuntimeSubscription: (() => void) | undefined;
  const attachRemoteRuntime = (nextRuntime: RuntimeHandle): void => {
    removeRemoteRuntimeSubscription?.();
    removeRemoteRuntimeSubscription = undefined;
    remoteRuntime = nextRuntime;
    coreHost?.attachRemote(bridgeForRuntimeHandle(nextRuntime));
    removeRemoteRuntimeSubscription = nextRuntime.subscribe(() => {
      // A disconnect clears the remote directory. Refresh first so the Host
      // stops remote consumers, then reconcile so they restart only after a
      // fresh complete directory has been accepted.
      coreHost?.refreshRuntimeUnitSnapshots();
      void coreHost?.reconcile().catch(() => undefined);
    });
    coreHost?.refreshRuntimeUnitSnapshots();
    void coreHost?.reconcile().catch(() => undefined);
  };
  if (remoteRuntime) attachRemoteRuntime(remoteRuntime);

  function orderedManifests(plugins: readonly PluginManifest[]): PluginManifest[] {
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const providers = new Map<string, string>();
    for (const plugin of plugins) {
      for (const capability of providesOfManifest(plugin, hostRuntime)) {
        if (!providers.has(capabilityKey(capability))) providers.set(capabilityKey(capability), plugin.id);
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: PluginManifest[] = [];
    const visit = (plugin: PluginManifest): void => {
      if (visited.has(plugin.id)) return;
      if (visiting.has(plugin.id)) return;
      visiting.add(plugin.id);
      for (const dependency of dependenciesOfManifest(plugin, hostRuntime)) {
        if (dependency.optional) continue;
        const providerId = providers.get(capabilityKey(dependency.capability));
        const provider = providerId ? byId.get(providerId) : undefined;
        if (provider) visit(provider);
      }
      visiting.delete(plugin.id);
      visited.add(plugin.id);
      result.push(plugin);
    };
    for (const plugin of plugins) visit(plugin);
    return result;
  }

  function legacyState(pluginId: string): ReturnType<LegacyPluginHost["state"]> {
    const manifest = manifests.get(pluginId);
    if (!manifest) return { id: pluginId, kind: "registered" };
    const current = coreHost!.state(pluginId);
    const declaredUnits = manifest.units ?? [];
    if (declaredUnits.length === 0) return current as ReturnType<LegacyPluginHost["state"]>;
    const selected = currentUnit(manifest, hostRuntime);
    const snapshots = remoteRuntime
      ? remoteRuntime.state().units.map((unit) => ({
          productId: unit.pluginId,
          unitId: unit.unitId,
          runtime: unit.runtime,
          instanceId: unit.instanceId,
          state: unit.state === "enabled"
            ? "ready" as const
            : unit.state === "starting"
              ? "starting" as const
              : "failed" as const,
          error: unit.state === "error-disabled" ? "远程运行单元失败" : undefined,
        }))
      : (options.runtimeUnitSnapshots?.() ?? []);
    const units = declaredUnits.map((declared) => {
      const isSelected = selected?.id === declared.id;
      const remote = isSelected || declared.runtime === hostRuntime
        ? undefined
        : snapshots.find((snapshot) => snapshot.productId === manifest.id && snapshot.unitId === declared.id);
      const remoteKind = remote
        ? remote.state === "ready" ? "enabled" : remote.state === "starting" ? "starting" : "error-disabled"
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
    const startup = manifest.startup;
    const defaultEnabled = manifest.defaultEnabled;
    const canDisable = manifest.canDisable;
    const units = manifest.units?.map((unit) => ({
      id: unit.id,
      runtime: unit.runtime,
      dependencies: unit.dependencies,
      provides: unit.provides,
      permissions: unit.permissions,
      config: unit.config,
      contribution: unit.business,
    }));
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      ...(units ? { units } : {}),
      startup,
      defaultEnabled,
      canDisable,
    };
  }

  function updateManifestMap(plugins: readonly PluginManifest[]): void {
    for (const plugin of plugins) manifests.set(plugin.id, plugin);
  }

  const safePath = options.safePath ?? "/settings/plugins";

  function matchRoutePath(pattern: string, path: string): boolean {
    if (!pattern.includes(":")) return pattern === path;
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) return false;
    for (let index = 0; index < patternParts.length; index += 1) {
      const patternPart = patternParts[index];
      if (patternPart && patternPart.startsWith(":")) continue;
      if (patternPart !== pathParts[index]) return false;
    }
    return true;
  }

  function pluginOwnsCurrentRoute(pluginId: string): boolean {
    if (typeof window === "undefined") return false;
    const path = window.location.pathname;
    for (const routeId of routeOwners.get(pluginId) ?? []) {
      const route = domain.routes.byId(routeId);
      if (route && matchRoutePath(route.path, path)) return true;
    }
    for (const routeId of settingsRouteOwners.get(pluginId) ?? []) {
      const route = domain.settings.byId(routeId);
      if (route && matchRoutePath(route.path, path)) return true;
    }
    return false;
  }

  function safeNavigateAway(pluginId: string): void {
    if (!pluginOwnsCurrentRoute(pluginId) || typeof window === "undefined") return;
    if (window.location.pathname === safePath) return;
    window.history.pushState({}, "", safePath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  /** 先处理反向依赖者，确保级联禁用时当前页面也能离开。 */
  function safeNavigateAwayBeforeDisable(pluginId: string): void {
    const visited = new Set<string>();
    const visit = (currentPluginId: string): void => {
      if (visited.has(currentPluginId)) return;
      visited.add(currentPluginId);
      for (const dependent of coreHost?.reverseDeps(currentPluginId) ?? []) {
        if (dependent.enabled) visit(dependent.pluginId);
      }
      safeNavigateAway(currentPluginId);
    };
    visit(pluginId);
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
    routes: domain.routes,
    breadcrumbs: domain.breadcrumbs,
    settings: domain.settings,
    systemSettings: domain.systemSettings,
    systemStatus: domain.systemStatus,
    vaultSettings: domain.vaultSettings,
    applicationSettings: domain.applicationSettings,
    home: domain.home,
    business: domain.business,
    commands: domain.commands,
    importers: domain.importers,
    transfers: domain.transfers,
    contactPublicKeyActions: domain.contactPublicKeyActions,
    assets: domain.assets,
    tokens: domain.tokens,
    collectibles: domain.collectibles,
    collectibleTransfer: domain.collectibleTransfer,
    protectedOutpoints: domain.protectedOutpoints,
    topbar: domain.topbar,
    notice: domain.notice,
    i18n,
    configStore,
    pluginIntent: options.pluginIntentCoordinator,
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
      if (key.id === KEYSPACE_SERVICE_CAPABILITY.id) bindHostKeyspace(value);
    },
    async register(plugin) {
      validateKeymasterManifest(plugin, options.runtime, manifests.values());
      updateManifestMap([plugin]);
      configStore.setRequiredPluginIds(
        [...manifests.values()].filter((item) => startupPolicy(item).startup === "required").map((item) => item.id),
      );
      try {
        const existing = coreHost!.getManifest(plugin.id);
        if (existing) {
          const state = coreHost!.state(plugin.id);
          const intent = options.pluginIntentCoordinator?.snapshot().desiredEnabled[plugin.id]
            ?? configStore.read()[plugin.id]
            ?? startupPolicy(plugin).defaultEnabled;
          const policy = startupPolicy(plugin);
          const desired = policy.startup === "required" || policy.canDisable === false || intent;
          // 这里的 desired 已经是 Coordinator 的当前真值；重新注册只是
          // 补做本地实例装配，不应再次提交“启用”命令。否则两个异步
          // 装配入口可能用同一个旧 revision 提交，后一个会被正确拒绝。
          if (desired && (state.kind === "error-disabled" || state.kind === "blocked" || state.kind === "disabled")) {
            await coreHost!.retry(plugin.id);
          }
          return;
        }
        await coreHost!.register(convertManifest(plugin));
        const state = coreHost!.state(plugin.id);
        if (state.kind === "error-disabled") {
          return;
        }
      } catch (error) {
        // 旧 API 对 optional 插件保留“状态可查询、register 不抛出”的启动
        // 语义；required 插件仍把 StartupPluginError 交给 bootstrap。
        if (error instanceof Error && error.name === "StartupPluginError"
          && startupPolicy(plugin).startup !== "required" && startupPolicy(plugin).canDisable !== false) return;
        throw error;
      }
    },
    async registerAll(plugins) {
      for (const plugin of plugins) validateKeymasterManifest(plugin, options.runtime, plugins);
      updateManifestMap(plugins);
      configStore.setRequiredPluginIds(
        [...manifests.values()].filter((item) => startupPolicy(item).startup === "required").map((item) => item.id),
      );
      for (const plugin of orderedManifests(plugins)) await legacyHost.register(plugin);
    },
    enable: async (pluginId) => {
      await coreHost!.enable(pluginId);
      await coreHost!.reconcile();
    },
    retry: async (pluginId) => {
      try {
        await coreHost!.retry(pluginId);
      } catch (error) {
        throw error;
      }
    },
    submitIntent: async (pluginId, enabled) => {
      const result = await coreHost!.submitIntent(pluginId, enabled);
      // accepted 只代表意图已由 Coordinator 持久化；本地 setup 失败必须
      // 进入 state(error-disabled)，不能让 submitIntent 反向抛出启动错误。
      await coreHost!.reconcile().catch(() => undefined);
      return result;
    },
    disable: async (pluginId) => {
      safeNavigateAwayBeforeDisable(pluginId);
      const result = await coreHost!.disable(pluginId);
      await coreHost!.reconcile();
      if (result.ok) return result;
      return {
        ok: false as const,
        reason: result.reason === `Plugin "${pluginId}" cannot be disabled`
          ? "Plugin is marked canDisable=false"
          : result.reason,
      };
    },
    unregister: async (pluginId) => {
      try {
        await coreHost!.unregister(pluginId);
      } catch (error) {
        if (error instanceof Error && error.message === `Plugin "${pluginId}" cannot be unregistered`) {
          throw new Error(`Plugin "${pluginId}" is startup-required`);
        }
        throw error;
      }
      manifests.delete(pluginId);
    },
    dispose: (reason) => {
      if (legacyDisposePromise) return legacyDisposePromise;
      removeRemoteRuntimeSubscription?.();
      removeRemoteRuntimeSubscription = undefined;
      keymasterRemoteRuntimeAttachers.delete(legacyHost);
      removeHostKeyspaceListener?.();
      removeHostKeyspaceListener = undefined;
      const scopeOwners = new Map<string, string>();
      for (const [pluginId] of manifests) {
        const scope = coreHost!.scope(pluginId);
        if (scope) scopeOwners.set(scope.identity.scopeId, pluginId);
        const cleanup = coreHost!.state(pluginId).cleanup as { scopeId?: string } | undefined;
        if (cleanup?.scopeId) scopeOwners.set(cleanup.scopeId, pluginId);
      }
      legacyDisposePromise = coreHost!.dispose(reason).then((result) => projectLegacyCleanupResult(result, scopeOwners));
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
      const storageChanged = (previousIdentity?.bucketGeneration ?? "unknown")
        !== (next.bucketGeneration ?? "unknown");
      const ownerChanged = previousIdentity?.vaultStatus !== next.vaultStatus
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
          // 禁用的可选插件不能因桶切换被意外打开。
          toSuspend.push({
            pluginId,
            scopeKind: unit.scopeKind,
            shouldRestart: coreHost!.state(pluginId).desiredEnabled,
          });
        }
      }
      runtimeIdentity = { ...next };
      // WebLoom 负责当前实例的 Scope；身份边界变化时先同步撤权，再等待
      // 有界清理。desiredEnabled 保持不变，解锁/重绑后由分阶段装配重新启动。
      // 新身份如果没有就绪存储（bucketGeneration 未知，例如冷启动停在存储
      // 认证页、或切换过程中旧绑定已卸下），storage 作用域单元的 setup 会
      // 立刻因“Platform storage requires a ready root”失败并把插件打成
      // error-disabled；这不是用户意图变化。此时保持挂起，等下一个带就绪
      // 存储的身份事件再重试，避免把安全入口打成启动失败页。
      const storageReadyForIdentity = next.bucketGeneration !== undefined;
      for (const item of toSuspend) {
        await coreHost!.suspend(item.pluginId, "runtime identity changed");
        if (item.scopeKind === "storage" && item.shouldRestart && storageReadyForIdentity) {
          // retry() 只启动当前已确认启用的本地实例，不改写 Coordinator
          // 的插件意图 revision；身份重绑不是一次用户启停操作。
          await coreHost!.retry(item.pluginId);
        }
      }
      // Locked/booting/uninitialized runtimes intentionally leave owner-session
      // units blocked. A global reconcile would immediately try to start the
      // required (canDisable=false) units again and turn the expected blocked
      // state into StartupCapabilityError. The next unlocked transition will
      // reconcile them after the owner identity is available.
      if (next.vaultStatus === "unlocked") await coreHost!.reconcile();
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
  return `${identity.vaultStatus}|${identity.ownerPublicKeyHex ?? ""}|${identity.sessionEpoch}|${identity.bucketGeneration ?? "unknown"}`;
}

function validateKeymasterManifest(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
  manifestSet: Iterable<PluginManifest>,
): void {
  if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") {
    throw new Error("Plugin id must be a non-empty string");
  }
  const startup = manifest.startup;
  const defaultEnabled = manifest.defaultEnabled;
  const canDisable = manifest.canDisable;
  if ((startup !== "required" && startup !== "optional")
    || typeof defaultEnabled !== "boolean" || typeof canDisable !== "boolean") {
    throw new Error(`Plugin "${manifest.id}" startup policy must define startup, defaultEnabled and canDisable`);
  }
  const units = manifest.units ?? [];
  if (units.length > 1 && runtime === undefined) {
    throw new Error(`Plugin "${manifest.id}" execution must be explicit for multi-unit manifests`);
  }
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
  if (startup === "required") {
    if (!defaultEnabled || canDisable) {
      throw new Error(`Required plugin "${manifest.id}" has inconsistent startup metadata`);
    }
    if (providesOfManifest(manifest, runtime).length === 0) {
      throw new Error(`Required plugin "${manifest.id}" must provide capabilities`);
    }
    const all = [...manifestSet];
    for (const dependency of dependenciesOfManifest(manifest, runtime)) {
      if (dependency.optional) continue;
      const provider = all.find((candidate) => providesOfManifest(candidate, runtime).some((provided) => capabilityKey(provided) === capabilityKey(dependency.capability)));
      const providerStartup = provider?.startup;
      if (provider && providerStartup === "optional") {
        throw new Error(`Required plugin "${manifest.id}" cannot depend on optional capability provider "${provider.id}"`);
      }
    }
  }
}
