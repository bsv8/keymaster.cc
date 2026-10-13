import type { LaunchOptions } from "@playwright/test";

/** 合并小内存 E2E 策略与调用方启动参数（保留证书、域名映射等配置）。 */
export function chromiumLaunchOptions(options?: LaunchOptions): LaunchOptions;
