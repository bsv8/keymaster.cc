import { defineConfig, devices } from "@playwright/test";

/**
 * 开发服务器（`npm run dev`）上的本地 Journey 执行档。
 *
 * 设计缘由：
 *   - 生产 preview 档无法覆盖"开发服务器 + 缺省 SatSubscription testnet
 *     网关"这一运行条件；
 *   - 该档只跑本地 Journey，且必须从当前工作树启动全新的 dev server。
 */
export default defineConfig({
  testDir: "./e2e/integration",
  timeout: 180_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/dev-local",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @keymaster/web dev --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/",
    // 必须从当前工作树启动全新的 dev server，避免复用旧进程导致模块图过期。
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "dev-local",
      testMatch: /journeys\/local\/local-satsubscription-default\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
