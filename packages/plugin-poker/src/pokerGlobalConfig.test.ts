// packages/plugin-poker/src/pokerGlobalConfig.test.ts
// 验证硬切换 004 后全局网络配置的持久化层：
//   - 读不到时返回默认值（proxyEndpoint 空）；
//   - 写入 / 读出 round-trip 一致；
//   - 容错：localStorage 写了半成品 schema 时归一化；
//   - 容错：localStorage 写了坏 JSON 时返回默认值；
//   - clearPokerGlobalConfig 后再读为默认值。

import { beforeEach, describe, expect, it } from "vitest";
import {
  POKER_GLOBAL_CONFIG_STORAGE_KEY,
  clearPokerGlobalConfig,
  defaultGlobalPokerConfig,
  normalizePokerConfig,
  readPokerGlobalConfig,
  writePokerGlobalConfig
} from "./pokerGlobalConfig.js";

beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("pokerGlobalConfig", () => {
  it("default config has empty proxyEndpoint (fail-closed)", () => {
    expect(defaultGlobalPokerConfig().proxyEndpoint).toBe("");
    expect(defaultGlobalPokerConfig().allowFallbackBroadcast).toBe(true);
  });

  it("read returns default when storage is empty", () => {
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("");
  });

  it("write + read round-trip preserves all fields", () => {
    writePokerGlobalConfig({
      proxyEndpoint: "wss://x",
      announceP2PNodeEndpoint: "node:1",
      announceTxLinkEndpoint: "tx:1",
      allowFallbackBroadcast: false
    });
    const got = readPokerGlobalConfig();
    expect(got.proxyEndpoint).toBe("wss://x");
    expect(got.announceP2PNodeEndpoint).toBe("node:1");
    expect(got.announceTxLinkEndpoint).toBe("tx:1");
    expect(got.allowFallbackBroadcast).toBe(false);
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

  it("read tolerates malformed JSON", () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(POKER_GLOBAL_CONFIG_STORAGE_KEY, "{not-json");
    }
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("");
  });

  it("clearPokerGlobalConfig restores default state", () => {
    writePokerGlobalConfig({ ...defaultGlobalPokerConfig(), proxyEndpoint: "wss://y" });
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("wss://y");
    clearPokerGlobalConfig();
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("");
  });
});
