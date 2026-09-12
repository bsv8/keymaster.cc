import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /coordinator-dev-http\.spec\.ts$/u,
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/dev-http",
  use: {
    // A non-loopback hostname is intentional: Chromium treats loopback HTTP
    // as a potentially trustworthy origin, which would not reproduce the
    // insecure-context path reported by users.
    baseURL: "http://keymaster-http.test:5181",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @keymaster/web dev --host 127.0.0.1 --port 5181 --strictPort",
    url: "http://127.0.0.1:5181/",
    // 这个回归必须从当前工作树启动全新的 Vite dev server；复用旧进程
    // 会让测试误连到其它子代理/旧提交的模块图，失去对本次修复的证明。
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--host-resolver-rules=MAP keymaster-http.test 127.0.0.1"],
        },
      },
    },
  ],
});
