import { expect, test } from "@playwright/test";
import { captureBrowserErrors, attachBrowserErrors } from "../support/browserEvidence.js";
import { STORAGE_BROWSER_GATE } from "../support/scenarioMetadata.js";

export const GATE_ID = STORAGE_BROWSER_GATE.id;
export const GATE_METADATA = STORAGE_BROWSER_GATE;

/**
 * 业务结果：用户的 Local 数据必须在真实浏览器中经过 localStorage bridge 保存和恢复，
 * 不能因为 Node 测试替身可用就宣称首次初始化成立。
 *
 * 开始状态：真实 Chromium + 生产 preview，没有注入 localStorage、Worker 或 MessageChannel 替身。
 * 失败影响：存储物理入口错了会导致刷新、Worker 重启或多页面状态丢失。
 */
test(GATE_ID + "：真实浏览器存储边界", async ({ page, context }, testInfo) => {
  const errors = captureBrowserErrors(page, context);
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const browserFacts = await page.evaluate(() => {
      const probeKey = "keymaster.e2e.browser-boundary-probe";
      window.localStorage.setItem(probeKey, "ok");
      const value = window.localStorage.getItem(probeKey);
      window.localStorage.removeItem(probeKey);
      return {
        hasLocalStorage: value === "ok",
        hasLegacyDatabaseApi: typeof indexedDB !== "undefined",
        hasWebCrypto: Boolean(window.isSecureContext && window.crypto?.subtle),
        hasSharedWorker: typeof SharedWorker === "function",
        catalogKey: window.localStorage.getItem("keymaster.storage.catalog.v2"),
      };
    });

    expect(browserFacts.hasLocalStorage).toBe(true);
    expect(browserFacts.hasWebCrypto).toBe(true);
    expect(browserFacts.hasSharedWorker).toBe(true);
    // IndexedDB 可能是浏览器能力，但当前 Keymaster Local 的正式物理真值仍是 localStorage。
    expect(browserFacts.catalogKey).toBeNull();
  } finally {
    await attachBrowserErrors(testInfo, errors);
  }
});
