import { test } from "@playwright/test";
import { loadE2EConfig, publicConfigFingerprint } from "./config/loader.js";
import type { LoadedE2EConfig } from "./config/types.js";
import { projectSatSubscriptionConfig } from "./satsubscription/healthResource.js";
import { TestnetFundingResource } from "./testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "./testnet/wocChainAdapter.js";
import { currentRunId } from "../support/ids.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { writeResourceRunState } from "../support/resourceState.js";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/**
 * 整轮 resources 执行档的唯一 setup：权限预检，以及 testnet 链
 * 网络/余额/旧账检查。SatSubscription 页面 Journey 自己
 * 通过真实 Chromium 建立连接；这里不把 Node WebSocket 探针当作页面业务
 * 证据，也不因为没有直接探测而把资源判定为失败。
 */
test("真实资源整轮准备：testnet 服务和资金账本门禁", async ({}, testInfo) => {
  test.setTimeout(60_000);
  let config: LoadedE2EConfig | undefined;
  const runId = currentRunId();
  try {
    config = await loadE2EConfig();
    const satProjection = projectSatSubscriptionConfig(config.satsubscription, runId);
    const chain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
    });
    const funding = new TestnetFundingResource(config.testnet.privateKeyHex, chain);
    const minimumReserve = Number(process.env.KEYMASTER_E2E_MIN_TESTNET_RESERVE_SATOSHIS ?? "100000");
    const prepared = await funding.prepare(minimumReserve);

    // Resource 状态只保留公开结果；seed、授权令牌和链适配器都不跨项目传递。
    await writeResourceRunState({
      version: 1,
      runId,
      configFingerprint: publicConfigFingerprint(config),
      satSubscription: {
        network: satProjection.network,
        configuredSupplierPublicKeyHex: satProjection.supplierPublicKeyHex,
        websocketVerified: satProjection.websocketVerified,
        webrtcDirectVerified: satProjection.webrtcDirectVerified,
      },
      testnet: {
        network: "testnet",
        seedAddress: prepared.seedAddress,
        seedPublicKeyHex: prepared.seedPublicKeyHex,
        testnetBalance: prepared.testnetBalance,
        spendableUtxoCount: prepared.spendableUtxoCount,
        tipHeight: prepared.tipHeight,
      },
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await attachRedactedText(testInfo, "resource-setup-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
