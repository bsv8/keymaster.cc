import { defineConfig, devices } from "@playwright/test";

// 正式发布边界使用 npm registry 的 WebLoom 0.4.3；同时覆盖原有插件链和
// 新增 Coordinator peer lifecycle 链。入口脚本在无 workspace/file 逃逸的
// 临时副本中用 frozen lockfile 安装后才加载此配置。
export default defineConfig({
  testDir: "./e2e/integration",
  testMatch: /gates\/lifecycle\/(?:plugin-lifecycle-production|coordinator-runtime-lifecycle)\.spec\.ts$/u,
  // 两条验收链共享同源 OPFS、Coordinator Worker 和生命周期全局状态；
  // 文件内 serial 不会阻止 Playwright 跨文件并发，必须在同一 registry
  // 临时副本中串行运行，避免把真实跨 tab 时序与两条链的资源争用混在一起。
  workers: 1,
  timeout: 30_000,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/lifecycle-registry",
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4175",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "lifecycle-registry",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info"] },
      },
    },
  ],
});
