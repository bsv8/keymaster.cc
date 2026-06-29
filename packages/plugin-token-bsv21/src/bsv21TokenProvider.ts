// packages/plugin-token-bsv21/src/bsv21TokenProvider.ts
// BSV-21 TokenProvider：聚合 bsv21Service 的 listActiveKeyTokens 为
// TokenSummary / TokenDetail，注入 token.registry。
//
// 设计缘由：
//   - phase 1 仅暴露列表 + 余额 + 详情；不做 transfer。
//   - 列表稳定排序：按 origin 升序，避免同一 origin 出现多次（同一
//     key 在 main / test 多个地址都持有时合并为一条）。

import type {
  TokenActivity,
  TokenDetail,
  TokenProvider,
  TokenSummary
} from "@keymaster/contracts";
import type { Bsv21ServiceHandle, TokenWithMeta } from "./bsv21Service.js";

export interface Bsv21TokenProviderOptions {
  service: Bsv21ServiceHandle;
}

export function createBsv21TokenProvider(options: Bsv21TokenProviderOptions): TokenProvider {
  if (!options || !options.service) {
    throw new Error("createBsv21TokenProvider: service is required");
  }
  const service = options.service;
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  function summaryOf(t: TokenWithMeta): TokenSummary {
    return {
      tokenId: t.meta.origin,
      providerId: "bsv21",
      symbol: t.meta.symbol ?? t.meta.origin.slice(0, 8),
      label: t.meta.symbol ? t.meta.symbol : `BSV-21 ${t.meta.origin.slice(0, 8)}…`,
      network: t.network,
      balance: {
        amount: t.balance.confirmed + t.balance.unconfirmed,
        unit: t.meta.symbol ?? "TOK",
        display: `${t.balance.confirmed + t.balance.unconfirmed} ${t.meta.symbol ?? "TOK"}`
      },
      status: "ready",
      issuer: t.meta.issuer,
      decimals: t.meta.decimals,
      tags: ["bsv21", t.network]
    };
  }

  let cached: TokenWithMeta[] = [];
  let cacheAt = 0;
  const CACHE_TTL_MS = 1000;
  // 简单内存缓存：1 秒内多次 listTokens 复用上一次结果，避免对 WOC 重复打。
  function isFresh(): boolean {
    return Date.now() - cacheAt <= CACHE_TTL_MS;
  }

  return {
    id: "bsv21",
    name: { key: "bsv21.provider.name", fallback: "BSV-21" },
    order: 10,

    async listTokens(): Promise<TokenSummary[]> {
      let items = cached;
      if (!isFresh()) {
        items = await service.listActiveKeyTokens();
        cached = items;
        cacheAt = Date.now();
      }
      // 合并：同一 origin 选第一条（保持稳定）。
      const seen = new Set<string>();
      const out: TokenSummary[] = [];
      for (const t of items) {
        if (seen.has(t.meta.origin)) continue;
        seen.add(t.meta.origin);
        out.push(summaryOf(t));
      }
      out.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
      return out;
    },

    async getToken(tokenId): Promise<TokenDetail | undefined> {
      const got = await service.getToken(tokenId);
      if (!got) return undefined;
      return {
        summary: {
          tokenId: got.meta.origin,
          providerId: "bsv21",
          symbol: got.meta.symbol ?? got.meta.origin.slice(0, 8),
          label: got.meta.symbol ? got.meta.symbol : `BSV-21 ${got.meta.origin.slice(0, 8)}…`,
          issuer: got.meta.issuer,
          decimals: got.meta.decimals,
          status: "ready"
        },
        activities: [],
        extras: { origin: got.meta.origin, confirmed: got.balance.confirmed, unconfirmed: got.balance.unconfirmed }
      };
    },

    async listActivity(): Promise<TokenActivity[]> {
      // phase 1：BSV-21 activity 端点未在 WOC 文档稳定，phase 1 返回空。
      // 后续接入 activity 端点时再扩展。
      return [];
    },

    async sync(): Promise<void> {
      // 简单 invalidate：清缓存 + 通知订阅者。
      cached = [];
      cacheAt = 0;
      emit();
    },

    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}