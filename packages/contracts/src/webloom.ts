// Keymaster 对 WebLoom 的领域扩展类型。
//
// 通用 Host、Scope、权限租约和服务桥属于 webloom-framework；本文件只描述 Keymaster
// 需要附加的 owner/session、Storage、Coordinator 和业务贡献面。
// 这样插件可以明确区分“框架字段”和“产品字段”，不会把产品语义重新塞回
// WebLoom 公共契约。

import type {
  Capability,
  CapabilityDependency,
  PluginConfig as WebLoomPluginConfig,
  PluginContext as WebLoomPluginContext,
  PluginContextExtension as WebLoomPluginContextExtension,
  PluginContribution as WebLoomPluginContribution,
  PluginManifest as WebLoomPluginManifest,
} from "webloom-framework";
import type { PluginBusinessContribution } from "./business.js";
import type { PluginPermission, RuntimeVaultStatus } from "./keymasterLifecycle.js";
import type { KeyValueStore } from "./storage/kv.js";

/** WebLoom Scope.attributes 中由 Keymaster 绑定的领域元数据。 */
export interface KeymasterScopeAttributes extends Readonly<Record<string, unknown>> {
  /** 当前 Vault 生命周期状态；只用于 Scope 可用性判断。 */
  readonly vaultStatus?: RuntimeVaultStatus;
  /** 当前 owner 的压缩公钥；不能作为私钥或签名凭据。 */
  readonly ownerPublicKeyHex?: string;
  /** owner/session 运行世代；变化时旧实例必须失效。 */
  readonly sessionEpoch?: string;
  /** Storage bucket 运行世代；变化时旧 Storage 句柄必须失效。 */
  readonly bucketGeneration?: number;
  /** Keymaster 权限策略或外部授权修订。 */
  readonly authorizationRevision?: number;
}

/** Keymaster 注入 WebLoom Context 的领域扩展。 */
export interface KeymasterContextExtension extends WebLoomPluginContextExtension {
  /** Host 预绑定的领域 Storage 句柄。 */
  readonly storage?: KeyValueStore;
  /** 按 pluginId 收窄后的 Coordinator facade。 */
  readonly coordinator?: unknown;
}

/** Keymaster 业务贡献的泛型绑定。 */
export type KeymasterPluginContribution =
  WebLoomPluginContribution | PluginBusinessContribution;

/** Keymaster 插件配置的泛型绑定。 */
export type KeymasterPluginConfig = WebLoomPluginConfig;

/** 带 WebLoom 通用字段和 Keymaster 扩展的 Context 类型。 */
export type KeymasterWebLoomContext = WebLoomPluginContext<
  readonly Capability[],
  readonly CapabilityDependency[],
  KeymasterPluginConfig,
  KeymasterContextExtension
>;

/** Keymaster 适配器内部使用的 WebLoom Manifest 类型。 */
export type KeymasterWebLoomManifest = WebLoomPluginManifest<
  KeymasterPluginContribution,
  KeymasterPluginConfig
>;

/** Keymaster 仍由产品定义的权限字符串别名，便于扩展类型自描述。 */
export type KeymasterPluginPermission = PluginPermission;
