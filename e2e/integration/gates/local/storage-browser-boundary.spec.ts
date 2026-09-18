import { expect, test } from "@playwright/test";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { readRawLocalBucketObjects, readRawLocalStorage } from "../../support/localBucketFormats.js";
import { grantPersistentStorage } from "../../support/persistentStorage.js";
import { STORAGE_BROWSER_GATE } from "../../support/scenarioMetadata.js";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";

export const GATE_ID = STORAGE_BROWSER_GATE.id;
export const GATE_METADATA = STORAGE_BROWSER_GATE;

/**
 * 业务结果：用户的 Local 数据必须写入真实浏览器 IndexedDB，并在获得
 * persistent-storage 授权前后表现一致；localStorage 只保留设备引导记录。
 *
 * 开始状态：真实 Chromium + 生产 preview，没有注入 localStorage、Worker 或 MessageChannel 替身。
 * 失败影响：存储物理入口错了会导致刷新、Worker 重启或多页面状态丢失；
 * 未授权的 IndexedDB 可能被浏览器在存储压力下清理。
 */
test(GATE_ID + "：真实浏览器存储边界", async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const errors = captureBrowserErrors(page, context);
  const password = "browser-boundary-e2e-password-123";
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const browserFacts = await page.evaluate(() => {
      const probeKey = "keymaster.e2e.browser-boundary-probe";
      window.localStorage.setItem(probeKey, "ok");
      const value = window.localStorage.getItem(probeKey);
      window.localStorage.removeItem(probeKey);
      return {
        hasLocalStorage: value === "ok",
        hasBrowserDatabaseApi: typeof indexedDB !== "undefined",
        hasWebCrypto: Boolean(window.isSecureContext && window.crypto?.subtle),
        hasSharedWorker: typeof SharedWorker === "function",
        catalogKey: window.localStorage.getItem("keymaster.storage.catalog.v2"),
      };
    });

    await expect(page).toHaveTitle("KeyMaster");
    expect(browserFacts.hasLocalStorage).toBe(true);
    expect(browserFacts.hasBrowserDatabaseApi).toBe(true);
    expect(browserFacts.hasWebCrypto).toBe(true);
    expect(browserFacts.hasSharedWorker).toBe(true);
    expect(browserFacts.catalogKey).toBeNull();

    // 未授权：授权条持续显示；点击授权后浏览器仍拒绝时不能消失。
    await test.step("未授权时授权条持续显示", async () => {
      const bar = page.getByTestId("indexeddb-persistence-bar");
      await expect(bar).toBeVisible();
      expect(await page.evaluate(() => navigator.storage.persisted())).toBe(false);
      await bar.getByRole("button").click();
      await expect(bar).toBeVisible();
    });

    const ready = await test.step("建立 Local 身份", async () => initializeNewLocalUser(
      { page },
      { bucketLabel: "存储边界 Gate 桶", keyLabel: "存储边界 Gate Key", password },
    ));

    await test.step("Local 桶对象只写 IndexedDB，localStorage 只保留引导记录", async () => {
      const bucketObjects = await readRawLocalBucketObjects(page);
      expect(
        bucketObjects.filter((entry) => entry.bucketId === ready.bucketId).map((entry) => entry.path),
        "IndexedDB 必须保存 KeyHold 与当前 Key 的应用锁",
      ).toEqual(expect.arrayContaining([
        `keys/${ready.publicKeyHex}.keyhold`,
        `${ready.publicKeyHex}/lock.json`,
      ]));
      const entries = await readRawLocalStorage(page);
      const bucketKeys = entries.filter((entry) => entry.key.startsWith("keymaster.bucket."));
      expect(bucketKeys, `Local 桶对象不得再写入 localStorage: ${bucketKeys.map((entry) => entry.key).join(", ")}`).toEqual([]);
      expect(entries.some((entry) => entry.key === `keymaster.device.${ready.bucketId}`)).toBe(true);
      expect(entries.some((entry) => entry.key === "keymaster.session")).toBe(true);
    });

    await test.step("授权永久存储后授权条消失，刷新仍保持", async () => {
      await grantPersistentStorage(page);
      await page.getByTestId("indexeddb-persistence-bar").getByRole("button").click();
      await expect(page.getByTestId("indexeddb-persistence-bar")).toHaveCount(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("indexeddb-persistence-bar")).toHaveCount(0);
      const afterReload = await readRawLocalBucketObjects(page);
      expect(afterReload.map((entry) => entry.path)).toContain(`keys/${ready.publicKeyHex}.keyhold`);
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});
