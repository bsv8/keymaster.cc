// packages/contracts/src/autolock.test.ts
// 自动锁契约边界测试：预设/缺省/上下限（24 小时封顶，24 小时后就是永不）。
import { describe, expect, it } from "vitest";
import {
  AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  AUTO_LOCK_MAX_CUSTOM_MINUTES,
  AUTO_LOCK_MAX_CUSTOM_TIMEOUT_MS,
  AUTO_LOCK_NEVER_TIMEOUT_MS,
  AUTO_LOCK_PRESET_OPTIONS_MS,
  AUTO_LOCK_TIMEOUT_24_HOUR_MS,
  isValidAutoLockTimeoutMs,
  normalizeAutoLockMinutesToMs,
  normalizeAutoLockTimeoutMs,
} from "./autolock.js";

describe("autolock contract bounds", () => {
  it("缺省 5 分钟，预设含 24 小时且以 24 小时收尾", () => {
    expect(AUTO_LOCK_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect([...AUTO_LOCK_PRESET_OPTIONS_MS]).toEqual([
      2 * 60 * 1000,
      5 * 60 * 1000,
      15 * 60 * 1000,
      24 * 60 * 60 * 1000,
    ]);
    expect(AUTO_LOCK_TIMEOUT_24_HOUR_MS).toBe(AUTO_LOCK_MAX_CUSTOM_TIMEOUT_MS);
  });

  it("24 小时合法，超过 24 小时非法（再往上就是永不）", () => {
    expect(isValidAutoLockTimeoutMs(AUTO_LOCK_NEVER_TIMEOUT_MS)).toBe(true);
    expect(isValidAutoLockTimeoutMs(60 * 1000)).toBe(true);
    expect(isValidAutoLockTimeoutMs(AUTO_LOCK_TIMEOUT_24_HOUR_MS)).toBe(true);
    expect(isValidAutoLockTimeoutMs(AUTO_LOCK_TIMEOUT_24_HOUR_MS + 1)).toBe(false);
    expect(isValidAutoLockTimeoutMs(30 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(isValidAutoLockTimeoutMs(30_000)).toBe(false);
    expect(isValidAutoLockTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("分钟归一化封顶 1440", () => {
    expect(normalizeAutoLockMinutesToMs(10)).toBe(10 * 60 * 1000);
    expect(normalizeAutoLockMinutesToMs(AUTO_LOCK_MAX_CUSTOM_MINUTES)).toBe(AUTO_LOCK_TIMEOUT_24_HOUR_MS);
    expect(normalizeAutoLockMinutesToMs(1441)).toBeUndefined();
    expect(normalizeAutoLockMinutesToMs(0)).toBeUndefined();
  });

  it("非法超时回落到缺省", () => {
    expect(normalizeAutoLockTimeoutMs(undefined)).toBe(AUTO_LOCK_DEFAULT_TIMEOUT_MS);
    expect(normalizeAutoLockTimeoutMs(48 * 60 * 60 * 1000)).toBe(AUTO_LOCK_DEFAULT_TIMEOUT_MS);
    expect(normalizeAutoLockTimeoutMs(AUTO_LOCK_NEVER_TIMEOUT_MS)).toBe(AUTO_LOCK_NEVER_TIMEOUT_MS);
  });
});
