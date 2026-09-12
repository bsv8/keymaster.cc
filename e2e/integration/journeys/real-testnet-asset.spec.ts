import { expect, test } from "@playwright/test";
import path from "node:path";
import { enableTestnetAssets, openTestnetTransfer, submitTestnetTransfer } from "../drivers/p2pkhDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../drivers/initialSetupDriver.js";
import { loadE2EConfig, publicConfigFingerprint } from "../resources/config/loader.js";
import { RecoveryLedger, TestnetFundingResource, deriveTestnetP2pkhAddress, deriveTestnetP2pkhAddressFromPrivateKey, type FundingLedgerRecord, type OneTimeWallet } from "../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../support/browserEvidence.js";
import { readResourceRunState } from "../support/resourceState.js";
import { REAL_TESTNET_ASSET_SCENARIO } from "../support/scenarioMetadata.js";
import type { LoadedE2EConfig } from "../resources/config/types.js";

export const JOURNEY_ID = REAL_TESTNET_ASSET_SCENARIO.id;
export const JOURNEY_METADATA = REAL_TESTNET_ASSET_SCENARIO;

// 这是公开的测试目标公钥，没有对应私钥；Journey 只向它发送少量 testnet
// 余额，结束时把一次性钱包剩余资金归集回 Resource 的 seed 地址。
const RECIPIENT_PUBLIC_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const FUNDING_SATOSHIS = 12_000;
const TRANSFER_SATOSHIS = 3_000;
const FEE_RESERVE_SATOSHIS = 2_000;
const MAX_LOSS_SATOSHIS = 2_000;

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
}

/**
 * 业务目标：用户在真实 testnet 上看到自己的余额，选择 testnet 资产，
 * 完成一次受控 P2PKH 转账，并在链上观察到同一笔 canonical txid。
 *
 * 开始状态：resource-setup 已完成 s3.json 指定桶的 lease、SatSubscription WebSocket
 * 健康检查和 testnet seed 余额/网络/恢复账本门禁；本浏览器仍是全新 context。
 * 长期 seed 只在本 Node 侧 Resource 中读取，一次性钱包私钥只在本 Journey
 * 的当前调用栈中短暂存在，绝不写入 resource-state、storageState 或报告。
 *
 * 成功标准：
 * - 生产页面正式开启 testnet 后出现 BSV Testnet transfer offer；
 * - 页面返回的 txid 与 Resource 对该 txid 的链上观察一致；
 * - 一次性钱包的剩余找零在归集前已确认不再包含原充值输出，归集结果写入
 *   脱敏 funding ledger，避免把“页面显示成功”当成资源生命周期闭合。
 *
 * 外部资源与收尾：使用独立一次性 testnet 钱包，最终归集到 seed 地址；
 * 任何未知广播结果都保留恢复账本并阻止盲目重试。该项目不保留 trace、
 * screenshot 或 video，因为浏览器会在初始化阶段短暂接触一次性私钥。
 *
 * 覆盖需求：KM-ASSET-001。
 */
test(JOURNEY_ID + "：真实 testnet 余额、转账和归集", async ({ page, context }, testInfo) => {
  test.setTimeout(900_000);
  const password = "real-testnet-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2EConfig | undefined;
  let wallet: OneTimeWallet | undefined;
  let funded: FundingLedgerRecord | undefined;
  let fundsReturned = false;
  let oneTimePrivateKeyHex = "";
  let journeyError: unknown;
  let cleanupError: unknown;
  let evidenceError: unknown;

  try {
    const state = await readResourceRunState();
    expect(state, "真实资源 setup 必须先产生运行状态").not.toBeNull();
    if (!state) throw new Error("真实资源运行状态不可用");

    config = await loadE2EConfig();
    expect(publicConfigFingerprint(config), "Journey 与 setup 使用的公开资源配置必须一致").toBe(state.configFingerprint);
    expect(
      deriveTestnetP2pkhAddressFromPrivateKey(config.testnet.privateKeyHex.read()),
      "setup 记录的 seed 地址必须与本次 Journey 实际使用的 seed 一致",
    ).toBe(state.testnet.seedAddress);

    const ledger = new RecoveryLedger(path.join(config.directory, "testnet-funding-ledger.json"));
    const chain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
      operationJournalPath: path.join(config.directory, "testnet-operation-journal.json"),
    });
    const funding = new TestnetFundingResource(config.testnet.privateKeyHex, chain, ledger);
    wallet = funding.createOneTimeWallet(state.runId, JOURNEY_ID);
    oneTimePrivateKeyHex = wallet.privateKey.read();

    await test.step("Resource 用一次性钱包充值，并等待生产 confirmed-sync 可见", async () => {
      funded = await funding.fund(wallet!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: MAX_LOSS_SATOSHIS,
        feeReserveSatoshis: FEE_RESERVE_SATOSHIS,
      });
      expect(funded.fundingTxid, "充值记录必须有 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);
      await chain.waitForConfirmedTransaction(funded.fundingTxid!, { timeoutMs: 600_000, pollMs: 2_000 });
    });

    await test.step("用户用一次性 testnet Key 完成 Local 首次初始化", async () => {
      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "真实 testnet 集成测试桶",
        keyLabel: "真实 testnet 一次性 Key",
        password,
        privateKeyHex: oneTimePrivateKeyHex,
      });
      expect(ready.publicKeyHex).toBe(wallet?.publicKeyHex);
      // Driver 已验证原始私钥不在 localStorage；此处只保留公钥归属断言。
    });

    await test.step("用户在正式设置中开启 testnet 资产", async () => {
      await enableTestnetAssets(page);
    });

    const recipientAddress = deriveTestnetP2pkhAddress(RECIPIENT_PUBLIC_KEY_HEX);
    let businessTxid = "";
    await test.step("用户选择 BSV Testnet 并核对地址、金额后广播", async () => {
      await openTestnetTransfer(page);
      businessTxid = await submitTestnetTransfer(page, { recipientAddress, amountSatoshis: TRANSFER_SATOSHIS });
      expect(businessTxid).toMatch(/^[0-9a-f]{64}$/iu);
      funded = await funding.recordBusinessTransaction(wallet!, businessTxid, TRANSFER_SATOSHIS);
    });

    await test.step("Resource 按同一 txid 观察链上结果，再安全归集找零", async () => {
      expect(funded?.fundingTxid).toBeTruthy();
      const observation = await chain.waitForTransaction(businessTxid, { timeoutMs: 180_000, pollMs: 2_000 });
      expect(observation, "页面 local-confirmed 后，链上至少应观察到 confirmed 或 unconfirmed").toMatch(/^(confirmed|unconfirmed)$/u);
      const remaining = await chain.waitForSpendableChange(wallet!.address, funded!.fundingTxid!, { timeoutMs: 180_000, pollMs: 2_000 });
      expect(remaining, "归集前一次性钱包必须仍有可花费找零").toBeGreaterThan(0);
      const returned = await funding.returnRemaining(wallet!, state.testnet.seedAddress);
      if (returned.status === "returned") fundsReturned = true;
      funded = returned;
      expect(returned.status).toBe("returned");
      expect(returned.returnTxid).toMatch(/^[0-9a-f]{64}$/iu);
      await chain.waitForTransaction(returned.returnTxid!, { timeoutMs: 180_000, pollMs: 2_000 });
    });
  } catch (error) {
    journeyError = error;
  } finally {
    // 不能让诊断附件或清理异常遮蔽原始业务失败；但清理失败仍必须让
    // 测试失败，促使下一轮按 recovery ledger 处理，而不是假装资源闭合。
    try {
      if (wallet && funded?.status === "funded" && !fundsReturned) {
        const cleanupConfig = config;
        if (!cleanupConfig) throw new Error("testnet cleanup config is unavailable");
        const cleanupLedger = new RecoveryLedger(path.join(cleanupConfig.directory, "testnet-funding-ledger.json"));
        const cleanupChain = createWocTestnetChainAdapter({
          baseUrl: cleanupConfig.satsubscription.testnetApiBaseUrl,
          ...(cleanupConfig.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: cleanupConfig.satsubscription.testnetApiAuthorization.read() }),
          operationJournalPath: path.join(cleanupConfig.directory, "testnet-operation-journal.json"),
        });
        const cleanupFunding = new TestnetFundingResource(cleanupConfig.testnet.privateKeyHex, cleanupChain, cleanupLedger);
        const returned = await cleanupFunding.returnRemaining(wallet, (await readResourceRunState())?.testnet.seedAddress ?? "");
        if (returned.returnTxid) await cleanupChain.waitForTransaction(returned.returnTxid, { timeoutMs: 180_000, pollMs: 2_000 });
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      // real-resource 项目显式关闭 trace/video/screenshot；只上传脱敏的
      // console/Worker 错误，并把一次性私钥作为已知秘密参与替换。
      const knownSecrets = [password, wallet?.privateKey.read() ?? ""];
      await attachBrowserErrors(testInfo, browserErrors, knownSecrets);
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
