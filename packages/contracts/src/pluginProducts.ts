// IDs and units are materialized by scripts/materialize-plugin-catalog.mjs.
// 内置插件产品清单。
//
// 这是当前 Web 发行版的稳定产品边界，不是动态插件注册表。Coordinator
// 只接受清单中的产品身份；未来如果开放第三方插件，必须另建可信注册
// 流程，不能把任意字符串直接加入这里或绕过 Worker 校验。

import type { RuntimeKind } from "webloom-framework";
import type { KeymasterScopeKind } from "./keymasterLifecycle.js";

/**
 * 当前 Web 发行版登记的稳定产品级 pluginId。
 *
 * 产品级 id 与运行单元 unitId 不同：Window / Worker 单元都归属于这里的
 * 一个产品。登记身份不授予能力，也不代表实例已经就绪。
 */
export const BUILTIN_PLUGIN_PRODUCT_IDS = [
  "page",
  "assets",
  "collectibles",
  "scan",
  "storage",
  "vault",
  "window-p2p",
  "msfile",
  "sat-subscription",
  "protocol",
  "contacts",
  "webrtc",
  "message",
  "background",
  "woc",
  "p2pkh",
  "token-bsv21",
  "token-stas",
  "collectible-1satordinals",
  "bsv-price",
  "apps",
] as const;

/** 供 Worker / 装配层做 O(1) 产品边界校验的只读集合。 */
export const BUILTIN_PLUGIN_PRODUCT_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_PRODUCT_IDS);

/**
 * Web 发行版的产品→运行单元静态契约。
 *
 * `productId` 是插件归属的产品；`unitId` 是框架实际装配的稳定运行
 * 单元。一个产品可以只有一个 Window 单元；只有已经有真实 Coordinator
 * Worker 装配入口的产品，才在这里同时声明 Worker 单元。不要把这里的
 * 声明当成“目录里写了就已经有实现”，Worker 单元必须再由 Worker 目录
 * 和任务/服务装配代码互相校验。
 */
export interface BuiltinPluginRuntimeUnitDeclaration {
  /** 稳定产品归属标识。 */
  productId: (typeof BUILTIN_PLUGIN_PRODUCT_IDS)[number];
  /** 稳定运行单元标识，不是一次启动生成的 instanceId。 */
  unitId: string;
  /** 运行代码所在环境。 */
  runtime: RuntimeKind;
  /** 运行单元的作用域寿命。 */
  scopeKind: KeymasterScopeKind;
}

/**
 * 当前发行版所有产品的显式运行单元。
 *
 * 这份表由真实发行版 manifest 生成，使用扁平记录，便于发布脚本和非 TypeScript 工具读取；同一
 * 产品的多条记录表示多个物理运行单元，而不是多个用户产品。
 */
export const BUILTIN_PLUGIN_RUNTIME_UNIT_CATALOG = [
  { productId: "page", unitId: "page.window", runtime: "window-main", scopeKind: "root" },
  { productId: "assets", unitId: "assets.window", runtime: "window-main", scopeKind: "root" },
  { productId: "collectibles", unitId: "collectibles.window", runtime: "window-main", scopeKind: "root" },
  { productId: "scan", unitId: "scan.window", runtime: "window-main", scopeKind: "root" },
  { productId: "storage", unitId: "storage.window", runtime: "window-main", scopeKind: "storage" },
  { productId: "storage", unitId: "storage.coordinator-worker", runtime: "shared-worker", scopeKind: "storage" },
  { productId: "vault", unitId: "vault.window", runtime: "window-main", scopeKind: "root" },
  { productId: "vault", unitId: "vault.coordinator-worker", runtime: "shared-worker", scopeKind: "root" },
  { productId: "window-p2p", unitId: "window-p2p.window", runtime: "window-main", scopeKind: "root" },
  { productId: "window-p2p", unitId: "window-p2p.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "msfile", unitId: "msfile.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "msfile", unitId: "msfile.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "sat-subscription", unitId: "sat-subscription.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "sat-subscription", unitId: "sat-subscription.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "protocol", unitId: "protocol.window", runtime: "window-main", scopeKind: "storage" },
  { productId: "contacts", unitId: "contacts.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "contacts", unitId: "contacts.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "webrtc", unitId: "webrtc.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "message", unitId: "message.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "background", unitId: "background.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "woc", unitId: "woc.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "woc", unitId: "woc.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "p2pkh", unitId: "p2pkh.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "p2pkh", unitId: "p2pkh.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "token-bsv21", unitId: "token-bsv21.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "token-bsv21", unitId: "token-bsv21.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "token-stas", unitId: "token-stas.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "token-stas", unitId: "token-stas.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "collectible-1satordinals", unitId: "collectible-1satordinals.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "collectible-1satordinals", unitId: "collectible-1satordinals.coordinator-worker", runtime: "shared-worker", scopeKind: "owner-session" },
  { productId: "bsv-price", unitId: "bsv-price.window", runtime: "window-main", scopeKind: "owner-session" },
  { productId: "apps", unitId: "apps.window", runtime: "window-main", scopeKind: "root" },
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
    if (unit.runtime === "shared-worker" && !["root", "storage", "owner-session"].includes(unit.scopeKind)) {
      errors.push(`Coordinator Worker 单元 scopeKind 必须是 root、storage 或 owner-session: ${unit.unitId}`);
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
