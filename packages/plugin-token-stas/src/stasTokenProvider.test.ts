// packages/plugin-token-stas/src/stasTokenProvider.test.ts
// STAS TokenProvider 测试：
//   1. 同 symbol、不同 issuer 必须显示为两项
//   2. 同 issuer/symbol 的多地址余额应合并
//   3. 详情查询与 tokenId 解析正确
//   4. onChange 通知机制

import { describe, expect, it, vi } from "vitest";
import type { KeyspaceService, AssetDataNotifier } from "@keymaster/contracts";
import { createStasTokenProvider, makeStasTokenId, parseStasTokenId } from "./stasTokenProvider.js";
import type { StasDb, StasTokenSnapshot } from "./stasDb.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return { active: () => ({ activePublicKeyHex }) } as unknown as KeyspaceService;
}

function makeSnapshot(overrides: Partial<StasTokenSnapshot> & { symbol: string }): StasTokenSnapshot {
  return {
    symbol: overrides.symbol,
    network: "main",
    address: overrides.address ?? "addr1",
    balance: overrides.balance ?? 100,
    issuer: overrides.issuer ?? "",
    syncedAt: "2026-01-01T00:00:00Z",
  };
}

function fakeDb(snapshots: StasTokenSnapshot[]): StasDb {
  return {
    put: vi.fn(),
    replaceAll: vi.fn(),
    list: vi.fn().mockResolvedValue(snapshots),
    close: vi.fn(),
  };
}

describe("stasTokenProvider", () => {
  describe("makeStasTokenId / parseStasTokenId", () => {
    it("round-trips issuer + symbol", () => {
      expect(makeStasTokenId("issuer1", "SYM")).toBe("stas:issuer1:SYM");
      expect(parseStasTokenId("stas:issuer1:SYM")).toEqual({ issuer: "issuer1", symbol: "SYM" });
    });

    it("空 issuer 用 unknown 占位", () => {
      expect(makeStasTokenId("", "SYM")).toBe("stas:unknown:SYM");
      expect(parseStasTokenId("stas:unknown:SYM")).toEqual({ issuer: "", symbol: "SYM" });
    });

    it("无效 tokenId 返回 undefined", () => {
      expect(parseStasTokenId("invalid")).toBeUndefined();
      expect(parseStasTokenId("stas:")).toBeUndefined();
      expect(parseStasTokenId("stas:abc")).toBeUndefined();
    });
  });

  describe("listTokens", () => {
    it("同 symbol、不同 issuer 显示为两项", async () => {
      const snapshots = [
        makeSnapshot({ symbol: "TOK", issuer: "issuerA" }),
        makeSnapshot({ symbol: "TOK", issuer: "issuerB" }),
      ];
      const provider = createStasTokenProvider({
        db: fakeDb(snapshots),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });

      const tokens = await provider.listTokens();
      expect(tokens).toHaveLength(2);
      const first = tokens[0];
      const second = tokens[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first!.tokenId).toBe("stas:issuerA:TOK");
      expect(second!.tokenId).toBe("stas:issuerB:TOK");
    });

    it("同 issuer/symbol 的多地址余额合并", async () => {
      const snapshots = [
        makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr1", balance: 100 }),
        makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr2", balance: 200 }),
      ];
      const provider = createStasTokenProvider({
        db: fakeDb(snapshots),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });

      const tokens = await provider.listTokens();
      expect(tokens).toHaveLength(1);
      const only = tokens[0];
      if (!only) throw new Error("token not found");
      expect(only.balance!.amount).toBe(300);
    });

    it("无 active key 时返回空", async () => {
      const provider = createStasTokenProvider({
        db: fakeDb([]),
        keyspace: fakeKeyspace(undefined),
      });
      expect(await provider.listTokens()).toEqual([]);
    });
  });

  describe("getToken", () => {
    it("按 tokenId 筛选并聚合多地址余额", async () => {
      const snapshots = [
        makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr1", balance: 100 }),
        makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr2", balance: 200 }),
        makeSnapshot({ symbol: "OTHER", issuer: "iss", address: "addr1", balance: 50 }),
      ];
      const provider = createStasTokenProvider({
        db: fakeDb(snapshots),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });

      const tokenId = makeStasTokenId("iss", "TOK");
      const detail = await provider.getToken(tokenId);
      if (!detail) throw new Error("detail not found");
      expect(detail.summary.balance!.amount).toBe(300);
      expect(detail.extras!.balance).toBe(300);
      expect(detail.extras!.addresses).toHaveLength(2);
    });

    it("不存在的 token 返回 undefined", async () => {
      const provider = createStasTokenProvider({
        db: fakeDb([]),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });
      expect(await provider.getToken("stas:unknown:NOPE")).toBeUndefined();
    });

    it("无效 tokenId 返回 undefined", async () => {
      const provider = createStasTokenProvider({
        db: fakeDb([]),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });
      expect(await provider.getToken("invalid")).toBeUndefined();
    });
  });

  describe("onChange", () => {
    it("assetDataNotifier 通知 stas 时触发 onChange", () => {
      const listeners: Array<(event: { providerId: string }) => void> = [];
      const notifier = {
        emit: vi.fn(),
        subscribe: vi.fn((handler: (event: { providerId: string }) => void) => {
          listeners.push(handler);
          return () => {};
        }),
      };

      const handler = vi.fn();
      const provider = createStasTokenProvider({
        db: fakeDb([]),
        keyspace: fakeKeyspace(ACTIVE_PK),
        assetDataNotifier: notifier as unknown as AssetDataNotifier,
      });

      const off = provider.onChange(handler);

      const firstListener = listeners[0];
      if (!firstListener) throw new Error("no listener registered");
      firstListener({ providerId: "stas" });
      expect(handler).toHaveBeenCalledTimes(1);

      firstListener({ providerId: "bsv21" });
      expect(handler).toHaveBeenCalledTimes(1);

      off();
    });
  });
});
