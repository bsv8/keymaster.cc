import { chromiumLaunchOptions } from "./integration/support/chromiumMemory.mjs";
import { defineConfig } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("deployment");

export default defineConfig({
  // 小内存机器默认串行，减少多个浏览器争用物理内存。
  workers: 1,
  testDir: "./integration",
  timeout: 30_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
  use: {
    launchOptions: chromiumLaunchOptions(),
    baseURL: process.env.KEYMASTER_E2E_DEPLOYMENT_BASE_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{
    name: "deployment-acceptance",
    testMatch: /(?:journeys\/deployment|gates\/deployment)\/[^/]+\.spec\.ts$/u,
  }],
});
