import type { PluginStorageDeclaration } from "./access.js";

/**
 * 中央系统存储 V1 的声明目录。
 *
 * 声明只描述稳定的 module/purpose 坐标；当前钱包身份世代、会话 epoch 和
 * Worker 运行世代由 Host/Coordinator 在打开句柄时预绑定。任何业务代码都不应
 * 复制这些坐标再拼物理路径。
 */
export const CENTRAL_STORAGE_DECLARATIONS = Object.freeze({
  coordinatorSettings: Object.freeze({
    moduleId: "coordinator",
    purposeId: "settings",
    authority: "platform-only",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolDurablePolicy: Object.freeze({
    moduleId: "protocol",
    purposeId: "durable-policy",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolSessions: Object.freeze({
    moduleId: "protocol",
    purposeId: "sessions",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  protocolCommandHistory: Object.freeze({
    moduleId: "protocol",
    purposeId: "command-history",
    authority: "platform-only",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  bsvPrice: Object.freeze({
    moduleId: "bsv-price",
    purposeId: "settings",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  ordinalsMintHistory: Object.freeze({
    moduleId: "collectible-1satordinals",
    purposeId: "mint-history",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  contactsAddressBook: Object.freeze({
    moduleId: "contacts",
    purposeId: "address-book",
    authority: "built-in-module",
    // 一联系人一文件，文件名使用稳定业务 ID，不依赖可修改的姓名或列表顺序。
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  messageHistory: Object.freeze({
    moduleId: "message",
    purposeId: "history",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  p2pkhState: Object.freeze({
    moduleId: "p2pkh",
    purposeId: "state",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * P2PKH 文件根（空 purpose = 模块根）。
   * 布局：`p2pkh/setting.json`、`p2pkh/<net>/tx|height/…`。
   */
  p2pkhFiles: Object.freeze({
    moduleId: "p2pkh",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * SatSubscription 文件根（空 purpose = `sat-subscription/`）。
   * 只允许其中的 `setting.json` 保存本地供应商设置；订阅/账单由 SS server 提供。
   */
  satSubscriptionFiles: Object.freeze({
    moduleId: "sat-subscription",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenBsv21State: Object.freeze({
    moduleId: "token-bsv21",
    purposeId: "token-state",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenBsv21MintHistory: Object.freeze({
    moduleId: "token-bsv21",
    purposeId: "mint-history",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  tokenStasState: Object.freeze({
    moduleId: "token-stas",
    purposeId: "token-state",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * Forum 配置、根验证证据、索引缓存、阅读位置、展示投影与发布任务。
   * 文件模型；正文本体不在这里，只存已冻结内容的 seed hash。
   */
  forumFiles: Object.freeze({
    moduleId: "forum",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * P2P（WebRTC）设置文件根（空 purpose = 模块根）。布局：`p2p/setting.json`。
   */
  p2pFiles: Object.freeze({
    moduleId: "p2p",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  webrtcHistory: Object.freeze({
    moduleId: "webrtc",
    purposeId: "history",
    authority: "built-in-module",
    model: "kv",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * 私密消息的原始证据根：`messages/<对端公钥>/{sent,received,timeindex}/…`。
   * 只存 raw 与本地时间索引，不存解析投影；见 KeymasterFormats 的 messages 规范。
   */
  messagesFiles: Object.freeze({
    moduleId: "messages",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * MSFile 设置与供应商：`msfiles/setting.json`，整文件替换。
   */
  msfilesFiles: Object.freeze({
    moduleId: "msfiles",
    purposeId: "",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * BitFS 不可逆协议证据：checkpoint、exact outbox 与结果未知交易。
   * 独立 purpose 防止与内容、MSFile 设置或 App 用量混写。
   */
  bitfsJournalFiles: Object.freeze({
    moduleId: "msfiles",
    purposeId: "bitfs-journal",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * 三方 App 的 Keymaster 管理设置：`.keymaster/system/app/app-settings/`。
   *
   * 这是平台管理记录，不在 `apps/<app-name>/` 内：App 不能通过自己的文件权限
   * 修改自己的授权、额度或其它 App 的记录。同一发布者的不同 appId 共享这一份
   * 发布者级设置，不按 App 目录复制成互相冲突的多份真值。
   */
  appSettingsFiles: Object.freeze({
    moduleId: "app",
    purposeId: "app-settings",
    authority: "platform-only",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
});

/** manifest pluginId 到中央声明的绑定目录。 */
export const SYSTEM_STORAGE_DECLARATIONS: Readonly<Record<string, readonly PluginStorageDeclaration[]>> = Object.freeze({
  "bsv-price": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.bsvPrice]),
  "collectible-1satordinals": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.ordinalsMintHistory]),
  contacts: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.contactsAddressBook]),
  forum: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.forumFiles]),
  message: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.messageHistory, CENTRAL_STORAGE_DECLARATIONS.messagesFiles]),
  p2pkh: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles, CENTRAL_STORAGE_DECLARATIONS.p2pkhState]),
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
    CENTRAL_STORAGE_DECLARATIONS.bitfsJournalFiles,
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
    && declaration.authority === candidate.authority
    && declaration.model === candidate.model
    && declaration.schemaVersion === candidate.schemaVersion
  )) {
    throw new Error(`Built-in plugin "${pluginId}" has an unauthorized storage declaration`);
  }
}
