import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // 默认入口只运行不依赖仓库外资源的 local-core 执行档；所有 spec 都在
  // integration 规划下，避免根目录测试被误放进生产 preview。
  testDir: "./e2e/integration",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    // 测试 Vite 的生产构建产物，避免仅验证开发服务器行为。
    command:
      "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI
  },
  projects: [
    {
      name: "local-core",
      // local-core 只包含本地浏览器 Journey 和纯本地 Gate；开发 HTTP、
      // MSFile/Go、真实资源、生命周期发布验收和目标部署由独立执行档负责。
      testMatch: /(?:journeys\/local|gates\/local)\/[^/]+\.spec\.ts$/u,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info"] }
      }
    }
  ]
});
