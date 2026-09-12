import { test } from "@playwright/test";
import { loadE2EConfig, publicConfigFingerprint } from "./config/loader.js";
import type { LoadedE2EConfig } from "./config/types.js";
import { S3CleanupResource } from "./s3/s3CleanupResource.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { readResourceRunState, removeResourceRunState } from "../support/resourceState.js";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
}

/** 依赖测试失败也执行；清理不确定时保留 lease，让下一轮 setup 收口。 */
test("真实资源整轮收尾：确认清理后释放专用桶 lease", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const state = await readResourceRunState();
  if (!state) return;
  let config: LoadedE2EConfig | undefined;
  try {
    config = await loadE2EConfig();
    if (publicConfigFingerprint(config) !== state.configFingerprint) throw new Error("resource config changed between setup and teardown");
    const s3 = new S3CleanupResource(config.s3);
    await s3.assertOwnership();
    await s3.adoptLease(state.runId);
    await s3.cleanup(state.runId);
    await s3.releaseLease(state.runId);
    await removeResourceRunState();
  } catch (error) {
    await attachRedactedText(testInfo, "resource-teardown-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
