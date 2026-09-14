import type { PluginStorageDeclaration } from "./access.js";

/**
 * 中央系统存储 V1 的声明目录。
 *
 * 声明只描述稳定的 module/purpose 坐标；bucket、owner 和当前运行世代
 * 由 Host/Coordinator 在打开句柄时预绑定。任何业务代码都不应复制这些
 * 坐标再拼物理路径。
 */
export const CENTRAL_STORAGE_DECLARATIONS = Object.freeze({
  coordinatorSelection: Object.freeze({
    moduleId: "coordinator",
    purposeId: "selection",
    scope: "bucket",
    authority: "platform-only",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  coordinatorSettings: Object.freeze({
    moduleId: "coordinator",
    purposeId: "settings",
    scope: "bucket",
    authority: "platform-only",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  coordinatorPluginIntent: Object.freeze({
    moduleId: "coordinator",
    purposeId: "plugin-intent",
    scope: "bucket",
    authority: "platform-only",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  storageProfileSalt: Object.freeze({
    moduleId: "storage",
    purposeId: "profile-salt",
    scope: "bucket",
    authority: "platform-only",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  vaultAuthMetadata: Object.freeze({
    moduleId: "vault",
    purposeId: "auth-metadata",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  vaultKeyIndex: Object.freeze({
    moduleId: "vault",
    purposeId: "key-index",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  vaultKeyLifecycleJournals: Object.freeze({
    moduleId: "vault",
    purposeId: "key-lifecycle-journals",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolDurablePolicy: Object.freeze({
    moduleId: "protocol",
    purposeId: "durable-policy",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolSessions: Object.freeze({
    moduleId: "protocol",
    purposeId: "sessions",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolCommandHistory: Object.freeze({
    moduleId: "protocol",
    purposeId: "command-history",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  storageMultipartUploads: Object.freeze({
    moduleId: "storage",
    purposeId: "multipart-uploads",
    scope: "bucket",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  bsvPrice: Object.freeze({
    moduleId: "bsv-price",
    purposeId: "settings",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  ordinalsMintHistory: Object.freeze({
    moduleId: "collectible-1satordinals",
    purposeId: "mint-history",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  contactsAddressBook: Object.freeze({
    moduleId: "contacts",
    purposeId: "address-book",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  messageHistory: Object.freeze({
    moduleId: "message",
    purposeId: "history",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  p2pkhState: Object.freeze({
    moduleId: "p2pkh",
    purposeId: "state",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  pokerSettings: Object.freeze({
    moduleId: "poker",
    purposeId: "settings",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  pokerSessionHistory: Object.freeze({
    moduleId: "poker",
    purposeId: "session-history",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  satSubscriptionState: Object.freeze({
    moduleId: "sat-subscription",
    purposeId: "subscription-state",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenBsv21State: Object.freeze({
    moduleId: "token-bsv21",
    purposeId: "token-state",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenBsv21MintHistory: Object.freeze({
    moduleId: "token-bsv21",
    purposeId: "mint-history",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenStasState: Object.freeze({
    moduleId: "token-stas",
    purposeId: "token-state",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  webrtcSettings: Object.freeze({
    moduleId: "webrtc",
    purposeId: "settings",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  webrtcHistory: Object.freeze({
    moduleId: "webrtc",
    purposeId: "history",
    scope: "owner",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  msfileSettings: Object.freeze({
    moduleId: "msfile",
    purposeId: "settings",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  msfileSuppliers: Object.freeze({
    moduleId: "msfile",
    purposeId: "suppliers",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  msfileAppPolicies: Object.freeze({
    moduleId: "msfile",
    purposeId: "app-policies",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  msfileAppUsage: Object.freeze({
    moduleId: "msfile",
    purposeId: "app-usage",
    scope: "bucket",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
});

/** manifest pluginId 到中央 owner/bucket 声明的绑定目录。 */
export const SYSTEM_STORAGE_DECLARATIONS: Readonly<Record<string, readonly PluginStorageDeclaration[]>> = Object.freeze({
  "bsv-price": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.bsvPrice]),
  "collectible-1satordinals": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.ordinalsMintHistory]),
  contacts: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook]),
  message: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.messageHistory]),
  p2pkh: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.p2pkhState]),
  poker: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.pokerSettings, CENTRAL_STORAGE_DECLARATIONS.pokerSessionHistory]),
  protocol: Object.freeze([
    CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
    CENTRAL_STORAGE_DECLARATIONS.protocolSessions,
    CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory,
  ]),
  "sat-subscription": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.satSubscriptionState]),
  "token-bsv21": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.tokenBsv21State, CENTRAL_STORAGE_DECLARATIONS.tokenBsv21MintHistory]),
  "token-stas": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.tokenStasState]),
  webrtc: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.webrtcSettings, CENTRAL_STORAGE_DECLARATIONS.webrtcHistory]),
  msfile: Object.freeze([
    CENTRAL_STORAGE_DECLARATIONS.msfileSettings,
    CENTRAL_STORAGE_DECLARATIONS.msfileSuppliers,
    CENTRAL_STORAGE_DECLARATIONS.msfileAppPolicies,
    CENTRAL_STORAGE_DECLARATIONS.msfileAppUsage,
  ]),
});

export const BUILTIN_STORAGE_DECLARATIONS = SYSTEM_STORAGE_DECLARATIONS;

export function systemStorageDeclarationFor(pluginId: string): PluginStorageDeclaration | undefined {
  const declarations = SYSTEM_STORAGE_DECLARATIONS[pluginId] ?? [];
  // Never collapse a multi-purpose module to an arbitrary first member.
  // Callers opening such a module must use the named purpose resolver below.
  if (declarations.length !== 1) return undefined;
  return declarations[0] ? { ...declarations[0] } : undefined;
}

/** Resolve one named declaration without collapsing a multi-purpose module. */
export function systemStorageDeclarationForPurpose(pluginId: string, purposeId: string): PluginStorageDeclaration | undefined {
  const declaration = SYSTEM_STORAGE_DECLARATIONS[pluginId]?.find((candidate) => candidate.purposeId === purposeId);
  return declaration ? { ...declaration } : undefined;
}

export function assertSystemStorageDeclaration(pluginId: string, declaration: PluginStorageDeclaration): void {
  const expected = SYSTEM_STORAGE_DECLARATIONS[pluginId];
  // Third-party owner namespaces are authorized by verified app identity, not
  // by this built-in module table. Every platform/built-in declaration must
  // nevertheless have an exact central registration; an unknown pluginId may
  // not self-assign built-in authority by simply bypassing the lookup.
  if (declaration.authority === "third-party-app") return;
  if (!expected || !expected.some((candidate) =>
    declaration.moduleId === candidate.moduleId
    && declaration.purposeId === candidate.purposeId
    && declaration.scope === candidate.scope
    && declaration.authority === candidate.authority
    && declaration.model === candidate.model
    && declaration.schemaVersion === candidate.schemaVersion
  )) {
    throw new Error(`Built-in plugin "${pluginId}" has an unauthorized storage declaration`);
  }
}
