// packages/contracts/src/plugin.ts
// 插件契约：描述 PluginManifest、PluginContext、PluginDependency。
// 这是 plugin host 装载插件的唯一入口；plugin 通过 setup(ctx) 暴露能力，
// 并在 disable / unregister 时由 host 调用 teardown 释放资源。

import type {
  LifecycleDisposeResult,
  LifecycleScope,
  PluginExecution,
  PluginLifetime,
} from "webloom-framework";
import type {
  KeymasterWebLoomContext,
  KeymasterWebLoomManifest,
} from "./webloom.js";
import type { I18nPluginResources } from "./i18n.js";
import type { PluginLogger } from "./log.js";
import type { PluginBusinessContribution } from "./business.js";
import type { PluginStorageDeclaration } from "./storage/access.js";
import type { KeyValueStore } from "./storage/kv.js";
import type { PluginPermission } from "./keymasterLifecycle.js";

/**
 * Keymaster 插件运行时上下文。
 *
 * 通用字段唯一继承自 WebLoom 泛型 Context；logger、Storage 和 Coordinator
 * 仍以 Keymaster 的平铺领域扩展保留，避免一次性改动全部业务插件调用点。
 * 同一批领域字段也同时位于 `ctx.extension`，供新代码逐步迁移。
 */
export interface PluginContext extends KeymasterWebLoomContext {
  /** 已绑定当前插件身份的 logger。 */
  readonly logger: PluginLogger;
  /** Host 预绑定的领域 Storage 句柄。 */
  readonly storage?: KeyValueStore;
  /** 按 pluginId 收窄后的 Coordinator facade。 */
  readonly coordinator?: unknown;
}

/**
 * 产品级插件依赖描述。
 *
 * 这是历史 manifest 兼容字段；产品级依赖在迁移到运行单元前允许缺少
 * 来源环境、契约版本和作用域。新拆出的运行单元必须使用下面的严格契约。
 */
export interface PluginDependency {
  /** 依赖的 capability key。 */
  capability: string;
  /** 依赖服务的精确契约版本；跨环境依赖不得省略。 */
  contractVersion?: string;
  /** 提供者运行代码所在环境；跨 Worker 依赖不得靠 capability 猜测。 */
  sourceExecution?: PluginExecution;
  /** 依赖服务允许存在的作用域范围；不包含单次请求这种临时作用域。 */
  scope?: PluginLifetime;
  /** 可选的人类可读描述，便于诊断。 */
  reason?: string;
  /** 可选依赖缺失时只关闭局部能力，不阻止插件主体运行。 */
  optional?: boolean;
}

/**
 * 运行单元依赖描述（生产严格契约）。
 *
 * 运行单元可能跨 Window / Worker 装配，不能只凭 capability（能力名）
 * 猜测实际服务。因此这三个绑定字段都是必填，并在 Host 装配前再次做
 * 运行时校验，防止未经 TypeScript 检查的 JSON / JavaScript 绕过契约。
 */
export interface RuntimeUnitDependency {
  /** 依赖的 capability key（能力契约标识）。 */
  capability: string;
  /** 精确契约版本；第一阶段只接受完全匹配。 */
  contractVersion: string;
  /** 提供者实际运行环境；不是消费者所在环境。 */
  sourceExecution: PluginExecution;
  /** 提供者允许存在的作用域寿命。 */
  scope: PluginLifetime;
  /** 可选的人类可读说明。 */
  reason?: string;
  /** 缺失时只关闭局部能力；未填写表示硬依赖。 */
  optional?: boolean;
}

/**
 * 运行单元能力契约的默认绑定。
 *
 * 这些值只描述平台已经发布的 capability 契约，不描述某个插件是否依赖
 * 它；依赖列表仍必须写在对应 RuntimeUnitDescriptor.dependencies 中。
 * 统一生成版本字符串可以避免 Window 与 Worker 手写出两个漂移的版本。
 */
const RUNTIME_CAPABILITY_BINDINGS: Readonly<Record<string, {
  /** 提供者代码所在环境。 */
  sourceExecution: PluginExecution;
  /** 提供者允许存在的最长作用域。 */
  scope: PluginLifetime;
}>> = {
  "vault.service": { sourceExecution: "window", scope: "root" },
  "keyspace.service": { sourceExecution: "window", scope: "root" },
  "vault-settings.registry": { sourceExecution: "window", scope: "root" },
  "protocol.service": { sourceExecution: "window", scope: "storage" },
  "p2pkh.service": { sourceExecution: "window", scope: "owner-session" },
  "p2pkh.protocol-spend": { sourceExecution: "window", scope: "owner-session" },
  "woc.service": { sourceExecution: "window", scope: "owner-session" },
  "woc.bsv21.service": { sourceExecution: "window", scope: "owner-session" },
  "woc.stas.service": { sourceExecution: "window", scope: "owner-session" },
  "woc.1satordinals.service": { sourceExecution: "window", scope: "owner-session" },
  "contacts.service": { sourceExecution: "window", scope: "owner-session" },
  "webrtc.service": { sourceExecution: "window", scope: "owner-session" },
  "message.service": { sourceExecution: "window", scope: "owner-session" },
  "background.registry": { sourceExecution: "window", scope: "owner-session" },
  "background.service": { sourceExecution: "window", scope: "owner-session" },
  "channel.runtime": { sourceExecution: "window", scope: "owner-session" },
  "window-p2p.executor": { sourceExecution: "window", scope: "root" },
  "window-p2p.coordinator-control": { sourceExecution: "window", scope: "root" },
  "storage.runtime-controller": { sourceExecution: "window", scope: "storage" },
};

/** 返回稳定的 capability 契约版本；字段含义：能力名 + 主版本。 */
export function runtimeCapabilityContractVersion(capability: string): string {
  return `${capability}.v1`;
}

/**
 * 将人类可读的依赖清单物化为严格的运行单元依赖契约。
 *
 * `defaults` 只用于尚未进入平台绑定表的本地 Registry；跨环境服务必须
 * 先补入上面的绑定表，不能依赖调用方猜测 sourceExecution / scope。
 */
export function defineRuntimeUnitDependencies(
  dependencies: readonly Pick<PluginDependency, "capability" | "reason" | "optional">[],
  defaults: Partial<Pick<RuntimeUnitDependency, "sourceExecution" | "scope">> = {},
): RuntimeUnitDependency[] {
  return dependencies.map((dependency) => {
    const binding = RUNTIME_CAPABILITY_BINDINGS[dependency.capability];
    const sourceExecution = binding?.sourceExecution ?? defaults.sourceExecution ?? "window";
    const scope = binding?.scope ?? defaults.scope ?? "root";
    return {
      capability: dependency.capability,
      contractVersion: runtimeCapabilityContractVersion(dependency.capability),
      sourceExecution,
      scope,
      ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
      ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
    };
  });
}

/**
 * 为运行单元提供的 capability 生成精确契约版本表。
 * 提供能力和消费能力共用此函数，避免只改一侧造成契约校验失配。
 */
export function defineRuntimeUnitProvidedContracts(
  capabilities: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    capabilities.map((capability) => [capability, runtimeCapabilityContractVersion(capability)]),
  );
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

/**
 * 插件进入应用启动流水线的明确阶段。
 *
 * 装配层只能按这个字段分阶段注册，不能从 pluginId、storage scope
 * 或插件分类反推阶段。通用 runtime 测试夹具可以省略该字段；应用实际
 * catalog 必须为每个 manifest 显式填写。
 */
export type PluginBootstrapStage =
  | "storage-onboarding"
  | "vault-selection"
  | "owner-apps-ready"
  | "connect-apps-ready";

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
 *   - 插件分类、默认启用、是否允许禁用、UI 分组。
 *   - 启停字段是产品意图真值；运行单元 capability / 依赖真值位于 units。
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
  /** 应用启动门禁阶段；生产 manifest 必须显式声明。 */
  bootstrapStage?: PluginBootstrapStage;
  /** 无 units 的简单插件的兼容能力摘要；显式单元不得从此字段继承。 */
  providesCapabilities?: string[];
  /** UI 分组（仅展示），不传则按 kind 兜底。 */
  displayGroup?: PluginDisplayGroup;
  /** 运行生命周期；未填写的历史 manifest 按 plugin-instance 兼容装配。 */
  lifetime?: PluginLifetime;
  /** 运行代码位置；不能通过 React manifest 推断。 */
  execution?: PluginExecution;
}

/** 插件 setup 钩子可返回的清理函数。 */
export type PluginTeardown = () => void | Promise<void>;

/** 插件运行单元的无 React 装配入口。 */
export type PluginSetup = (ctx: PluginContext) =>
  void | Promise<void> | PluginTeardown | Promise<PluginTeardown>;

/**
 * 当前执行环境的运行实现注册表。
 *
 * `RuntimeUnitDescriptor` 只描述产品和运行单元，不携带可执行函数；Window、
 * Coordinator Worker 等装配层通过本注册表按 productId + unitId 取得入口。
 */
export interface RuntimeUnitImplementationRegistry {
  /** 返回当前环境中指定运行单元的 setup；未装配时返回 undefined。 */
  get(pluginId: string, unitId: string): PluginSetup | undefined;
}

/**
 * 一个插件产品可装配的运行单元描述。
 *
 * 简单插件不填写 `units`，Host 按历史 manifest 兼容为一个同名单元；
 * 多环境插件再显式拆分 Worker / Window / Connect 单元。
 */
export interface RuntimeUnitDescriptor {
  /** 稳定运行单元标识，不是每次启动生成的 instanceId。 */
  id: string;
  /** 运行代码所在环境。 */
  execution: PluginExecution;
  /** 依附的作用域寿命。 */
  lifetime: PluginLifetime;
  /** 本单元所需的服务和精确契约版本；运行单元依赖不得省略绑定字段。 */
  dependencies?: RuntimeUnitDependency[];
  /** 本单元提供的 capability；兼容旧字段的语义。 */
  provides?: string[];
  /** 本单元每个 capability 的精确服务契约版本；严格依赖按此字段匹配。 */
  providedContracts?: Record<string, string>;
  /** 本单元的界面、菜单和首页贡献；Worker 单元不得继承 Window 贡献。 */
  business?: PluginBusinessContribution;
  /** 本单元申请的权限。 */
  permissions?: PluginPermission[];
  /** 本单元的存储声明。 */
  storage?: PluginStorageDeclaration;
  /** 单元专属配置契约 / 部署默认值。 */
  config?: Record<string, unknown>;
}

/**
 * 插件清单：通用静态字段来自 WebLoom，Keymaster 只补充产品领域字段。
 * setup 不属于清单，运行实现必须通过 RuntimeUnitImplementationRegistry 注入。
 */
export interface PluginManifest extends Omit<
  KeymasterWebLoomManifest,
  "meta" | "contribution" | "dependencies" | "permissions" | "units" | "config"
> {
  /**
   * 无 units 的简单插件的兼容业务声明；显式运行单元必须放入 unit.business。
   * runtime 自动注册并在 disable / uninstall 时统一回收；插件 setup 不必
   * 接触 route.registry 或 home.registry。
   */
  business?: PluginBusinessContribution;
  /** 无 units 的简单插件的兼容依赖；显式运行单元必须放入 unit.dependencies。 */
  dependencies?: PluginDependency[];
  /**
   * 硬切换 001：插件元数据（分类、默认启用、是否可禁用、提供 capability）。
   * meta 与 startup 都是必填，runtime 不进行默认/兼容推断。
   */
  meta: PluginMeta;
  /**
   * 新统一存储声明。系统 App 也只能通过 `scope: "key"` 获取自己的目录；
   * `scope: "platform"` 由 Host 白名单显式授权，普通插件会被拒绝；
   * 显式运行单元必须将声明放入 unit.storage。
   */
  storage?: PluginStorageDeclaration;
  /**
   * 显式配置面（施工单 2026-07-08 001 硬切换；仅无 units 的兼容插件）。
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
  /** 无 units 的简单插件的兼容权限集合；显式运行单元必须放入 unit.permissions。 */
  permissions?: PluginPermission[];
  /** 多运行环境插件的静态单元描述；缺省兼容为一个 product-instance 单元。 */
  units?: readonly RuntimeUnitDescriptor[];
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
  | "starting"
  | "stopping"
  | "enabled"
  | "disabled"
  | "blocked"
  | "error-disabled"
  | "cleanup-pending"
  /** 远程运行单元没有可用快照；未知不能伪装成 blocked。 */
  | "unknown";

/** 对外稳定的产品运行语义；kind 保留旧 API 兼容，业务新代码使用此字段。 */
export type PluginLifecycleState = "disabled" | "waiting" | "starting" | "running" | "stopping" | "failed";

/** host.state(pluginId) 返回的状态对象。 */
export interface PluginState {
  id: string;
  kind: PluginStateKind;
  /** 设计 6.1 的稳定状态；不把用户意图和运行状态混为一个布尔值。 */
  lifecycleState?: PluginLifecycleState;
  /** teardown 抛错时填入的最近错误信息。 */
  error?: string;
  /** 用户持久化的启用意图；依赖阻塞时仍保持 true。 */
  desiredEnabled?: boolean;
  /** 当前产品意图修订；旧实例结果不得覆盖更高修订。 */
  desiredRevision?: number;
  /** 当前运行实例标识；disabled/blocked 时为空。 */
  instanceId?: string;
  /** 当前运行单元标识；历史单元缺省时等于插件 id。 */
  unitId?: string;
  /** 当前阻塞或清理原因（中文 UI 可据此映射）。 */
  blockedBy?: string[];
  /** 最近一次结构化清理结果。 */
  cleanup?: LifecycleDisposeResult;
  /** 当前产品下各运行单元的独立状态；旧简单插件只包含一个单元。 */
  units?: readonly PluginUnitState[];
}

/** 运行单元状态；唯一键是 productId + unitId + instanceId。 */
export interface PluginUnitState {
  /** 所属产品标识。 */
  pluginId: string;
  /** 稳定运行单元标识。 */
  unitId: string;
  /** 运行环境。 */
  execution: PluginExecution;
  /** 当前运行实例；未运行时为空。 */
  instanceId?: string;
  /** 当前产品意图修订；用于丢弃旧单元异步结果。 */
  desiredRevision?: number;
  /** 单元自身生命周期状态。 */
  kind: PluginStateKind;
  /** 单元的阻塞或失败原因。 */
  error?: string;
  /** 单元清理结果。 */
  cleanup?: LifecycleDisposeResult;
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
  /** 插件 -> 仅用于局部能力的可选依赖；缺失不阻断主体。 */
  optionalDependencies?: Record<string, string[]>;
  /** 插件 -> 它声明提供的 capability 列表（产品与运行单元合并）。 */
  provides: Record<string, string[]>;
  /** 插件 -> 反向依赖它的启用中插件。 */
  reverse: Record<string, PluginReverseDep[]>;
  /** capability -> 声明提供者；用于重复提供诊断。 */
  providers?: Record<string, string[]>;
  /** 插件 -> 精确依赖描述；保留版本、来源环境和作用域，不只保留 capability 名。 */
  dependencyDetails?: Record<string, PluginDependency[]>;
  /** 装配前发现的硬依赖环；每一项是插件 id 路径。 */
  cycles?: string[][];
  /** 按 productId/unitId 编索引的已选运行单元图；未选环境不会出现在这里。 */
  units?: Record<string, PluginUnitGraph>;
}

/** 运行单元依赖图节点；用于避免把未部署的 Worker/Window 单元当成能力提供者。 */
export interface PluginUnitGraph {
  /** 所属产品标识。 */
  pluginId: string;
  /** 稳定运行单元标识。 */
  unitId: string;
  /** 运行环境。 */
  execution: PluginExecution;
  /** 本单元依赖的 capability。 */
  dependencies: string[];
  /** 本单元依赖的精确契约描述。 */
  dependencyDetails?: RuntimeUnitDependency[];
  /** 本单元实际提供的 capability。 */
  provides: string[];
  /** 本单元对外 capability 的精确契约版本。 */
  providedContracts?: Record<string, string>;
}

/** 通用订阅回调（host version / state 变化时调用）。 */
export type HostListener = (snapshot: { version: number }) => void;
