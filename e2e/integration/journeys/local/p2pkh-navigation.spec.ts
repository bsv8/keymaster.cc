import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { LOCAL_P2PKH_NAVIGATION_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_P2PKH_NAVIGATION_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_P2PKH_NAVIGATION_SCENARIO;

/**
 * 业务目标：用户建立 P2PKH 身份后，可以从正式菜单进入链上交易和本地交易页面。
 *
 * 这是默认 E2E 中的真实浏览器 smoke，不注入 provider 响应、IndexedDB 数据或
 * 本地广播服务器。新建钱包没有可消费余额，因此本场景只验证真实生产壳、真实
 * provider 读取链路和页面路由；testnet 充值、转账、确认和归集由 p2pkh
 * Journey 负责。
 */
test(JOURNEY_ID + "：P2PKH 钱包通过真实 provider 展示链上和本地交易入口", async ({ page }) => {
  test.setTimeout(60_000);

  await initializeNewLocalUser(
    { page },
    { bucketLabel: "p2pkh-e2e", keyLabel: "p2pkh-e2e-key", password: "playwright-password" },
  );
  await expect(page.getByRole("button", { name: "Lock", exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "On-chain transactions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "On-chain transactions · Mainnet" })).toBeVisible();

  await page.goto("/p2pkh/mainnet/local-transactions?page=1");
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/p2pkh\/mainnet\/local-transactions\?page=1$/);
  await expect(page.getByRole("heading", { name: "Local transactions · Mainnet" })).toBeVisible();
});
