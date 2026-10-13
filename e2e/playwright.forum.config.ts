import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";
const { outputDir } = configureRunSuite("forum");
export default defineConfig({
  // Smoke accepts state A immediately; waiting for a mined block is not part
  // of this journey. Unknown dispatch is retained for explicit reconciliation.
  testDir: "./integration", timeout: 900_000, retries: 0, workers: 1, forbidOnly: true, reporter: "list", outputDir,
  // Real wallet import: never record private key input, trace or browser video.
  use: { baseURL: "http://127.0.0.1:4173", trace: "off", screenshot: "off", video: "off", ignoreHTTPSErrors: true,
    // Playwright's context certificate override does not cover every
    // SharedWorker target. This isolated browser uses a disposable local TLS
    // certificate; protocol identity/signatures are still verified normally.
    launchOptions: { args: ["--ignore-certificate-errors"] }, actionTimeout: 30_000, navigationTimeout: 60_000 },
  webServer: {
    command: "VITE_MSFILE_E2E=1 pnpm --filter @keymaster/web build && pnpm --filter @keymaster/web exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173", reuseExistingServer: false,
  },
  projects: [{ name: "forum", testMatch: /journeys\/forum\/real-forum-smoke\.spec\.ts$/u, use: { ...devices["Desktop Chrome"] } }],
});
