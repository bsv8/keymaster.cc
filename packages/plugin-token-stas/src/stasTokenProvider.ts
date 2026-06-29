// packages/plugin-token-stas/src/stasTokenProvider.ts
// STAS TokenProvider：聚合 stasService 的 listActiveKeyTokens 为
// TokenSummary / TokenDetail，注入 token.registry。
//
// 特殊约束（施工单）：
//   - phase 1 只支持主网 STAS；零或负值不进入统一持仓页。
//   - 列表稳定排序：按 symbol 升序。

import type {
  TokenActivity,
  TokenDetail,
  TokenProvider,
  TokenSummary
} from "@keymaster/contracts";
import type { StasServiceHandle, StasTokenWithEntry } from "./stasService.js";

export interface StasTokenProviderOptions {
  service: StasServiceHandle;
}

export function createStasTokenProvider(options: StasTokenProviderOptions): TokenProvider {
  if (!options || !options.service) {
    throw new Error("createStasTokenProvider: service is required");
  }
  const service = options.service;
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  function summaryOf(t: StasTokenWithEntry): TokenSummary {
    return {
      tokenId: `stas:${t.entry.symbol}`,
      providerId: "stas",
      symbol: t.entry.symbol,
      label: `STAS ${t.entry.symbol}`,
      network: t.network,
      balance: {
        amount: t.entry.balance,
        unit: t.entry.symbol,
        display: `${t.entry.balance} ${t.entry.symbol}`
      },
      status: "ready",
      issuer: t.entry.issuer,
      tags: ["stas", "main"]
    };
  }

  return {
    id: "stas",
    name: { key: "stas.provider.name", fallback: "STAS" },
    order: 20,

    async listTokens(): Promise<TokenSummary[]> {
      const items = await service.listActiveKeyTokens();
      // 阶段 1 约束：零或负值不进入统一持仓页。
      const positive = items.filter((t) => Number.isFinite(t.entry.balance) && t.entry.balance > 0);
      // 合并：同一 symbol 选第一条（保持稳定）。
      const seen = new Set<string>();
      const out: TokenSummary[] = [];
      for (const t of positive) {
        if (seen.has(t.entry.symbol)) continue;
        seen.add(t.entry.symbol);
        out.push(summaryOf(t));
      }
      out.sort((a, b) => a.symbol.localeCompare(b.symbol));
      return out;
    },

    async getToken(tokenId): Promise<TokenDetail | undefined> {
      const items = await service.listActiveKeyTokens();
      const symbol = tokenId.startsWith("stas:") ? tokenId.slice("stas:".length) : tokenId;
      const hit = items.find((t) => t.entry.symbol === symbol);
      if (!hit) return undefined;
      return {
        summary: summaryOf(hit),
        activities: [],
        extras: { issuer: hit.entry.issuer, balance: hit.entry.balance, address: hit.address }
      };
    },

    async listActivity(): Promise<TokenActivity[]> {
      // phase 1：STAS activity 端点未稳定，phase 1 返回空。
      return [];
    },

    async sync(): Promise<void> {
      emit();
    },

    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}