import { expect, type Page } from "@playwright/test";
import { openSettingsPage } from "./settingsDriver.js";
import { enableSatSupplierReceiveAndDefault, saveSatSupplierFromPage, waitForSatSupplierConnectionState } from "./satSubscriptionDriver.js";
import type { SatSubscriptionLocalServer } from "../resources/satsubscription/localServerResource.js";
import { unlockWalletInPlace } from "./vaultDriver.js";

/** Use the public SPA route, as Forum's internal links do; preserve the live Host. */
export async function openForumPost(page: Page, configId: string, txid: string, password: string): Promise<void> {
  await page.evaluate(path => {
    const url = new URL(path, location.origin); url.search = location.search;
    history.pushState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/forum/${encodeURIComponent(configId)}/post/${txid}`);
  await expect.poll(() => page.evaluate(() => {
    const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { connectionState?: string } } | undefined;
    return hook?.diagnostics().connectionState;
  }), { timeout: 60_000 }).toBe("ready");
  await expect.poll(async () => (await page.getByRole("button", { name: /^(Lock|锁定)$/u }).count()) + (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()), { timeout: 30_000 }).toBeGreaterThan(0);
  if (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) await unlockWalletInPlace(page, password);
  await expect(page.locator(".forum-post > .forum-node-header")).toBeVisible({ timeout: 60_000 });
}

/** Keep each real wallet awake while its peer is buying; never share a session. */
export async function keepForumWalletAwake(page: Page): Promise<void> {
  await openSettingsPage(page, { label: /^Auto lock$|^自动锁屏$/u, path: /\/settings\/auto-lock$/u, heading: /^Auto lock$|^自动锁屏$/u });
  const never = page.getByRole("button", { name: /^Never$|^永不$/u });
  if (await never.getAttribute("aria-pressed") !== "true") await never.click();
  await expect(never).toHaveAttribute("aria-pressed", "true");
}

/** Real SSP discovery, with a free whitelist, not a replacement file server. */
export async function connectForumFileDiscovery(page: Page, server: SatSubscriptionLocalServer): Promise<void> {
  await openSettingsPage(page, { label: /^Broadcast gateway$|^广播网关$/u, path: /\/settings\/system-status$/u, heading: /^Broadcast gateway$|^广播网关$/u });
  await saveSatSupplierFromPage(page, { supplierId: "forum-file-smoke", name: "Forum file smoke", supplierPublicKeyHex: server.supplierPublicKeyHex, multiaddrs: [server.multiaddr], enabled: true });
  await waitForSatSupplierConnectionState(page, "forum-file-smoke", "online");
  await enableSatSupplierReceiveAndDefault(page, "forum-file-smoke");
}

export async function addSmokeForum(page: Page, input: { root: string; publicKeyHex: string; endpoint: string }): Promise<string> {
  await page.getByRole("navigation", { name: /Primary navigation|主导航/u }).getByRole("button", { name: /^(Forum|论坛)$/u }).click();
  await page.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
  const form = page.locator("form.forum-config-form");
  await form.getByLabel(/^(Label|显示别名)$/u).fill("Forum file smoke");
  await form.getByLabel(/^(Genesis root txid|创世根 txid)$/u).fill(input.root);
  await form.getByLabel(/^(Forum service public key|论坛服务公钥)$/u).fill(input.publicKeyHex);
  await form.locator("select").first().selectOption("test");
  await form.locator("input").last().fill(input.endpoint);
  await form.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
  const browse = page.getByRole("link", { name: /^(Browse boards|进入板块)$/u });
  // This is a read-only trust check against the real chain API. A transient
  // fetch outage may be retried through the same public button; never bypass
  // root validation or apply this policy to publication/payment actions.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: /^(Verify genesis root|验证创世根)$/u }).click();
    try { await expect(browse).toBeVisible({ timeout: 30_000 }); break; }
    catch (error) {
      const text = await page.locator("main").innerText();
      if (attempt === 2 || !/Failed to fetch|HTTP (?:429|50[234])/u.test(text)) throw error;
      await page.waitForTimeout(5_000);
    }
  }
  await expect(browse).toBeVisible({ timeout: 60_000 });
  const href = await browse.getAttribute("href");
  const id = href && /\/forum\/([^/]+)/u.exec(href)?.[1];
  if (!id) throw new Error("Verified Forum has no public route");
  await browse.click();
  return id;
}
