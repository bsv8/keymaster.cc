// packages/contracts/src/background.test.ts
// 同步间隔契约测试：预设只是快捷入口，合法值判定必须覆盖自定义整秒区间。

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SYNC_MAX_CUSTOM_INTERVAL_MS,
  BACKGROUND_SYNC_MIN_CUSTOM_INTERVAL_MS,
  BACKGROUND_SYNC_PRESET_OPTIONS_MS,
  isValidBackgroundSyncIntervalMs,
  normalizeBackgroundSyncSecondsToMs,
} from "./background.js";

describe("同步间隔合法值", () => {
  it("预设全部合法，0 表示关闭", () => {
    for (const preset of BACKGROUND_SYNC_PRESET_OPTIONS_MS) {
      expect(isValidBackgroundSyncIntervalMs(preset)).toBe(true);
    }
    expect(BACKGROUND_SYNC_PRESET_OPTIONS_MS).toEqual([30_000, 60_000, 120_000, 300_000, 0]);
  });

  it("接受 10 秒～24 小时之间的任意整秒自定义值", () => {
    expect(isValidBackgroundSyncIntervalMs(10_000)).toBe(true);
    expect(isValidBackgroundSyncIntervalMs(45_000)).toBe(true);
    expect(isValidBackgroundSyncIntervalMs(7_200_000)).toBe(true);
    expect(isValidBackgroundSyncIntervalMs(BACKGROUND_SYNC_MAX_CUSTOM_INTERVAL_MS)).toBe(true);
  });

  it("拒绝非整秒、超界与非数字", () => {
    expect(isValidBackgroundSyncIntervalMs(9_000)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(12_345)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(BACKGROUND_SYNC_MAX_CUSTOM_INTERVAL_MS + 1_000)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(-30_000)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(Number.NaN)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs("60000")).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(undefined)).toBe(false);
    expect(isValidBackgroundSyncIntervalMs(BACKGROUND_SYNC_MIN_CUSTOM_INTERVAL_MS - 1)).toBe(false);
  });
});

describe("用户输入秒数归一化", () => {
  it("整秒输入转成毫秒并四舍五入", () => {
    expect(normalizeBackgroundSyncSecondsToMs(45)).toBe(45_000);
    expect(normalizeBackgroundSyncSecondsToMs(45.4)).toBe(45_000);
    expect(normalizeBackgroundSyncSecondsToMs(45.6)).toBe(46_000);
  });

  it("非法输入返回 undefined，而不是静默夹到边界", () => {
    expect(normalizeBackgroundSyncSecondsToMs(9)).toBeUndefined();
    expect(normalizeBackgroundSyncSecondsToMs(86_401)).toBeUndefined();
    expect(normalizeBackgroundSyncSecondsToMs(Number.NaN)).toBeUndefined();
    expect(normalizeBackgroundSyncSecondsToMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeBackgroundSyncSecondsToMs("45")).toBeUndefined();
    expect(normalizeBackgroundSyncSecondsToMs(undefined)).toBeUndefined();
  });
});
