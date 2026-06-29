// packages/plugin-assets/src/holdingsFlow.test.ts
// toHoldingRows 排序不变量回归测试。
//
// 关键不变量（施工单 004）：
//   1. asset 组永远排在 token 组前。
//   2. 组内先按 provider.order 升序；同 order 再按 provider 的 I18nText
//      业务 code（fallback）稳定排序；同 provider 再按 entry 的 label /
//      symbol 业务 code 升序。

import { describe, expect, it } from "vitest";
import type { AssetProvider, AssetSummary, TokenProvider, TokenSummary } from "@keymaster/contracts";
import {
  toHoldingRows,
  type AssetProviderLoadResult,
  type TokenProviderLoadResult
} from "./holdingsFlow.js";

const HOST = {
  i18n: {
    text: (t: unknown, fallback?: string) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && "fallback" in t) {
        return String((t as { fallback: unknown }).fallback);
      }
      return fallback ?? "";
    }
  }
};

function assetProvider(id: string, order: number | undefined, name: string): AssetProvider {
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order,
    kind: "coin",
    listAssets: () => Promise.resolve([]),
    getAsset: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    sync: () => Promise.resolve(),
    onChange: () => () => {}
  };
}

function tokenProvider(id: string, order: number | undefined, name: string): TokenProvider {
  return {
    id,
    name: { key: `${id}.name`, fallback: name },
    order,
    listTokens: () => Promise.resolve([]),
    getToken: () => Promise.resolve(undefined),
    listActivity: () => Promise.resolve([]),
    sync: () => Promise.resolve(),
    onChange: () => () => {}
  };
}

function assetResult(provider: AssetProvider, items: AssetSummary[]): AssetProviderLoadResult {
  return { provider, assets: items };
}

function tokenResult(provider: TokenProvider, items: TokenSummary[]): TokenProviderLoadResult {
  return { provider, tokens: items };
}

function makeAsset(provider: AssetProvider, assetId: string, label: string): AssetSummary {
  return {
    assetId,
    providerId: provider.id,
    kind: "coin",
    label,
    status: "ready"
  };
}

function makeToken(provider: TokenProvider, tokenId: string, symbol: string, label: string): TokenSummary {
  return {
    tokenId,
    providerId: provider.id,
    symbol,
    label,
    status: "ready"
  };
}

describe("toHoldingRows - 排序不变量", () => {
  it("asset 组永远在 token 组前", () => {
    const assetA = assetProvider("p2pkh", 0, "P2PKH");
    const tokenB = tokenProvider("bsv21", 1000, "BSV-21");
    const result = {
      assets: [assetResult(assetA, [makeAsset(assetA, "bsv", "BSV")])],
      tokens: [tokenResult(tokenB, [makeToken(tokenB, "t1", "T1", "T1 token")])]
    };
    const rows = toHoldingRows(HOST, result);
    expect(rows.length).toBe(2);
    expect(rows[0]!.kind).toBe("asset");
    expect(rows[1]!.kind).toBe("token");
  });

  it("组内先按 provider.order 升序", () => {
    const pLow = tokenProvider("stas", 10, "STAS");
    const pHigh = tokenProvider("bsv21", 100, "BSV-21");
    const result = {
      assets: [],
      tokens: [
        tokenResult(pHigh, [makeToken(pHigh, "t-hi", "HI", "Hi token")]),
        tokenResult(pLow, [makeToken(pLow, "t-lo", "LO", "Lo token")])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    expect(rows.map((r) => r.providerId)).toEqual(["stas", "bsv21"]);
  });

  it("同 order 时按 provider 名称（fallback 业务 code）稳定排序", () => {
    const a = tokenProvider("aaa", 50, "Aaa");
    const b = tokenProvider("bbb", 50, "Bbb");
    const result = {
      assets: [],
      tokens: [
        tokenResult(b, [makeToken(b, "t-b", "B", "B token")]),
        tokenResult(a, [makeToken(a, "t-a", "A", "A token")])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    expect(rows.map((r) => r.providerId)).toEqual(["aaa", "bbb"]);
  });

  it("同 provider 时按 entry label 升序", () => {
    const p = tokenProvider("bsv21", 0, "BSV-21");
    const result = {
      assets: [],
      tokens: [
        tokenResult(p, [
          makeToken(p, "t2", "Z", "Z token"),
          makeToken(p, "t1", "A", "A token")
        ])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    expect(rows.map((r) => r.itemId)).toEqual(["t1", "t2"]);
  });

  it("provider.order 缺省时按 0 处理", () => {
    const pNoOrder = tokenProvider("x", undefined, "X");
    const pOrdered = tokenProvider("y", 0, "Y");
    const result = {
      assets: [],
      tokens: [
        tokenResult(pOrdered, [makeToken(pOrdered, "t-y", "Y", "Y")]),
        tokenResult(pNoOrder, [makeToken(pNoOrder, "t-x", "X", "X")])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    // 两者 order 都按 0 处理；同 order 时按名称升序：X 在 Y 前。
    expect(rows.map((r) => r.providerId)).toEqual(["x", "y"]);
  });

  it("asset 与 token 内部独立排序，asset 整体仍在前", () => {
    const a1 = assetProvider("a-low", 10, "A-low");
    const a2 = assetProvider("a-hi", 100, "A-hi");
    const t1 = tokenProvider("t-low", 0, "T-low");
    const t2 = tokenProvider("t-hi", 1, "T-hi");
    const result = {
      assets: [
        assetResult(a2, [makeAsset(a2, "a2", "A2")]),
        assetResult(a1, [makeAsset(a1, "a1", "A1")])
      ],
      tokens: [
        tokenResult(t2, [makeToken(t2, "t2", "T2", "T2")]),
        tokenResult(t1, [makeToken(t1, "t1", "T1", "T1")])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    expect(rows.map((r) => `${r.kind}:${r.providerId}`)).toEqual([
      "asset:a-low",
      "asset:a-hi",
      "token:t-low",
      "token:t-hi"
    ]);
  });

  it("provider.name 为 I18nText 时按 fallback 而非 key 排序", () => {
    // 两个 provider 的 key 与 fallback 故意相反，验证排序用 fallback。
    const a = tokenProvider("p1", 0, "Z-name");
    const b = tokenProvider("p2", 0, "A-name");
    const result = {
      assets: [],
      tokens: [
        tokenResult(a, [makeToken(a, "t-a", "TA", "TA")]),
        tokenResult(b, [makeToken(b, "t-b", "TB", "TB")])
      ]
    };
    const rows = toHoldingRows(HOST, result);
    // fallback 业务 code 排序：A-name 在 Z-name 前。
    expect(rows.map((r) => r.providerId)).toEqual(["p2", "p1"]);
  });
});