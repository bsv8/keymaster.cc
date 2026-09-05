import type { PluginStorageDeclaration } from "./access.js";

/**
 * 内置插件的唯一存储声明表。
 *
 * Host、Coordinator Worker 和 manifest 校验必须共享这张表；任何一处按
 * 目录名或 applicationStorageId 猜测权限，都会导致插件身份与数据目录
 * 脱钩。第三方插件不在此表中，必须通过 Host 的显式授权流程获得声明。
 */
export const SYSTEM_STORAGE_DECLARATIONS: Readonly<Record<string, PluginStorageDeclaration>> = Object.freeze({
  background: Object.freeze({ scope: "key", applicationStorageId: "Background", schemaVersion: 1 }),
  "bsv-price": Object.freeze({ scope: "key", applicationStorageId: "BsvPrice", schemaVersion: 1 }),
  "collectible-1satordinals": Object.freeze({ scope: "key", applicationStorageId: "1SatOrdinals", schemaVersion: 1 }),
  contacts: Object.freeze({ scope: "key", applicationStorageId: "Contacts", schemaVersion: 1 }),
  message: Object.freeze({ scope: "key", applicationStorageId: "Messages", schemaVersion: 1 }),
  p2pkh: Object.freeze({ scope: "key", applicationStorageId: "UTXOS", schemaVersion: 1 }),
  poker: Object.freeze({ scope: "key", applicationStorageId: "Poker", schemaVersion: 1 }),
  protocol: Object.freeze({ scope: "platform", applicationStorageId: "protocol", schemaVersion: 1 }),
  "sat-subscription": Object.freeze({ scope: "key", applicationStorageId: "SatSubscription", schemaVersion: 1 }),
  "token-bsv21": Object.freeze({ scope: "key", applicationStorageId: "BSV21", schemaVersion: 1 }),
  "token-stas": Object.freeze({ scope: "key", applicationStorageId: "STAS", schemaVersion: 1 }),
  webrtc: Object.freeze({ scope: "key", applicationStorageId: "WebRTC", schemaVersion: 1 }),
  woc: Object.freeze({ scope: "key", applicationStorageId: "WOC", schemaVersion: 1 }),
  msfile: Object.freeze({ scope: "key", applicationStorageId: "MSFile", schemaVersion: 1 })
});

export function systemStorageDeclarationFor(pluginId: string): PluginStorageDeclaration | undefined {
  const declaration = SYSTEM_STORAGE_DECLARATIONS[pluginId];
  return declaration ? { ...declaration } : undefined;
}

export function assertSystemStorageDeclaration(pluginId: string, declaration: PluginStorageDeclaration): void {
  const expected = SYSTEM_STORAGE_DECLARATIONS[pluginId];
  if (!expected) return;
  if (
    declaration.scope !== expected.scope ||
    declaration.applicationStorageId !== expected.applicationStorageId ||
    declaration.schemaVersion !== expected.schemaVersion
  ) {
    throw new Error(`Built-in plugin "${pluginId}" has an unauthorized storage declaration`);
  }
}
