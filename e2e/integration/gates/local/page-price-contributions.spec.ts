import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { lockWallet, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import type { IntegrationScenarioMetadata } from "../../support/types.js";
export const GATE_ID = "G-PAGE-PRICE-CONTRIBUTIONS";
export const GATE_METADATA = {
  id: GATE_ID,
  level: "local-integration",
  requirementIds: ["KM-NAV-001", "KM-LIFECYCLE-001", "KM-CONTACT-001", "KM-MESSAGE-001"],
  startingState: "全新 Chromium context；生产 preview 与真实 SharedWorker、IndexedDB。",
  successCriteria: ["Assets 首页卡片、资产及藏品页面、Contacts 列表/详情及编辑器、Message 列表及两个动态详情入口、P2PKH 转账页与自有 Widget/Contacts 选择器、BSV 链设置、应用列表、本地文件页面、行情页、价格设置页与插件诊断页以贡献方 consumer 渲染；统一图片扫码能分派联系人、消息和转账，付款 URI 只预填金额并保留业务确认。", "锁定移除 owner 页面，重新解锁后可恢复。"],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

test(GATE_ID + "：生产页面贡献在锁定后恢复", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const password = "page-price-local-password-123";
  const errors = captureBrowserErrors(page, context);
  const contactKey = "03" + "22".repeat(32);
  try {
    await initializeNewLocalUser({ page }, { keyLabel: "Page price key", password });
    await test.step("统一图片扫码分派到业务实例，付款 URI 只预填转账", async () => {
      await page.getByTestId("home-my-info-button").click();
      const identity = page.getByTestId("home-my-info-modal");
      await expect(identity.locator(".home-actions__qr svg")).toBeVisible();
      const qrImage = testInfo.outputPath("local-public-key-qr.png");
      const png = await identity.locator(".home-actions__qr svg").evaluate(async element => {
        const svg = element.cloneNode(true) as SVGSVGElement;
        svg.setAttribute("width", "784"); svg.setAttribute("height", "784");
        const image = new Image();
        image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
        await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = 848; canvas.height = 848;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "white"; context.fillRect(0, 0, 848, 848);
        context.drawImage(image, 32, 32, 784, 784);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      await writeFile(qrImage, Buffer.from(png, "base64"));
      await identity.getByRole("button", { name: /Close my information|关闭我的信息/u }).click();
      await page.getByTestId("home-scan-button").click();
      const scan = page.getByTestId("home-scan-modal");
      await scan.getByRole("tab", { name: /^Image$|^图片$/u }).click();
      // This valid high-resolution pattern defeats the decoder's first scale.
      await scan.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL("../../fixtures/qr-public-key.png", import.meta.url)));
      await expect(scan.getByTestId("scan-results")).toBeVisible();
      await scan.getByRole("button", { name: /Scan another|重新扫描/u }).click();
      await scan.locator('input[type="file"]').setInputFiles(qrImage);
      await expect(scan.getByTestId("scan-results")).toBeVisible();
      await expect(scan.getByRole("button", { name: /View or save contact|查看或保存联系人/u })).toBeVisible();
      await expect(scan.getByRole("button", { name: /Transfer BSV|转账 BSV/u })).toBeVisible();
      await expect(scan.getByRole("button", { name: /^Message$|Open conversation|Send message|发消息/u })).toBeVisible();
      await scan.getByRole("button", { name: /View or save contact|查看或保存联系人/u }).click();
      await expect(scan.getByTestId("contact-uri-action")).toBeVisible();
      await scan.getByRole("button", { name: /^Save contact$|^保存联系人$/u }).click();
      const editor = page.getByRole("dialog").filter({ has: page.getByLabel("Contact publicKeyHex", { exact: true }) });
      await expect(editor.getByLabel("Contact publicKeyHex", { exact: true })).toHaveValue(/^(02|03)[0-9a-f]{64}$/u);
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await scan.getByRole("button", { name: /Close scan|关闭扫码/u }).click();
      await page.getByTestId("home-scan-button").click();
      await scan.getByRole("tab", { name: /^Paste$|^粘贴$/u }).click();
      await scan.getByRole("textbox", { name: /URI, public key or address|URI、公钥或地址/u }).fill("unrecognized content");
      await scan.getByRole("button", { name: /^Recognize$|^识别$/u }).click();
      await expect(scan.getByTestId("scan-results")).toContainText(/No available plugin|没有可用插件/u);
      await scan.getByRole("button", { name: /Scan another|重新扫描/u }).click();
      await scan.getByRole("textbox", { name: /URI, public key or address|URI、公钥或地址/u }).fill("bsv:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?amount=0.00000001");
      await scan.getByRole("button", { name: /^Recognize$|^识别$/u }).click();
      await scan.getByRole("button", { name: /Transfer BSV|转账 BSV/u }).click();
      await expect(scan.getByTestId("payment-uri-action")).toContainText("0.00000001 BSV");
      await scan.getByRole("button", { name: /Open transfer|打开转账/u }).click();
      await expect(page).toHaveURL(/requestedAmountBsv=0\.00000001/u);
      await expect(page.getByTestId("p2pkh-recipient-address")).toContainText("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
      await expect(page.locator(".p2pkh-transfer-widget__amount-input input")).toHaveValue("1");
      await expect(scan).toHaveCount(0);
      const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/u });
      await navigation.getByRole("button", { name: /^Home$|^首页$/u }).click();
    });
    await expect(page.locator(".asset-overview-home")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-bsv-price-home-price]')).toBeVisible({ timeout: 30_000 });
    for (const [path, selector] of [
      ["/apps", ".apps-page"],
      ["/assets", ".assets-page"],
      ["/contacts", ".contacts-page"],
      [`/contacts/${contactKey}?source=transfer`, ".contact-detail"],
      ["/messages", ".km-message-page"],
      [`/message/${contactKey}?source=contacts`, ".km-message-detail"],
      [`/messages/${contactKey}?source=contacts`, ".km-message-detail"],
      ["/transfer", ".transfer-page"],
      ["/transfer?recipientAddress=1BoatSLRHtKNngkdXEeobR76b53LETtpyT", ".p2pkh-transfer-widget"],
      ["/collectibles", ".collectibles-page"],
      ["/collectibles/transfer?providerId=absent-provider&collectibleId=absent-collectible", ".ui-empty-state"],
      ["/settings/bsv-chain", ".bsv-chain-page"],
      ["/msfile/files", ".msfile-home-file"],
      ["/msfile/storage", ".msfile-bucket"],
      ["/settings/local-files", ".msfile-settings-page"],
      ["/settings/plugins", ".plugin-manager"],
      ["/bsv-price", '[data-bsv-price-page="active"]'],
      ["/settings/bsv-price", '[data-bsv-price-settings="main"]'],
    ] as const) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ })).toBeVisible({ timeout: 30_000 });
      await unlockWalletInPlace(page, password);
      await expect(page.locator(selector)).toBeVisible({ timeout: 30_000 });
      if (path === "/contacts") {
        await page.getByRole("button", { name: "New", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
        await dialog.getByLabel("Contact publicKeyHex", { exact: true }).fill(contactKey);
        await dialog.getByLabel("Name", { exact: true }).fill("Page contact");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("link", { name: "Page contact", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Page contact");
        await dialog.getByLabel("Name", { exact: true }).fill("Updated page contact");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("link", { name: "Updated page contact", exact: true })).toBeVisible();
      }
      if (path.startsWith("/contacts/")) {
        await expect(page.getByRole("heading", { name: "Updated page contact", exact: true })).toBeVisible();
        await expect(page.locator(".contact-detail__public-key")).toHaveText(contactKey);
        await expect(page.locator(".contact-detail").getByRole("button", { name: "Transfer", exact: true })).toBeVisible();
        await lockWallet(page);
        await expect(page.locator(".contact-detail")).toHaveCount(0);
        await unlockWalletInPlace(page, password);
        await expect(page.getByRole("heading", { name: "Updated page contact", exact: true })).toBeVisible({ timeout: 30_000 });
      }
      if (path.startsWith("/message/") || path.startsWith("/messages/")) {
        await expect(page.locator(".km-message-detail")).toHaveAttribute("data-peer-public-key-hex", contactKey);
        await expect(page.locator(".km-message-detail").getByRole("heading", { name: "Updated page contact", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Audio chat", exact: true })).toBeDisabled();
        await lockWallet(page);
        await expect(page.locator(".km-message-detail")).toHaveCount(0);
        await unlockWalletInPlace(page, password);
        await expect(page.locator(".km-message-detail").getByRole("heading", { name: "Updated page contact", exact: true })).toBeVisible({ timeout: 30_000 });
      }
      if (path === "/transfer") {
        await expect(page.locator(".transfer-page").getByRole("heading", { name: "Transfer", exact: true })).toBeVisible();
        await expect(page.locator(".transfer-page").getByRole("combobox", { name: "Contacts", exact: true })).toBeVisible({ timeout: 30_000 });
      }
      if (path.startsWith("/transfer?")) {
        await expect(page.getByTestId("p2pkh-recipient-address")).toContainText("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
      }
      if (path.startsWith("/collectibles/transfer?")) {
        await expect(page.getByRole("heading", { name: "This collectible is unavailable", exact: true })).toBeVisible({ timeout: 30_000 });
      }
      if (path === "/settings/bsv-chain") {
        await expect(page.locator(".bsv-chain-page #p2pkh .p2pkh-settings")).toBeVisible({ timeout: 30_000 });
        await expect(page.locator(".bsv-chain-page #woc .woc-settings")).toBeVisible();
        await expect(page.locator(".bsv-chain-page__section")).toHaveCount(2);
      }
    }
    await lockWallet(page);
    await expect(page.locator('[data-bsv-price-settings="main"]')).toHaveCount(0);
    await unlockWalletInPlace(page, password);
    // 失效页面可以安全导航回首页；后续重新进入设置页仍需新实例。
    await page.goto("/settings/bsv-price", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ })).toBeVisible({ timeout: 30_000 });
    await unlockWalletInPlace(page, password);
    await expect(page.locator('[data-bsv-price-settings="main"]')).toBeVisible({ timeout: 30_000 });
    expect(errors.pageErrors).toEqual([]);
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});

test(GATE_ID + "：同 Key 重新解锁与 Worker 重启撤销旧会话", async ({ page, context, browser }, testInfo) => {
  test.setTimeout(150_000);
  const password = "wallet-state-local-password-123";
  const errors = captureBrowserErrors(page, context);
  const read = (tab: import("@playwright/test").Page) => tab.evaluate(() => {
    const hooks = window.__lifecycleProductionE2E;
    if (!hooks) throw new Error("Lifecycle hooks are unavailable");
    return hooks.walletStateSnapshot();
  });
  try {
    const ready = await initializeNewLocalUser({ page }, { keyLabel: "Wallet state key", password });
    await page.goto("/?lifecycleE2E=1");
    await unlockWalletInPlace(page, password);
    await expect.poll(() => read(page).then(snapshot => snapshot.status)).toBe("unlocked");
    const first = await read(page);
    expect(first.activeKeyIdentity?.label).toBe(ready.keyLabel);
    await page.evaluate(() => window.__lifecycleProductionE2E!.cacheWalletCrypto());
    expect(await page.evaluate(() => window.__lifecycleProductionE2E!.cachedWalletCryptoFresh())).toBe(true);
    await lockWallet(page);
    await expect.poll(() => read(page).then(snapshot => snapshot.status)).toBe("locked");
    expect((await read(page)).activePublicKeyHex).toBeUndefined();
    await unlockWalletInPlace(page, password);
    await expect.poll(() => read(page).then(snapshot => snapshot.status)).toBe("unlocked");
    const second = await read(page);
    expect(second.activePublicKeyHex).toBe(first.activePublicKeyHex);
    expect(second.sessionEpoch).not.toBe(first.sessionEpoch);
    expect(await page.evaluate(() => window.__lifecycleProductionE2E!.cachedWalletCryptoFresh())).toBe(false);

    const other = await context.newPage();
    await other.goto("/?lifecycleE2E=1");
    await other.waitForFunction(() => window.__lifecycleProductionE2E !== undefined);
    await expect.poll(() => read(other).then(snapshot => snapshot.runGeneration)).toBe(second.runGeneration);
    await other.reload();
    await other.waitForFunction(() => window.__lifecycleProductionE2E !== undefined);
    await expect.poll(() => read(other).then(snapshot => snapshot.sessionEpoch)).toBe((await read(page)).sessionEpoch);
    await lockWallet(other);
    await expect.poll(() => read(other).then(snapshot => snapshot.status)).toBe("locked");
    await expect.poll(() => read(page).then(snapshot => snapshot.status)).toBe("locked");
    await unlockWalletInPlace(other, password);
    await expect.poll(() => read(page).then(snapshot => snapshot.sessionEpoch)).toBe((await read(other)).sessionEpoch);

    // Terminate the actual SharedWorker in this isolated browser context, then recover from disk.
    const pageCdp = await context.newCDPSession(page);
    const info = await pageCdp.send("Target.getTargetInfo");
    const cdp = await browser.newBrowserCDPSession();
    const targets = await cdp.send("Target.getTargets");
    const worker = targets.targetInfos.find(target => target.type === "shared_worker" && target.browserContextId === info.targetInfo.browserContextId && target.url.includes("keymasterSessionCoordinator.worker"));
    expect(worker, "真实 Coordinator SharedWorker 必须存在").toBeDefined();
    expect((await cdp.send("Target.closeTarget", { targetId: worker!.targetId })).success).toBe(true);
    await other.close();
    await page.reload();
    await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined);
    await expect.poll(() => read(page).then(snapshot => snapshot.runGeneration), { timeout: 30_000 }).not.toBe(second.runGeneration);
    await expect.poll(() => read(page).then(snapshot => snapshot.status)).toBe("locked");
    await unlockWalletInPlace(page, password);
    const restarted = await read(page);
    expect(restarted.activePublicKeyHex).toBe(first.activePublicKeyHex);
    expect(restarted.walletGeneration).toBe(first.walletGeneration);
    expect(restarted.sessionEpoch).not.toBe(second.sessionEpoch);
    await cdp.detach(); await pageCdp.detach();
    await testInfo.attach("wallet-state-generations", { body: JSON.stringify({ first, second, restarted }), contentType: "application/json" });
  } finally {
    await attachBrowserErrors(testInfo, errors);
  }
});
