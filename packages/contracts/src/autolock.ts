// packages/contracts/src/autolock.ts
// 自动锁定设置契约。
//
// 设计缘由：
//   - 自动锁是本地安全边界：无任意用户活动达到配置时长，Coordinator 全局 lock。
//   - 0 = 永不自动锁定（一直不锁），与后台同步管理「0 = 关闭」语义一致；
//     0 绝不表示「立即锁定」。
//   - 预设 2 / 5 / 15 分钟 + 24 小时，缺省 5 分钟；自定义允许 1～1440 分钟
//     整数，再往上就是永不。最小 1 分钟防止误触立即锁定。
//   - 上限 24 小时（86_400_000ms）远小于浏览器 setTimeout 单次上限
//     2^31−1ms（约 24.85 天），Coordinator 可直接整段计时，无需分段重排。
//   - 桶级 Coordinator 快照持久化（coordinator.settings），多 tab 经
//     session.state 广播收敛；无桶/旧快照回落到缺省。

import { defineCapability } from "webloom-framework";

export const AUTO_LOCK_TIMEOUT_2_MIN_MS = 2 * 60 * 1000;
export const AUTO_LOCK_TIMEOUT_5_MIN_MS = 5 * 60 * 1000;
export const AUTO_LOCK_TIMEOUT_15_MIN_MS = 15 * 60 * 1000;
/** 预设最长：24 小时。 */
export const AUTO_LOCK_TIMEOUT_24_HOUR_MS = 24 * 60 * 60 * 1000;

/** 缺省自动锁定：5 分钟。 */
export const AUTO_LOCK_DEFAULT_TIMEOUT_MS = AUTO_LOCK_TIMEOUT_5_MIN_MS;

/** 永不自动锁定：一直不锁。 */
export const AUTO_LOCK_NEVER_TIMEOUT_MS = 0;

/** 自定义最小值：1 分钟。 */
export const AUTO_LOCK_MIN_CUSTOM_TIMEOUT_MS = 60 * 1000;

/** 自定义最大值：24 小时；再往上就是永不。 */
export const AUTO_LOCK_MAX_CUSTOM_TIMEOUT_MS = AUTO_LOCK_TIMEOUT_24_HOUR_MS;

/** 自定义分钟数上限：1440。 */
export const AUTO_LOCK_MAX_CUSTOM_MINUTES = 1440;

/** 快捷预设（毫秒），UI 按此顺序展示：24 小时后面就是永不。 */
export const AUTO_LOCK_PRESET_OPTIONS_MS = [
  AUTO_LOCK_TIMEOUT_2_MIN_MS,
  AUTO_LOCK_TIMEOUT_5_MIN_MS,
  AUTO_LOCK_TIMEOUT_15_MIN_MS,
  AUTO_LOCK_TIMEOUT_24_HOUR_MS,
] as const;

/** 自动锁定设置：超时毫秒；0 = 永不。 */
export interface AutoLockSettings {
  timeoutMs: number;
}

/** 是否为永不锁定。 */
export function isAutoLockNever(timeoutMs: number): boolean {
  return timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS;
}

/** 校验超时是否合法：0，或 1 分钟～24 小时间整数毫秒。 */
export function isValidAutoLockTimeoutMs(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value === AUTO_LOCK_NEVER_TIMEOUT_MS) return true;
  return value >= AUTO_LOCK_MIN_CUSTOM_TIMEOUT_MS && value <= AUTO_LOCK_MAX_CUSTOM_TIMEOUT_MS;
}

/** 归一化用户输入分钟数到毫秒；非法（<1 或 >1440）返回 undefined。 */
export function normalizeAutoLockMinutesToMs(minutes: unknown): number | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return undefined;
  const rounded = Math.round(minutes);
  if (rounded < 1 || rounded > AUTO_LOCK_MAX_CUSTOM_MINUTES) return undefined;
  const ms = rounded * 60 * 1000;
  if (!Number.isSafeInteger(ms)) return undefined;
  return ms;
}

/** 归一化超时：非法回落到缺省。 */
export function normalizeAutoLockTimeoutMs(value: unknown): number {
  return isValidAutoLockTimeoutMs(value) ? value : AUTO_LOCK_DEFAULT_TIMEOUT_MS;
}

/** 展示用：毫秒 -> 分钟（永不返回 undefined）。 */
export function autoLockTimeoutMsToMinutes(timeoutMs: number): number | undefined {
  if (timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS) return undefined;
  return Math.round(timeoutMs / 60000);
}

export type AutoLockCommandResult =
  | { status: "accepted" }
  | { status: "locked" | "not-ready" | "stale-epoch" }
  | { status: "validation-error" | "error" | "transport-error"; message: string };

/** Vault 侧自动锁读写面；由 plugin-vault 的 Coordinator facade 实现。 */
export interface AutoLockService {
  getSettings(): AutoLockSettings;
  onSettingsChanged(handler: (settings: AutoLockSettings) => void): () => void;
  updateSettings(settings: AutoLockSettings): Promise<AutoLockCommandResult>;
  dispose?(): void;
}

export const AUTOLOCK_SERVICE_CAPABILITY = defineCapability<AutoLockService>({
  kind: "local",
  id: "vault.autolock-service",
  version: "1",
});
