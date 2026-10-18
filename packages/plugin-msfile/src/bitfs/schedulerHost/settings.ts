// 下载策略器宿主的设置映射：keymaster.cc 买方设置 → 内核显式 Config。

import type { Config } from "keymaster.cc-download-scheduler";

/** 宿主的调度器设置；由 MSFile 买方设置中的对应字段提供。 */
export interface SchedulerHostSettings {
  /** 系统缺省块价（聪）：内核 `maxBlockPrice`，任务手动价格杆的自动值。 */
  maxFullBlockPriceSatoshis: string;
  /** 一个费用池 = 一批 = 一次请求的块数上限。 */
  poolBlocks: number;
  /** 任务内总席位（基础席位 + 浮动位）。 */
  schedulerTotalSeats: number;
  /** 浮动位：在席且未测速的卖家上限。 */
  schedulerFloatingSeats: number;
  /** 请求停摆超时（毫秒）：连续这么久没有新字节即判停摆。 */
  schedulerRequestTimeoutMs: number;
}

/** 宿主缺省值；内核不带缺省值，这里必须给全。 */
export const SCHEDULER_HOST_DEFAULTS: Readonly<SchedulerHostSettings> = Object.freeze({
  maxFullBlockPriceSatoshis: "0",
  poolBlocks: 4,
  schedulerTotalSeats: 8,
  schedulerFloatingSeats: 2,
  schedulerRequestTimeoutMs: 5_000,
});

/**
 * 席位拆分：内核要求 `baseSeats >= 1`、`floatingSeats >= 1`，
 * 因此总席位最小按 2 收敛，浮动位最大为总席位 − 1。
 */
export function schedulerSeatSplit(totalSeats: number, floatingSeats: number): { baseSeats: number; floatingSeats: number } {
  const total = Number.isSafeInteger(totalSeats) ? Math.max(2, totalSeats) : SCHEDULER_HOST_DEFAULTS.schedulerTotalSeats;
  const floating = Number.isSafeInteger(floatingSeats) ? Math.max(1, Math.min(floatingSeats, total - 1)) : SCHEDULER_HOST_DEFAULTS.schedulerFloatingSeats;
  return { baseSeats: total - floating, floatingSeats: floating };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

/** 组装内核 Config；所有字段来自宿主设置，缺省只在宿主层补。 */
export function schedulerKernelConfig(settings: SchedulerHostSettings): Config {
  const { baseSeats, floatingSeats } = schedulerSeatSplit(settings.schedulerTotalSeats, settings.schedulerFloatingSeats);
  return {
    maxBlockPrice: /^(0|[1-9][0-9]*)$/u.test(settings.maxFullBlockPriceSatoshis)
      ? settings.maxFullBlockPriceSatoshis
      : SCHEDULER_HOST_DEFAULTS.maxFullBlockPriceSatoshis,
    baseSeats,
    floatingSeats,
    poolBlocks: positiveInteger(settings.poolBlocks, SCHEDULER_HOST_DEFAULTS.poolBlocks),
    requestTimeoutMs: positiveInteger(settings.schedulerRequestTimeoutMs, SCHEDULER_HOST_DEFAULTS.schedulerRequestTimeoutMs),
  };
}
