import { test } from "@playwright/test";
import { loadE2EConfig, publicConfigFingerprint } from "./config/loader.js";
import type { LoadedE2EConfig } from "./config/types.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { readResourceRunState, removeResourceRunState } from "../support/resourceState.js";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/** 依赖测试失败也执行；只有本轮运行状态可确认时才移除它。 */
test("真实资源整轮收尾：移除本轮运行状态", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const state = await readResourceRunState();
  if (!state) return;
  let config: LoadedE2EConfig | undefined;
  try {
    config = await loadE2EConfig();
    if (publicConfigFingerprint(config) !== state.configFingerprint) throw new Error("resource config changed between setup and teardown");
    await removeResourceRunState();
  } catch (error) {
    await attachRedactedText(testInfo, "resource-teardown-error", JSON.stringify(redactedError(error)), { contentType: "application/json" });
    throw error;
  } finally {
    clearSecrets(config);
  }
});
