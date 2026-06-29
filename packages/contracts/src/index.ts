// packages/contracts/src/index.ts
// 统一导出所有契约类型。
// 设计缘由：每个能力域单独一个文件，便于 plugin 只 import 自己关心的部分。
// 这一层只放类型和协议，不放任何实现（实现都在 plugin-* 中）。
//
// 注意：P2PKH 专属类型已从全局 contracts 迁出到 packages/plugin-p2pkh/src/p2pkhContracts.ts。
// 资产平台协议在 assets.ts，P2PKH 只是众多 AssetProvider 之一。

export * from "./plugin.js";
export * from "./vault.js";
export * from "./keyspace.js";
export * from "./keyImport.js";
export * from "./transfer.js";
export * from "./navigation.js";
export * from "./settings.js";
export * from "./home.js";
export * from "./assets.js";
export * from "./contacts.js";
export * from "./messageBus.js";
export * from "./registries.js";
export * from "./topbar.js";
export * from "./background.js";
export * from "./woc.js";
export * from "./wocTokens.js";
export * from "./tokens.js";
export * from "./collectibles.js";
export * from "./collectibleTransfer.js";
export * from "./i18n.js";
export * from "./keyDisplay.js";
export * from "./poker.js";
export * from "./log.js";
export * from "./protocol.js";
