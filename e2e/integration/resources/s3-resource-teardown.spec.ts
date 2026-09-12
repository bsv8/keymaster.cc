import { test } from "@playwright/test";
import { loadE2ES3Config, publicS3ConfigFingerprint } from "./config/loader.js";
import type { LoadedE2ES3Config } from "./config/types.js";
import { S3CleanupResource } from "./s3/s3CleanupResource.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { readS3ResourceRunState, removeS3ResourceRunState } from "../support/s3ResourceState.js";

function clearSecrets(config: LoadedE2ES3Config | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
}

/** 非前缀收尾：清理指定桶全部业务对象后才释放 lease。 */
test("真实 S3 资源收尾：全量业务清理并释放 lease", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const state = await readS3ResourceRunState();
  if (!state) return;
  let config: LoadedE2ES3Config | undefined;
  try {
    config = await loadE2ES3Config();
    if (publicS3ConfigFingerprint(config) !== state.configFingerprint) throw new Error("S3 config changed between setup and teardown");
    const resource = new S3CleanupResource(config.s3);
    await resource.adoptLease(state.runId);
    await resource.cleanup(state.runId);
    await resource.releaseLease(state.runId);
    await removeS3ResourceRunState();
  } catch (error) {
    await attachRedactedText(testInfo, "s3-resource-teardown-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
