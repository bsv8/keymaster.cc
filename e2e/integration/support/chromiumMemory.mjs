/**
 * 小内存机器的 E2E 启动策略；只作用于测试浏览器。
 * KEYMASTER_E2E_LOW_MEMORY=0：恢复 Chromium 默认内存策略，供真实内存压力验收使用。
 * Swap（磁盘交换空间）仍由操作系统管理，不能保证 Worker 永不退出。
 */
export function chromiumLaunchOptions(options = {}) {
  const memoryArgs = process.env.KEYMASTER_E2E_LOW_MEMORY === "0" ? [] : [
    // Chromium 149 的 CreateMemoryPressureMonitor 在此测试开关下不创建
    // 系统内存压力监控器，避免宿主机内存压力干扰功能 E2E。
    "--browser-test",
    // 禁用低内存设备模式；不改变 Worker 正常的关闭和生命周期规则。
    "--disable-low-end-device-mode",
  ];
  return { ...options, args: [...memoryArgs, ...(options.args ?? [])] };
}
