import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bytesToHex, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import {
  billingNextPage,
  billingPrevPage,
  enableSatSupplierReceiveAndDefault,
  queryServerBillingFirstPage,
  readBillingStatus,
  readSatSupplierConnectionLight,
  refreshRemoteSubscriptionsFromPage,
  refreshSpiBalanceFromPage,
  saveSatSupplierFromPage,
  waitForSatSupplierConnectionLight,
  waitForSatSupplierConnectionState,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import {
  startSatSubscriptionLocalServer,
  type SatSubscriptionLocalServer,
} from "../../resources/satsubscription/localServerResource.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_SATSUB_SERVER_SETTINGS_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_SATSUB_SERVER_SETTINGS_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUB_SERVER_SETTINGS_SCENARIO;

const SUPPLIER_ID = "ss-settings-local";
const SUPPLIER_NAME = "SS 设置页本地供应商";
const PASSWORD = "ss-settings-password-123";
/** 固定短期私钥；服务端永久免费白名单身份，不进入附件。 */
const USER_PRIVATE_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000004";

interface SettingsUser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly publicKeyHex: string;
  readonly browserErrors: BrowserErrorEvidence;
}

function billingRecordIds(page: Page, supplierId: string) {
  return page.getByTestId(new RegExp(`^ss-billing-record-${supplierId}-`));
}

async function readBillingRecordIds(page: Page, supplierId: string): Promise<string[]> {
  const locator = billingRecordIds(page, supplierId);
  const count = await locator.count();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await locator.nth(index).getAttribute("data-billing-record")) ?? "");
  }
  return ids.filter(Boolean);
}

/**
 * 业务目标：初始化桶 Key 后进入设置页，等待本地 SS 供应商连接
 * （红绿灯变绿），依次验证刷新 SPI 余额、刷新远端订阅、查询服务器
 * 账单与真实翻页三功能正常。不测内置 bsv8 缺省供应商。
 *
 * 开始状态：Node 从 SATS_SUBSCRIPTION_DIR 构建正式服务并启动一次性
 * PostgreSQL；单用户用确定性 Hex Key（服务端永久免费白名单内，
 * 因此订阅/收发免费且必成功）。
 *
 * 正扣费账单说明：付费协议路径要求 SPI 足额余额，e2e 不做真实充值；
 * 翻页所需的 3 条正扣费记录由一次性库的正式 operations fixture 预置
 * （满足服务端全部约束），查询仍走真实 SSP BillingRequest/Response。
 * 空账单由组件单测覆盖，不与本真实翻页混在一起。
 *
 * 成功标准：
 * - 本地 SS 供应商红绿灯 data-state=online 且中文说明含“已连接”；
 * - 刷新 SPI 后行内出现 BSV/testnet 账户且无 role=alert；
 * - 刷新远端订阅后状态栏提示已刷新且无 alert；
 * - 以每页 2 条查询账单：第 1 页 2 条且有下一页 → 第 2 页 1 条且
 *   与第 1 页不重复 → 返回第 1 页记录与之前一致，全程无 alert。
 *
 * 外部资源与收尾：只用一次性 PostgreSQL、随机服务身份和回环地址；
 * 结束时关闭浏览器、服务进程和临时目录，不产生真实资金流动。
 *
 * 覆盖需求：KM-SATSUB-001、KM-SETTINGS-001。
 */
test(JOURNEY_ID + "：SS server 设置页三功能与账单真实翻页", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const whitelistPublicKeys = [USER_PRIVATE_KEY_HEX].map((privateKeyHex) =>
    bytesToHex(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(privateKeyHex, "hex")))),
  );
  const server: SatSubscriptionLocalServer = await startSatSubscriptionLocalServer({ whitelistPublicKeys });
  let user: SettingsUser | undefined;

  try {
    await test.step("初始化桶 Key 并进入设置页保存本地 SS 供应商", async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
      const page = await context.newPage();
      const browserErrors = captureBrowserErrors(page, context);
      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "SS 设置页桶",
        keyLabel: "SS 设置页 Key",
        password: PASSWORD,
        privateKeyHex: USER_PRIVATE_KEY_HEX,
      });
      user = { browser, context, page, publicKeyHex: ready.publicKeyHex, browserErrors };
      expect(user.publicKeyHex).toBe(whitelistPublicKeys[0]);

      await openSettingsPage(page, {
        label: /^System$|^系统$/u,
        path: /\/settings\/system$/u,
        heading: /^System$|^系统$/u,
      });
      await saveSatSupplierFromPage(page, {
        supplierId: SUPPLIER_ID,
        name: SUPPLIER_NAME,
        supplierPublicKeyHex: server.supplierPublicKeyHex,
        multiaddrs: [server.multiaddr],
        enabled: true,
      });
    });

    await test.step("等待本地 SS 连接红绿灯变绿并设为接收与默认发布", async () => {
      const page = user!.page;
      await waitForSatSupplierConnectionState(page, SUPPLIER_ID, "online");
      await waitForSatSupplierConnectionLight(page, SUPPLIER_ID, "online");
      expect(await readSatSupplierConnectionLight(page, SUPPLIER_ID)).toBe("online");
      await enableSatSupplierReceiveAndDefault(page, SUPPLIER_ID);
    });

    await test.step("刷新 SPI 余额与远端订阅正常", async () => {
      const page = user!.page;
      await refreshSpiBalanceFromPage(page, SUPPLIER_ID);
      const spiAccount = page.getByTestId(`ss-spi-account-${SUPPLIER_ID}-BSV-testnet`);
      await expect(spiAccount).toBeVisible({ timeout: 30_000 });
      await expect(spiAccount).toContainText(/充值地址/u);
      await refreshRemoteSubscriptionsFromPage(page, SUPPLIER_ID);
      const inbox = `bsv8.inbox.${user!.publicKeyHex}`;
      await expect.poll(async () => (await server.ledgerSummary()).subscriptionChannels, {
        timeout: 60_000,
        message: "真实账本未登记 owner inbox 订阅",
      }).toContain(inbox);
    });

    await test.step("预置 3 条正扣费账单 fixture 并查第 1 页", async () => {
      const page = user!.page;
      await server.seedBillingFixture({ ownerPublicKeyHex: user!.publicKeyHex, count: 3 });
      await queryServerBillingFirstPage(page, SUPPLIER_ID, 2);
      expect(await readBillingStatus(page, SUPPLIER_ID)).toContain("第 1 页");
      const ids = await readBillingRecordIds(page, SUPPLIER_ID);
      expect(ids, "每页 2 条时首页应有 2 条正扣费记录").toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      const nextButton = page.locator(`[data-supplier-id="${SUPPLIER_ID}"]`).getByRole("button", { name: /下一页|Next page/iu });
      await expect(nextButton, "3 条记录以每页 2 条查询必须有下一页").toBeEnabled();
      await expect(billingRecordIds(page, SUPPLIER_ID).first()).toContainText(/供应商编号.*动作.*频道.*扣费金额.*账单编号/u);
    });

    await test.step("账单第 1 页 → 第 2 页 → 第 1 页往返且记录不重复", async () => {
      const page = user!.page;
      const firstPageIds = await readBillingRecordIds(page, SUPPLIER_ID);
      expect(await billingNextPage(page, SUPPLIER_ID)).toBe(true);
      expect(await readBillingStatus(page, SUPPLIER_ID)).toContain("第 2 页");
      const secondPageIds = await readBillingRecordIds(page, SUPPLIER_ID);
      expect(secondPageIds, "第 2 页应有 1 条记录").toHaveLength(1);
      expect(secondPageIds.filter((id) => firstPageIds.includes(id)), "翻页记录必须不重复").toHaveLength(0);
      expect(await billingPrevPage(page, SUPPLIER_ID)).toBe(true);
      expect(await readBillingStatus(page, SUPPLIER_ID)).toContain("第 1 页");
      expect(await readBillingRecordIds(page, SUPPLIER_ID)).toEqual(firstPageIds);
      await expect(page.locator(".sat-subscription-settings").getByRole("alert")).toHaveCount(0);
    });
  } finally {
    if (user) {
      await attachBrowserErrors(testInfo, user.browserErrors, [PASSWORD, USER_PRIVATE_KEY_HEX]);
      await attachVisibleDiagnostic(user.page, testInfo);
      await user.context.close().catch(() => undefined);
      await user.browser.close().catch(() => undefined);
    }
    await server.stop();
  }
});
