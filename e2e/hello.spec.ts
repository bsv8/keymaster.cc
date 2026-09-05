import { expect, test } from "@playwright/test";

test("hello: production application opens with native browser storage APIs", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("KeyMaster");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        hasIndexedRepository: typeof indexedDB !== "undefined",
        hasWebCrypto: Boolean(window.isSecureContext && window.crypto?.subtle)
      }))
    )
    .toEqual({ hasIndexedRepository: true, hasWebCrypto: true });
});
