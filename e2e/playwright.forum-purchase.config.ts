import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("forum");
export default defineConfig({
  testDir: "./integration", timeout: 900_000, retries: 0, workers: 1, forbidOnly: true, reporter: "list", outputDir,
  use: { baseURL: "http://127.0.0.1:4173", trace: "off", screenshot: "off", video: "off", actionTimeout: 30_000, navigationTimeout: 60_000 },
  webServer: {
    // All protocol, chain and file-transfer paths remain production paths.
    // Testnet/loopback and diagnostic flags apply only to this isolated build.
    command: "VITE_MSFILE_E2E=1 VITE_BITFS_E2E=true VITE_BITFS_NETWORK=test VITE_BITFS_ALLOW_LOOPBACK_WS=true VITE_BITFS_MAX_FEE_SATOSHIS=1000 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173", reuseExistingServer: false,
  },
  projects: [{ name: "forum-purchase", testMatch: /journeys\/forum\/real-forum-purchase\.spec\.ts$/u, use: { ...devices["Desktop Chrome"] } }],
});
