import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import {
  enableTestnetAssets,
  openTransferPage,
  readTestnetOfferBalance,
  setP2pkhFeeRate,
} from "../../drivers/p2pkhDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { loadE2EConfig, publicConfigFingerprint } from "../../resources/config/loader.js";
import { RecoveryLedger, TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachRedactedText } from "../../support/redaction.js";
import { readResourceRunState } from "../../support/resourceState.js";
import { REAL_TESTNET_ARRIVAL_PROBE_SCENARIO } from "../../support/scenarioMetadata.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";

export const JOURNEY_ID = REAL_TESTNET_ARRIVAL_PROBE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_TESTNET_ARRIVAL_PROBE_SCENARIO;

const FUNDING_SATOSHIS = 10;
/** 开启 testnet 后先等一个自然观察窗口，再决定是否强制同步。 */
const NATURAL_OBSERVE_WINDOW_MS = 90_000;
/** 强制同步后的观察窗口。 */
const FORCED_OBSERVE_WINDOW_MS = 180_000;
const OBSERVE_POLL_MS = 5_000;

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

async function observeBalance(page: Page, expected: number, windowMs: number): Promise<{ readonly observed: boolean; readonly elapsedMs: number; readonly lastBalance: number | undefined }> {
  const startedAt = Date.now();
  let lastBalance: number | undefined;
  while (Date.now() - startedAt < windowMs) {
    try {
      lastBalance = await readTestnetOfferBalance(page);
      if (lastBalance === expected) return { observed: true, elapsedMs: Date.now() - startedAt, lastBalance };
    } catch {
      // 页面重渲染/Offer 暂不可读时继续轮询，不把瞬时失败当成余额结论。
    }
    await page.waitForTimeout(OBSERVE_POLL_MS);
  }
  return { observed: false, elapsedMs: Date.now() - startedAt, lastBalance };
}

/**
 * 业务目标（观察探针）：回答“seed 打 10 sat 到固定 key01 地址后，页面什么时候
 * 能看到余额”，不做回款。
 *
 * 开始状态：resource-setup 已完成真实资源门禁；key01 地址必须为 0 余额。
 * 流程：页面导入 key01 → seed 打款并等待 confirmed（记录时间点）→ 开启 testnet
 * 触发 confirmed-sync → 在转账 Offer 上轮询余额；自然窗口没出现时，再用一次
 * 费率设置变更强制同步并记录第二次窗口结果。
 *
 * 该探针故意不把 10 sat 转回 seed：余额留在固定地址供跨轮追踪；再次运行前需要
 * 先把该地址清空（可用回款 Journey 或手工导入 key01 转出）。不保留
 * trace/screenshot/video。
 *
 * 覆盖需求：KM-ASSET-001。
 */
test(JOURNEY_ID + "：seed 打 10 sat 到 key01，页面何时观察到余额", async ({ page, context }, testInfo) => {
  test.setTimeout(2_100_000);
  const password = "real-testnet-arrival-probe-password-123";
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2EConfig | undefined;
  let wallet: OneTimeWallet | undefined;
  let evidenceError: unknown;

  try {
    const state = await readResourceRunState();
    expect(state, "真实资源 setup 必须先产生运行状态").not.toBeNull();
    if (!state) throw new Error("真实资源运行状态不可用");

    config = await loadE2EConfig();
    expect(publicConfigFingerprint(config), "Journey 与 setup 使用的公开资源配置必须一致").toBe(state.configFingerprint);

    const ledger = new RecoveryLedger(path.join(config.directory, "testnet-funding-ledger.json"));
    const chain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
      operationJournalPath: path.join(config.directory, "testnet-operation-journal.json"),
    });
    const funding = new TestnetFundingResource(config.testnet.privateKeyHex, chain, ledger);
    wallet = funding.createImportedWallet(state.runId, JOURNEY_ID, config.testnet.trackingKeyPrivateKeyHex.read());

    const report: Record<string, unknown> = {
      journey: JOURNEY_ID,
      keyAddress: wallet.address,
      seedAddress: state.testnet.seedAddress,
    };

    await test.step("页面用 key01 导入 Key，确认地址在打款前为 0 余额", async () => {
      const existing = await chain.inspectAddress(wallet!.address);
      expect(existing.mainnetBalance, "可追踪测试 Key 不得在 mainnet 有余额").toBe(0);
      // 只按“是否还有可花费输出”判空：上一轮支出可能仍在 mempool，
      // confirmed + unconfirmed 的求和会短暂为负，不能作为判空依据。
      expect(
        existing.spendableUtxoCount === 0,
        `可追踪 Key 地址 ${wallet!.address} 仍有可花费 testnet 输出（utxos=${existing.spendableUtxoCount}，balance=${existing.testnetBalance}）；请先清空该地址后再跑探针`,
      ).toBe(true);

      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "真实 testnet 到账探针桶",
        keyLabel: "真实 testnet 到账探针 Key",
        password,
        privateKeyHex: wallet!.privateKey.read(),
      });
      expect(ready.publicKeyHex, "页面导入后的 active Key 必须等于可追踪测试 Key").toBe(wallet!.publicKeyHex);
    });

    await test.step("seed 打 10 sat 并等待 confirmed，记录时间点", async () => {
      const broadcastAt = Date.now();
      const funded = await funding.fund(wallet!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: FUNDING_SATOSHIS,
        feeReserveSatoshis: 1_000,
      });
      report.fundingTxid = funded.fundingTxid;
      report.broadcastAt = new Date(broadcastAt).toISOString();
      expect(funded.fundingTxid, "充值记录必须有 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);

      const confirmed = await chain.waitForConfirmedTransaction(funded.fundingTxid!, { timeoutMs: 1_500_000, pollMs: 15_000 });
      report.confirmedAt = new Date().toISOString();
      report.confirmationMs = Date.now() - broadcastAt;
      expect(confirmed, "探针必须观察到真实 confirmed 才继续").toBe("confirmed");
    });

    let natural: { observed: boolean; elapsedMs: number; lastBalance: number | undefined } | undefined;
    let forced: { observed: boolean; elapsedMs: number; lastBalance: number | undefined } | undefined;
    await test.step("开启 testnet 触发同步，在 Offer 上观察余额出现时间", async () => {
      const enabledAt = Date.now();
      await enableTestnetAssets(page);
      await openTransferPage(page);
      natural = await observeBalance(page, FUNDING_SATOSHIS, NATURAL_OBSERVE_WINDOW_MS);
      report.testnetEnabledAt = new Date(enabledAt).toISOString();
      report.naturalObserved = natural.observed;
      report.naturalObservedMs = natural.elapsedMs;
      report.naturalLastBalance = natural.lastBalance;

      if (!natural.observed) {
        // 自然窗口内没出现时，用一次费率设置变更强制 provider-change 同步；
        // 这能把“同步没被触发”和“同步跑了但看不到钱”区分开。
        const forcedAt = Date.now();
        await setP2pkhFeeRate(page, "medium", 1);
        await openTransferPage(page);
        forced = await observeBalance(page, FUNDING_SATOSHIS, FORCED_OBSERVE_WINDOW_MS);
        report.forcedSyncAt = new Date(forcedAt).toISOString();
        report.forcedObserved = forced.observed;
        report.forcedObservedMs = forced.elapsedMs;
        report.forcedLastBalance = forced.lastBalance;
      }
    });

    await attachRedactedText(testInfo, "arrival-probe-report", JSON.stringify(report), { contentType: "application/json" });
    const observed = natural?.observed === true || forced?.observed === true;
    expect(
      observed,
      `页面在 ${NATURAL_OBSERVE_WINDOW_MS / 1_000}s 自然窗口和 ${FORCED_OBSERVE_WINDOW_MS / 1_000}s 强制同步窗口内都没有观察到 10 sats；报告：${JSON.stringify(report)}`,
    ).toBe(true);
  } catch (error) {
    throw error;
  } finally {
    try {
      await attachBrowserErrors(testInfo, browserErrors, [password]);
    } catch (error) {
      evidenceError = error;
    }
    wallet?.clear();
    clearSecrets(config);
  }

  if (evidenceError) throw evidenceError;
});
