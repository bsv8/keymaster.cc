import { randomBytes } from "node:crypto";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bytesToHex, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { enableTestnetAssets } from "../../drivers/p2pkhDriver.js";
import {
  collectFromPage,
  prepareTopUpFromPage,
  readSatSupplierConnectionLight,
  readSpiBalanceSatoshis,
  readSpiPaymentAddress,
  refreshRemoteSubscriptionsFromPage,
  refreshSpiBalanceFromPage,
  saveSatSupplierFromPage,
  submitTopUpFromPage,
  waitForSatSupplierConnectionLight,
  waitForSatSupplierConnectionState,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import { loadE2EConfig } from "../../resources/config/loader.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";
import {
  startSatSubscriptionLocalServer,
  type SatSubscriptionLocalServer,
} from "../../resources/satsubscription/localServerResource.js";
import { TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter, type WocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { currentRunId } from "../../support/ids.js";
import { REAL_SATSUB_SERVER_SETTINGS_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_SATSUB_SERVER_SETTINGS_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUB_SERVER_SETTINGS_SCENARIO;

const SUPPLIER_ID = "ss-settings-local";
const SUPPLIER_NAME = "SS 设置页本地供应商";
const PASSWORD = "ss-testnet-password-123";

/**
 * 金额反向推导（只查 SPI 余额，不做付费 publish）：
 * - 充值金额（TOPUP）：3000 sats。大于 dust 546 + P2PKH 充值手续费（~300 sats，
 *   satSpi 按 medium 1000 sats/kB 估算）+ scanner 归属余量。
 * - 回收金额（COLLECT）：3000 sats = 全额清零，直观验证余额回到 0。
 * - 充值（FUNDING）：10000 sats = 3000 业务 + 三笔链上手续费（seed→Key、Key→SS、
 *   Key→seed，每笔约 200~500 sats）+ 2000+ 缓冲。实测手续费合计通常 <1000。
 * - 上限与容忍：单笔充值上限 10000，最大损失 3000（只覆盖手续费；充值本金已按
 *   业务金额登记，不计入损失）。
 */
const FUNDING_SATOSHIS = 10_000;
const TOPUP_SATOSHIS = 3_000;
const COLLECT_SATOSHIS = 3_000;
const FEE_RESERVE_SATOSHIS = 2_000;
const MAX_LOSS_SATOSHIS = 3_000;

interface SettingsUser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly publicKeyHex: string;
  readonly browserErrors: BrowserErrorEvidence;
}

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/**
 * WOC 公共端点无 key 时会间歇性 429。链调用统一走这个重试，
 * 成功即返回；非 429 错误直接抛出，不盲目重试。
 */
async function withWocRetry<T>(operation: () => Promise<T>, label: string, attempts = 8, delayMs = 20_000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const rateLimited = error instanceof Error && /HTTP 429/u.test(error.message);
      if (!rateLimited || attempt === attempts) throw error;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** 生成与测试 Key 不同的随机白名单公钥，让测试 Key 走真实付费身份（余额只查，不 publish）。 */
function randomWhitelistPublicKeyHex(exclude: string): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const candidate = bytesToHex(publicKeyFromPrivateKey(randomBytes(32))).toLowerCase();
      if (candidate !== exclude.toLowerCase()) return candidate;
    } catch {
      // 极小概率随机到非法标量，重试即可。
    }
  }
  throw new Error("无法生成白名单随机公钥");
}

/**
 * 业务目标：seed（testnet）→ 固定 key01 钱包（极少金额）→ 页面充值进本地 SS
 * → 只查 SPI 余额 → 页面回收清零 → key01 找零归集回 seed。全程 testnet。
 *
 * 开始状态：seed 有足额 testnet 余额；key01 地址必须已无可花费输出；本地 SS 用
 * 一次性 PostgreSQL + 随机服务身份启动，且同时启动独立 scanner run（否则链上
 * 充值无人入账，余额永远为 0）。
 *
 * 关键语义（不要按“赎回链上币”理解）：
 * - 页面“回收余额”（Collect）只扣减服务端账本进清算账，不会链上打款；
 *   链上能回 seed 的只有 key01 的找零（充值本金已留在 SS 固定地址）。
 * - 不再维护跨轮账本：固定 key01 + 每轮开始的可花费输出门禁 + 手工归集脚本
 *   就是恢复保障，损失在本 Journey 内按链上事实核算。
 *
 * 成功标准：
 * - seed→key01 充值确认后页面能导入同一把 Key 并看到 testnet UTXO；
 * - 本地 SS 红绿灯 online，SPI 行出现 BSV/testnet 账户；
 * - 充值前余额为 0，充值 TOPUP 后轮询到余额 == TOPUP；
 * - 回收 COLLECT（=TOPUP）后余额回到 0；
 * - 找零归集回 seed，损失不超过声明上限。
 *
 * 外部资源与收尾：固定 key01 + 一次性 PG；结束时关浏览器/服务/临时目录，
 * 找零归 seed，结果未知时先观察链上再决定是否重试。
 *
 * 覆盖需求：KM-SATSUB-001、KM-SETTINGS-001。
 */
test(JOURNEY_ID + "：SS server 设置页 testnet 小额充值只查余额与回收归集", async ({}, testInfo) => {
  test.setTimeout(900_000);
  const runId = currentRunId();
  let config: LoadedE2EConfig | undefined;
  let funding: TestnetFundingResource | undefined;
  let chain: WocTestnetChainAdapter | undefined;
  let wallet: OneTimeWallet | undefined;
  let seedAddress = "";
  let fundingTxid = "";
  let fundsReturned = false;
  let oneTimePrivateKeyHex = "";
  let server: SatSubscriptionLocalServer | undefined;
  let user: SettingsUser | undefined;
  let journeyError: unknown;
  let cleanupError: unknown;
  let evidenceError: unknown;

  try {
    config = await loadE2EConfig();
    const activeChain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
    });
    const activeFunding = new TestnetFundingResource(config.testnet.privateKeyHex, activeChain);
    chain = activeChain;
    funding = activeFunding;
    wallet = activeFunding.createImportedWallet(runId, JOURNEY_ID, config.testnet.trackingKeyPrivateKeyHex.read());
    oneTimePrivateKeyHex = wallet.privateKey.read();
    seedAddress = (await withWocRetry(() => activeFunding.prepare(FUNDING_SATOSHIS), "prepare")).seedAddress;

    await test.step("seed 打极少金额到固定 Key 并等链上可观察", async () => {
      // 固定地址不能混入旧钱：有可花费输出就必须先归集。
      const existing = await withWocRetry(() => activeChain.inspectAddress(wallet!.address), "precheck");
      expect(
        existing.spendableUtxoCount === 0,
        `key01 地址 ${wallet!.address} 仍有可花费 testnet 输出（utxos=${existing.spendableUtxoCount}）；请先跑 pnpm collect:testnet:key01`,
      ).toBe(true);
      const funded = await withWocRetry(() => activeFunding.fund(wallet!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: MAX_LOSS_SATOSHIS,
        feeReserveSatoshis: FEE_RESERVE_SATOSHIS,
      }), "fund");
      fundingTxid = funded.txid;
      expect(fundingTxid, "充值回执必须有 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);
      await withWocRetry(() => activeChain.waitForTransaction(fundingTxid, { timeoutMs: 180_000, pollMs: 10_000 }), "wait-observed", 3, 5_000);
    });

    await test.step("固定 Key 初始化并开启 testnet，启动本地 SS（含 scanner）后保存供应商", async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
      const page = await context.newPage();
      const browserErrors = captureBrowserErrors(page, context);
      // 充值与回收都要弹 window.confirm；无监听时 Playwright 默认取消，必须先自动确认。
      page.on("dialog", (dialog) => void dialog.accept());
      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "SS 设置页桶",
        keyLabel: "SS 设置页 Key",
        password: PASSWORD,
        privateKeyHex: oneTimePrivateKeyHex,
      });
      user = { browser, context, page, publicKeyHex: ready.publicKeyHex, browserErrors };
      expect(user.publicKeyHex).toBe(wallet?.publicKeyHex);

      // SPI 充值走 P2PKH testnet，未开 testnet 会直接报 unavailable。
      await enableTestnetAssets(page);

      server = await startSatSubscriptionLocalServer({
        whitelistPublicKeys: [randomWhitelistPublicKeyHex(user.publicKeyHex)],
        enableScanner: true,
      });
      await openSettingsPage(page, {
        label: /^Broadcast gateway$|^广播网关$/u,
        path: /\/settings\/system-status$/u,
        heading: /^Broadcast gateway$|^广播网关$/u,
      });
      await saveSatSupplierFromPage(page, {
        supplierId: SUPPLIER_ID,
        name: SUPPLIER_NAME,
        supplierPublicKeyHex: server.supplierPublicKeyHex,
        multiaddrs: [server.multiaddr],
        enabled: true,
      });
      await waitForSatSupplierConnectionState(page, SUPPLIER_ID, "online");
      await waitForSatSupplierConnectionLight(page, SUPPLIER_ID, "online");
      expect(await readSatSupplierConnectionLight(page, SUPPLIER_ID)).toBe("online");
    });

    await test.step("刷新 SPI 并确认充值前余额为 0", async () => {
      const page = user!.page;
      await refreshSpiBalanceFromPage(page, SUPPLIER_ID);
      const account = page.getByTestId(`ss-spi-account-${SUPPLIER_ID}-BSV-testnet`);
      await expect(account).toBeVisible({ timeout: 30_000 });
      await expect(account).toContainText(/充值地址/u);
      expect(await readSpiBalanceSatoshis(page, SUPPLIER_ID)).toBe(0n);
      expect(await readSpiPaymentAddress(page, SUPPLIER_ID)).toMatch(/^[13mn2]/u);
      await refreshRemoteSubscriptionsFromPage(page, SUPPLIER_ID);
    });

    await test.step("空闲 40s 保活不断线（至少一次 libp2p Ping）", async () => {
      const page = user!.page;
      // 保活间隔 30s：40s 无业务流量至少触发一次标准 Ping；本地服务端
      // 已注册 Ping 服务。若保活本身导致降级，红绿灯会变红并失败。
      await page.waitForTimeout(40_000);
      expect(await readSatSupplierConnectionLight(page, SUPPLIER_ID)).toBe("online");
      await expect(page.locator(".sat-subscription-settings").getByRole("alert")).toHaveCount(0);
    });

    await test.step("从 Key 打入 SS：页面充值并等链上可见", async () => {
      const page = user!.page;
      await prepareTopUpFromPage(page, SUPPLIER_ID, TOPUP_SATOSHIS);
      const topupTxid = await submitTopUpFromPage(page);
      expect(topupTxid).toMatch(/^[0-9a-f]{64}$/iu);
      // 充值本金是用户有意转出：损失核算先扣掉 TOPUP，只统计链上手续费。
      await withWocRetry(() => activeChain.waitForTransaction(topupTxid, { timeoutMs: 180_000, pollMs: 2_000 }), "wait-topup", 3, 5_000);
    });

    await test.step("只查 SPI 余额：轮询到余额等于充值金额", async () => {
      const page = user!.page;
      await expect.poll(async () => {
        await refreshSpiBalanceFromPage(page, SUPPLIER_ID);
        return await readSpiBalanceSatoshis(page, SUPPLIER_ID);
      }, { timeout: 600_000, intervals: [5_000, 10_000, 15_000], message: "scanner 未把充值记入 SPI 余额" }).toBe(BigInt(TOPUP_SATOSHIS));
    });

    await test.step("从 SS 回收金额：页面回收清零（只动账本不清算链上）", async () => {
      const page = user!.page;
      const result = await collectFromPage(page, SUPPLIER_ID, COLLECT_SATOSHIS);
      expect(result).toMatch(/succeeded/u);
      await refreshSpiBalanceFromPage(page, SUPPLIER_ID);
      expect(await readSpiBalanceSatoshis(page, SUPPLIER_ID)).toBe(0n);
      await expect(page.locator(".sat-subscription-settings").getByRole("alert")).toHaveCount(0);
    });

    await test.step("从固定 Key 归集找零回 seed", async () => {
      expect(fundingTxid).toBeTruthy();
      const remaining = await withWocRetry(() => activeChain.waitForSpendableChange(wallet!.address, fundingTxid, { timeoutMs: 180_000, pollMs: 2_000 }), "wait-change", 3, 5_000);
      expect(remaining, "归集前固定 Key 钱包必须仍有可花费找零").toBeGreaterThan(0);
      const returned = await withWocRetry(() => activeFunding.returnRemaining(wallet!, seedAddress), "return");
      fundsReturned = true;
      expect(returned.txid).toMatch(/^[0-9a-f]{64}$/iu);
      await withWocRetry(() => activeChain.waitForTransaction(returned.txid, { timeoutMs: 180_000, pollMs: 2_000 }), "wait-return", 3, 5_000);
      // 损失 = 充值 − 业务充值 − 回款，只应包含链上手续费。
      const loss = FUNDING_SATOSHIS - TOPUP_SATOSHIS - returned.outputSatoshis;
      expect(loss, "归集损失不得超过声明的最大损失").toBeGreaterThanOrEqual(0);
      expect(loss, "归集损失不得超过声明的最大损失").toBeLessThanOrEqual(MAX_LOSS_SATOSHIS);
    });
  } catch (error) {
    journeyError = error;
  } finally {
    try {
      // 不看内存里的 fundingTxid：广播结果未知时它可能没留下；只要 key01
      // 地址真的有可花费输出，就必须归集回 seed。
      if (wallet && funding && chain && !fundsReturned) {
        const observation = await chain.inspectAddress(wallet.address);
        if (observation.spendableUtxoCount > 0) {
          const returned = await withWocRetry(() => funding!.returnRemaining(wallet!, seedAddress), "cleanup-return");
          await chain.waitForTransaction(returned.txid, { timeoutMs: 180_000, pollMs: 2_000 });
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (user) {
        await attachBrowserErrors(testInfo, user.browserErrors, [PASSWORD, oneTimePrivateKeyHex]);
        await attachVisibleDiagnostic(user.page, testInfo);
        await user.context.close().catch(() => undefined);
        await user.browser.close().catch(() => undefined);
      }
      await server?.stop();
    } catch (error) {
      evidenceError = error;
    }
    wallet?.clear();
    oneTimePrivateKeyHex = "";
    clearSecrets(config);
  }

  if (journeyError) throw journeyError;
  if (cleanupError) throw cleanupError;
  if (evidenceError) throw evidenceError;
});
