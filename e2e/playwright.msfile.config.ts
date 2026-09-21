import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("msfile");

/**
 * MSFile 本地执行档。
 *
 * 这些场景会启动仓库外（或临时构建的）Go supplier：`gates/msfile` 验证真实
 * P2P、Range、Service Worker 和生命周期边界，`journeys/msfile` 从正式页面
 * 配置真实 NAS 并完成文件获取；它们不应被普通 local-core PR 扫描到。
 */
export default defineConfig({
  testDir: "./integration",
  timeout: 360_000,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [{
    name: "msfile",
    testMatch: /(?:gates|journeys)\/msfile\/[^/]+\.spec\.ts$/u,
    use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--enable-precise-memory-info"] } },
  }],
});
