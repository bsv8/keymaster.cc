import { expect, test } from "@playwright/test";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import {
  WALLET_KEYHOLD_PATH,
  WALLET_META_PATH,
  assertWalletStorage,
  readRawLocalStorage,
  readRawWalletObjects,
} from "../../support/walletStorageFormats.js";
import { grantPersistentStorage } from "../../support/persistentStorage.js";
import { STORAGE_BROWSER_GATE } from "../../support/scenarioMetadata.js";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";

export const GATE_ID = STORAGE_BROWSER_GATE.id;
export const GATE_METADATA = STORAGE_BROWSER_GATE;

/**
 * 业务结果：用户的唯一钱包数据必须写入真实浏览器 IndexedDB 的固定路径，并在
 * 获得 persistent-storage 授权前后表现一致；localStorage 不承载任何钱包数据。
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
      { keyLabel: "存储边界 Gate Key", password },
    ));

    await test.step("唯一 Key 只写 IndexedDB，localStorage 不承载钱包数据", async () => {
      const snapshot = await assertWalletStorage(page, {
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
      expect(snapshot.walletGeneration).toBe(ready.walletGeneration);
      const walletObjects = await readRawWalletObjects(page);
      expect(
        walletObjects.map((entry) => entry.path),
        "IndexedDB 必须保存固定 key.json 与 .keymaster/meta",
      ).toEqual(expect.arrayContaining([WALLET_KEYHOLD_PATH, WALLET_META_PATH]));
      const entries = await readRawLocalStorage(page);
      const walletKeys = entries.filter((entry) => /^keymaster\.(?:bucket|device|session|storage\.catalog|storage\.catalog\.v2)\b/u.test(entry.key));
      expect(walletKeys, "localStorage 不得保存任何钱包指针: " + walletKeys.map((entry) => entry.key).join(", ")).toEqual([]);
    });

    await test.step("授权永久存储后授权条消失，刷新仍保持", async () => {
      await grantPersistentStorage(page);
      await page.getByTestId("indexeddb-persistence-bar").getByRole("button").click();
      await expect(page.getByTestId("indexeddb-persistence-bar")).toHaveCount(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("indexeddb-persistence-bar")).toHaveCount(0);
      const afterReload = await readRawWalletObjects(page);
      expect(afterReload.map((entry) => entry.path)).toContain(WALLET_KEYHOLD_PATH);
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});
