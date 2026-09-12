import { test } from "@playwright/test";
import { loadE2ES3Config, publicS3ConfigFingerprint } from "./config/loader.js";
import type { LoadedE2ES3Config } from "./config/types.js";
import { S3CleanupResource } from "./s3/s3CleanupResource.js";
import { currentRunId } from "../support/ids.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { writeS3ResourceRunState } from "../support/s3ResourceState.js";

function clearSecrets(config: LoadedE2ES3Config | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
}

/** 只准备真实 S3 Journey；不读取 SatSubscription、testnet 或其它长期秘密。 */
test("真实 S3 资源准备：取得 lease 并执行非前缀开场清理", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const runId = currentRunId();
  let config: LoadedE2ES3Config | undefined;
  let resource: S3CleanupResource | undefined;
  let leaseAcquired = false;
  let stateWritten = false;
  try {
    config = await loadE2ES3Config();
    resource = new S3CleanupResource(config.s3);
    await resource.acquireLease(runId);
    leaseAcquired = true;
    // setup 是非前缀阶段：清理 s3.json 指定桶中的全部业务对象。
    await resource.cleanup(runId);
    await writeS3ResourceRunState({
      version: 1,
      runId,
      configFingerprint: publicS3ConfigFingerprint(config),
      s3LeaseAcquired: true,
      createdAt: new Date().toISOString(),
    });
    stateWritten = true;
  } catch (error) {
    if (resource && leaseAcquired && !stateWritten) await resource.releaseLease(runId).catch(() => undefined);
    await attachRedactedText(testInfo, "s3-resource-setup-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
