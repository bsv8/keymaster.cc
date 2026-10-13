// Runs against the actual built app, with real IndexedDB/Coordinator/plugin
// lifecycles. Each run uses a disposable browser context and a newly generated
// wallet; it never imports keys or uses the user's browser profile.
// Usage: node Coding/keymaster/e2e-wallet-lock/run.mjs http://127.0.0.1:4199/
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const password = `local-lock-regression-${crypto.randomUUID()}`;
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => {
  if (message.type() === "error" && /cleanup|scope.*stopping|identity transition/i.test(message.text())) errors.push(message.text());
});
const lock = page.getByRole("button", { name: /^(Lock|锁定)$/u });
const unlock = page.getByRole("button", { name: /^(Unlock|解锁)$/u });
try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:4199/", { waitUntil: "domcontentloaded" });
  await page.locator('button[data-intent="new"]').click();
  await page.getByLabel(/^新密码$|^New password$/u).fill(password);
  await page.getByLabel(/^确认密码$|^Confirm password$/u).fill(password);
  await page.getByRole("button", { name: /^创建$|^Create$/u }).click();
  for (let round = 1; round <= 2; round++) {
    await expect(lock).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      window.__walletLockPaintMs = undefined;
      const clicked = event => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if (!button || !/^(Lock|锁定)$/.test(button.getAttribute("aria-label") ?? button.textContent ?? "")) return;
        document.removeEventListener("click", clicked, true);
        const started = performance.now();
        const observer = new MutationObserver(() => {
          if (![...document.querySelectorAll("h1,h2")].some(heading => /^(Wallet locked|钱包已锁定)$/.test(heading.textContent ?? ""))) return;
          window.__walletLockPaintMs = performance.now() - started;
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      };
      document.addEventListener("click", clicked, true);
    });
    await lock.click();
    await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/u })).toBeVisible({ timeout: 3_000 });
    const lockScreenMs = await page.evaluate(() => window.__walletLockPaintMs);
    expect(lockScreenMs, "Lock screen should update without waiting for plugin teardown").toBeLessThan(250);
    console.log(`Lock screen round ${round}: ${lockScreenMs.toFixed(1)} ms`);
    await expect(unlock).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/部分服务清理失败|Some services could not finish cleaning up/u)).toHaveCount(0);
    if (round === 1) {
      await page.getByLabel(/密码|password/iu).fill(`${password}-wrong`);
      await unlock.click();
      await expect(unlock).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel(/密码|password/iu)).toBeEnabled();
      await expect(page.locator(".ui-field__error")).toBeVisible();
      await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/u })).toBeVisible();
      await expect(page.locator(".startup-placeholder")).toHaveCount(0);
    }
    await page.getByLabel(/密码|password/iu).fill(password);
    await page.evaluate(() => {
      window.__unlockTransitionFailures = [];
      const entry = document.querySelector(".locked-shell--form");
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".startup-placeholder") || node.querySelector(".startup-placeholder"))) {
            window.__unlockTransitionFailures.push(`Intermediate startup spinner appeared: ${node.textContent}`);
          }
        }
        const arrived = [...document.querySelectorAll("button")].some(button => /^(Lock|锁定)$/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
        if (arrived) { observer.disconnect(); return; }
        if (!entry?.isConnected) window.__unlockTransitionFailures.push("Unlock form was unmounted before the destination was ready");
        const button = entry?.querySelector(".locked-shell__actions button");
        if (button && (!button.disabled || button.textContent !== "Loading…")) window.__unlockTransitionFailures.push("Unlock loading ended before the destination was ready");
      });
      entry?.querySelector(".locked-shell__actions button")?.addEventListener("click", () => {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      }, { capture: true, once: true });
    });
    await unlock.click();
    await expect(lock).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.__unlockTransitionFailures)).toEqual([]);
    console.log(`Lock/unlock round ${round} passed`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("No page errors or plugin cleanup failures");
} catch (error) {
  console.error("Visible diagnostic:", await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
