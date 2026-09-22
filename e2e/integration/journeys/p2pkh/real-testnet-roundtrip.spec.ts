import { expect, test } from "@playwright/test";
import {
  dismissTestnetTransferResult,
  enableTestnetAssets,
  expectAmountBalanceReference,
  expectTestnetWalletBalance,
  expectTransferFeeTierRate,
  openTransferPage,
  refreshTestnetUtxoSnapshot,
  setP2pkhFeeRate,
  submitTestnetSendAll,
  waitForP2pkhSyncIdle,
  waitForTestnetUtxoSnapshot,
} from "../../drivers/p2pkhDriver.js";
import { enterManualRecipient, selectRecipientTab } from "../../drivers/transferRecipientDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { loadE2EConfig, publicConfigFingerprint } from "../../resources/config/loader.js";
import { TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter, type WocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachRedactedText } from "../../support/redaction.js";
import { readResourceRunState } from "../../support/resourceState.js";
import { REAL_TESTNET_ROUNDTRIP_SCENARIO } from "../../support/scenarioMetadata.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";

export const JOURNEY_ID = REAL_TESTNET_ROUNDTRIP_SCENARIO.id;
export const JOURNEY_METADATA = REAL_TESTNET_ROUNDTRIP_SCENARIO;

/** 从 seed 打到页面 Key 的金额；50 sat 让「全部」转出后仍留下正输出。 */
const FUNDING_SATOSHIS = 50;
/**
 * 页面“全部”转出的矿工费率。testnet 已实测接受 191 字节交易 1 sat 总费用；
 * 只有把中档费率调到 1 sats/kB，50 sat 余额才可能覆盖矿工费并留下正输出。
 */
const FEE_RATE_SATOSHIS_PER_KB = 1;
/** 本次允许的最大未归集损失：页面广播前失败时，Node 归集只损失 1 sat 矿工费。 */
const MAX_LOSS_SATOSHIS = 10;

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/**
 * 业务目标：用户在真实 testnet 上收币、看到余额，再用页面「全部」把余额
 * 转回 seed；本项目唯一的 testnet 资产 Journey（原 asset/arrival-probe 已合并）。
 *
 * 开始状态：resource-setup 已完成 s3.json 指定桶的 lease、SatSubscription 配置
 * 投影和 testnet seed 余额/网络门禁；本浏览器是全新 context。页面从仓库外
 * key01.hex 正式导入固定测试 Key，该地址在上一轮必须已无可花费输出。
 * 固定 Key 的私钥一直在仓库外配置里：任何一轮失败都能人工归集，因此不再
 * 需要跨轮恢复账本；每轮开始的可花费输出门禁 + 手工归集脚本是恢复保障。
 *
 * 成功标准：
 * - 页面导入后的 active Key 公钥等于 key01 派生公钥；
 * - Node 从 seed 打入 50 sat 并等待链上（mempool 即可）可观察，记录广播/可观察时间点；
 * - 开启 testnet 后 keymaster 自己的 WoC `unspent/all` 快照让转账 Offer 显示
 *   50 sats，并记录页面观察到的时间点；
 * - 用户以「全部」转回 seed：预览无找零、矿工费从余额扣除、页面返回 local-confirmed；
 * - 转出后页面余额回到 0；
 * - Node 只核对原始交易：它确实消费了资助输出，seed 收到的金额与页面预览一致，
 *   损失（充值 − 回款）不超过声明的最大损失。
 *
 * 外部资源与收尾：seed 侧广播由 Node Resource 完成。页面转账广播前失败时，Node
 * 用同一把 key01 私钥把资金按同一低费率归集回 seed；页面已广播后只按链上事实
 * 对账，绝不重复归集。该项目不保留 trace、screenshot 或 video，因为浏览器会在
 * 初始化阶段短暂接触 Key 密码和私钥材料。
 *
 * 覆盖需求：KM-ASSET-001。
 */
test(JOURNEY_ID + "：真实 testnet 收币、到账观察与全额回款", async ({ page, context }, testInfo) => {
  test.setTimeout(1_200_000);
  const password = "real-testnet-roundtrip-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2EConfig | undefined;
  let funding: TestnetFundingResource | undefined;
  let chain: WocTestnetChainAdapter | undefined;
  let wallet: OneTimeWallet | undefined;
  let fundingTxid = "";
  let seedAddress = "";
  let appReturnSubmitted = false;
  let fundsReturned = false;
  let journeyError: unknown;
  let evidenceError: unknown;
  let recoveryError: unknown;

  try {
    const state = await readResourceRunState();
    expect(state, "真实资源 setup 必须先产生运行状态").not.toBeNull();
    if (!state) throw new Error("真实资源运行状态不可用");

    config = await loadE2EConfig();
    expect(publicConfigFingerprint(config), "Journey 与 setup 使用的公开资源配置必须一致").toBe(state.configFingerprint);
    seedAddress = state.testnet.seedAddress;

    const activeChain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
    });
    const activeFunding = new TestnetFundingResource(config.testnet.privateKeyHex, activeChain);
    chain = activeChain;
    funding = activeFunding;
    wallet = activeFunding.createImportedWallet(state.runId, JOURNEY_ID, config.testnet.trackingKeyPrivateKeyHex.read());

    await test.step("用户用 key01 导入第一把 Key，地址与 Node 可追踪身份一致且上一轮已清空", async () => {
      const existing = await activeChain.inspectAddress(wallet!.address);
      expect(existing.mainnetBalance, "可追踪测试 Key 不得在 mainnet 有余额").toBe(0);
      // 只按“是否还有可花费输出”判空：testnet 确认慢，上一轮的支出可能仍在
      // mempool，此时 confirmed + unconfirmed 的求和会短暂为负，不能作为判空
      // 依据；只要没有可花费输出，就不会把旧钱混进本轮。
      expect(
        existing.spendableUtxoCount === 0,
        `可追踪 Key 地址 ${wallet!.address} 仍有可花费 testnet 输出（utxos=${existing.spendableUtxoCount}，balance=${existing.testnetBalance}）；请先跑 pnpm collect:testnet:key01 归集后再跑`,
      ).toBe(true);

      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "真实 testnet 回款测试桶",
        keyLabel: "真实 testnet 回款 Key",
        password,
        privateKeyHex: wallet!.privateKey.read(),
      });
      expect(ready.publicKeyHex, "页面导入后的 active Key 必须等于可追踪测试 Key").toBe(wallet!.publicKeyHex);
    });

    const timing: Record<string, unknown> = {
      journey: JOURNEY_ID,
      keyAddress: wallet.address,
      seedAddress,
      fundingSatoshis: FUNDING_SATOSHIS,
    };
    await test.step("Resource 从 seed 打 50 sat 到可追踪地址并等待链上可观察", async () => {
      const broadcastAt = Date.now();
      const funded = await activeFunding.fund(wallet!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: MAX_LOSS_SATOSHIS,
        feeReserveSatoshis: 1_000,
      });
      fundingTxid = funded.txid;
      // 附件不写 txid：脱敏门禁把任意 64 位 hex 视为私钥形状；txid 只在本轮
      // 内存里用于链上对账，不进入报告。
      timing.fundingFeeSatoshis = funded.feeSatoshis;
      timing.broadcastAt = new Date(broadcastAt).toISOString();
      expect(fundingTxid, "充值记录必须有 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);
      // 余额真值是 Coordinator 的 WoC `unspent/all` 快照，它同时返回未确认
      // 输出；这里只要求链上（mempool 即可）可观察，就能让随后的
      // provider-change 快照刷新看到这笔钱，不再为等出块浪费十几分钟。
      const observation = await activeChain.waitForTransaction(fundingTxid, { timeoutMs: 180_000, pollMs: 10_000 });
      expect(observation, "充值交易必须先在链上（mempool 或 confirmed）可观察，才能触发页面同步").toMatch(/^(confirmed|unconfirmed)$/u);
      timing.chainObservedAt = new Date().toISOString();
      timing.chainObservedMs = Date.now() - broadcastAt;
    });

    await test.step("用户开启 testnet 并调低费率，keymaster 自动刷新出 testnet UTXO 快照", async () => {
      await enableTestnetAssets(page);
      await setP2pkhFeeRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);
      // 设置变更会触发 provider-change 即时任务（历史同步 + UTXO 快照刷新）。
      // 已知竞态：若在这轮同步结束前就切到 Testnet 钱包页，Coordinator
      // SharedWorker 会在数秒后被回收，页面回到锁屏。这里先在设置页等到
      // 同步任务回到空闲，再进入钱包页观察快照。
      await waitForP2pkhSyncIdle(page);
      // 页面上的“UTXO 快照：<time>（N 个输出）”证明 keymaster 真的对 testnet
      // 资源跑完了一次 `unspent/all` 刷新，钱已经进入可花费集合。
      await waitForTestnetUtxoSnapshot(page);
      await expectTestnetWalletBalance(page, FUNDING_SATOSHIS);
    });

    let receipt: Awaited<ReturnType<typeof submitTestnetSendAll>> | undefined;
    await test.step("Keymaster 检测到账后，用户把全部余额转回 seed 地址", async () => {
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await expectAmountBalanceReference(page, { network: "test", satoshis: FUNDING_SATOSHIS });
      await expectTransferFeeTierRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);
      timing.pageObservedAt = new Date().toISOString();
      timing.pageObservedMs = Date.now() - Date.parse(String(timing.broadcastAt));

      // 页面即将广播：此后 Node 不再尝试归集，避免与页面交易双花。
      receipt = await submitTestnetSendAll(page, {
        recipientAddress: seedAddress,
        onBroadcastAttempt: () => { appReturnSubmitted = true; },
      });
      expect(receipt.amountSatoshis + receipt.feeSatoshis, "“全部”转出的收款输出与矿工费必须等于到账的 50 sat").toBe(FUNDING_SATOSHIS);
      expect(receipt.amountSatoshis, "收款输出必须为正整数").toBeLessThan(FUNDING_SATOSHIS);
    });

    await test.step("页面余额回到 0，Node 按原始交易核对回款", async () => {
      await dismissTestnetTransferResult(page);
      // 自动快照可能比 WoC 内存池更新早一步；用页面自己的「刷新 UTXO」
      // 推一轮，再断言 keymaster 快照不再包含资助输出。
      await refreshTestnetUtxoSnapshot(page, 0);
      await expectTestnetWalletBalance(page, 0, 60_000);

      const observation = await activeChain.waitForTransaction(receipt!.txid, { timeoutMs: 180_000, pollMs: 10_000 });
      expect(observation, "页面 local-confirmed 后，链上至少应观察到 confirmed 或 unconfirmed").toMatch(/^(confirmed|unconfirmed)$/u);
      // WoC 的 hash/propagation 与 raw hex 索引进度不同，hex 可能短暂 404。
      const returned = await activeChain.waitForTransactionOutputs(receipt!.txid, seedAddress, { timeoutMs: 120_000, pollMs: 5_000 });
      expect(returned.txid, "回款交易的 canonical txid 必须与页面一致").toBe(receipt!.txid);
      expect(
        returned.inputOutpointKeys.some((key) => key.startsWith(`${fundingTxid}:`)),
        "回款交易必须消费本轮充值输出",
      ).toBe(true);
      expect(returned.outputSatoshis, "seed 实收金额必须等于页面预览的收款输出").toBe(receipt!.amountSatoshis);
      const loss = FUNDING_SATOSHIS - returned.outputSatoshis;
      expect(loss, "损失不得超过声明的最大损失").toBeGreaterThanOrEqual(0);
      expect(loss, "损失不得超过声明的最大损失").toBeLessThanOrEqual(MAX_LOSS_SATOSHIS);
      timing.returnedSatoshis = returned.outputSatoshis;
      timing.lossSatoshis = loss;
      timing.appFeeSatoshis = receipt!.feeSatoshis;
    });

    await attachRedactedText(testInfo, "testnet-arrival-timing", JSON.stringify(timing, null, 2), { contentType: "application/json" });
  } catch (error) {
    journeyError = error;
  } finally {
    // 页面转账广播前失败时，Node 仍持有同一把 key01 私钥，可以把打款归集回
    // seed；归集使用与本 Journey 相同的 1 sats/kB 费率，50 sat 余额也能归集，
    // 不会留在固定地址阻塞下一轮。页面已广播后只按链上事实对账，绝不重复归集。
    if (funding && chain && wallet && !fundsReturned && !appReturnSubmitted) {
      try {
        // 不看内存里的 fundingTxid：广播结果未知时 txid 可能没留下，但只要
        // key01 地址真的有可花费输出，就必须归集回 seed。
        const observation = await chain.inspectAddress(wallet.address);
        if (observation.spendableUtxoCount > 0) {
          const returned = await funding.returnRemaining(wallet, seedAddress, { feeRateSatoshisPerKb: FEE_RATE_SATOSHIS_PER_KB });
          fundsReturned = true;
          await chain.waitForTransaction(returned.txid, { timeoutMs: 180_000, pollMs: 2_000 });
        }
      } catch (error) {
        recoveryError = error;
      }
    }
    try {
      const knownSecrets = [password, wallet?.privateKey.read() ?? ""];
      await attachBrowserErrors(testInfo, browserErrors, knownSecrets);
    } catch (error) {
      evidenceError = error;
    }
    wallet?.clear();
    clearSecrets(config);
  }

  if (journeyError) throw journeyError;
  if (recoveryError) throw recoveryError;
  if (evidenceError) throw evidenceError;
});
