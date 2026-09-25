import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("bitfs");

export default defineConfig({
  testDir: "./integration",
  timeout: 300_000,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "VITE_BITFS_E2E=true VITE_BITFS_NETWORK=test VITE_BITFS_ALLOW_LOOPBACK_WS=true VITE_BITFS_MAX_FEE_SATOSHIS=1000 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [{
    name: "bitfs",
    testMatch: /journeys\/bitfs\/[^/]+\.spec\.ts$/u,
    use: { ...devices["Desktop Chrome"] },
  }],
});
