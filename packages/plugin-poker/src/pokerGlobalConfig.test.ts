// 验证 Poker 全局配置的默认值与 K-V 输入归一化规则。

import { describe, expect, it } from "vitest";
import { defaultGlobalPokerConfig, normalizePokerConfig } from "./pokerGlobalConfig.js";

describe("pokerGlobalConfig", () => {
  it("default config has empty proxyEndpoint (fail-closed)", () => {
    expect(defaultGlobalPokerConfig().proxyEndpoint).toBe("");
    expect(defaultGlobalPokerConfig().allowFallbackBroadcast).toBe(true);
  });

  it("normalizePokerConfig falls back to default for non-object input", () => {
    expect(normalizePokerConfig(null)).toEqual(defaultGlobalPokerConfig());
    expect(normalizePokerConfig("xxx")).toEqual(defaultGlobalPokerConfig());
    expect(normalizePokerConfig(42)).toEqual(defaultGlobalPokerConfig());
  });

  it("normalizePokerConfig falls back per-field for bad types", () => {
    const got = normalizePokerConfig({
      proxyEndpoint: 123,
      allowFallbackBroadcast: "yes"
    });
    expect(got.proxyEndpoint).toBe(defaultGlobalPokerConfig().proxyEndpoint);
    expect(got.allowFallbackBroadcast).toBe(defaultGlobalPokerConfig().allowFallbackBroadcast);
  });
});
