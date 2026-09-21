import { defineConfig } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

// 手工维护入口：只跑 maintenance 目录下的 Node 侧脚本（不启动浏览器、不 build 页面）。
// 这些脚本会接触真实 testnet 资金，必须显式调用，不加入任何自动执行档。
const { outputDir } = configureRunSuite("maintenance");

export default defineConfig({
  testDir: "./maintenance",
  timeout: 300_000,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
  projects: [{ name: "maintenance" }],
});
