import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadE2EConfig, loadE2ETestnetKeysConfig } from "../../resources/config/loader.js";
import { TestnetFundingResource } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { buildForumPrograms, startForumServer, ForumTestnetApi } from "../../resources/forum/localForumResource.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { enableTestnetAssets, refreshTestnetUtxoSnapshot, waitForP2pkhSyncIdle, openTestnetWalletPage } from "../../drivers/p2pkhDriver.js";
import { lockWallet, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import { currentRunId } from "../../support/ids.js";
import { runDataPath, ensureRunDataDirectory } from "../../support/runData.js";
import { calcTxidFromRawTxHex } from "../../../../packages/plugin-p2pkh/src/p2pkhSigner.js";
import { redactText } from "../../support/redaction.js";
import { readRawWalletObjects } from "../../support/walletStorageFormats.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { REAL_FORUM_SMOKE_SCENARIO } from "../../support/scenarioMetadata.js";
import type { ForumPublishTask } from "@keymaster/contracts";
import { captureCoordinatorWorkerConsole } from "../../support/coordinatorWorkerConsole.js";
export const JOURNEY_ID = REAL_FORUM_SMOKE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_FORUM_SMOKE_SCENARIO;

test(JOURNEY_ID + "：Keymaster 发布，经真实 Go 索引后展示 MSFile 正文", async ({ page }, testInfo) => {
  // Isolated E2E diagnostics and authenticated restoration of actual WAL.
  // Fresh publication uses public UI; recovery resumes the same production
  // Worker service and retained funding, without creating another task.
  await page.addInitScript(() => {
    const url = new URL(location.href); url.searchParams.set("lifecycleE2E", "1"); history.replaceState(null, "", url);
  });
  const config = await loadE2EConfig(); const keys = await loadE2ETestnetKeysConfig();
  const chain = createWocTestnetChainAdapter({ baseUrl: config.satsubscription.testnetApiBaseUrl, ...(config.satsubscription.testnetApiAuthorization ? { authorization: config.satsubscription.testnetApiAuthorization.read() } : {}) });
  const api = new ForumTestnetApi(config.satsubscription.testnetApiBaseUrl, config.satsubscription.testnetApiAuthorization?.read());
  const funding = new TestnetFundingResource(keys.seedPrivateKeyHex, chain);
  const serverWallet = funding.createImportedWallet(currentRunId(), JOURNEY_ID, keys.key02PrivateKeyHex.read());
  const author = funding.createImportedWallet(currentRunId(), JOURNEY_ID, keys.key01PrivateKeyHex.read());
  const password = "Forum-smoke-testnet-2026!";
  const recoveryDirectory = process.env.FORUM_E2E_RECOVERY_DIR;
  const recovery = recoveryDirectory ? {
    evidence: JSON.parse(await readFile(resolve(recoveryDirectory, "smoke.json"), "utf8")) as { runId: string; contentRunId?: string; resumedFrom?: string; authorAddress: string; rootTxid: string },
    records: JSON.parse(await readFile(resolve(recoveryDirectory, "recovery-records.json"), "utf8")) as Array<{ path: string; text: string }>,
  } : undefined;
  if (recovery && recovery.evidence.authorAddress !== author.address) throw new Error("Recovery author does not match configured key01");
  const recoveredTask = recovery?.records.filter(record => record.path.startsWith("forum/publish/")).map(record => JSON.parse(record.text).data as { taskId: string; forumConfigId: string; funding?: {txid: string; vout: number} })[0];
  if (recovery && !recoveredTask?.funding) throw new Error("Recovery has no retained funded task");
  const browserErrors = captureBrowserErrors(page, page.context());
  page.on("console", message => { if (message.text().startsWith("[coordinator]")) console.log("[forum-smoke] " + message.text()); });
  let server: Awaited<ReturnType<typeof startForumServer>> | undefined;
  let programs: Awaited<ReturnType<typeof buildForumPrograms>> | undefined;
  let stopWorkerConsole: (() => Promise<void>) | undefined;
  let seedAddress = "", root = "", publicationTxid = "", broadcastStarted = false, successful = false, authorFunded = false;
  const evidence: Record<string, unknown> = { runId: currentRunId(), network: "testnet", authorAddress: author.address };
  const announce = (phase: string) => console.log(`[forum-smoke] ${phase}`);
  page.context().on("console", message => { if (message.page() !== page && message.text().startsWith("[coordinator]")) console.log("[forum-smoke-worker] " + message.text()); });
  let lastRuntimeDiagnostic = "";
  const diagnosticTimer = setInterval(() => {
    void page.evaluate(() => {
      const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { connectionState?: string; recoverableDiagnostics?: Array<{kind: string; message: string}> } } | undefined;
      const value = hook?.diagnostics();
      return { connection: value?.connectionState, failures: value?.recoverableDiagnostics?.filter(item => item.kind !== "invalid-topic-event").slice(-3) };
    }).then(value => {
      const text = JSON.stringify(value).replace(/[a-f0-9]{64,}/giu, "[hex]");
      if (text !== lastRuntimeDiagnostic) { lastRuntimeDiagnostic = text; console.log("[forum-smoke] connection " + text); }
    }).catch(() => undefined);
  }, 5000);
  const unlockIfNeeded = async () => {
    // Cold navigation first settles the real coordinator handshake. An old
    // unlocked shell can precede the first-connect lock and is not readiness.
    await expect.poll(() => page.evaluate(() => {
      const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { connectionState?: string } } | undefined;
      return hook?.diagnostics().connectionState;
    }), { timeout: 60_000 }).toBe("ready");
    await expect.poll(async () => (await page.getByRole("button", { name: /^(Lock|锁定)$/u }).count()) + (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()), { timeout: 30_000 }).toBeGreaterThan(0);
    if (await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) await unlockWalletInPlace(page, password);
  };
  try {
    announce("检查真实测试网、资金与 Go 程序");
    const seed = await funding.prepare(3000); seedAddress = seed.seedAddress;
    console.log(JSON.stringify({ seedBalance: seed.testnetBalance, forumBalance: (await chain.inspectAddress(serverWallet.address)).testnetBalance, authorBalance: (await chain.inspectAddress(author.address)).testnetBalance }));
    programs = await buildForumPrograms();
    process.env.FORUM_E2E_ROOT_STATE ??= resolve(config.directory,"data","forum-smoke-root.json");
    root = await api.findRoot(serverWallet.publicKeyHex) ?? "";
    if (!root) {
      announce("准备真实创世资金（接受未确认 UTXO）");
      const balance = await chain.inspectAddress(serverWallet.address);
      expect(balance.mainnetBalance).toBe(0);
      if (balance.testnetBalance < 500) {
        const receipt = await funding.fund(serverWallet, 1000, { maxFundingSatoshis: 1000, maxLossSatoshis: 1000, feeReserveSatoshis: 1000 });
        evidence.genesisFundingTxid = receipt.txid;
        announce(`等待创世资金广播可见 ${receipt.txid}`);
        await api.wait(receipt.txid, false, 120_000);
      }
      await api.waitFunding(serverWallet.publicKeyHex,500);
      const pair = await programs.genesis(serverWallet, api);
      root = calcTxidFromRawTxHex(pair.root);
      evidence.rootTxid = root;
      // Only public root identity is retained so a confirmation timeout can be
      // resumed without creating another root or spending the funding twice.
      const statePath = resolve(config.directory, "data", "forum-smoke-root.json");
      await mkdir(resolve(config.directory, "data"), { recursive: true, mode: 0o700 });
      await writeFile(statePath, JSON.stringify({ txid: root, publicKeyHex: serverWallet.publicKeyHex }), { mode: 0o600 });
      expect(await api.broadcast(pair.root)).toBe(root);
      await api.wait(root, false, 120_000);
      evidence.rootCollectionTxid = await api.broadcast(pair.collection);
    }
    announce(`核验已广播固定根 ${root}`);
    await api.wait(root, false, 120_000);
    api.verifyRoot(await api.waitRaw(root), root, serverWallet.publicKeyHex);
    evidence.rootTxid = root;
    if (recovery) {
      expect(root).toBe(recovery.evidence.rootTxid);
      evidence.resumedFrom = recovery.evidence.runId;
      evidence.retainedFunding = recoveredTask!.funding;
    } else {
      expect((await chain.inspectAddress(author.address)).spendableUtxoCount, "key01 应先对账旧轮资金，再开始新冒烟").toBe(0);
      const authorReceipt = await funding.fund(author, 500, { maxFundingSatoshis: 500, maxLossSatoshis: 500, feeReserveSatoshis: 1000 });
      authorFunded = true;
      evidence.authorFundingTxid = authorReceipt.txid;
      await api.wait(authorReceipt.txid, false, 120_000);
      await api.waitFunding(author.publicKeyHex, 500);
    }
    await initializeLocalUserWithImportedHexKey(page, { keyLabel: "Forum smoke", password, privateKeyHex: author.privateKey.read() });
    stopWorkerConsole = await captureCoordinatorWorkerConsole(page, message => console.log("[forum-worker] " + redactText(message, [password, author.privateKey.read(), serverWallet.privateKey.read(), keys.seedPrivateKeyHex.read(), config.satsubscription.testnetApiAuthorization?.read() ?? ""])));
    announce("通过正式页面导入测试身份并刷新 UTXO");
    await enableTestnetAssets(page);
    await waitForP2pkhSyncIdle(page);
    if (recovery) {
      announce("恢复上轮真实任务与资金写前记录，不新增资金交易");
      await page.evaluate(async records => {
        const hook = window.__lifecycleProductionE2E as unknown as { restoreForumSmokeRecords(records: Array<{path: string; text: string}>): Promise<void> } | undefined;
        if (!hook) throw new Error("Recovery hook unavailable");
        await hook.restoreForumSmokeRecords(records);
      }, recovery.records);
      // Recreate owner-session services so their protections hydrate from the
      // actual restored wallet records. No synthetic claim or stage is written.
      await lockWallet(page); await unlockWalletInPlace(page, password);
    }
    await refreshTestnetUtxoSnapshot(page, 1, 180_000, async () => {
      const session = await page.evaluate(() => {
        const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { connectionState?: string; bootstrap?: {vaultStatus?: string} } } | undefined;
        const value = hook?.diagnostics(); return { connection: value?.connectionState, vault: value?.bootstrap?.vaultStatus };
      });
      // A disconnected Window renders the locked shell even while the Worker
      // is unlocked. Re-unlocking then would create another owner generation
      // and interrupt restoration; wait for the actual session first.
      if (session.connection === "ready" && session.vault === "locked"
        && await page.getByRole("button", { name: /^(Unlock|解锁)$/u }).count()) {
        await unlockWalletInPlace(page, password); await openTestnetWalletPage(page);
      }
    });
    announce("启动真实 PostgreSQL、Go Forum 和 TLS 入口");
    server = await startForumServer({ programs, wallet: serverWallet, root, api });
    announce("页面连接论坛并验证真实根");
    await unlockIfNeeded();
    await page.getByRole("button", { name: /^(Forum|论坛)$/u }).click();
    const contentRunId = recovery?.evidence.contentRunId ?? recovery?.evidence.resumedFrom ?? recovery?.evidence.runId ?? currentRunId();
    evidence.contentRunId = contentRunId;
    const marker = `Forum smoke ${contentRunId}`;
    let configId = recoveredTask?.forumConfigId;
    if (recovery) {
      broadcastStarted = true;
      announce("复用原专用资金，生产 Worker 重新报价并继续同一发布任务");
      const task = await page.evaluate(async input => {
        const hook = window.__lifecycleProductionE2E as unknown as { resumeForumSmoke(taskId: string, markdown: string, endpoint: string): Promise<ForumPublishTask> } | undefined;
        if (!hook) throw new Error("Recovery hook unavailable");
        return hook.resumeForumSmoke(input.taskId, input.markdown, input.endpoint);
      }, { taskId: recoveredTask!.taskId, markdown: `# ${marker}\n\nKeymaster → Go Forum → testnet → index → MSFile smoke.`, endpoint: server.url });
      if (!task.txid) throw new Error(`Retained task did not submit: ${task.phase} (${task.failureCode ?? "none"})`);
      publicationTxid = task.txid;
      evidence.resumedTaskId = task.taskId;
    } else {
      announce("已进入论坛页面，填写连接配置");
      await page.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
      const form = page.locator("form.forum-config-form");
      await form.getByLabel(/^(Label|显示别名)$/u).fill("Forum smoke");
      await form.getByLabel(/^(Genesis root txid|创世根 txid)$/u).fill(root);
      await form.getByLabel(/^(Forum service public key|论坛服务公钥)$/u).fill(serverWallet.publicKeyHex);
      await form.locator("select").first().selectOption("test"); await form.locator("input").last().fill(server.url);
      await form.getByRole("button", { name: /^(Add forum|添加论坛)$/u }).click();
      announce("连接配置已保存，开始验证创世根");
      await page.getByRole("button", { name: /^(Verify genesis root|验证创世根)$/u }).click();
      const browse = page.getByRole("link", { name: /^(Browse boards|进入板块)$/u });
      await expect(browse).toBeVisible({ timeout: 60_000 }); await browse.click(); await unlockIfNeeded();
      await page.getByRole("link", { name: /^(Publish reply|发布回复)$/u }).click(); await unlockIfNeeded();

      await page.locator("textarea").fill(`# ${marker}\n\nKeymaster → Go Forum → testnet → index → MSFile smoke.`);
      announce("获取真实报价、确认金额并通过 Keymaster 广播");
      await page.getByRole("button", { name: /^(Publish reply|发布回复)$/u }).click();
      await expect(page.locator(".forum-task")).toContainText("quoted", { timeout: 60_000 });
      // Preparing dedicated funds can already broadcast a wallet transaction.
      // Preserve those funds on any later failure, before the post dispatch too.
      broadcastStarted = true;
      await page.getByRole("button", { name: /^(Confirm budget|确认预算)$/u }).click();
      await expect(page.getByRole("button", { name: /^(Broadcast|广播)$/u })).toBeEnabled();
      await page.getByRole("button", { name: /^(Broadcast|广播)$/u }).click();
      await expect(page.locator(".forum-txid")).toBeVisible({ timeout: 180_000 });
      publicationTxid = (await page.locator(".forum-txid").innerText()).trim();
      configId = /\/forum\/([^/]+)\/publish\//u.exec(new URL(page.url()).pathname)?.[1];
    }
    evidence.publicationTxid = publicationTxid;
    await api.wait(publicationTxid, false, 120_000);
    announce(`等待 Go 从链上索引 ${publicationTxid}`);
    // Follow the ordinary public page route. Go must discover the transaction
    // itself; neither SQL insert nor a synthetic chain observation is allowed.
    if (!configId) throw new Error("Forum publish route has no config ID");
    evidence.indexState = await server.waitIndexed(publicationTxid);
    await stopWorkerConsole(); stopWorkerConsole = undefined;
    await page.goto(`/forum/${configId}/post/${publicationTxid}`); await unlockIfNeeded();
    await expect.poll(async () => page.locator(".forum-post > .forum-node-header").count(), { timeout: 240_000, intervals: [5000] }).toBeGreaterThan(0);
    const readButton = page.getByRole("button", { name: /^(Read|阅读)$/u });
    if (await readButton.count()) await readButton.click();
    await expect(page.locator(".forum-markdown")).toContainText(marker, { timeout: 60_000 });
    successful = true; evidence.result = "passed";
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const hook = window.__lifecycleProductionE2E as unknown as { diagnostics(): { forumState?: unknown; bootstrap?: { coordinatorWorkerUnits?: unknown } } } | undefined;
      const state = hook?.diagnostics();
      return { ...state, workerUnits: state?.bootstrap?.coordinatorWorkerUnits };
    }).catch(() => undefined);
    console.log("[forum-smoke] runtime diagnostics " + JSON.stringify(diagnostics).replace(/[a-f0-9]{64,}/giu, "[redacted-hex]"));
    console.log("[forum-smoke] browser errors " + redactText(JSON.stringify(browserErrors), [password, author.privateKey.read(), serverWallet.privateKey.read(), keys.seedPrivateKeyHex.read(), config.satsubscription.testnetApiAuthorization?.read() ?? ""]));
    throw error;
  } finally {
    clearInterval(diagnosticTimer);
    await stopWorkerConsole?.().catch(() => undefined);
    // Once app dispatch has started, failures preserve the original transaction
    // and funds for reconciliation. Never sweep them merely because UI timed out.
    if (authorFunded && seedAddress && (successful || !broadcastStarted)) {
      try { if ((await chain.inspectAddress(author.address)).spendableUtxoCount > 0) evidence.authorReturn = await funding.returnRemaining(author, seedAddress, { feeRateSatoshisPerKb: 1 }); } catch { evidence.authorReturn = "pending-chain-observation"; }
    }
    await ensureRunDataDirectory("forum", "state");
    if (broadcastStarted) {
      if (!successful) evidence.fundsRetained = true;
      // Keep public write-ahead records before Playwright removes the temporary
      // browser profile. Preserve successful submissions as well: an older
      // archive must not become the only recovery record after acceptance.
      // No KeyHold, wallet secret or MSFile content is exported.
      try {
        const records = await readRawWalletObjects(page, "(?:^|/)(?:forum/(?:publish|funding|configs|roots)/|p2pkh/(?:funding|protocol)/)");
        const sensitive = [password, author.privateKey.read(), serverWallet.privateKey.read(), keys.seedPrivateKeyHex.read(), config.satsubscription.testnetApiAuthorization?.read() ?? ""].filter(Boolean);
        if (sensitive.some(secret => JSON.stringify(records).includes(secret))) throw new Error("Recovery evidence contains a secret");
        await writeFile(runDataPath("forum", "state", "recovery-records.json"), JSON.stringify(records, null, 2), { mode: 0o600 });
        evidence.recoveryRecordCount = records.length;
      } catch { evidence.recoveryEvidence = "unavailable"; }
    }
    await writeFile(runDataPath("forum", "state", "smoke.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    if (server) { await testInfo.attach("go-forum-log", { body: server.logs().replaceAll(serverWallet.privateKey.read(), "[secret]"), contentType: "text/plain" }); await server.stop(); }
    await attachBrowserErrors(testInfo, browserErrors, [password, author.privateKey.read(), serverWallet.privateKey.read(), keys.seedPrivateKeyHex.read(), config.satsubscription.testnetApiAuthorization?.read() ?? ""]);
    await programs?.dispose(); serverWallet.clear(); author.clear();
    for (const secret of [keys.seedPrivateKeyHex, keys.key01PrivateKeyHex, keys.key02PrivateKeyHex, config.testnet.privateKeyHex, config.testnet.trackingKeyPrivateKeyHex, config.satsubscription.testnetApiAuthorization]) secret?.clear();
  }
});
