// packages/plugin-token-stas/src/stasTokenProvider.ts
// STAS TokenProvider：从 snapshot DB 读取，注入 token.registry。
//
// 设计缘由：
//   - listTokens / getToken 只读 snapshot DB，不访问 WOC。
//   - 后台 task 通过 stasSync 写入 DB，页面通过 onChange 重读。
//   - phase 1 只支持主网 STAS；零或负值不进入统一持仓页。
//   - 同 issuer+symbol 的多地址余额需要聚合。
//   - tokenId 使用稳定形式 `stas:${issuer}:${symbol}`，避免不同发行方
//     同名 symbol 相互覆盖。
//   - 列表稳定排序：按 tokenId 升序。

import type {
  AssetDataNotifier,
  KeyspaceService,
  TokenActivity,
  TokenDetail,
  TokenProvider,
  TokenSummary
} from "@keymaster/contracts";
import type { StasDb, StasTokenSnapshot } from "./stasDb.js";

export interface StasTokenProviderOptions {
  db: StasDb;
  keyspace: KeyspaceService;
  assetDataNotifier?: AssetDataNotifier;
}

/**
 * 生成稳定的 tokenId。
 * 设计缘由：issuer + symbol 唯一标识一个 STAS 资产。
 * issuer 为空时用 "unknown" 占位，保证 tokenId 格式稳定。
 */
export function makeStasTokenId(issuer: string, symbol: string): string {
  return `stas:${issuer || "unknown"}:${symbol}`;
}

/**
 * 从 tokenId 解析出 issuer 和 symbol。
 */
export function parseStasTokenId(tokenId: string): { issuer: string; symbol: string } | undefined {
  if (!tokenId.startsWith("stas:")) return undefined;
  const rest = tokenId.slice("stas:".length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return undefined;
  const issuer = rest.slice(0, colonIdx);
  const symbol = rest.slice(colonIdx + 1);
  if (!symbol) return undefined;
  return { issuer: issuer === "unknown" ? "" : issuer, symbol };
}

export function createStasTokenProvider(options: StasTokenProviderOptions): TokenProvider {
  if (!options || !options.db || !options.keyspace) {
    throw new Error("createStasTokenProvider: db and keyspace are required");
  }
  const { db, keyspace, assetDataNotifier } = options;
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of [...listeners]) {
      try { l(); } catch { /* 静默 */ }
    }
  }

  // 订阅 assetDataNotifier：收到 stas provider 的 data-changed 后通知本地订阅者。
  if (assetDataNotifier) {
    assetDataNotifier.subscribe((event) => {
      if (event.providerId === "stas") {
        notify();
      }
    });
  }

  /** 聚合键：issuer + symbol。 */
  function aggregateKey(s: StasTokenSnapshot): string {
    return `${s.issuer || ""}:${s.symbol}`;
  }

  function summaryOf(tokenId: string, s: StasTokenSnapshot, aggregatedBalance: number): TokenSummary {
    return {
      tokenId,
      providerId: "stas",
      symbol: s.symbol,
      label: `STAS ${s.symbol}`,
      network: s.network,
      balance: {
        amount: aggregatedBalance,
        unit: s.symbol,
        display: `${aggregatedBalance} ${s.symbol}`
      },
      status: "ready",
      issuer: s.issuer || undefined,
      tags: ["stas", "main"]
    };
  }

  return {
    id: "stas",
    name: { key: "stas.provider.name", fallback: "STAS" },
    order: 20,

    async listTokens(): Promise<TokenSummary[]> {
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return [];

      const snapshots = await db.listByPublicKey(state.activePublicKeyHex);

      // 按 issuer+symbol 聚合多地址的余额
      const aggregated = new Map<string, {
        snapshot: StasTokenSnapshot;
        balance: number;
      }>();
      for (const s of snapshots) {
        const key = aggregateKey(s);
        const existing = aggregated.get(key);
        if (existing) {
          existing.balance += s.balance;
        } else {
          aggregated.set(key, {
            snapshot: s,
            balance: s.balance,
          });
        }
      }

      const out: TokenSummary[] = [];
      for (const [, entry] of aggregated) {
        const tokenId = makeStasTokenId(entry.snapshot.issuer, entry.snapshot.symbol);
        out.push(summaryOf(tokenId, entry.snapshot, entry.balance));
      }
      out.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
      return out;
    },

    async getToken(tokenId): Promise<TokenDetail | undefined> {
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return undefined;

      // 从 listByPublicKey 结果中按 tokenId 筛选并聚合
      const parsed = parseStasTokenId(tokenId);
      if (!parsed) return undefined;

      const snapshots = await db.listByPublicKey(state.activePublicKeyHex);
      const matching = snapshots.filter(
        (s) => (s.issuer || "") === parsed.issuer && s.symbol === parsed.symbol
      );
      if (matching.length === 0) return undefined;
      const first = matching[0];
      if (!first) return undefined;

      // 聚合多地址余额
      let aggregatedBalance = 0;
      const addresses: Array<{ address: string; network: string; balance: number }> = [];
      for (const s of matching) {
        aggregatedBalance += s.balance;
        addresses.push({ address: s.address, network: s.network, balance: s.balance });
      }

      return {
        summary: summaryOf(tokenId, first, aggregatedBalance),
        activities: [],
        extras: {
          issuer: first.issuer || undefined,
          balance: aggregatedBalance,
          addresses,
        }
      };
    },

    async listActivity(): Promise<TokenActivity[]> {
      // phase 1：STAS activity 端点未稳定，phase 1 返回空。
      return [];
    },

    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}