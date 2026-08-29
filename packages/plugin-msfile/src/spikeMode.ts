// 旧 executor 架构验证模式的查询参数只允许出现在显式 E2E 构建。
// Vite 生产构建通过 define 注入 false，并在 tree-shaking 时删除查询参数分支；
// 未经过 Vite 的 Vitest/Node 环境中该全局不存在，也必须安全地视为 false。
declare const __KEYMASTER_MSFILE_SPIKE__: boolean;

const SPIKE_BUILD_ENABLED = typeof __KEYMASTER_MSFILE_SPIKE__ !== "undefined"
  && __KEYMASTER_MSFILE_SPIKE__;

export function isLegacyExecutorHarnessMode(): boolean {
  if (!SPIKE_BUILD_ENABLED) return false;
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("msfileSpike");
}
