import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadE2EConfig } from "../integration/resources/config/loader.js";
import type { LoadedE2EConfig } from "../integration/resources/config/types.js";
import { TestnetFundingResource } from "../integration/resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../integration/resources/testnet/wocChainAdapter.js";
import { currentRunId } from "../integration/support/ids.js";
import { ensureRunDataDirectory } from "../integration/support/runData.js";

/** 手工归集优先用最低合法费率，尽量把钱还给 seed；广播前由适配器按真实大小复核。 */
const FEE_RATE_SATOSHIS_PER_KB = 1;
const SCENARIO_ID = "MANUAL-COLLECT-KEY01";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/**
 * 手工维护脚本：把 key01 地址上所有可花费 testnet 余额归集回 seed。
 *
 * 用途：某轮 Journey 硬崩或手工操作后，key01 上留下资金，下一轮 Journey 的
 * “无可花费输出”门禁会 fail-closed；运营者先用本脚本清空。
 *
 * 设计缘由：
 * - 走 Node 侧适配器的「全部转出」逻辑（生产交易构造器 + 自动按真实签名大小
 *   计算并扣除矿工费），不驱动页面，因此不依赖页面构建，也不接触浏览器 Vault。
 * - 无余额时安全退出并报告“无需归集”；私钥、WIF、S3 凭据绝不写入日志或报告。
 * - 结果未知（uncertain）时直接失败，不做盲目重发；先看链上再决定下一步。
 */
test("手工归集 key01 testnet 余额回 seed", async ({}, testInfo) => {
  test.setTimeout(300_000);
  let config: LoadedE2EConfig | undefined;
  try {
    config = await loadE2EConfig();
    const chain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
    });
    const funding = new TestnetFundingResource(config.testnet.privateKeyHex, chain);
    const wallet = funding.createImportedWallet(currentRunId(), SCENARIO_ID, config.testnet.trackingKeyPrivateKeyHex.read());
    try {
      // prepare 同时校验网络身份、seed 地址归属和 mainnet 安全边界。
      const { seedAddress } = await funding.prepare(0);
      const observation = await chain.inspectAddress(wallet.address);
      if (observation.spendableUtxoCount === 0) {
        console.log(`[collect-key01] 无需归集：${wallet.address} 没有可花费 testnet 输出`);
        return;
      }

      const returned = await funding.returnRemaining(wallet, seedAddress, { feeRateSatoshisPerKb: FEE_RATE_SATOSHIS_PER_KB });
      await chain.waitForTransaction(returned.txid, { timeoutMs: 180_000, pollMs: 5_000 });
      const summary = {
        collectedAt: new Date().toISOString(),
        key01Address: wallet.address,
        seedAddress,
        inputUtxoCount: observation.spendableUtxoCount,
        returnedSatoshis: returned.outputSatoshis,
        feeSatoshis: returned.feeSatoshis,
        returnTxid: returned.txid,
      };
      const directory = await ensureRunDataDirectory("maintenance", "logs");
      const logFile = path.join(directory, `collect-key01-${Date.now().toString(36)}.json`);
      await writeFile(logFile, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      console.log(`[collect-key01] 已归集 ${returned.outputSatoshis} sat 回 seed（手续费 ${returned.feeSatoshis} sat，txid ${returned.txid}，记录 ${logFile}）`);
      expect(returned.outputSatoshis, "归集回执必须为正").toBeGreaterThan(0);
    } finally {
      wallet.clear();
    }
  } finally {
    clearSecrets(config);
  }
});
