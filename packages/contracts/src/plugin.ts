// packages/contracts/src/plugin.ts
// 插件契约：描述 PluginManifest、PluginContext、PluginDependency。
// 这是 plugin host 装载插件的唯一入口；plugin 通过 setup(ctx) 暴露能力，
// 并在 disable / unregister 时由 host 调用 teardown 释放资源。

import type { MessageBus } from "./messageBus.js";
import type { I18nPluginResources } from "./i18n.js";
import type { PluginLogger } from "./log.js";

/** 插件运行时上下文，由 plugin host 创建并传入 setup。 */
export interface PluginContext {
  /** 注册 capability，重复注册会抛错。 */
  provide<T>(key: string, value: T): void;
  /** 读取 capability，缺失会抛错。 */
  get<T>(key: string): T;
  /** 探测 capability 是否存在。 */
  has(key: string): boolean;
  /** 要求某个 capability 必须存在，否则抛错。 */
  require(key: string): void;
  /**
   * 访问统一 MessageBus（事件/命令/请求）。
   * 这是事件订阅/发布、命令投递、请求响应的唯一入口。
   * 旧 emit / on 已被移除，避免与 messageBus.publish / subscribe 双入口并存。
   */
  messageBus: MessageBus;
  /**
   * 平台注入的统一 logger。
   *   - pluginId 已经天然绑定，插件作者**禁止**自己再传 pluginId。
   *   - 不允许插件自己 new / 拼装第二套 logger。
   *   - debug 关闭时 logger.debug() 不写库。
   *   - child(scope) 仅用于在同一插件内细分模块。
   */
  logger: PluginLogger;
}

/** 插件依赖描述。 */
export interface PluginDependency {
  /** 依赖的 capability key。 */
  capability: string;
  /** 可选的人类可读描述，便于诊断。 */
  reason?: string;
}

/**
 * 插件分类：
 *   - core：宿主必备，禁止 disable（如 vault / settings / home）。
 *   - platform：平台层能力，可 disable 但 UI 默认提示风险。
 *   - business：业务插件，可随时 disable（如 poker / p2pkh）。
 */
export type PluginKind = "core" | "platform" | "business";

/** 插件展示分组（仅 UI 用）。 */
export type PluginDisplayGroup = "core" | "platform" | "business" | "import" | "experimental";

/**
 * 插件元数据（硬切换 001）：
 *   - 插件分类、默认启用、是否允许禁用、提供 capability、UI 分组。
 *   - 这些字段是插件依赖图与系统级启停的真值；运行时不再另建中心化目录。
 */
export interface PluginMeta {
  /** 插件分类。 */
  kind: PluginKind;
  /** 首屏默认是否启用。runtime 启动时与全局启停配置合并得到初始集合。 */
  defaultEnabled: boolean;
  /** 是否允许用户在系统级 UI 禁用。core 必为 false。 */
  canDisable: boolean;
  /** 该插件提供哪些 capability（供反向依赖查询使用）。 */
  providesCapabilities?: string[];
  /** UI 分组（仅展示），不传则按 kind 兜底。 */
  displayGroup?: PluginDisplayGroup;
}

/** 插件 setup 钩子可返回的清理函数。 */
export type PluginTeardown = () => void | Promise<void>;

/** 插件清单：插件作者导出的唯一对象。 */
export interface PluginManifest {
  /** 全局唯一 id，使用命名空间，例如 "vault"、"p2pkh"。 */
  id: string;
  /** 展示用名称。 */
  name: string;
  /** 描述。 */
  description?: string;
  /** 显式声明依赖的 capability（PluginHost 会做依赖检查）。 */
  dependencies?: PluginDependency[];
  /**
   * 硬切换 001：插件元数据（分类、默认启用、是否可禁用、提供 capability）。
   * 旧插件没有 meta 字段时，runtime bootstrap 视为"业务插件、可禁用"。
   */
  meta?: PluginMeta;
  /**
   * 声明插件拥有的 key-scoped storage。
   * 装载时由 runtime 自动调用 keyspace.registerPluginStorage，让 keyspace
   * 在 deleteKey 时能找到要删除的 DB；插件不得直接 indexedDB.open 固定名字
   * 的 key 相关 DB。
   */
  keyScopedStorages?: PluginKeyStorageDeclaration[];
  /**
   * 可选：插件的 i18n 资源。
   * 设计缘由：插件 setup 中可能引用自己的 i18n key 注册 route / menu / settings。
   * 资源必须在 setup 之前可用，否则 plugin manifest 内的硬切换文案会回退到 fallback。
   * runtime 在 host 创建时拿到 i18n service 并在 register(plugin) 流程中
   * 优先注册 plugin.i18n 资源，再执行 setup。
   *
   * 注意：i18n service 自身作为内置 capability 暴露在 ctx.get("i18n.service")，
   * 需要运行时翻译的插件可以显式 get 它（不再要求每个 plugin 手写 registerResources）。
   */
  i18n?: I18nPluginResources;
  /**
   * 插件的 setup 钩子，所有注册动作都发生在这里。
   * 硬切换 001：可以返回 teardown 清理函数；host 在 disable / unregister 时
   * 调用它。teardown 必须是幂等、可重复调用、可容忍部分资源已被清理。
   */
  setup(ctx: PluginContext): void | Promise<void> | PluginTeardown | Promise<PluginTeardown>;
}

/** 插件声明的一个 key-scoped storage。 */
export interface PluginKeyStorageDeclaration {
  /** storage 唯一 id（插件内）。 */
  storageId: string;
  /** 描述，便于诊断。 */
  description?: string;
}

/**
 * 插件启停运行时状态。
 *   - `registered` 仅表示已知；不代表 enabled。
 *   - `enabled` 当前正在运行，可被 UI 访问。
 *   - `disabled` 已被显式禁用；host 内已卸载。
 *   - `blocked` 当前无法 enable（依赖未满足）。
 *   - `error-disabled` teardown 出错但已被卸载。
 */
export type PluginStateKind =
  | "registered"
  | "enabled"
  | "disabled"
  | "blocked"
  | "error-disabled";

/** host.state(pluginId) 返回的状态对象。 */
export interface PluginState {
  id: string;
  kind: PluginStateKind;
  /** teardown 抛错时填入的最近错误信息。 */
  error?: string;
}

/** 插件依赖图中"被谁依赖"查询的条目。 */
export interface PluginReverseDep {
  /** 反向依赖者 id。 */
  pluginId: string;
  /** 反向依赖者当前是否 enabled。 */
  enabled: boolean;
  /** 触发依赖的 capability 列表（被本插件 provides 的子集）。 */
  capabilities: string[];
}

/** 插件依赖图快照。 */
export interface PluginGraph {
  /** 已知 manifest id 列表。 */
  plugins: string[];
  /** 插件 -> 它依赖的 capability 列表。 */
  dependencies: Record<string, string[]>;
  /** 插件 -> 它声明提供的 capability 列表（取自 manifest.meta）。 */
  provides: Record<string, string[]>;
  /** 插件 -> 反向依赖它的启用中插件。 */
  reverse: Record<string, PluginReverseDep[]>;
}

/** 通用订阅回调（host version / state 变化时调用）。 */
export type HostListener = (snapshot: { version: number }) => void;
