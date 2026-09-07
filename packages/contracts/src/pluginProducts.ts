// 内置插件产品清单。
//
// 这是当前 Web 发行版的稳定产品边界，不是动态插件注册表。Coordinator
// 只能接受清单中的产品意图；未来如果开放第三方插件，必须另建可信注册
// 流程，不能把任意字符串直接加入这里或绕过 Worker 校验。

import type { PluginExecution, PluginLifetime } from "webloom-framework";

/**
 * 当前 Web 发行版允许用户启停的产品级 pluginId。
 *
 * 产品级 id 与运行单元 unitId 不同：Window / Worker 单元都归属于这里的
 * 一个产品，用户命令只操作产品意图。
 */
export const BUILTIN_PLUGIN_PRODUCT_IDS = [
  "storage",
  "vault",
  "window-p2p",
  "msfile",
  "sat-subscription",
  "protocol",
  "contacts",
  "webrtc",
  "message",
  "settings",
  "key-import",
  "background",
  "home",
  "woc",
  "junglebus",
  "p2pkh",
  "token-bsv21",
  "token-stas",
  "collectible-1satordinals",
  "poker",
  "importer-wif",
  "importer-hex",
  "importer-json-file",
  "bsv-price",
  "apps",
] as const;

/** 供 Worker / 装配层做 O(1) 产品边界校验的只读集合。 */
export const BUILTIN_PLUGIN_PRODUCT_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_PRODUCT_IDS);

/**
 * Web 发行版的产品→运行单元静态契约。
 *
 * `productId` 是用户启停的产品；`unitId` 是框架实际装配的稳定运行
 * 单元。一个产品可以只有一个 Window 单元；只有已经有真实 Coordinator
 * Worker 装配入口的产品，才在这里同时声明 Worker 单元。不要把这里的
 * 声明当成“目录里写了就已经有实现”，Worker 单元必须再由 Worker 目录
 * 和任务/服务装配代码互相校验。
 */
export interface BuiltinPluginRuntimeUnitDeclaration {
  /** 用户可启停的产品标识。 */
  productId: (typeof BUILTIN_PLUGIN_PRODUCT_IDS)[number];
  /** 稳定运行单元标识，不是一次启动生成的 instanceId。 */
  unitId: string;
  /** 运行代码所在环境。 */
  execution: PluginExecution;
  /** 运行单元的作用域寿命。 */
  lifetime: PluginLifetime;
}

/**
 * 当前发行版所有产品的显式运行单元。
 *
 * 这份表故意使用扁平记录，便于发布脚本和非 TypeScript 工具读取；同一
 * 产品的多条记录表示多个物理运行单元，而不是多个用户产品。
 */
export const BUILTIN_PLUGIN_RUNTIME_UNIT_CATALOG = [
  { productId: "storage", unitId: "storage.window", execution: "window", lifetime: "storage" },
  { productId: "storage", unitId: "storage.coordinator-worker", execution: "coordinator-worker", lifetime: "storage" },
  { productId: "vault", unitId: "vault.window", execution: "window", lifetime: "root" },
  { productId: "vault", unitId: "vault.coordinator-worker", execution: "coordinator-worker", lifetime: "root" },
  { productId: "window-p2p", unitId: "window-p2p.window", execution: "window", lifetime: "root" },
  { productId: "window-p2p", unitId: "window-p2p.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "msfile", unitId: "msfile.window", execution: "window", lifetime: "owner-session" },
  { productId: "msfile", unitId: "msfile.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "sat-subscription", unitId: "sat-subscription.window", execution: "window", lifetime: "owner-session" },
  { productId: "sat-subscription", unitId: "sat-subscription.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "protocol", unitId: "protocol.window", execution: "window", lifetime: "storage" },
  { productId: "contacts", unitId: "contacts.window", execution: "window", lifetime: "owner-session" },
  { productId: "contacts", unitId: "contacts.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "webrtc", unitId: "webrtc.window", execution: "window", lifetime: "owner-session" },
  { productId: "message", unitId: "message.window", execution: "window", lifetime: "owner-session" },
  { productId: "settings", unitId: "settings.window", execution: "window", lifetime: "root" },
  { productId: "key-import", unitId: "key-import.window", execution: "window", lifetime: "root" },
  { productId: "background", unitId: "background.window", execution: "window", lifetime: "owner-session" },
  { productId: "home", unitId: "home.window", execution: "window", lifetime: "root" },
  { productId: "woc", unitId: "woc.window", execution: "window", lifetime: "owner-session" },
  { productId: "woc", unitId: "woc.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "junglebus", unitId: "junglebus.window", execution: "window", lifetime: "owner-session" },
  { productId: "junglebus", unitId: "junglebus.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "p2pkh", unitId: "p2pkh.window", execution: "window", lifetime: "owner-session" },
  { productId: "p2pkh", unitId: "p2pkh.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "token-bsv21", unitId: "token-bsv21.window", execution: "window", lifetime: "owner-session" },
  { productId: "token-bsv21", unitId: "token-bsv21.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "token-stas", unitId: "token-stas.window", execution: "window", lifetime: "owner-session" },
  { productId: "token-stas", unitId: "token-stas.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "collectible-1satordinals", unitId: "collectible-1satordinals.window", execution: "window", lifetime: "owner-session" },
  { productId: "collectible-1satordinals", unitId: "collectible-1satordinals.coordinator-worker", execution: "coordinator-worker", lifetime: "owner-session" },
  { productId: "poker", unitId: "poker.window", execution: "window", lifetime: "owner-session" },
  { productId: "importer-wif", unitId: "importer-wif.window", execution: "window", lifetime: "root" },
  { productId: "importer-hex", unitId: "importer-hex.window", execution: "window", lifetime: "root" },
  { productId: "importer-json-file", unitId: "importer-json-file.window", execution: "window", lifetime: "root" },
  { productId: "bsv-price", unitId: "bsv-price.window", execution: "window", lifetime: "owner-session" },
  { productId: "apps", unitId: "apps.window", execution: "window", lifetime: "root" },
] as const satisfies readonly BuiltinPluginRuntimeUnitDeclaration[];

/** 返回一个产品的静态运行单元声明；调用方不得自行补默认单元。 */
export function getBuiltinPluginRuntimeUnits(
  productId: string,
): readonly BuiltinPluginRuntimeUnitDeclaration[] {
  return BUILTIN_PLUGIN_RUNTIME_UNIT_CATALOG.filter((unit) => unit.productId === productId);
}

/** 校验产品、单元和执行环境的唯一性，供应用装配和发布脚本复用。 */
export function validateBuiltinPluginRuntimeUnitCatalog(
  catalog: readonly BuiltinPluginRuntimeUnitDeclaration[] = BUILTIN_PLUGIN_RUNTIME_UNIT_CATALOG,
): string[] {
  const errors: string[] = [];
  const products = new Set<string>();
  const units = new Set<string>();
  for (const unit of catalog) {
    if (!BUILTIN_PLUGIN_PRODUCT_ID_SET.has(unit.productId)) {
      errors.push(`运行单元引用未知产品: ${unit.productId}`);
    }
    if (units.has(unit.unitId)) errors.push(`重复运行单元: ${unit.unitId}`);
    units.add(unit.unitId);
    const productUnitKey = `${unit.productId}\u0000${unit.unitId}`;
    if (products.has(productUnitKey)) errors.push(`重复产品运行单元: ${productUnitKey}`);
    products.add(productUnitKey);
    if (unit.execution === "coordinator-worker" && !["root", "storage", "owner-session"].includes(unit.lifetime)) {
      errors.push(`Coordinator Worker 单元 lifetime 必须是 root、storage 或 owner-session: ${unit.unitId}`);
    }
  }
  for (const productId of BUILTIN_PLUGIN_PRODUCT_IDS) {
    if (!catalog.some((unit) => unit.productId === productId)) {
      errors.push(`产品缺少运行单元: ${productId}`);
    }
  }
  return errors;
}

/** 生产装配加载时立即拒绝不完整的产品运行单元契约。 */
export function assertBuiltinPluginRuntimeUnitCatalog(): void {
  const errors = validateBuiltinPluginRuntimeUnitCatalog();
  if (errors.length > 0) throw new Error(`内置产品运行单元目录无效: ${errors.join("；")}`);
}

/**
 * 不能被用户关闭的内置产品。
 *
 * 这份策略必须同时被 Window Host 和 Coordinator Worker 使用：Host 负责
 * UI/实例状态，Worker 负责真实服务、任务和最终 I/O。只在前端 manifest
 * 中声明 canDisable=false 不足以形成生产边界，因为调用方仍可直接向
 * SharedWorker 提交命令。
 */
export const BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_IDS = [
  "storage",
  "vault",
  "window-p2p",
  "msfile",
  "sat-subscription",
  "protocol",
  "message",
  "settings",
  "home",
] as const;

/** 供 Worker 在命令入口做 O(1) 的不可关闭产品校验。 */
export const BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_ID_SET: ReadonlySet<string> = new Set(BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_IDS);
