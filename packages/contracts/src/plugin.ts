// packages/contracts/src/plugin.ts
// 插件契约：描述 PluginManifest、PluginContext、PluginDependency。
// 这是 plugin host 装载插件的唯一入口；plugin 通过 setup(ctx) 暴露能力，
// 并在 disable / unregister 时由 host 调用 teardown 释放资源。

import type { MessageBus } from "./messageBus.js";
import type { I18nPluginResources } from "./i18n.js";
import type { PluginLogger } from "./log.js";
import type { PluginBusinessContribution } from "./business.js";

/** 插件运行时上下文，由 plugin host 创建并传入 setup。 */
export interface PluginContext {
  /** Register cleanup that runs before teardown and registry ownership recovery. */
  onDispose(cleanup: PluginTeardown): void;
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
  /**
   * 当前 plugin 的显式配置面（施工单 2026-07-08 001 硬切换）。
   *
   * 由装配层在 `registerPlugin(manifest)` 期间按 `manifest.config` 注入；
   * plugin 的 `setup(ctx)` 直接按 `ctx.config?.[key]` 读取。
   *
   * 关键边界：
   *   - 这是 plugin **唯一**允许读取"装配层注入真值"的接口；
   *   - **不**允许 plugin 反向写入 `ctx.config`（只读视图）；
   *   - 缺值时按 plugin 自己声明的降级路径处理（如显示"未配置"）；
   *   - 与 `PluginConfigStore`（启停配置）**不**共用：后者是 runtime
   *     内部 store；前者是插件作者自定义字段。
   */
  readonly config?: Record<string, unknown>;
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

/** 首屏是否允许在该插件缺失时挂载 entrypoint。 */
export type PluginStartupMode = "required" | "optional";

export interface StartupCapabilityErrorDetails {
  capability: string;
  providerPluginId?: string;
  providerState?: PluginStateKind;
  providerError?: string;
  configuredEnabled?: boolean;
}

export interface StartupPluginErrorDetails {
  pluginId: string;
  capabilities: string[];
  state: PluginStateKind;
  error?: string;
}

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
  /** 必须显式选择；required 插件必须 defaultEnabled=true、canDisable=false 且提供能力。 */
  startup: PluginStartupMode;
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
  /**
   * 插件面向用户的页面、菜单和首页卡片声明。
   * runtime 自动注册并在 disable / uninstall 时统一回收；插件 setup 不必
   * 接触 route.registry 或 home.registry。
   */
  business?: PluginBusinessContribution;
  /** 显式声明依赖的 capability（PluginHost 会做依赖检查）。 */
  dependencies?: PluginDependency[];
  /**
   * 硬切换 001：插件元数据（分类、默认启用、是否可禁用、提供 capability）。
   * meta 与 startup 都是必填，runtime 不进行默认/兼容推断。
   */
  meta: PluginMeta;
  /**
   * 声明插件拥有的 key-scoped storage。
   * 装载时由 runtime 自动调用 keyspace.registerPluginStorage，让 keyspace
   * 在 deleteKey 时能找到要删除的 DB；插件不得直接 indexedDB.open 固定名字
   * 的 key 相关 DB。
   */
  keyScopedStorages?: PluginKeyStorageDeclaration[];
  /**
   * 显式配置面（施工单 2026-07-08 001 硬切换）。
   *
   * 设计缘由：
   *   - 装配层（`apps/web/src/bootstrapPlugins.ts`）按依赖顺序对每个
   *     plugin 注入一份强类型配置真值；
   *   - 插件自己的 `setup` 通过 `ctx.config` 直接读；
   *   - **不**走 `globalThis.__XXX__` 隐式注入路径；
   *   - **不**走运行时编辑器（本次硬切换明确不做）；
   *   - 缺省 `{}`：插件必须对每个字段做"缺值时降级到无害空态"处理。
   *
   * 用途示例：
   *   - `plugin-bsv-price` 的 `pricePublisherPublicKeyHex` —— PriceCast
   *     publisher 公钥 hex 强配置注入；
   *   - 任何"装配层硬编码的部署侧真值"都走这里。
   */
  config?: Record<string, unknown>;
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
   * 可选：声明本插件拥有"应用消息总线端点"。
   *
   * 设计缘由（施工单 2026-07-04 001 硬切换）：
   *   - 声明后，runtime 在 enable 阶段对 `endpointId` 做形状校验
   *     （`isValidPluginEndpointIdShape`）+ 全局唯一性校验，冲突即
   *     fail-closed；
   *   - **不再**由 runtime 注入 `<pluginId>.appmsg.client` capability。
   *     业务插件需要时在自己的 `setup` 里通过
   *     `appmsg.endpoint.registry` capability 拿一个 endpoint 对应的
   *     稳定 `AppMsgEndpointService`；
   *   - `endpointId` **不**等于 Vault key 域真值（`publicKeyHex`）；**不**
   *     要求等于 manifest id；必须在同 Keymaster 安装内全局唯一；
   *   - **不**声明 endpoint 的插件：runtime 不做任何注入，也不影响其
   *     它 capability；
   *   - 端点 service 内部自动处理 owner 真值 / provider 切换的迁移，
   *     插件**不需要**自己监听 keyspace / vault / provider；
   *   - endpoint service 的生命周期由 plugin-appmsg 内部持有——业务
   *     插件在 teardown 时调用 `endpointRegistry.releaseEndpoint(...)`
   *     释放即可。
   *
   * 字段命名约束：
   *   - `endpointId` 形状见 `isValidPluginEndpointIdShape`（portable
   *     subset）。
   */
  appMessageEndpoint?: {
    /** 远端消息端点 id；全局唯一；不等于 vault key 域真值；不等于 manifest id。 */
    endpointId: string;
    /** 可选人类可读描述，便于诊断。 */
    description?: string;
  };
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
