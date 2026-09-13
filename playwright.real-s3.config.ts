import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/integration",
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/integration-real-s3",
  use: {
    baseURL: "http://127.0.0.1:4173",
    // S3 表单会短暂接触访问密钥；真实测试不保留页面产物。
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
      name: "s3-resource-setup",
      testMatch: /resources\/s3-resource-setup\.spec\.ts$/u,
      teardown: "s3-resource-teardown",
    },
    {
      name: "real-s3",
      dependencies: ["s3-resource-setup"],
      testMatch: /(?:gates\/real-resource\/resource-safety|journeys\/real-resource\/real-s3-initialization)\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "s3-resource-teardown",
      testMatch: /resources\/s3-resource-teardown\.spec\.ts$/u,
    },
  ],
});
