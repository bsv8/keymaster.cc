import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  dismissTestnetTransferResult,
  enableTestnetAssets,
  expectTestnetOfferBalance,
  expectTransferFeeTierRate,
  openTransferPage,
  selectTestnetTransferOffer,
  setP2pkhFeeRate,
  submitTestnetSendAll,
  waitForTestnetConfirmedSync,
} from "../../drivers/p2pkhDriver.js";
import { initializeLocalUser } from "../../drivers/initialSetupDriver.js";
import { loadE2EConfig, publicConfigFingerprint } from "../../resources/config/loader.js";
import { RecoveryLedger, TestnetFundingResource, deriveTestnetP2pkhAddress, type FundingLedgerRecord, type FundingTarget } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { readResourceRunState } from "../../support/resourceState.js";
import { REAL_TESTNET_ROUNDTRIP_SCENARIO } from "../../support/scenarioMetadata.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";

export const JOURNEY_ID = REAL_TESTNET_ROUNDTRIP_SCENARIO.id;
export const JOURNEY_METADATA = REAL_TESTNET_ROUNDTRIP_SCENARIO;

/** 从 seed 打到页面 Key 的金额；10 sat 是本次覆盖的最小可用转账规模。 */
const FUNDING_SATOSHIS = 10;
/**
 * 页面“全部”转出的矿工费率。testnet 已实测接受 191 字节交易 1 sat 总费用；
 * 只有把中档费率调到 1 sats/kB，10 sat 余额才可能覆盖矿工费并留下正输出。
 */
const FEE_RATE_SATOSHIS_PER_KB = 1;
/** 本次允许的最大未归集损失：最坏情况是 10 sat 全部留在页面 Key。 */
const MAX_LOSS_SATOSHIS = 10;
const ADAPTER_FEE_RESERVE_SATOSHIS = 1_000;

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
}

/**
 * 业务目标：用户初始化桶和第一把 Key 后，seed 向该 Key 的 testnet 地址
 * 转入 10 sat；Keymaster 自己同步并检测到账，用户再把全部余额转回 seed。
 *
 * 开始状态：resource-setup 已完成 s3.json 指定桶的 lease、SatSubscription 配置
 * 投影和 testnet seed 余额/网络/旧账门禁；本浏览器仍是全新 context。
 * Key 由页面正式初始化流程生成，私钥从不离开页面 Vault；Node 侧只按公开
 * 地址打款，并按 canonical raw transaction 核对回款，不用 Node 余额代替
 * 页面余额断言。
 *
 * 成功标准：
 * - 转账 Offer 余额由 keymaster confirmed-sync 显示为 10 sats，而不是 Node 侧查询；
 * - 用户以“全部”转回 seed：预览无找零、矿工费从余额扣除、页面返回 local-confirmed；
 * - 转出后页面余额回到 0；
 * - Node 只核对原始交易：它确实消费了资助输出，seed 收到的金额与页面预览一致，
 *   账本闭合为 returned，损失等于页面显示的矿工费。
 *
 * 外部资源与收尾：seed 侧广播由 Node Resource 完成，页面 Key 私钥始终只在
 * 浏览器 Vault。任何失败最多留下 10 sat 在浏览器 profile 中，等于声明的
 * maxLoss；账本保持 funded 供人工核对，不做盲目重试。该项目不保留 trace、
 * screenshot 或 video，因为浏览器会在初始化阶段短暂接触 Key 密码。
 *
 * 覆盖需求：KM-ASSET-001。
 */
test(JOURNEY_ID + "：真实 testnet 收币与全额回款", async ({ page, context }, testInfo) => {
  test.setTimeout(1_200_000);
  const password = "real-testnet-roundtrip-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2EConfig | undefined;
  let target: FundingTarget | undefined;
  let funded: FundingLedgerRecord | undefined;
  let journeyError: unknown;
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

    let keyAddress = "";
    await test.step("用户初始化 Local 桶和第一把 Key，Node 只取得公开 testnet 地址", async () => {
      const ready = await initializeLocalUser(page, {
        bucketLabel: "真实 testnet 回款测试桶",
        keyLabel: "真实 testnet 回款 Key",
        password,
      });
      keyAddress = deriveTestnetP2pkhAddress(ready.publicKeyHex);
      target = funding.createFundingTarget(state.runId, JOURNEY_ID, keyAddress);
    });

    await test.step("Resource 从 seed 打 10 sat 到页面 Key 并等待 confirmed", async () => {
      funded = await funding.fund(target!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: MAX_LOSS_SATOSHIS,
        feeReserveSatoshis: ADAPTER_FEE_RESERVE_SATOSHIS,
      });
      expect(funded.fundingTxid, "充值记录必须有 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);
      // keymaster confirmed-sync 只摄入已进块交易；这里必须等真实确认，
      // 不能用“WOC 能查到交易”代替确认。testnet 出块不稳，用较慢轮询减少
      // 与页面同步共用 WOC 配额时的 429。
      await chain.waitForConfirmedTransaction(funded.fundingTxid!, { timeoutMs: 900_000, pollMs: 15_000 });
    });

    await test.step("用户开启 testnet 并调低费率，keymaster 完成一次 testnet confirmed-sync", async () => {
      await enableTestnetAssets(page);
      await setP2pkhFeeRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);
      // 设置变更会触发 provider-change 即时同步；钱包页的“最近完整同步”
      // 证明 keymaster 真的跑完了一次覆盖 testnet 资源的确认同步。
      await waitForTestnetConfirmedSync(page);
    });

    let receipt: Awaited<ReturnType<typeof submitTestnetSendAll>> | undefined;
    await test.step("Keymaster 检测到账后，用户把全部余额转回 seed 地址", async () => {
      await openTransferPage(page);
      await expectTestnetOfferBalance(page, FUNDING_SATOSHIS);
      await selectTestnetTransferOffer(page);
      await expectTransferFeeTierRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);

      receipt = await submitTestnetSendAll(page, { recipientAddress: state.testnet.seedAddress });
      expect(receipt.amountSatoshis + receipt.feeSatoshis, "“全部”转出的收款输出与矿工费必须等于到账的 10 sat").toBe(FUNDING_SATOSHIS);
      expect(receipt.amountSatoshis, "收款输出必须为正整数").toBeLessThan(FUNDING_SATOSHIS);
    });

    await test.step("页面余额回到 0，Node 按原始交易核对回款并闭合账本", async () => {
      await dismissTestnetTransferResult(page);
      await expectTestnetOfferBalance(page, 0);

      const observation = await chain.waitForTransaction(receipt!.txid, { timeoutMs: 180_000, pollMs: 10_000 });
      expect(observation, "页面 local-confirmed 后，链上至少应观察到 confirmed 或 unconfirmed").toMatch(/^(confirmed|unconfirmed)$/u);
      const returned = await funding.recordAppReturn(target!, {
        returnTxid: receipt!.txid,
        targetAddress: state.testnet.seedAddress,
      });
      expect(returned.status, "链上回款符合预算后账本必须闭合为 returned").toBe("returned");
      expect(returned.returnTxid).toBe(receipt!.txid);
      expect(returned.returnedSatoshis, "seed 实收金额必须等于页面预览的收款输出").toBe(receipt!.amountSatoshis);
      expect(returned.lossSatoshis, "账本损失必须等于页面显示的矿工费").toBe(receipt!.feeSatoshis);
    });
  } catch (error) {
    journeyError = error;
  } finally {
    // 页面 Key 的私钥只存在于浏览器 Vault，Node 无法替它归集；失败时账本
    // 保持 funded，按公开地址留下人工核对线索，不盲目重放。
    try {
      const knownSecrets = [password];
      await attachBrowserErrors(testInfo, browserErrors, knownSecrets);
    } catch (error) {
      evidenceError = error;
    }
    clearSecrets(config);
  }

  if (journeyError) throw journeyError;
  if (evidenceError) throw evidenceError;
});
