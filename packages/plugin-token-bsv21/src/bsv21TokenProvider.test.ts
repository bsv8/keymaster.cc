// packages/plugin-token-bsv21/src/bsv21TokenProvider.test.ts
// BSV-21 TokenProvider 测试：
//   1. 多地址同 origin 的余额应合并
//   2. 详情页展示聚合余额和地址明细
//   3. 不存在 token 返回 undefined
//   4. 后台通知触发 onChange

import { describe, expect, it, vi } from "vitest";
import type { KeyspaceService, AssetDataNotifier } from "@keymaster/contracts";
import { createBsv21TokenProvider } from "./bsv21TokenProvider.js";
import type { Bsv21StateRepository, Bsv21TokenSnapshot } from "./storage/bsv21StateRepository.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return { active: () => ({ activePublicKeyHex }) } as unknown as KeyspaceService;
}

function makeSnapshot(overrides: Partial<Bsv21TokenSnapshot> & { origin: string }): Bsv21TokenSnapshot {
  return {
    origin: overrides.origin,
    network: "main",
    address: overrides.address ?? "addr1",
    outpoint: overrides.outpoint ?? `${overrides.origin}_0`,
    amount: overrides.amount ?? "110",
    observation: overrides.observation,
    canonicalTxid: overrides.canonicalTxid,
    meta: overrides.meta ?? { origin: overrides.origin, symbol: "TOK" },
    syncedAt: "2026-01-01T00:00:00Z",
  };
}

function fakeRepository(snapshots: Bsv21TokenSnapshot[]): Bsv21StateRepository {
  return {
    put: vi.fn(),
    replaceAll: vi.fn(),
    list: vi.fn().mockResolvedValue(snapshots),
    close: vi.fn(),
  };
}

describe("bsv21TokenProvider", () => {
  describe("listTokens", () => {
    it("聚合多地址同 origin 的余额", async () => {
      const snapshots = [
        makeSnapshot({ origin: "tok1", address: "addr1", amount: "110", observation: "unconfirmed", canonicalTxid: "tx1" }),
        makeSnapshot({ origin: "tok1", address: "addr2", amount: "220", outpoint: "tok1_1", observation: "confirmed", canonicalTxid: "tx2" }),
        makeSnapshot({ origin: "tok2", address: "addr1", amount: "55" }),
      ];
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository(snapshots),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });

      const tokens = await provider.listTokens();
      expect(tokens).toHaveLength(2);

      const tok1 = tokens.find((t) => t.tokenId === "tok1");
      if (!tok1) throw new Error("tok1 not found");
      expect(tok1.balance!.amount).toBe(330); // 100+10 + 200+20
      expect(tok1.balance!.display).toBe("330 TOK");
      expect(tok1.observation).toBe("unconfirmed");
      expect(tok1.canonicalTxid).toBe("tx1");

      const tok2 = tokens.find((t) => t.tokenId === "tok2");
      if (!tok2) throw new Error("tok2 not found");
      expect(tok2.balance!.amount).toBe(55); // 50+5
    });

    it("无 active key 时返回空", async () => {
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository([]),
        keyspace: fakeKeyspace(undefined),
      });
      expect(await provider.listTokens()).toEqual([]);
    });
  });

  describe("getToken", () => {
    it("聚合多地址的详情余额，extras 包含地址明细", async () => {
      const snapshots = [
        makeSnapshot({ origin: "tok1", address: "addr1", amount: "110", observation: "unconfirmed", canonicalTxid: "tx1" }),
        makeSnapshot({ origin: "tok1", address: "addr2", amount: "220", outpoint: "tok1_1", observation: "confirmed", canonicalTxid: "tx2" }),
      ];
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository(snapshots),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });

      const detail = await provider.getToken("tok1");
      if (!detail) throw new Error("detail not found");
      expect(detail.summary.balance!.amount).toBe(330);
      expect(detail.summary.balance!.display).toBe("330 TOK");
      expect(detail.summary.observation).toBe("unconfirmed");
      expect(detail.summary.canonicalTxid).toBe("tx1");
      expect(detail.extras!.amount).toBe("330");
      expect(detail.extras!.addresses).toHaveLength(2);
      expect(detail.extras!.observation).toBe("unconfirmed");
    });

    it("不存在的 token 返回 undefined", async () => {
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository([]),
        keyspace: fakeKeyspace(ACTIVE_PK),
      });
      expect(await provider.getToken("nonexistent")).toBeUndefined();
    });

    it("无 active key 时返回 undefined", async () => {
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository([]),
        keyspace: fakeKeyspace(undefined),
      });
      expect(await provider.getToken("tok1")).toBeUndefined();
    });
  });

  describe("onChange", () => {
    it("assetDataNotifier 通知 bsv21 时触发 onChange", () => {
      const listeners: Array<(event: { providerId: string }) => void> = [];
      const notifier = {
        emit: vi.fn(),
        subscribe: vi.fn((handler: (event: { providerId: string }) => void) => {
          listeners.push(handler);
          return () => {};
        }),
      };

      const handler = vi.fn();
      const provider = createBsv21TokenProvider({
        stateRepository: fakeRepository([]),
        keyspace: fakeKeyspace(ACTIVE_PK),
        assetDataNotifier: notifier as unknown as AssetDataNotifier,
      });

      const off = provider.onChange(handler);
      expect(notifier.subscribe).toHaveBeenCalled();

      // 触发 bsv21 通知
      const firstListener = listeners[0];
      if (!firstListener) throw new Error("no listener registered");
      firstListener({ providerId: "bsv21" });
      expect(handler).toHaveBeenCalledTimes(1);

      // 非 bsv21 通知不触发
      firstListener({ providerId: "p2pkh" });
      expect(handler).toHaveBeenCalledTimes(1);

      off();
    });
  });
});
