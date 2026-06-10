// packages/contracts/src/plugin.ts
// 插件契约：描述 PluginManifest、PluginContext、PluginDependency。
// 这是 plugin host 装载插件的唯一入口；plugin 通过 setup(ctx) 暴露能力。

import type { MessageBus } from "./messageBus.js";
import type { I18nPluginResources } from "./i18n.js";

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
}

/** 插件依赖描述。 */
export interface PluginDependency {
  /** 依赖的 capability key。 */
  capability: string;
  /** 可选的人类可读描述，便于诊断。 */
  reason?: string;
}

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
  /** 插件的 setup 钩子，所有注册动作都发生在这里。 */
  setup(ctx: PluginContext): void | Promise<void>;
}

/** 插件声明的一个 key-scoped storage。 */
export interface PluginKeyStorageDeclaration {
  /** storage 唯一 id（插件内）。 */
  storageId: string;
  /** 描述，便于诊断。 */
  description?: string;
}
