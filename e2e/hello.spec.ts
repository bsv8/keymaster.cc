import { expect, test } from "@playwright/test";

test("hello: production application opens with native browser storage APIs", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("KeyMaster");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        hasIndexedDb: typeof indexedDB !== "undefined",
        hasWebCrypto: Boolean(window.isSecureContext && window.crypto?.subtle)
      }))
    )
    .toEqual({ hasIndexedDb: true, hasWebCrypto: true });
});
