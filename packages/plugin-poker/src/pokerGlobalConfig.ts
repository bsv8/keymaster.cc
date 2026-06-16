// packages/plugin-poker/src/pokerGlobalConfig.ts
// Poker 全局网络配置（与具体 key 无关）的持久化层。
//
// 设计缘由（硬切换 004）：
//   - proxyEndpoint / 双平面 announce endpoint / fallback broadcast 开关
//     都属于"全局网络偏好"，不能继续跟着某把 key 走：切 active key 不应
//     让用户重填 endpoint，也不应让 service 把"全局配置"塞进任何一把
//     key 的 key-scoped namespace DB。
//   - 本模块用 localStorage 作为持久化载体（plugin 级全局，不需要跨设备
//     同步；同浏览器同 profile 即视为同一会话）。如果未来需要跨 profile /
//     跨设备同步，可以替换为 plugin 级全局 IndexedDB，但必须保持"全局"
//     这一真值属性。
//   - 该模块被 pokerService 在启动时一次性 hydrate，在 settings 页保存时
//     写回；与 key-scoped IDB 完全解耦。

import type { PokerSettings } from "@keymaster/contracts";

/** localStorage 中 Poker 全局配置的键名。设计缘由：plugin-poker 独占。 */
export const POKER_GLOBAL_CONFIG_STORAGE_KEY = "keymaster.plugin-poker.globalConfig.v1";

/**
 * 全局配置默认值；首次启动 / 读不到时返回。
 *
 * 设计缘由：`proxyEndpoint` 默认空串——fail-closed 的配置起点：必须
 * 用户在设置页显式填入才能 connect。
 */
export function defaultGlobalPokerConfig(): PokerSettings {
  return {
    proxyEndpoint: "",
    announceP2PNodeEndpoint: "",
    announceTxLinkEndpoint: "",
    allowFallbackBroadcast: true
  };
}

/**
 * 把任意对象视作 PokerSettings 形状归一化：缺省字段补默认值，类型错误的
 * 字段降级到默认（而不是抛错；UI 输入可能存在中间态）。
 *
 * 设计缘由：localStorage 可能被旧版本 / 测试 / 其它 tab 写入半成品 schema；
 * 读取时必须容错；不允许一个坏值把整个 Poker service 顶住。
 */
export function normalizePokerConfig(raw: unknown): PokerSettings {
  const fallback = defaultGlobalPokerConfig();
  if (!raw || typeof raw !== "object") return { ...fallback };
  const r = raw as Partial<PokerSettings> & Record<string, unknown>;
  return {
    proxyEndpoint: typeof r.proxyEndpoint === "string" ? r.proxyEndpoint : fallback.proxyEndpoint,
    announceP2PNodeEndpoint:
      typeof r.announceP2PNodeEndpoint === "string"
        ? r.announceP2PNodeEndpoint
        : fallback.announceP2PNodeEndpoint,
    announceTxLinkEndpoint:
      typeof r.announceTxLinkEndpoint === "string"
        ? r.announceTxLinkEndpoint
        : fallback.announceTxLinkEndpoint,
    allowFallbackBroadcast:
      typeof r.allowFallbackBroadcast === "boolean"
        ? r.allowFallbackBroadcast
        : fallback.allowFallbackBroadcast
  };
}

/**
 * 从 localStorage 读取 Poker 全局配置；读不到 / parse 失败 / schema 缺字段
 * 时返回归一化默认值。
 *
 * 设计缘由：硬切换 004 之前 settings 写在 key-scoped DB；现在迁到
 * localStorage。对旧 key-scoped settings 的迁移在 pokerDb.ts 的迁移路径
 * 里完成（只从"当前 active key 的旧 DB"迁一次），不再回写 key-scoped。
 */
export function readPokerGlobalConfig(): PokerSettings {
  if (typeof localStorage === "undefined") return defaultGlobalPokerConfig();
  try {
    const raw = localStorage.getItem(POKER_GLOBAL_CONFIG_STORAGE_KEY);
    if (!raw) return defaultGlobalPokerConfig();
    const parsed = JSON.parse(raw);
    return normalizePokerConfig(parsed);
  } catch {
    return defaultGlobalPokerConfig();
  }
}

/**
 * 把 Poker 全局配置写入 localStorage。
 *
 * 设计缘由：硬切换 004 的网络配置全部走全局持久化；任何 setting 写盘
 * 都走这一函数，避免零散字符串拼接出错。失败仅 swallow（设置页 UI
 * 已经反映新值；下次 hydrate 会兜底）。
 */
export function writePokerGlobalConfig(settings: PokerSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    const normalized = normalizePokerConfig(settings);
    localStorage.setItem(POKER_GLOBAL_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // swallow：localStorage 配额满 / 隐私模式禁用等情况下不抛
  }
}

/**
 * 清空 Poker 全局配置（诊断 / 测试用）。生产代码不调用。
 */
export function clearPokerGlobalConfig(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(POKER_GLOBAL_CONFIG_STORAGE_KEY);
  } catch {
    // swallow
  }
}
