// Runtime 测试夹具：把可执行 setup 显式登记到 implementation registry。
//
// 测试仍可以把 manifest + setup 写在一起，夹具会在交给生产 Adapter 前拆开；
// Adapter 本身不会读取清单中的测试 setup，因此测试不会重新引入生产兼容回退。

import type {
  PluginHost,
  CreatePluginHostOptions,
} from "../pluginHostContract.js";
import { createKeymasterPluginHost } from "../keymasterHostAdapter.js";
import {
  APPLICATION_SETTINGS_REGISTRY_CAPABILITY,
  ASSET_DATA_NOTIFIER_CAPABILITY,
  ASSET_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  COLLECTIBLE_REGISTRY_CAPABILITY,
  COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY,
  COMMAND_REGISTRY_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  HOME_REGISTRY_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  IMPORTER_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  NOTICE_REGISTRY_TYPED_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY_TYPED,
  RESOURCE_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_STATUS_REGISTRY_CAPABILITY,
  TOKEN_REGISTRY_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY,
  TRANSFER_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  VAULT_SETTINGS_REGISTRY_CAPABILITY,
} from "@keymaster/contracts";
import { defineCapability } from "webloom-framework";
import { StartupCapabilityError } from "webloom-framework/advanced";
import type {
  PluginManifest,
  PluginSetup,
  RuntimeUnitDescriptor,
  RuntimeUnitImplementationRegistry,
} from "@keymaster/contracts";
import type {
  Capability,
  CapabilityDescriptor,
  RuntimeKind,
} from "webloom-framework";

type TestMeta = {
  readonly kind?: PluginManifest["kind"];
  readonly startup?: PluginManifest["startup"];
  readonly defaultEnabled?: boolean;
  readonly canDisable?: boolean;
  readonly bootstrapStage?: PluginManifest["bootstrapStage"];
  readonly displayGroup?: PluginManifest["displayGroup"];
  readonly providesCapabilities?: readonly (Capability | CapabilityDescriptor | string)[];
};

type TestCapabilityInput = Capability | CapabilityDescriptor | string;

type TestDependencyInput = {
  readonly capability: TestCapabilityInput;
  readonly source?: "peer";
  readonly sourceRuntime?: RuntimeKind;
  readonly optional?: boolean;
  readonly reason?: string;
  /** 旧测试元数据；转换后不会进入 WebLoom。 */
  readonly contractVersion?: string;
  readonly scopeKind?: string;
};

type TestUnit = Omit<RuntimeUnitDescriptor, "dependencies" | "provides"> & {
  readonly dependencies?: readonly TestDependencyInput[];
  readonly provides?: readonly TestCapabilityInput[];
};

/**
 * 测试源码中的便捷输入形状。
 *
 * 这是唯一的 test-only 物化边界：旧测试可以保留紧凑的 fixture 元数据，
 * 但交给生产 Adapter 前一定会变成 v4 manifest（descriptor + unit），并
 * 丢弃 `meta`/`setup`。生产 API 没有这些字段或兼容方法。
 */
export type TestPluginManifest = Omit<Partial<PluginManifest>, "units"> & {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly meta?: TestMeta;
  readonly dependencies?: readonly TestDependencyInput[];
  readonly provides?: readonly TestCapabilityInput[];
  readonly permissions?: readonly import("@keymaster/contracts").PluginPermission[];
  readonly business?: unknown;
  readonly units?: readonly TestUnit[];
  setup?: PluginSetup;
};

const builtinCapabilities: readonly Capability[] = [
  APPLICATION_SETTINGS_REGISTRY_CAPABILITY,
  ASSET_DATA_NOTIFIER_CAPABILITY,
  ASSET_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  COLLECTIBLE_REGISTRY_CAPABILITY,
  COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY,
  COMMAND_REGISTRY_CAPABILITY,
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  HOME_REGISTRY_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  IMPORTER_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  NOTICE_REGISTRY_TYPED_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY_TYPED,
  RESOURCE_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_SETTINGS_REGISTRY_CAPABILITY,
  SYSTEM_STATUS_REGISTRY_CAPABILITY,
  TOKEN_REGISTRY_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY,
  TRANSFER_REGISTRY_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  VAULT_SETTINGS_REGISTRY_CAPABILITY,
];

const capabilityByKey = new Map<string, Capability>(
  builtinCapabilities.map((capability) => [`${capability.kind}:${capability.id}@${capability.version}`, capability]),
);

function capabilityKey(value: { readonly kind: string; readonly id: string; readonly version: string }): string {
  return `${value.kind}:${value.id}@${value.version}`;
}

function asCapability(value: TestCapabilityInput): Capability {
  if (typeof value !== "string" && "request" in value && "response" in value) return value;
  if (typeof value !== "string" && "item" in value && "request" in value) return value;
  const descriptor = typeof value === "string"
    ? { kind: "local" as const, id: value, version: "1" }
    : { kind: value.kind, id: value.id, version: value.version };
  const key = capabilityKey(descriptor);
  const known = capabilityByKey.get(key);
  if (known) return known;
  const existing = capabilityByKey.get(key);
  if (existing) return existing;
  const created = defineCapability({ kind: "local", id: descriptor.id, version: descriptor.version });
  capabilityByKey.set(key, created);
  return created;
}

function asDescriptor(value: TestCapabilityInput): CapabilityDescriptor {
  const capability = asCapability(value);
  return Object.freeze({ kind: capability.kind, id: capability.id, version: capability.version });
}

function normalizeDependency(value: TestDependencyInput, runtime: RuntimeKind): NonNullable<RuntimeUnitDescriptor["dependencies"]>[number] {
  const capability = asDescriptor(value.capability);
  return Object.freeze({
    capability,
    ...(value.source === "peer" ? { source: "peer" as const } : { sourceRuntime: value.sourceRuntime ?? runtime }),
    ...(value.optional !== undefined ? { optional: value.optional } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  });
}

function normalizeUnit(
  plugin: TestPluginManifest,
  input: TestUnit,
  runtime: RuntimeKind,
  fallbackDependencies: readonly TestDependencyInput[],
  fallbackProvides: readonly TestCapabilityInput[],
): RuntimeUnitDescriptor {
  const dependencies = [...(input.dependencies ?? fallbackDependencies)].map((item) => normalizeDependency(item, runtime));
  const provides = [...(input.provides ?? fallbackProvides)].map(asDescriptor);
  const scopeKind = input.scopeKind ?? "root";
  return {
    ...input,
    id: input.id,
    runtime: input.runtime ?? runtime,
    scopeKind,
    ...(input.permissions !== undefined
      ? { permissions: input.permissions }
      : plugin.permissions !== undefined ? { permissions: plugin.permissions } : {}),
    ...(input.storage !== undefined
      ? { storage: input.storage }
      : plugin.storage !== undefined ? { storage: plugin.storage } : {}),
    ...(input.config !== undefined
      ? { config: input.config }
      : plugin.config !== undefined ? { config: plugin.config } : {}),
    ...(input.business !== undefined
      ? { business: input.business }
      : plugin.business !== undefined ? { business: plugin.business } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(provides.length > 0 ? { provides } : {}),
  } as RuntimeUnitDescriptor;
}

function normalizeManifest(plugin: TestPluginManifest, runtime: RuntimeKind): PluginManifest {
  const meta = plugin.meta;
  const fallbackDependencies = plugin.dependencies ?? [];
  // Legacy fixtures often repeat the same declaration in both `provides` and
  // `meta.providesCapabilities`.  The production manifest has one canonical
  // unit declaration, so collapse that test-only overlap before validation.
  const fallbackProvidesByKey = new Map<string, TestCapabilityInput>();
  // `meta.providesCapabilities` is the old canonical declaration when it is
  // present; otherwise keep the compact top-level fixture form.  This also
  // lets tests exercise an invalid empty metadata declaration even when an
  // older fixture still carries a stale top-level `provides` field.
  const declaredProvides = meta && Object.prototype.hasOwnProperty.call(meta, "providesCapabilities")
    ? (meta.providesCapabilities ?? [])
    : (plugin.provides ?? []);
  for (const value of declaredProvides) fallbackProvidesByKey.set(capabilityKey(asDescriptor(value)), value);
  const fallbackProvides = [...fallbackProvidesByKey.values()];
  const sourceUnits = plugin.units && plugin.units.length > 0
    ? plugin.units
    : [{ id: plugin.id, runtime, scopeKind: "root" as const } satisfies TestUnit];
  const units = sourceUnits.map((unit) => normalizeUnit(plugin, unit, unit.runtime ?? runtime, fallbackDependencies, fallbackProvides));
  const declared = new Map<string, Capability>();
  for (const unit of units) {
    for (const item of [...(unit.provides ?? []), ...(unit.dependencies ?? []).map((dependency) => dependency.capability)]) {
      const key = capabilityKey(item);
      declared.set(key, asCapability(item));
    }
  }
  // Built-in local capabilities are optional declarations for old test setups
  // that obtain registries through ctx.capability(). They do not enter the
  // required graph and are already provided by the Adapter's Host.
  const normalizedUnits = units.map((unit) => ({
    ...unit,
    dependencies: Object.freeze([
      ...(unit.dependencies ?? []),
      ...builtinCapabilities
        .filter((capability) => !declared.has(capabilityKey(capability)))
        .map((capability) => ({ capability: asDescriptor(capability), sourceRuntime: unit.runtime ?? runtime, optional: true as const }))
        .filter((candidate) => !(unit.dependencies ?? []).some((dependency) => capabilityKey(dependency.capability) === capabilityKey(candidate.capability))),
    ]),
  }));
  return {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    kind: plugin.kind ?? meta?.kind ?? "business",
    startup: plugin.startup ?? meta?.startup ?? "optional",
    defaultEnabled: plugin.defaultEnabled ?? meta?.defaultEnabled ?? true,
    canDisable: plugin.canDisable ?? meta?.canDisable ?? true,
    bootstrapStage: plugin.bootstrapStage ?? meta?.bootstrapStage ?? "owner-apps-ready",
    displayGroup: plugin.displayGroup ?? meta?.displayGroup ?? "business",
    ...(plugin.storage !== undefined ? { storage: plugin.storage } : {}),
    ...(plugin.config !== undefined ? { config: plugin.config } : {}),
    ...(plugin.i18n !== undefined ? { i18n: plugin.i18n } : {}),
    units: Object.freeze(normalizedUnits),
  };
}

export type TestPluginHost = Omit<PluginHost, "register" | "registerAll"> & {
  register(plugin: TestPluginManifest): Promise<void>;
  registerAll(plugins: readonly TestPluginManifest[]): Promise<void>;
  validateManifestSet(plugins: readonly TestPluginManifest[]): void;
};

/** 创建带显式测试实现注册表的 Keymaster Host。 */
export function createTestPluginHost(
  options: CreatePluginHostOptions = {},
): TestPluginHost {
  const setups = new Map<string, PluginSetup>();
  const suppliedRegistry = options.runtimeUnitImplementationRegistry;
  const runtimeUnitImplementationRegistry: RuntimeUnitImplementationRegistry = {
    get(pluginId, unitId) {
      return (suppliedRegistry?.get(pluginId, unitId) as PluginSetup | undefined)
        ?? setups.get(`${pluginId}:${unitId}`)
        ?? setups.get(pluginId);
    },
  };
  const host = createKeymasterPluginHost({
    ...options,
    runtimeUnitImplementationRegistry,
  });

  const stripAndRemember = (plugin: TestPluginManifest): PluginManifest => {
    const runtime = options.runtime ?? "window-main";
    const normalized = normalizeManifest(plugin, runtime);
    if (plugin.setup) {
      for (const unit of normalized.units ?? []) setups.set(`${plugin.id}:${unit.id}`, plugin.setup);
    }
    return normalized;
  };

  return {
    ...host,
    register: (plugin) => host.register(stripAndRemember(plugin)),
    registerAll: (plugins) => host.registerAll(plugins.map(stripAndRemember)),
    validateManifestSet: (plugins) => host.validateManifestSet(plugins.map(stripAndRemember)),
    assertCapabilities(required, extra) {
      try {
        host.assertCapabilities(required, extra);
      } catch (error) {
        // The Keymaster compatibility tests historically displayed capability
        // ids as strings; production Keymaster keeps the typed descriptors.
        if (error instanceof StartupCapabilityError) {
          throw new StartupCapabilityError(error.details.map((detail) => ({
            ...detail,
            capability: detail.capability.id,
          } as never)), extra?.phase);
        }
        throw error;
      }
    },
  };
}
