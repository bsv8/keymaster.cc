import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("local-integration");

export default defineConfig({
  testDir: "./integration",
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{
    name: "local-integration",
    // 真实资源和目标部署必须由各自的命令运行；本地 PR 不能因为扫描到
    // integration 目录就误读仓库外 seed 或把 preview 当成部署验收。
    testMatch: /(?:journeys\/local|gates\/local)\/[^/]+\.spec\.ts$/u,
    use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--enable-precise-memory-info"] } },
  }],
});
