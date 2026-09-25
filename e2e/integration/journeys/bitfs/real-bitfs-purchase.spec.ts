import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import {
  configureBitfsBuyer,
  configureBitfsSeller,
  assertBitfsFundingPoolClosed,
  assertBitfsPurchaseEvidence,
  assertBitfsPurchaseBatching,
  assertBitfsDiagnosticsHealthy,
  openMsFileStoragePage,
  startBitfsPurchase,
  uploadMsFile,
  verifyDownloadedMsFile,
  waitForBitfsPurchaseCompleted,
} from "../../drivers/bitfsMsFileDriver.js";
import { saveMsFilePriceLimits } from "../../drivers/msfileDriver.js";
import { enableTestnetAssets, setP2pkhFeeRate, waitForP2pkhSyncIdle, waitForTestnetUtxoSnapshot } from "../../drivers/p2pkhDriver.js";
import {
  enableSatSupplierReceiveAndDefault,
  saveSatSupplierFromPage,
  waitForSatSupplierConnectionState,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import {
  BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS,
  BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB,
  BITFS_E2E_SEED_PRICE_SATOSHIS,
  bitfsFilePath,
  calculateBitfsBuyerBudget,
  loadBitfsKeyMaterial,
  readBitfsSeedHash,
  type BitfsKeyMaterial,
} from "../../resources/bitfs/bitfsTestnetResource.js";
import { startSatSubscriptionLocalServer, type SatSubscriptionLocalServer } from "../../resources/satsubscription/localServerResource.js";
import { TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter, type WocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { readRawLocalBucketObjects } from "../../support/localBucketFormats.js";
import { currentRunId } from "../../support/ids.js";
import { REAL_BITFS_PURCHASE_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_BITFS_PURCHASE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_BITFS_PURCHASE_SCENARIO;

const PREVIEW_ORIGIN = "http://127.0.0.1:4173";
const BUYER_PASSWORD = "real-bitfs-buyer-password-123";
const SELLER_PASSWORD = "real-bitfs-seller-password-123";
const SUPPLIER_ID = "real-bitfs-local";
const SUPPLIER_NAME = "BitFS E2E SatSubscription";
const API_BASE_URL = "https://api.whatsonchain.com/v1/bsv";
const MAX_LOSS_SATOSHIS = 2_000;
const BITFS_E2E_ARBITER_PRIVATE_KEY = new Uint8Array(32);
BITFS_E2E_ARBITER_PRIVATE_KEY[31] = 3;
const BITFS_E2E_ARBITER_PUBLIC_KEY_HEX = Buffer.from(secp256k1.getPublicKey(BITFS_E2E_ARBITER_PRIVATE_KEY, true)).toString("hex");

function announce(phase: string): void {
  process.stdout.write(`[bitfs-e2e] ${phase}\n`);
}

interface BitfsUser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly publicKeyHex: string;
  readonly password: string;
  readonly browserErrors: BrowserErrorEvidence;
}

async function launchUser(input: { readonly password: string; readonly privateKeyHex: string; readonly bucketLabel: string; readonly keyLabel: string }): Promise<BitfsUser> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: PREVIEW_ORIGIN, acceptDownloads: true });
  const page = await context.newPage();
  page.on("dialog", (dialog) => { void dialog.accept(); });
  page.on("console", (message) => {
    if (/bitfs|msfile|webrtc|executor|channel|sat/iu.test(message.text())) {
      process.stdout.write(`[bitfs-e2e] ${input.keyLabel} console.${message.type()}: ${message.text().slice(0, 500)}\n`);
    }
  });
  page.on("pageerror", (error) => {
    process.stdout.write(`[bitfs-e2e] ${input.keyLabel} pageerror: ${error.message.slice(0, 500)}\n`);
  });
  context.on("console", (message) => {
    if (message.page() !== page && /bitfs|msfile|webrtc|executor|channel|sat/iu.test(message.text())) {
      process.stdout.write(`[bitfs-e2e] ${input.keyLabel} context.console.${message.type()}: ${message.text().slice(0, 500)}\n`);
    }
  });
  const browserErrors = captureBrowserErrors(page, context);
  try {
    const ready = await initializeLocalUserWithImportedHexKey(page, input);
    return { browser, context, page, publicKeyHex: ready.publicKeyHex, password: input.password, browserErrors };
  } catch (error) {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function disableAutoLock(user: BitfsUser): Promise<void> {
  await openSettingsPage(user.page, {
    label: /^Auto lock$|^自动锁屏$/u,
    path: /\/settings\/auto-lock$/u,
    heading: /^Auto lock$|^自动锁屏$/u,
  });
  const never = user.page.getByRole("button", { name: /^Never$|^永不$/u });
  await expect(never).toBeVisible({ timeout: 15_000 });
  if (await never.getAttribute("aria-pressed") !== "true") await never.click();
  await expect(never).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
}

async function configureSupplier(user: BitfsUser, server: SatSubscriptionLocalServer): Promise<void> {
  await openSettingsPage(user.page, {
    label: /^Broadcast gateway$|^广播网关$/u,
    path: /\/settings\/system-status$/u,
    heading: /^Broadcast gateway$|^广播网关$/u,
  });
  await saveSatSupplierFromPage(user.page, {
    supplierId: SUPPLIER_ID,
    name: SUPPLIER_NAME,
    supplierPublicKeyHex: server.supplierPublicKeyHex,
    multiaddrs: [server.multiaddr],
    enabled: true,
  });
  await waitForSatSupplierConnectionState(user.page, SUPPLIER_ID, "online");
  await enableSatSupplierReceiveAndDefault(user.page, SUPPLIER_ID);
}

async function waitForFreeSubscriptions(server: SatSubscriptionLocalServer, buyerPublicKeyHex: string, sellerPublicKeyHex: string): Promise<void> {
  await expect.poll(async () => {
    const ledger = await server.ledgerSummary();
    return {
      hash: ledger.subscriptionChannels.includes("bsv8.hash.request.v1"),
      buyer: ledger.subscriptions.some((entry) => entry.subjectPublicKeyHex === buyerPublicKeyHex && entry.channel === "bsv8.hash.request.v1"),
      seller: ledger.subscriptions.some((entry) => entry.subjectPublicKeyHex === sellerPublicKeyHex && entry.channel === "bsv8.hash.request.v1"),
      free: ledger.operations.every((entry) => entry.chargedSubunits === "0"),
    };
  }, { timeout: 45_000, message: "BitFS 双方必须通过免费 SatSubscription 订阅 Hash 频道" }).toEqual({ hash: true, buyer: true, seller: true, free: true });
}

function clearMaterial(material: BitfsKeyMaterial | undefined): void {
  material?.config.seedPrivateKeyHex.clear();
  material?.config.key01PrivateKeyHex.clear();
  material?.config.key02PrivateKeyHex.clear();
}

async function observeFunding(chain: WocTestnetChainAdapter, txid: string): Promise<void> {
  await chain.waitForTransaction(txid, { timeoutMs: 60_000, pollMs: 2_000 });
}

async function waitForZeroSpendable(chain: WocTestnetChainAdapter, address: string, timeoutMs = 30_000): Promise<void> {
  await expect.poll(async () => (await chain.inspectAddress(address)).spendableUtxoCount, {
    timeout: timeoutMs,
    intervals: [1_000, 2_000, 5_000, 10_000],
    message: "key01 不应留下可花费 testnet 输出",
  }).toBe(0);
}

test(JOURNEY_ID + "：双浏览器 BitFS 报价、testnet 购买与关池回款", async ({}, testInfo) => {
  test.setTimeout(1_800_000);
  const users: BitfsUser[] = [];
  let material: BitfsKeyMaterial | undefined;
  let chain: WocTestnetChainAdapter | undefined;
  let funding: TestnetFundingResource | undefined;
  let wallet: OneTimeWallet | undefined;
  let server: SatSubscriptionLocalServer | undefined;
  let seedAddress = "";
  let fundingTxid = "";
  let fundsReturned = false;
  let purchaseStarted = false;
  let journeyError: unknown;
  let cleanupError: unknown;
  let evidenceError: unknown;

  try {
    announce("加载密钥与 MP4");
    material = await loadBitfsKeyMaterial();
    const filePath = bitfsFilePath(material.config);
    const fileStat = await stat(filePath);
    const budget = calculateBitfsBuyerBudget(BigInt(fileStat.size));
    const expectedSeedHashHex = await readBitfsSeedHash(filePath);
    expect(budget.openingAmountSatoshis).toBe(BITFS_E2E_SEED_PRICE_SATOSHIS + BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS * budget.blockCount + BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB * 2n);

    announce("检查 testnet 并准备买方资金");
    chain = createWocTestnetChainAdapter({ baseUrl: API_BASE_URL });
    const network = await chain.inspectNetwork();
    expect(network.network).toBe("testnet");
    funding = new TestnetFundingResource(material.config.seedPrivateKeyHex, chain);
    const seed = await funding.prepare(Number(budget.buyerFundingSatoshis));
    seedAddress = seed.seedAddress;
    const existingBuyer = await chain.inspectAddress(material.buyerAddress);
    expect(existingBuyer.mainnetBalance).toBe(0);
    await waitForZeroSpendable(chain, material.buyerAddress);
    const settledBuyer = await chain.inspectAddress(material.buyerAddress);
    expect(settledBuyer.mainnetBalance).toBe(0);
    expect(settledBuyer.spendableUtxoCount, "key01 开始前必须没有可花费 testnet 输出").toBe(0);

    wallet = funding.createImportedWallet(currentRunId(), JOURNEY_ID, material.config.key01PrivateKeyHex.read());
    const funded = await funding.fund(wallet, Number(budget.buyerFundingSatoshis), {
      maxFundingSatoshis: Number(budget.buyerFundingSatoshis),
      maxLossSatoshis: MAX_LOSS_SATOSHIS,
      feeReserveSatoshis: 1_000,
    });
    fundingTxid = funded.txid;
    await observeFunding(chain, fundingTxid);

    announce("启动真实 SatSubscription");
    server = await startSatSubscriptionLocalServer({ whitelistPublicKeys: [material.buyerPublicKeyHex, material.sellerPublicKeyHex] });
    announce("启动买方浏览器");
    const buyer = await launchUser({
      password: BUYER_PASSWORD,
      privateKeyHex: material.config.key01PrivateKeyHex.read(),
      bucketLabel: "BitFS E2E 买方桶",
      keyLabel: "BitFS E2E key01",
    });
    users.push(buyer);
    expect(buyer.publicKeyHex).toBe(material.buyerPublicKeyHex);
    announce("启动卖方浏览器");
    const seller = await launchUser({
      password: SELLER_PASSWORD,
      privateKeyHex: material.config.key02PrivateKeyHex.read(),
      bucketLabel: "BitFS E2E 卖方桶",
      keyLabel: "BitFS E2E key02",
    });
    users.push(seller);
    expect(seller.publicKeyHex).toBe(material.sellerPublicKeyHex);

    announce("关闭双方自动锁定");
    await disableAutoLock(buyer);
    await disableAutoLock(seller);
    announce("配置双方 SatSubscription 供应商");
    await configureSupplier(buyer, server);
    await configureSupplier(seller, server);
    announce("等待免费 Hash 订阅");
    await waitForFreeSubscriptions(server, material.buyerPublicKeyHex, material.sellerPublicKeyHex);

    announce("开启买方 testnet");
    await enableTestnetAssets(buyer.page);
    announce("设置买方费率");
    await setP2pkhFeeRate(buyer.page, "medium", Number(BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB));
    announce("等待买方同步");
    await waitForP2pkhSyncIdle(buyer.page, 5_000);
    announce("等待买方 testnet UTXO 快照");
    await waitForTestnetUtxoSnapshot(buyer.page, 1, 45_000);
    announce("打开买方 MSFile 设置");
    await openSettingsPage(buyer.page, {
      label: /^Local files$|^本地文件$/u,
      path: /\/settings\/local-files$/u,
      heading: /^Local files$|^本地文件$/u,
    });
    await saveMsFilePriceLimits(buyer.page, { seedMaxPriceSatoshis: "9", blockMaxPriceSatoshis: "9" });
    announce("保存买方 BitFS 设置");
    await configureBitfsBuyer(buyer.page, {
      buyerAutoPurchaseEnabled: false,
      maxFullBlockPriceSatoshis: BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS.toString(),
      sellerSelectionPriority: "price",
      maxConcurrentDownloads: "1",
      maxConcurrentSellerSessions: "1",
      blocksPerBatch: "10",
    });

    announce("上传卖方 MP4");
    await openMsFileStoragePage(seller.page);
    announce("卖方文件输入已打开");
    const uploaded = await uploadMsFile(seller.page, filePath);
    announce("卖方 MP4 上传完成");
    expect(uploaded.seedHashHex, "key02 上传文件的 Seed Hash 必须与 Node 独立计算一致").toBe(expectedSeedHashHex);
    announce("打开卖方 MSFile 设置");
    await openSettingsPage(seller.page, {
      label: /^Local files$|^本地文件$/u,
      path: /\/settings\/local-files$/u,
      heading: /^Local files$|^本地文件$/u,
    });
    await saveMsFilePriceLimits(seller.page, { seedMaxPriceSatoshis: "9", blockMaxPriceSatoshis: "9" });
    announce("保存卖方 BitFS 设置");
    await configureBitfsSeller(seller.page, {
      seedPriceSatoshis: BITFS_E2E_SEED_PRICE_SATOSHIS.toString(),
      fullBlockPriceSatoshis: BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS.toString(),
      quoteLifetimeSeconds: "1200",
      maxConcurrentSales: "1",
       supportedArbiterPublicKeys: [BITFS_E2E_ARBITER_PUBLIC_KEY_HEX],
    });

    announce("查询 Seed 并购买");
    try {
      await startBitfsPurchase(buyer.page, expectedSeedHashHex, { onBeforeClick: async () => {
        announce("保持报价连接超过 30 秒建连期限");
        await buyer.page.waitForTimeout(35_000);
        await assertBitfsDiagnosticsHealthy(buyer.page);
        await assertBitfsDiagnosticsHealthy(seller.page);
        purchaseStarted = true;
      } });
    } catch (error) {
      const ledger = await server.ledgerSummary();
       const sellerEntries = await readRawLocalBucketObjects(seller.page, "/msfiles/.*\\.json$|sat-subscription|setting");
       const buyerEntries = users[0] ? await readRawLocalBucketObjects(users[0].page, "/msfiles/.*\\.json$") : [];
       const sellerMeta = sellerEntries.find((entry) => entry.path.includes(`/msfiles/meta/${expectedSeedHashHex}.json`));
       const sellerSat = sellerEntries.filter((entry) => /sat-subscription|setting/u.test(entry.path));
       const sellerDiagnostics = sellerEntries.filter((entry) => entry.path.includes("/bitfs-e2e-diagnostics/"));
       const buyerDiagnostics = buyerEntries.filter((entry) => entry.path.includes("/bitfs-e2e-diagnostics/"));
       const sellerJournal = sellerEntries.filter((entry) => entry.path.includes("/bitfs-journal/"));
       const buyerJournal = buyerEntries.filter((entry) => entry.path.includes("/bitfs-journal/"));
       process.stdout.write(`[bitfs-e2e] 报价等待失败账本：${JSON.stringify(ledger)}\n`);
       process.stdout.write(`[bitfs-e2e] 卖方 SatSubscription 状态：${JSON.stringify(sellerSat.map((entry) => ({ path: entry.path, text: entry.text.slice(0, 1000) })))}\n`);
       process.stdout.write(`[bitfs-e2e] 卖方 BitFS 诊断：${JSON.stringify(sellerDiagnostics.map((entry) => ({ path: entry.path, text: entry.text })))}\n`);
       process.stdout.write(`[bitfs-e2e] 买方 BitFS 诊断：${JSON.stringify(buyerDiagnostics.map((entry) => ({ path: entry.path, text: entry.text })))}\n`);
       process.stdout.write(`[bitfs-e2e] 买方 BitFS Journal：${JSON.stringify(buyerJournal.map((entry) => ({ path: entry.path, text: entry.text.slice(0, 2000) })))}\n`);
       process.stdout.write(`[bitfs-e2e] 卖方 BitFS Journal：${JSON.stringify(sellerJournal.map((entry) => ({ path: entry.path, text: entry.text.slice(0, 2000) })))}\n`);
       process.stdout.write(`[bitfs-e2e] 卖方 BitFS 元数据：${sellerMeta?.text ?? "missing"}\n`);
      process.stdout.write(`[bitfs-e2e] 卖方 BitFS 桶路径：${JSON.stringify(sellerEntries.map((entry) => entry.path).filter((path) => /bitfs|msfile/u.test(path)))}\n`);
      process.stdout.write(`[bitfs-e2e] SatSubscription 日志：${server.serverLogTail(20).join(" | ")}\n`);
      throw error;
    }
    const purchaseStartedAtMs = Date.now();
    try {
       await waitForBitfsPurchaseCompleted(buyer.page, expectedSeedHashHex);
     } catch (error) {
       const buyerEntries = users[0] ? await readRawLocalBucketObjects(users[0].page, "/msfiles/.*\\.json$") : [];
       const sellerEntries = await readRawLocalBucketObjects(seller.page, "/msfiles/.*\\.json$|sat-subscription|setting");
       const buyerDiagnostics = buyerEntries.filter((entry) => entry.path.includes("/bitfs-e2e-diagnostics/"));
       const sellerDiagnostics = sellerEntries.filter((entry) => entry.path.includes("/bitfs-e2e-diagnostics/"));
       const buyerJournal = buyerEntries.filter((entry) => entry.path.includes("/bitfs-journal/"));
       const sellerJournal = sellerEntries.filter((entry) => entry.path.includes("/bitfs-journal/"));
       process.stdout.write(`[bitfs-e2e] 购买等待失败买方诊断：${JSON.stringify(buyerDiagnostics.map((entry) => ({ path: entry.path, text: entry.text })))}\n`);
       process.stdout.write(`[bitfs-e2e] 购买等待失败卖方诊断：${JSON.stringify(sellerDiagnostics.map((entry) => ({ path: entry.path, text: entry.text })))}\n`);
       process.stdout.write(`[bitfs-e2e] 购买等待失败买方 Journal：${JSON.stringify(buyerJournal.map((entry) => ({ path: entry.path, text: entry.text.slice(0, 3000) })))}\n`);
       process.stdout.write(`[bitfs-e2e] 购买等待失败卖方 Journal：${JSON.stringify(sellerJournal.map((entry) => ({ path: entry.path, text: entry.text.slice(0, 3000) })))}\n`);
       process.stdout.write(`[bitfs-e2e] 购买等待失败买方状态：${JSON.stringify(await buyer.page.locator("main").innerText())}\n`);
       throw error;
     }
     announce("检查 BitFS 专款关池");
    await assertBitfsFundingPoolClosed(buyer.page, expectedSeedHashHex);
    await assertBitfsPurchaseEvidence(buyer.page, expectedSeedHashHex);
    const batching = await assertBitfsPurchaseBatching(buyer.page, expectedSeedHashHex, 10);
    announce(`批量购买性能：${batching.blockCount} 块、${batching.paymentRounds} 轮付款、${((Date.now() - purchaseStartedAtMs) / 1_000).toFixed(1)} 秒`);
    await assertBitfsDiagnosticsHealthy(seller.page);

    announce("校验并下载购买文件");
    const download = await verifyDownloadedMsFile(buyer.page, expectedSeedHashHex);
    expect(download.suggestedFilename()).toBe(uploaded.fileName);
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error("BitFS 购买文件没有产生下载路径");
    const [sourceBytes, downloadedBytes] = await Promise.all([readFile(filePath), readFile(downloadedPath)]);
    expect(downloadedBytes.byteLength).toBe(sourceBytes.byteLength);
    expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(createHash("sha256").update(sourceBytes).digest("hex"));

    const finalLedger = await server.ledgerSummary();
    expect(finalLedger.operations.length).toBeGreaterThan(0);
    expect(finalLedger.operations.every((entry) => entry.chargedSubunits === "0")).toBe(true);

    announce("归集买方剩余资金");
    await chain.waitForSpendableChange(wallet.address, fundingTxid, { timeoutMs: 60_000, pollMs: 2_000 });
    const returned = await funding.returnRemaining(wallet, seedAddress, { feeRateSatoshisPerKb: Number(BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB) });
    fundsReturned = true;
    await observeFunding(chain, returned.txid);
    const returnedOutputs = await chain.waitForTransactionOutputs(returned.txid, seedAddress, { timeoutMs: 60_000, pollMs: 2_000 });
    expect(returnedOutputs.txid).toBe(returned.txid);
    expect(returnedOutputs.outputSatoshis).toBeGreaterThan(0);
    await waitForZeroSpendable(chain, wallet.address);
  } catch (error) {
    journeyError = error;
  } finally {
    const knownSecrets = [
      BUYER_PASSWORD,
      SELLER_PASSWORD,
      fundingTxid,
      material?.config.seedPrivateKeyHex.read() ?? "",
      material?.config.key01PrivateKeyHex.read() ?? "",
      material?.config.key02PrivateKeyHex.read() ?? "",
      wallet?.privateKey.read() ?? "",
    ];
    try {
      if (funding && chain && wallet && seedAddress && fundingTxid && !fundsReturned && !purchaseStarted) {
        const observation = await chain.inspectAddress(wallet.address);
        if (observation.spendableUtxoCount > 0) {
          const returned = await funding.returnRemaining(wallet, seedAddress, { feeRateSatoshisPerKb: Number(BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB) });
          fundsReturned = true;
          await observeFunding(chain, returned.txid);
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      for (const user of users) {
        await attachBrowserErrors(testInfo, user.browserErrors, knownSecrets);
        await attachVisibleDiagnostic(user.page, testInfo);
      }
    } catch (error) {
      evidenceError = error;
    }
    await Promise.all(users.map((user) => user.context.close().catch(() => undefined)));
    await Promise.all(users.map((user) => user.browser.close().catch(() => undefined)));
    try {
      await server?.stop();
    } catch (error) {
      cleanupError ??= error;
    }
    wallet?.clear();
    clearMaterial(material);
    if (cleanupError) throw cleanupError;
    if (evidenceError) throw evidenceError;
  }

  if (journeyError) throw journeyError;
});
