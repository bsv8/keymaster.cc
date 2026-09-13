import { defineConfig, devices } from "@playwright/test";

// 本配置只负责本地 tarball 的严格 0.4.3 Coordinator 生命周期验收。
// 正式 registry 0.4.3 验收使用 playwright.lifecycle.registry.config.ts，
// 并由 registry-only 临时副本入口执行。
export default defineConfig({
  testDir: "./e2e/integration",
  testMatch: /gates\/lifecycle\/(?:coordinator-runtime-lifecycle|plugin-lifecycle-production)\.spec\.ts$/u,
  timeout: 30_000,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/coordinator-runtime-lifecycle",
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
      name: "lifecycle-local",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info"] },
      },
    },
  ],
});
