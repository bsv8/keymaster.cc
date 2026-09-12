import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
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
      name: "chromium",
      // integration 有独立的 config、资源生命周期和证据目录；默认 E2E
      // 命令只运行既有 e2e 测试，避免真实资源 Journey 被静默降级执行。
      testIgnore: /integration\//u,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info"] }
      }
    }
  ]
});
