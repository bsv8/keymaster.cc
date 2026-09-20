import { defineConfig } from "@playwright/test";

/**
 * 真实 SatSubscription 本地执行档。
 *
 * 场景从仓库外 SatSubscription 源码构建正式服务，并启动一次性 PostgreSQL；
 * 浏览器使用生产 preview，不注入任何协议替身。该档不进默认 local-core，
 * 需要 SATS_SUBSCRIPTION_DIR、Go 和 PostgreSQL 才能运行。
 */
export default defineConfig({
  testDir: "./integration",
  timeout: 360_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../test-results/satsubscription",
  // 每个场景独占临时 PostgreSQL 与供应商端口；串行避免资源竞争。
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    // 不启用 reuse：必须用当前工作树重新构建生产 preview，避免旧服务器
    // 让真实供应商验收跑在过期产物上。用 pnpm filter 从仓库根解析，
    // 兼容 Playwright 以 config 目录为 cwd 启动 webServer 的行为。
    command: "pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [{
    name: "satsubscription",
    testMatch: /journeys\/satsubscription\/[^/]+\.spec\.ts$/u,
  }],
});
