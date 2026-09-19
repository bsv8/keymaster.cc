import type { PluginStorageDeclaration } from "./access.js";

/**
 * 中央系统存储 V1 的声明目录。
 *
 * 声明只描述稳定的 module/purpose 坐标；bucket、owner 和当前运行世代
 * 由 Host/Coordinator 在打开句柄时预绑定。任何业务代码都不应复制这些
 * 坐标再拼物理路径。
 */
export const CENTRAL_STORAGE_DECLARATIONS = Object.freeze({
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
    // 一联系人一文件（KeymasterFormats《联系人文件》），使用扁平 owner 文件根。
    model: "files",
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
  /**
   * P2PKH 桶内文件根（空 purpose = 模块根，见 KeymasterFormats《P2PKH》）。
   * 布局：`p2pkh/setting.json`、`p2pkh/<net>/tx|height/…`。
   */
  p2pkhFiles: Object.freeze({
    moduleId: "p2pkh",
    purposeId: "",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
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
  /**
   * SatSubscription owner 文件根（空 purpose = `sat-subscription/`）。
   * 只允许其中的 `setting.json` 保存本地供应商设置；订阅/账单由 SS server 提供。
   */
  satSubscriptionFiles: Object.freeze({
    moduleId: "sat-subscription",
    purposeId: "",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
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
  /**
   * P2P（WebRTC）设置文件根（空 purpose = 模块根，见 KeymasterFormats
   * 《桶/<owner>/p2p/setting.json》）。布局：`p2p/setting.json`。
   */
  p2pFiles: Object.freeze({
    moduleId: "p2p",
    purposeId: "",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
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
  /**
   * 私密消息的原始证据根：`<owner>/messages/<对端公钥>/{sent,received,timeindex}/…`。
   * 只存 raw 与本地时间索引，不存解析投影；见 KeymasterFormats 的 messages 规范。
   */
  messagesFiles: Object.freeze({
    moduleId: "messages",
    purposeId: "",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * MSFile 设置与供应商（KeymasterFormats《msfiles/setting.json》）：
   * `<owner>/msfiles/setting.json`，每个 owner 一份，整文件替换。
   */
  msfilesFiles: Object.freeze({
    moduleId: "msfiles",
    purposeId: "",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * 三方 App 设置（KeymasterFormats《app.publickeyhex/settings.json》）：
   * `<owner>/app.<publisher 公钥>/settings.json`。绑定必须携带 publisher，
   * 因此不通过 filesFor(purposeId) 暴露给普通插件 setup。
   */
  appSettingsFiles: Object.freeze({
    moduleId: "app",
    purposeId: "app-settings",
    scope: "owner",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
});

/** manifest pluginId 到中央 owner/bucket 声明的绑定目录。 */
export const SYSTEM_STORAGE_DECLARATIONS: Readonly<Record<string, readonly PluginStorageDeclaration[]>> = Object.freeze({
  "bsv-price": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.bsvPrice]),
  "collectible-1satordinals": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.ordinalsMintHistory]),
  contacts: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook]),
  message: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.messageHistory, CENTRAL_STORAGE_DECLARATIONS.messagesFiles]),
  p2pkh: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles, CENTRAL_STORAGE_DECLARATIONS.p2pkhState]),
  poker: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.pokerSettings, CENTRAL_STORAGE_DECLARATIONS.pokerSessionHistory]),
  protocol: Object.freeze([
    CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
    CENTRAL_STORAGE_DECLARATIONS.protocolSessions,
    CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory,
  ]),
  "sat-subscription": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.satSubscriptionFiles]),
  "token-bsv21": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.tokenBsv21State, CENTRAL_STORAGE_DECLARATIONS.tokenBsv21MintHistory]),
  "token-stas": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.tokenStasState]),
  webrtc: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.p2pFiles, CENTRAL_STORAGE_DECLARATIONS.webrtcHistory]),
  msfile: Object.freeze([
    CENTRAL_STORAGE_DECLARATIONS.msfilesFiles,
    CENTRAL_STORAGE_DECLARATIONS.appSettingsFiles,
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
