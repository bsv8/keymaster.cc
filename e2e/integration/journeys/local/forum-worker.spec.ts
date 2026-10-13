import { expect, test, type Page } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { enableTestnetAssets, setP2pkhFeeRate, waitForP2pkhSyncIdle } from "../../drivers/p2pkhDriver.js";
import { lockWallet, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { LOCAL_FORUM_WORKER_SCENARIO } from "../../support/scenarioMetadata.js";
export const JOURNEY_ID = LOCAL_FORUM_WORKER_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_FORUM_WORKER_SCENARIO;

// Production diagnostics is intentionally opaque to unrelated lifecycle tests.
// This journey spells out only the snapshot fields it actually asserts.
type ForumDiagnostics = {
  forumState: { cleanup?: { cleanupIncomplete?: boolean }; kind: string; units: Array<{ unitId: string; instanceId?: string }> };
  capabilityIds: string[]; remoteRuntime?: unknown;
  bootstrap: { coordinatorWorkerUnits?: Array<{ unitId: string; state: unknown; reasons: unknown }> };
};

async function openForum(page: Page, password: string) {
  await page.goto("/forum?lifecycleE2E=1");
  await expect.poll(async () => (await page.getByRole("heading", { name: /^(Forum|论坛)$/u }).count()) + (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()), { timeout: 20_000 }).toBeGreaterThan(0);
  if (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) await unlockWalletInPlace(page, password);
  await expect(page.getByRole("heading", { name: /^(Forum|论坛)$/u })).toBeVisible();
}

test(JOURNEY_ID + "：两页通过唯一 Worker 保存配置并在锁定后恢复", async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const password = "Forum-local-2026!";
  const evidence = captureBrowserErrors(page, context);
  page.on("pageerror", error => console.log(String(error.stack).replaceAll(password, "[password]").replace(/[a-f0-9]{64,}/giu, "[hex]")));
  try {
    await page.goto("/");
    const ready = await initializeNewLocalUser({ page }, { keyLabel: "Forum local", password });
    await openForum(page, password);
    // Reopening wallet resources must not drop Forum's independent exposure.
    await enableTestnetAssets(page); await setP2pkhFeeRate(page, "medium", 1);
    await waitForP2pkhSyncIdle(page);
    if (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) await unlockWalletInPlace(page, password);
    await expect.poll(async () => {
      if (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) await unlockWalletInPlace(page, password);
      return page.getByRole("button", { name: /^(Forum|论坛)$/u }).count();
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: /^(Forum|论坛)$/u }).click();
    await page.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
    const form = page.locator("form.forum-config-form");
    await form.getByLabel(/^(Label|显示别名)$/u).fill("Forum Worker local");
    await form.getByLabel(/^(Genesis root txid|创世根 txid)$/u).fill("ab".repeat(32));
    await form.getByLabel(/^(Forum service public key|论坛服务公钥)$/u).fill(ready.publicKeyHex);
    await form.locator("select").first().selectOption("test");
    await form.locator("input").last().fill("https://forum.invalid");
    await form.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
    await expect(page.getByRole("heading", { name: "Forum Worker local" })).toBeVisible();
    const second = await context.newPage();
    await openForum(second, password);
    await expect(second.getByRole("heading", { name: "Forum Worker local" })).toBeVisible();
    await expect(second.getByText(/^(Root not verified|根未验证)$/u)).toBeVisible();
    const workerInstance = async (target: Page) => target.evaluate(() => (window.__lifecycleProductionE2E as unknown as { diagnostics(): ForumDiagnostics } | undefined)?.diagnostics().forumState.units.find(unit => unit.unitId === "forum.coordinator-worker")?.instanceId);
    expect(await workerInstance(page)).toBeTruthy();
    expect(await workerInstance(second)).toBe(await workerInstance(page));
    await lockWallet(page);
    await expect(second.getByRole("button", { name: /^(Unlock|解锁)$/u })).toBeVisible();
    await unlockWalletInPlace(second, password);
    // Owner pages are unregistered while locked; the shell can select a settings
    // fallback. Navigate through the restored Forum contribution after unlock.
    await page.getByRole("button", { name: /^(Forum|论坛)$/u }).click();
    await second.getByRole("button", { name: /^(Forum|论坛)$/u }).click();
    await expect(page.getByRole("heading", { name: "Forum Worker local" })).toBeVisible();
    await expect(second.getByRole("heading", { name: "Forum Worker local" })).toBeVisible();
    for (const target of [page, second]) {
      const state = await target.evaluate(() => (window.__lifecycleProductionE2E as unknown as { diagnostics(): ForumDiagnostics } | undefined)?.diagnostics().forumState);
      expect(state?.kind).toBe("enabled");
      expect(state?.cleanup?.cleanupIncomplete).not.toBe(true);
    }
    expect(evidence.pageErrors).toEqual([]);
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const snapshot = (window.__lifecycleProductionE2E as unknown as { diagnostics(): ForumDiagnostics } | undefined)?.diagnostics();
      return { remoteRuntime: snapshot?.remoteRuntime, forumState: snapshot?.forumState, forumCapabilities: snapshot?.capabilityIds.filter(id => id.includes("forum")), units: snapshot?.bootstrap.coordinatorWorkerUnits?.map(unit => ({ unitId: unit.unitId, state: unit.state, reasons: unit.reasons })) };
    });
    await testInfo.attach("forum-runtime-diagnostics", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    console.log(JSON.stringify(diagnostics));
    console.log(JSON.stringify(evidence).replaceAll(password, "[password]").replace(/[a-f0-9]{64,}/giu, "[hex]"));
    throw error;
  } finally { await attachBrowserErrors(testInfo, evidence); }
});
