import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./integration",
  timeout: 30_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../test-results/integration-deployment",
  use: {
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
