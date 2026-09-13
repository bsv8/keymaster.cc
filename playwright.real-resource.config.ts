import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/integration",
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/integration-real-resource",
  use: {
    baseURL: "http://127.0.0.1:4173",
    // 真实资源 Journey 会在初始化阶段短暂接触一次性私钥；禁止把页面、
    // console 或网络附件自动写入报告。
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "VITE_MSFILE_E2E=1 VITE_MSFILE_SPIKE=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "resource-setup",
      testMatch: /resources\/resource-setup\.spec\.ts$/u,
      teardown: "resource-teardown",
    },
    {
      name: "real-resource",
      dependencies: ["resource-setup"],
      testMatch: /(?:resources\/real-resource-availability|journeys\/real-resource\/real-(?:testnet-asset|satsubscription-health))\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "resource-teardown",
      testMatch: /resources\/resource-teardown\.spec\.ts$/u,
    },
  ],
});
