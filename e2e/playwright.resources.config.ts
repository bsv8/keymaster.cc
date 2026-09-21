import { defineConfig, devices } from "@playwright/test";
import { configureRunSuite } from "./integration/support/runData.js";

const { outputDir } = configureRunSuite("resources");

export default defineConfig({
  testDir: "./integration",
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  // 两个 testnet Journey 可能同时从同一 seed 选币；并行会让它们选到同一个
  // 已确认 UTXO 而互相冲突。真实资金场景必须串行，不能靠重试掩盖双花竞争。
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  outputDir,
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
      // 链上资产与转账：真实 testnet 资金 Journey。
      name: "p2pkh",
      dependencies: ["resource-setup"],
      testMatch: /journeys\/p2pkh\/[^/]+\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // SatSubscription 健康投影：只读取脱敏配置，不冒充页面业务结果。
      name: "satsubscription",
      dependencies: ["resource-setup"],
      testMatch: /journeys\/satsubscription\/real-satsubscription-health\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // 资源可用性：断言 setup 之后的 lease 与运行状态。
      name: "resources",
      dependencies: ["resource-setup"],
      testMatch: /resources\/resource-availability\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // 页面 Journey 只需要仓库外 satsubscription.json；不依赖会做 S3/
      // testnet 资源准备的项目，避免资源层阻断掩盖真实页面结果。
      name: "satsubscription-page",
      testMatch: /journeys\/satsubscription\/real-satsubscription-page\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "resource-teardown",
      testMatch: /resources\/resource-teardown\.spec\.ts$/u,
    },
  ],
});
