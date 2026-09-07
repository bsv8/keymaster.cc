import { defineConfig, devices } from "@playwright/test";

// 生命周期生产链使用独立端口，且禁止复用旧 preview；避免测试误连到
// 另一份构建产物。外部部署验收由独立 runner 负责，不在这里复用本地服务。
export default defineConfig({
  testDir: "./e2e",
  testMatch: "plugin-lifecycle-production.spec.ts",
  timeout: 30_000,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/plugin-lifecycle",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-lifecycle",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info"] },
      },
    },
  ],
});
