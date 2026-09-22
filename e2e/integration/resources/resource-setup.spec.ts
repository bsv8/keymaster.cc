import { test } from "@playwright/test";
import { loadE2EConfig, publicConfigFingerprint } from "./config/loader.js";
import type { LoadedE2EConfig } from "./config/types.js";
import { S3CleanupResource } from "./s3/s3CleanupResource.js";
import { projectSatSubscriptionConfig } from "./satsubscription/healthResource.js";
import { TestnetFundingResource } from "./testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "./testnet/wocChainAdapter.js";
import { currentRunId } from "../support/ids.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { writeResourceRunState } from "../support/resourceState.js";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/** 真实资源 Journey 最长 30 分钟；租约还要覆盖 setup、收尾和网络抖动。 */
const RESOURCE_RUN_LEASE_TTL_MS = 60 * 60_000;

/**
 * 整轮 resources 执行档的唯一 setup：权限预检、S3 lease/开场清理，
 * 以及 testnet 链网络/余额/旧账检查。SatSubscription 页面 Journey 自己
 * 通过真实 Chromium 建立连接；这里不把 Node WebSocket 探针当作页面业务
 * 证据，也不因为没有直接探测而把资源判定为失败。
 */
test("真实资源整轮准备：S3、testnet 服务和资金账本门禁", async ({}, testInfo) => {
  test.setTimeout(60_000);
  let config: LoadedE2EConfig | undefined;
  let s3: S3CleanupResource | undefined;
  let leaseAcquired = false;
  let runStateWritten = false;
  const runId = currentRunId();
  try {
    config = await loadE2EConfig();
    s3 = new S3CleanupResource(config.s3);
    await s3.acquireLease(runId, Date.now(), RESOURCE_RUN_LEASE_TTL_MS);
    leaseAcquired = true;
    // setup 是非前缀测试：按约定清理指定桶中的全部业务对象；后续 Journey
    // 如果是前缀测试，则显式传入自己的 run_id/scenario_id 前缀。
    await s3.cleanup(runId);

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
      s3LeaseAcquired: true,
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
