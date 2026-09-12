import { test } from "@playwright/test";
import { loadE2EConfig, publicConfigFingerprint } from "./config/loader.js";
import type { LoadedE2EConfig } from "./config/types.js";
import { S3CleanupResource } from "./s3/s3CleanupResource.js";
import { createWebSocketProbe, SatSubscriptionHealthResource } from "./satsubscription/healthResource.js";
import { RecoveryLedger, TestnetFundingResource } from "./testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "./testnet/wocChainAdapter.js";
import { currentRunId } from "../support/ids.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { writeResourceRunState } from "../support/resourceState.js";
import path from "node:path";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
}

/**
 * 整轮 real-resource 的唯一 setup：权限预检、S3 ownership/lease/开场清理，
 * 以及 SatSubscription WebSocket、testnet 链网络/余额/旧账检查。缺配置或
 * 缺少真实链适配器时故意失败，不能降级为本地 fake。
 */
test("真实资源整轮准备：专用桶、testnet 服务和资金账本门禁", async ({}, testInfo) => {
  test.setTimeout(60_000);
  let config: LoadedE2EConfig | undefined;
  let s3: S3CleanupResource | undefined;
  let leaseAcquired = false;
  let runStateWritten = false;
  const runId = currentRunId();
  try {
    config = await loadE2EConfig();
    s3 = new S3CleanupResource(config.s3);
    await s3.assertOwnership();
    await s3.acquireLease(runId);
    leaseAcquired = true;
    // 这是本轮唯一的开场全桶清理；后续 Journey 只能使用 run_id/scenario_id 前缀。
    await s3.cleanup(runId);

    const websocketProbe = createWebSocketProbe();
    const sat = new SatSubscriptionHealthResource(config.satsubscription, {
      ...websocketProbe,
      checkWebrtcDirect: async () => { throw new Error("WebRTC Direct real adapter is required by a scenario and was not configured"); },
    });
    const satVerification = await sat.verify(runId, { requireWebrtcDirect: process.env.KEYMASTER_E2E_REQUIRE_WEBRTC_DIRECT === "1" });

    const ledger = new RecoveryLedger(path.join(config.directory, "testnet-funding-ledger.json"));
    const chain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
      operationJournalPath: path.join(config.directory, "testnet-operation-journal.json"),
    });
    const funding = new TestnetFundingResource(config.testnet.privateKeyHex, chain, ledger);
    const minimumReserve = Number(process.env.KEYMASTER_E2E_MIN_TESTNET_RESERVE_SATOSHIS ?? "100000");
    const prepared = await funding.prepare(runId, minimumReserve);

    // Resource 状态只保留公开结果；seed、授权令牌和链适配器都不跨项目传递。
    await writeResourceRunState({
      version: 1,
      runId,
      configFingerprint: publicConfigFingerprint(config),
      s3LeaseAcquired: true,
      satSubscription: {
        network: satVerification.network,
        servicePublicKeyHex: satVerification.servicePublicKeyHex,
        websocketVerified: true,
        webrtcDirectVerified: Boolean(satVerification.webrtcDirect),
      },
      testnet: {
        network: "testnet",
        seedAddress: prepared.seedAddress,
        testnetBalance: prepared.testnetBalance,
        spendableUtxoCount: prepared.spendableUtxoCount,
        tipHeight: prepared.tipHeight,
      },
      createdAt: new Date().toISOString(),
    });
    runStateWritten = true;
  } catch (error) {
    // 如果 lease 已拿到但非敏感运行状态还没落盘，teardown 无法安全认领它；
    // 此时尚未允许任何 Journey 运行，可以条件释放孤立 lease，避免留下不可恢复的锁。
    if (s3 && leaseAcquired && !runStateWritten) await s3.releaseLease(runId).catch(() => undefined);
    await attachRedactedText(testInfo, "resource-setup-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
