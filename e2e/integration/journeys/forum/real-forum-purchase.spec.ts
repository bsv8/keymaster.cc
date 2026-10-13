import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ForumPublishTask } from "@keymaster/contracts";
import { calcTxidFromRawTxHex } from "../../../../packages/plugin-p2pkh/src/p2pkhSigner.js";
import { loadE2EConfig, loadE2ETestnetKeysConfig } from "../../resources/config/loader.js";
import { TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { buildForumPrograms, startForumServer, ForumTestnetApi } from "../../resources/forum/localForumResource.js";
import { startSatSubscriptionLocalServer } from "../../resources/satsubscription/localServerResource.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { enableTestnetAssets, setP2pkhFeeRate, waitForP2pkhSyncIdle, refreshTestnetUtxoSnapshot } from "../../drivers/p2pkhDriver.js";
import { addSmokeForum, connectForumFileDiscovery, keepForumWalletAwake, openForumPost } from "../../drivers/forumPurchaseDriver.js";
import { configureBitfsBuyer, configureBitfsSeller, assertBitfsFundingPoolClosed, assertBitfsPurchaseEvidence, verifyDownloadedMsFile, uploadMsFile, openMsFileStoragePage } from "../../drivers/bitfsMsFileDriver.js";
import { openMsFileSettingsPage, saveMsFilePriceLimits } from "../../drivers/msfileDriver.js";
import { currentRunId } from "../../support/ids.js";
import { ensureRunDataDirectory, runDataPath } from "../../support/runData.js";
import { readRawWalletObjects } from "../../support/walletStorageFormats.js";
import { readWalletPublicKey } from "../../drivers/appDriver.js";
import { redactText } from "../../support/redaction.js";
import { captureCoordinatorWorkerConsole } from "../../support/coordinatorWorkerConsole.js";
import { REAL_FORUM_PURCHASE_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_FORUM_PURCHASE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_FORUM_PURCHASE_SCENARIO;
const password = "Forum-file-testnet-2026!";
const origin = "http://127.0.0.1:4173";
const arbiterSecret = new Uint8Array(32); arbiterSecret[31] = 3;
// Existing BitFS smoke uses the same public arbiter; this journey never signs
// an arbitration or invokes an arbiter service.
const arbiter = Buffer.from(secp256k1.getPublicKey(arbiterSecret, true)).toString("hex");

test(JOURNEY_ID + "：两个客户端通过论坛买卖 MSFile 帖子正文", async ({}, testInfo) => {
  const config = await loadE2EConfig(); const keys = await loadE2ETestnetKeysConfig();
  const chain = createWocTestnetChainAdapter({ baseUrl: config.satsubscription.testnetApiBaseUrl, ...(config.satsubscription.testnetApiAuthorization ? { authorization: config.satsubscription.testnetApiAuthorization.read() } : {}) });
  const api = new ForumTestnetApi(config.satsubscription.testnetApiBaseUrl, config.satsubscription.testnetApiAuthorization?.read());
  const funding = new TestnetFundingResource(keys.seedPrivateKeyHex, chain);
  const seller = funding.createImportedWallet(currentRunId(), JOURNEY_ID, keys.key01PrivateKeyHex.read());
  const buyer = funding.createImportedWallet(currentRunId(), JOURNEY_ID, keys.key02PrivateKeyHex.read());
  const browsers: Browser[] = []; const pages: Array<{ role: string; page: Page }> = []; const stops: Array<() => Promise<void>> = [];
  let programs: Awaited<ReturnType<typeof buildForumPrograms>> | undefined;
  let forum: Awaited<ReturnType<typeof startForumServer>> | undefined;
  let discovery: Awaited<ReturnType<typeof startSatSubscriptionLocalServer>> | undefined;
  let purchaseStarted = false, publishStarted = false;
  const evidence: Record<string, unknown> = { runId: currentRunId(), network: "testnet", sellerAddress: seller.address, buyerAddress: buyer.address, result: "not-completed" };
  const resumePath = process.env.FORUM_PURCHASE_RESUME_STATE;
  let resumed: { rootTxid?: string; publicationTxid?: string; markdown: string; seedHashHex?: string; buyerPurchaseStarted?: boolean } | undefined;
  let markdown: string;
  const secrets = () => [password, seller.privateKey.read(), buyer.privateKey.read(), keys.seedPrivateKeyHex.read(), config.satsubscription.testnetApiAuthorization?.read() ?? ""].filter(Boolean);
  const announce = (message: string) => console.log(`[forum-purchase] ${message}`);
  const archived = new Set<string>();
  const archive = async (role: string, page: Page): Promise<void> => {
    if (archived.has(role)) return;
    const records = await readRawWalletObjects(page, "^(?:forum/(?:publish|funding|configs|roots)/|p2pkh/(?:funding|protocol)/|msfiles/(?:bitfs-journal|bitfs-e2e-diagnostics|funding)/)", true);
    const text = JSON.stringify(records, null, 2);
    if (secrets().some(secret => text.includes(secret))) throw new Error("Public evidence contains a secret");
    await ensureRunDataDirectory("forum", "state");
    await writeFile(runDataPath("forum", "state", `purchase-${role}-records.json`), text, { mode: 0o600 });
    archived.add(role);
  };
  const launch = async (role: string, wallet: OneTimeWallet): Promise<Page> => {
    // Independent processes also make Host/Worker isolation explicit. No
    // storageState, file import or seller bytes are ever passed to the buyer.
    const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] }); browsers.push(browser);
    const context = await browser.newContext({ baseURL: origin, acceptDownloads: true, ignoreHTTPSErrors: true });
    const page = await context.newPage(); pages.push({ role, page });
    page.on("dialog", dialog => { void dialog.accept(); });
    await page.addInitScript(() => { const url = new URL(location.href); url.searchParams.set("lifecycleE2E", "1"); history.replaceState(null, "", url); });
    page.on("pageerror", error => console.log(`[forum-purchase] ${role} ${redactText(error.message, secrets())}`));
    const identity = await initializeLocalUserWithImportedHexKey(page, { keyLabel: `Forum ${role}`, password, privateKeyHex: wallet.privateKey.read() });
    expect(identity.publicKeyHex).toBe(wallet.publicKeyHex);
    stops.push(await captureCoordinatorWorkerConsole(page, message => console.log(`[forum-purchase-worker] ${role} ${redactText(message, secrets())}`), ["[coordinator]", "[sat-subscription]", "[channel]", "[msfile]", "[bitfs]"]));
    await keepForumWalletAwake(page);
    await enableTestnetAssets(page); await setP2pkhFeeRate(page, "medium", 100);
    await waitForP2pkhSyncIdle(page);
    return page;
  };
  try {
    resumed = resumePath ? JSON.parse(await readFile(resolve(resumePath), "utf8")) as typeof resumed : undefined;
    if (resumed?.buyerPurchaseStarted) throw new Error("Prior purchase was dispatched; reconcile its retained MSFile journal before another payment");
    markdown = resumed?.markdown ?? `# Forum paid file ${currentRunId()}\n\nThis post was bought from another independent Keymaster client.`;
    evidence.markdown = markdown;
    announce("核验真实测试网根与已有资金");
    expect(seller.publicKeyHex).not.toBe(buyer.publicKeyHex);
    await funding.prepare(5000);
    programs = await buildForumPrograms();
    discovery = await startSatSubscriptionLocalServer({ whitelistPublicKeys: [seller.publicKeyHex, buyer.publicKeyHex] });
    // Reuse existing ordinary test funds. Never sweep either long-lived wallet
    // or its protocol outputs; only top up once if this declared budget needs it.
    for (const [role, wallet, minimum, amount] of [["seller", seller, 100, 500], ["buyer", buyer, 2000, 2500]] as const) {
      const observation = await chain.inspectAddress(wallet.address); expect(observation.mainnetBalance).toBe(0);
      evidence[`${role}StartingBalance`] = observation.testnetBalance;
      if (observation.testnetBalance < minimum) {
        const receipt = await funding.fund(wallet, amount, { maxFundingSatoshis: amount, maxLossSatoshis: amount, feeReserveSatoshis: 1000 });
        evidence[`${role}FundingTxid`] = receipt.txid; await api.wait(receipt.txid, false, 120_000);
      }
    }
    let root = resumed?.rootTxid;
    if (!root) {
      // A disposable real forum avoids replaying an old forum's entire block
      // history when a smoke post happens to be mined before mempool discovery.
      // Generate/broadcast the official genesis; never insert an index row or
      // skip block validation. The original smoke root/cache stays untouched.
      announce("正式 Go 程序创建本轮真实论坛根");
      await api.waitFunding(buyer.publicKeyHex, 500);
      const pair = await programs.genesis(buyer, api);
      root = calcTxidFromRawTxHex(pair.root);
      evidence.rootTxid = root;
      await ensureRunDataDirectory("forum", "state");
      await writeFile(runDataPath("forum", "state", "genesis.json"), JSON.stringify({ rootTxid: root,
        publicKeyHex: buyer.publicKeyHex, rawTxHex: pair.root, collectionTxid: calcTxidFromRawTxHex(pair.collection),
        collectionRawTxHex: pair.collection }, null, 2), { mode: 0o600 });
      evidence.genesisDispatched = true;
      expect(await api.broadcast(pair.root)).toBe(root);
      await api.wait(root, false, 120_000);
      // Return only this genesis's own change output, using its fixed Go-built
      // collection transaction. This is not a sweep of existing wallet funds.
      evidence.rootCollectionTxid = await api.broadcast(pair.collection);
      await api.wait(evidence.rootCollectionTxid as string, false, 120_000);
    }
    api.verifyRoot(await api.waitRaw(root), root, buyer.publicKeyHex); evidence.rootTxid = root;
    forum = await startForumServer({ programs, wallet: buyer, root, api });
    announce("启动隔离的卖方与买方浏览器");
    const sellerPage = await launch("seller", seller); const buyerPage = await launch("buyer", buyer);
    expect(await readWalletPublicKey(sellerPage)).not.toBe(await readWalletPublicKey(buyerPage));
    const workerIds = await Promise.all([sellerPage, buyerPage].map(page => page.evaluate(() => {
      const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { remoteRuntime?: { runtimeInstanceId?: string } } };
      return hook.diagnostics().remoteRuntime?.runtimeInstanceId;
    })));
    expect(workerIds.every(Boolean)).toBe(true);
    expect(workerIds[0], "independent clients must not share a coordinator").not.toBe(workerIds[1]);
    evidence.independentWorkerInstanceIds = workerIds;
    await refreshTestnetUtxoSnapshot(sellerPage, (await chain.inspectAddress(seller.address)).spendableUtxoCount, 120_000);
    await refreshTestnetUtxoSnapshot(buyerPage, (await chain.inspectAddress(buyer.address)).spendableUtxoCount, 120_000);
    for (const page of [sellerPage, buyerPage]) await connectForumFileDiscovery(page, discovery);
    const sellerConfig = await addSmokeForum(sellerPage, { root, publicKeyHex: buyer.publicKeyHex, endpoint: forum.url });
    let txid = resumed?.publicationTxid;
    if (!txid) {
      announce("卖方冻结正文、真实报价并发布帖子");
      await sellerPage.getByRole("link", { name: /^(Publish reply|发布回复)$/u }).click();
      await sellerPage.locator("textarea").fill(markdown);
      await sellerPage.getByRole("button", { name: /^(Publish reply|发布回复)$/u }).click();
      await expect(sellerPage.locator(".forum-task")).toContainText("quoted", { timeout: 60_000 });
      publishStarted = true;
      await sellerPage.getByRole("button", { name: /^(Confirm budget|确认预算)$/u }).click();
      await expect(sellerPage.getByRole("button", { name: /^(Broadcast|广播)$/u })).toBeEnabled();
      await sellerPage.getByRole("button", { name: /^(Broadcast|广播)$/u }).click();
      await expect(sellerPage.locator(".forum-txid")).toBeVisible({ timeout: 180_000 });
      txid = (await sellerPage.locator(".forum-txid").innerText()).trim();
    } else {
      // Public file bytes are restored only on the seller, not on the buyer.
      // Reuse the actual broadcast transaction; do not publish a second post.
      const path = runDataPath("forum", "state", "seller-post.md");
      await ensureRunDataDirectory("forum", "state"); await writeFile(path, markdown);
      await openMsFileStoragePage(sellerPage); const uploaded = await uploadMsFile(sellerPage, path);
      expect(uploaded.seedHashHex).toBe(resumed!.seedHashHex);
    }
    evidence.publicationTxid = txid;
    announce(`核验广播并等待 Go 自主索引 ${txid}`);
    await api.wait(txid, false, 120_000); evidence.indexState = await forum.waitIndexed(txid);
    const records = await readRawWalletObjects(sellerPage, "^forum/publish/");
    const task = records.map(record => (JSON.parse(record.text) as { data: ForumPublishTask }).data).find(task => task.txid === txid);
    const seedHashHex = task?.replyMasterSeedHash ?? resumed?.seedHashHex;
    if (!seedHashHex || !/^[a-f0-9]{64}$/u.test(seedHashHex)) throw new Error("Published post has no durable MSFile Seed identity");
    evidence.seedHashHex = seedHashHex; evidence.sellerConfigId = sellerConfig;
    expect(await readRawWalletObjects(buyerPage, `^msfiles/meta/${seedHashHex}\\.json$`), "buyer must not already have the seller file").toEqual([]);
    announce("卖方开启真实出售，买方设置明确的 1 sat 价格上限");
    await openMsFileSettingsPage(sellerPage); await saveMsFilePriceLimits(sellerPage, { seedMaxPriceSatoshis: "1", blockMaxPriceSatoshis: "1" });
    await configureBitfsSeller(sellerPage, { seedPriceSatoshis: "1", fullBlockPriceSatoshis: "1", quoteLifetimeSeconds: "1200", maxConcurrentSales: "1", supportedArbiterPublicKeys: [arbiter] });
    await openMsFileSettingsPage(buyerPage); await saveMsFilePriceLimits(buyerPage, { seedMaxPriceSatoshis: "1", blockMaxPriceSatoshis: "1" });
    await configureBitfsBuyer(buyerPage, { buyerAutoPurchaseEnabled: false, maxFullBlockPriceSatoshis: "1", sellerSelectionPriority: "price", maxConcurrentDownloads: "1", maxConcurrentSellerSessions: "1", blocksPerBatch: "10" });
    const buyerConfig = await addSmokeForum(buyerPage, { root, publicKeyHex: buyer.publicKeyHex, endpoint: forum.url });
    // Navigate through the ordinary SPA router without disrupting either Host.
    // Browser-restart lifecycle acceptance is separate from this purchase smoke.
    await openForumPost(buyerPage, buyerConfig, txid, password);
    await expect(buyerPage.locator(".forum-post > .forum-node-header .forum-seed-hash")).toHaveText(seedHashHex);
    await expect(buyerPage.locator(".forum-markdown")).toHaveCount(0);
    await expect.poll(async () => {
      const ledger = await discovery!.ledgerSummary();
      return [seller.publicKeyHex, buyer.publicKeyHex].every(key => ledger.subscriptions.some(entry => entry.subjectPublicKeyHex === key && entry.channel === "bsv8.hash.request.v1"));
    }, { timeout: 60_000 }).toBe(true);
    announce("买方在论坛点击阅读，发现卖方、支付并获取正文");
    purchaseStarted = true; evidence.buyerPurchaseStarted = true;
    await buyerPage.getByRole("button", { name: /^(Read|阅读)$/u }).click();
    // Observe real journals while waiting: a terminal failed purchase must not
    // spend four minutes waiting for Markdown that cannot arrive. No retries
    // or replacement payments are issued by this observation loop.
    const deadline = Date.now() + 240_000;
    let lastPhase = "";
    while (!(await buyerPage.locator(".forum-markdown").count())) {
      const saved = await readRawWalletObjects(buyerPage, "^msfiles/bitfs-journal/sessions/");
      const session = saved.map(record => JSON.parse(record.text) as { role: string; seedHashHex: string; phase: string })
        .find(session => session.role === "buyer" && session.seedHashHex === seedHashHex);
      if (session?.phase && session.phase !== lastPhase) { lastPhase = session.phase; announce(`买方协议阶段：${lastPhase}`); }
      if (session?.phase === "failed" || session?.phase === "cancelled" || session?.phase === "refunded") {
        throw new Error(`Actual buyer protocol ended in ${session.phase}; retain the original journal`);
      }
      if (Date.now() >= deadline) throw new Error(`Forum body not available; last actual buyer phase: ${lastPhase || "no-session"}`);
      await buyerPage.waitForTimeout(2_000);
    }
    await expect(buyerPage.locator(".forum-markdown")).toContainText("This post was bought from another independent Keymaster client.");
    // Content commit can become visible before the seller's close transaction
    // is observed. Keep both clients alive until the original pool is closed.
    await expect.poll(async () => {
      const records = await readRawWalletObjects(buyerPage, "^msfiles/bitfs-journal/sessions/");
      return records.map(record => JSON.parse(record.text) as { role: string; seedHashHex: string; phase: string })
        .filter(session => session.role === "buyer" && session.seedHashHex === seedHashHex).map(session => session.phase);
    }, { timeout: 120_000, intervals: [2_000], message: "actual buyer must finish close reconciliation" }).toEqual(["completed"]);
    await assertBitfsPurchaseEvidence(buyerPage, seedHashHex); await assertBitfsFundingPoolClosed(buyerPage, seedHashHex);
    evidence.buyerProtocolCompleted = true;
    const accounts = await readRawWalletObjects(buyerPage, `^msfiles/bitfs-journal/funding/accounts/test/${seedHashHex}\\.json$`);
    const account = JSON.parse(accounts[0]!.text) as { transactions: Array<{ txid: string; purpose: string; state: string; inputsReconciled?: boolean }> };
    const close = account.transactions.find(transaction => transaction.purpose === "close" && transaction.state === "observed");
    if (!close) throw new Error("Purchase has no observed close transaction");
    evidence.closeTxid = close.txid;
    await api.wait(close.txid, false, 120_000);
    // Hash propagation may precede raw-hex indexing. Poll reads of this exact
    // accepted transaction; never rebroadcast or start another payment here.
    const payment = await chain.waitForTransactionOutputs(close.txid, seller.address, { timeoutMs: 120_000, pollMs: 5_000 });
    expect(payment.outputSatoshis, "real close transaction must pay the discovered seller").toBeGreaterThan(0);
    evidence.closeTxid = close.txid; evidence.sellerReceivedSatoshis = payment.outputSatoshis;
    const sellerSessions = (await readRawWalletObjects(sellerPage, "^msfiles/bitfs-journal/sessions/"))
      .map(record => JSON.parse(record.text) as { role: string; seedHashHex: string; phase: string });
    expect(sellerSessions.some(session => session.role === "seller" && session.seedHashHex === seedHashHex && session.phase === "closed")).toBe(true);
    const download = await verifyDownloadedMsFile(buyerPage, seedHashHex); const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error("Purchased MSFile produced no local download");
    const bytes = await readFile(downloadedPath); expect(bytes.equals(Buffer.from(markdown, "utf8"))).toBe(true);
    evidence.contentSha256 = createHash("sha256").update(bytes).digest("hex");
    announce("卖方离线后，买方从自己保存的 MSFile 再次阅读");
    await archive("seller", sellerPage);
    await browsers[0]!.close();
    await openForumPost(buyerPage, buyerConfig, txid, password);
    await expect(buyerPage.locator(".forum-markdown")).toContainText("This post was bought from another independent Keymaster client.", { timeout: 60_000 });
    const afterOffline = await readRawWalletObjects(buyerPage, `^msfiles/bitfs-journal/funding/accounts/test/${seedHashHex}\\.json$`);
    const offlineAccount = JSON.parse(afterOffline[0]!.text) as typeof account;
    // Background chain observation may legitimately update the account's
    // revision/time and inputsReconciled flags. Compare the complete payment
    // plans, preserving IDs, values, inputs/outputs and states, not that metadata.
    const paymentPlans = (value: typeof account) => value.transactions.map(({ inputsReconciled: _observation, ...transaction }) => transaction);
    expect(paymentPlans(offlineAccount), "local reread must not create another payment").toEqual(paymentPlans(account));
    const ledger = await discovery.ledgerSummary(); expect(ledger.operations.every(entry => entry.chargedSubunits === "0")).toBe(true);
    await archive("buyer", buyerPage);
    evidence.result = "passed"; evidence.offlineLocalRead = true;
  } catch (error) {
    evidence.result = "failed"; evidence.failure = redactText(String(error), secrets());
    for (const { role, page } of pages) {
      const diagnostics = await page.evaluate(() => {
        const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): unknown } | undefined;
        return hook?.diagnostics();
      }).catch(() => undefined);
      console.log(`[forum-purchase] ${role} diagnostics ${redactText(JSON.stringify(diagnostics) ?? "unavailable", secrets())}`);
    }
    throw error;
  } finally {
    evidence.fundsRetainedForReconciliation = evidence.result !== "passed" && (publishStarted || purchaseStarted || evidence.genesisDispatched === true);
    evidence.testnetWalletsNotSwept = true;
    await ensureRunDataDirectory("forum", "state");
    // Preserve real public journals and funding/submission evidence before the
    // ephemeral browser is closed. Unknown payments are never swept or retried.
    for (const { role, page } of pages) {
      try { await archive(role, page); } catch { evidence[`${role}Evidence`] = "unavailable"; }
    }
    await writeFile(runDataPath("forum", "state", "purchase.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    for (const stop of stops) await stop().catch(() => undefined);
    for (const browser of browsers) await browser.close().catch(() => undefined);
    if (forum) { await testInfo.attach("go-forum-log", { body: redactText(forum.logs(), secrets()), contentType: "text/plain" }); await forum.stop(); }
    if (discovery) await testInfo.attach("sat-subscription-log", { body: redactText(discovery.serverLogTail(40).join("\n"), secrets()), contentType: "text/plain" });
    await discovery?.stop(); await programs?.dispose(); seller.clear(); buyer.clear();
    for (const secret of [keys.seedPrivateKeyHex, keys.key01PrivateKeyHex, keys.key02PrivateKeyHex, config.testnet.privateKeyHex, config.testnet.trackingKeyPrivateKeyHex, config.satsubscription.testnetApiAuthorization]) secret?.clear();
  }
});
