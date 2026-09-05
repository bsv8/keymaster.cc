// packages/plugin-poker/src/pokerGlobalConfig.ts
// Poker 全局网络配置（与具体 key 无关）的持久化层。
//
// 设计缘由（硬切换 004）：
//   - proxyEndpoint / 双平面 announce endpoint / fallback broadcast 开关
//     都属于"全局网络偏好"，不能继续跟着某把 key 走：切 active key 不应
//     让用户重填 endpoint，也不应让 service 把"全局配置"塞进任何一把
//     key 的 key-scoped namespace K-V。
//   - 本模块只负责默认值和 K-V 值归一化；持久化由 Host 注入的
//     Poker owner/App K-V 句柄负责。

import type { PokerSettings } from "@keymaster/contracts";

/** K-V 中的相对配置键。 */
export const POKER_GLOBAL_CONFIG_STORAGE_KEY = "settings";

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
 * 设计缘由：平台 K-V 可能被外部因素写入半成品 schema；
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
