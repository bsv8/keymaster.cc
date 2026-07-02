// packages/contracts/src/appmsgBind.test.ts
// canonicalBindText 单测：分隔符 / 顺序 / 数字格式。
//
// 关键约束：与 HubMsg `internal/ws/bind.go` 的 `CanonicalBindText`
// 必须 bit 级一致；任何一边修改必须同步另一边。
import { describe, expect, it } from "vitest";
import { canonicalBindText } from "./appmsgBind.js";

describe("canonicalBindText", () => {
  it("pipes 4 fields in fixed order", () => {
    expect(canonicalBindText("a", "b", "c", 123)).toBe("a|b|c|123");
  });

  it("does not pad zeros on issuedAtMs", () => {
    // 大数 / 13 位 unix ms 不能前导零
    expect(canonicalBindText("sid", "nonce", "02ff00ff00", 1700000000123)).toBe(
      "sid|nonce|02ff00ff00|1700000000123"
    );
  });

  it("treats zero as '0', not empty", () => {
    expect(canonicalBindText("sid", "nonce", "02ab", 0)).toBe("sid|nonce|02ab|0");
  });

  it("rejects NaN / Infinity / negative / non-integer issuedAtMs", () => {
    expect(() => canonicalBindText("a", "b", "c", Number.NaN)).toThrow();
    expect(() => canonicalBindText("a", "b", "c", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalBindText("a", "b", "c", -1)).toThrow();
    expect(() => canonicalBindText("a", "b", "c", 1.5)).toThrow();
  });

  it("preserves sessionId / nonce / publicKeyHex verbatim", () => {
    const sid = "0123456789abcdef0123456789abcdef";
    const nonce = "ffeeddccbbaa99887766554433221100";
    const pub = "02e6b8034abd0fa323bb50166cde541d81864c3329304e6a4449490758c5ca03a2";
    expect(canonicalBindText(sid, nonce, pub, 1)).toBe(
      `${sid}|${nonce}|${pub}|1`
    );
  });
});