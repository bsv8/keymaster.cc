// packages/contracts/src/wocTokens.test.ts
// toWocOutpoint 翻译函数回归测试。
//
// 关键不变量：WOC 1Sat endpoint 使用的 outpoint 字符串是 "txid_vout"
// （下划线），不是 "txid:vout"。本 helper 是契约层对外暴露的
// 唯一翻译入口；任何业务插件要向 1Sat 发请求都必须用它构造 outpoint。

import { describe, expect, it } from "vitest";
import { toWocOutpoint } from "./wocTokens.js";

describe("toWocOutpoint", () => {
  it("txid + vout 拼成 'txid_vout'（下划线）", () => {
    expect(toWocOutpoint("abcdef", 0)).toBe("abcdef_0");
    expect(toWocOutpoint("abcdef", 7)).toBe("abcdef_7");
  });

  it("保留 txid 的原始大小写（不归一化）", () => {
    // 翻译函数只负责格式拼接，不做归一化；归一化由 actor 内部统一处理。
    expect(toWocOutpoint("AABBCC", 0)).toBe("AABBCC_0");
  });

  it("vout 为 0 时仍保留下划线", () => {
    expect(toWocOutpoint("txid", 0)).toBe("txid_0");
  });
});