// packages/plugin-token-bsv21/src/bsv21TokenProvider.ts
// BSV-21 TokenProvider：从 snapshot DB 读取，注入 token.registry。
//
// 设计缘由：
//   - listTokens / getToken 只读 snapshot DB，不访问 WOC。
//   - 后台 task 通过 bsv21Sync 写入 DB，页面通过 onChange 重读。
//   - 同一 token（origin）可能被多个地址持有，需要按 origin 聚合余额。
//   - 列表稳定排序：按 origin 升序。
//   - DB 已按 active key namespace 隔离，不需要传 publicKeyHex。

import type {
  AssetDataNotifier,
  KeyspaceService,
  TokenActivity,
  TokenDetail,
  TokenProvider,
  TokenSummary
} from "@keymaster/contracts";
import type { Bsv21Db, Bsv21TokenSnapshot } from "./bsv21Db.js";

export interface Bsv21TokenProviderOptions {
  db: Bsv21Db;
  keyspace: KeyspaceService;
  assetDataNotifier?: AssetDataNotifier;
}

export function createBsv21TokenProvider(options: Bsv21TokenProviderOptions): TokenProvider {
  if (!options || !options.db || !options.keyspace) {
    throw new Error("createBsv21TokenProvider: db and keyspace are required");
  }
  const { db, keyspace, assetDataNotifier } = options;
  const listeners = new Set<() => void>();
  let offNotifier: (() => void) | undefined;

  function notify() {
    for (const l of [...listeners]) {
      try { l(); } catch { /* 静默 */ }
    }
  }

  // 订阅 assetDataNotifier：收到 bsv21 provider 的 data-changed 后通知本地订阅者。
  if (assetDataNotifier) {
    offNotifier = assetDataNotifier.subscribe((event) => {
      if (event.providerId === "bsv21") {
        notify();
      }
    });
  }

  function summaryOf(
    s: Bsv21TokenSnapshot,
    aggregated: bigint
  ): TokenSummary {
    const amount = aggregated.toString();
    return {
      tokenId: s.origin,
      providerId: "bsv21",
      symbol: s.meta.symbol ?? s.origin.slice(0, 8),
      label: s.meta.symbol ? s.meta.symbol : `BSV-21 ${s.origin.slice(0, 8)}…`,
      network: s.network,
      balance: {
        amount: toSafeNumber(aggregated),
        unit: s.meta.symbol ?? "TOK",
        display: `${amount} ${s.meta.symbol ?? "TOK"}`
      },
      status: "ready",
      issuer: s.meta.issuer,
      decimals: s.meta.decimals,
      tags: ["bsv21", s.network]
    };
  }

  return {
    id: "bsv21",
    name: { key: "bsv21.provider.name", fallback: "BSV-21" },
    order: 10,

    async listTokens(): Promise<TokenSummary[]> {
      // 无 active key 时返回空（不抛错）
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return [];

      // DB 操作隐式使用当前 active key 的 namespace
      const snapshots = await db.list();

      // 按 origin 聚合多地址的 unspent 金额
      const aggregated = new Map<string, {
        snapshot: Bsv21TokenSnapshot;
        amount: bigint;
      }>();
      for (const s of snapshots) {
        const existing = aggregated.get(s.origin);
        const amount = parseAmount(s.amount);
        if (existing) {
          existing.amount += amount;
        } else {
          aggregated.set(s.origin, {
            snapshot: s,
            amount,
          });
        }
      }

      const out: TokenSummary[] = [];
      for (const entry of aggregated.values()) {
        out.push(summaryOf(entry.snapshot, entry.amount));
      }
      out.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
      return out;
    },

    async getToken(tokenId): Promise<TokenDetail | undefined> {
      // 无 active key 时返回 undefined
      const state = keyspace.active();
      if (!state.activePublicKeyHex) return undefined;

      // DB 操作隐式使用当前 active key 的 namespace
      const snapshots = await db.list();
      const matching = snapshots.filter((s) => s.origin === tokenId);
      if (matching.length === 0) return undefined;
      const first = matching[0];
      if (!first) return undefined;

      // 聚合多地址的 unspent 余额
      let aggregated = 0n;
      const addresses: Array<{ address: string; network: string; amount: string }> = [];
      for (const s of matching) {
        const amount = parseAmount(s.amount);
        aggregated += amount;
        addresses.push({
          address: s.address,
          network: s.network,
          amount: s.amount,
        });
      }

      return {
        summary: summaryOf(first, aggregated),
        activities: [],
        extras: {
          origin: tokenId,
          amount: aggregated.toString(),
          addresses,
        }
      };
    },

    async listActivity(): Promise<TokenActivity[]> {
      // phase 1：BSV-21 activity 端点未在 WOC 文档稳定，phase 1 返回空。
      return [];
    },

    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    dispose() {
      offNotifier?.();
      offNotifier = undefined;
    }
  };
}

function parseAmount(amount: string): bigint {
  if (!/^[0-9]+$/.test(amount)) {
    throw new Error("BSV-21 amount must be a decimal string");
  }
  return BigInt(amount);
}

function toSafeNumber(value: bigint): number {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return Number.MAX_SAFE_INTEGER;
}
