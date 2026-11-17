import type { PluginStorageDeclaration } from "./access.js";

/**
 * 中央系统存储 V1 的声明目录。
 *
 * 声明只描述稳定的 module/purpose 坐标；当前钱包身份世代、会话 epoch 和
 * Worker 运行世代由 Host/Coordinator 在打开句柄时预绑定。任何业务代码都不应
 * 复制这些坐标再拼物理路径。
 */
export const CENTRAL_STORAGE_DECLARATIONS = Object.freeze({
  protocolFiles: Object.freeze({ moduleId: "protocol", purposeId: "", authority: "built-in-module", model: "files", schemaVersion: 1 } satisfies PluginStorageDeclaration),
  aiState: Object.freeze({
    moduleId: "ai", purposeId: "", authority: "built-in-module", model: "files", schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  vaultPayments: Object.freeze({
    moduleId: "vault", purposeId: "payments", authority: "built-in-module", model: "files", schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  coordinatorSettings: Object.freeze({
    moduleId: "background",
    purposeId: "settings",
    authority: "built-in-module",
    model: "snapshot",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  appsDirectory: Object.freeze({
    moduleId: "apps", purposeId: "", authority: "built-in-module", model: "files", schemaVersion: 2,
  } satisfies PluginStorageDeclaration),
  /**
   * P2PKH 文件根（空 purpose = 模块根）。
   * 布局（已绑定网络身份根）：`p2pkh/setting.json`、`p2pkh/history.json`。
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
  /**
   * MSFile 设置与供应商：`msfile/setting.json`，整文件替换。
   */
  msfilesFiles: Object.freeze({
    moduleId: "msfile",
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
    moduleId: "msfile",
    purposeId: "bitfs-journal",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
  /**
   * 三方 App 的 Keymaster 管理设置：`msfile/app-settings/`。
   *
   * 这是平台管理记录，不在 `apps/<app-name>/` 内：App 不能通过自己的文件权限
   * 修改自己的授权、额度或其它 App 的记录。同一发布者的不同 appId 共享这一份
   * 发布者级设置，不按 App 目录复制成互相冲突的多份真值。
   */
  appSettingsFiles: Object.freeze({
    moduleId: "msfile",
    purposeId: "app-settings",
    authority: "built-in-module",
    model: "files",
    schemaVersion: 1,
  } satisfies PluginStorageDeclaration),
});

/** manifest pluginId 到中央声明的绑定目录。 */
export const SYSTEM_STORAGE_DECLARATIONS: Readonly<Record<string, readonly PluginStorageDeclaration[]>> = Object.freeze({
  apps: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.appsDirectory]),
  ai: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.aiState]),
  vault: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.vaultPayments]),
  p2pkh: Object.freeze([CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles]),
  protocol: Object.freeze([
    CENTRAL_STORAGE_DECLARATIONS.protocolFiles,
  ]),
  "sat-subscription": Object.freeze([CENTRAL_STORAGE_DECLARATIONS.satSubscriptionFiles]),
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
  if (declaration.moduleId !== pluginId) throw new Error("Storage module must match its plugin");
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
