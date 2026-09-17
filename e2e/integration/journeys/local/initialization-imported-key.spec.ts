import { expect, test } from "@playwright/test";
import { readSessionPublicKey } from "../../drivers/appDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { LOCAL_IMPORTED_KEY_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_IMPORTED_KEY_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_IMPORTED_KEY_SCENARIO;

/**
 * 业务目标：首次初始化时导入一把 Hex Key，完成后进入首页并保持同一身份。
 *
 * 这条 Journey 保留旧 initial-setup 的独有导入分支；生成 Key、刷新、锁定和
 * 解锁由 initialization-generated Journey 负责，避免同一初始化路径重复执行。
 * 私钥是本次测试专用的确定性短期值，只在当前页面操作期间出现，诊断会脱敏。
 */
test(JOURNEY_ID + "：首次初始化导入 Hex Key 后进入首页", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const password = "imported-key-e2e-password-123";
  const privateKeyHex = "0000000000000000000000000000000000000000000000000000000000000001";
  const browserErrors = captureBrowserErrors(page, context);

  try {
    const ready = await initializeLocalUserWithImportedHexKey(page, {
      bucketLabel: "Imported E2E bucket",
      keyLabel: "Imported E2E Key",
      password,
      privateKeyHex,
    });
    expect(ready.publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/iu);
    // 初始化完成后落在首页；身份真值由 session 记录确认。
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(readSessionPublicKey(page)).resolves.toBe(ready.publicKeyHex);
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password, privateKeyHex]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
