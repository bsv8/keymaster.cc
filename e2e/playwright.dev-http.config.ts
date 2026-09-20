import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./integration",
  testMatch: /gates\/dev-http\/coordinator-dev-http\.spec\.ts$/u,
  // 在非安全 HTTP 的 Chromium 中，真实 Local 初始化会在 URL/DOM 完成屏障前
  // 执行多次 600k PBKDF2 派生。这里给冷启动保留足够的上限，但不是用等待时间
  // 猜测业务已经完成。
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../test-results/dev-http",
  use: {
    // 故意使用非 loopback 主机名：Chromium 可能把 loopback HTTP 当作可信来源，
    // 无法复现用户报告的非安全上下文路径。
    baseURL: "http://keymaster-http.test:5174",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @keymaster/web dev --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174/",
    // 这个回归必须从当前工作树启动全新的 Vite dev server；复用旧进程
    // 会让测试误连到其它子代理/旧提交的模块图，失去对本次修复的证明。
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "dev-http",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--host-resolver-rules=MAP keymaster-http.test 127.0.0.1"],
        },
      },
    },
  ],
});
