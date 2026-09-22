import { expect, test } from "@playwright/test";
import { createContact } from "../../drivers/contactDriver.js";
import {
  dismissTestnetTransferResult,
  disableTestnetAssets,
  enableTestnetAssets,
  expectAmountBalanceReference,
  expectAmountValue,
  expectTestnetWalletBalance,
  expectTransferFeeTierRate,
  openTestnetWalletPage,
  openTransferPage,
  refreshTestnetUtxoSnapshot,
  setAmountValue,
  setP2pkhFeeRate,
  submitAndAwaitResult,
  waitForP2pkhSyncIdle,
  waitForTestnetUtxoSnapshot,
  type TransferReceipt,
} from "../../drivers/p2pkhDriver.js";
import {
  changeRecipient,
  chooseRecipientNetwork,
  enterManualRecipient,
  expectNetworkSelectorLocked,
  expectNoNetworkSelector,
  expectRecipientAddress,
  expectRecipientError,
  expectSourceBadge,
  pickContact,
  selectRecipientTab,
} from "../../drivers/transferRecipientDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import { navigateToBusinessPage } from "../../drivers/navigationDriver.js";
import { unlockWalletWithReplay } from "../../drivers/vaultDriver.js";
import { loadE2EConfig, publicConfigFingerprint } from "../../resources/config/loader.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";
import { deriveMainnetP2pkhAddress, deriveTestnetP2pkhAddress, TestnetFundingResource, type OneTimeWallet } from "../../resources/testnet/fundingResource.js";
import { createWocTestnetChainAdapter, type WocTestnetChainAdapter } from "../../resources/testnet/wocChainAdapter.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachRedactedText } from "../../support/redaction.js";
import { readResourceRunState } from "../../support/resourceState.js";
import { REAL_TESTNET_CONTACT_TRANSFER_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_TESTNET_CONTACT_TRANSFER_SCENARIO.id;
export const JOURNEY_METADATA = REAL_TESTNET_CONTACT_TRANSFER_SCENARIO;

/** 本轮固定充值预算；每笔手续费由页面最终预览和链上输入输出对账。 */
const FUNDING_SATOSHIS = 200;
/** 中档费率设为 1 sats/kB，保证小额真实 testnet 交易可完成。 */
const FEE_RATE_SATOSHIS_PER_KB = 1;
/** T4.5 只用于把“金额 + 手续费”不足分支变成确定失败；不广播。 */
const INSUFFICIENT_BALANCE_FEE_RATE_SATOSHIS_PER_KB = 1_000;
/** 本轮允许的总手续费损失上限。 */
const MAX_LOSS_SATOSHIS = 10;
/** 确定性合法陌生公钥；只用于派生陌生 testnet 地址，不持有其私钥。 */
const STRANGER_PUBLIC_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
/** 版本为 3 的 Base58Check 地址，属于 P2SH，不应被 P2PKH codec 接受。 */
const P2SH_ADDRESS = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

function invalidChecksumAddress(address: string): string {
  const last = address.at(-1);
  return `${address.slice(0, -1)}${last === "1" ? "2" : "1"}`;
}

/** 只输出步骤进度和公开 txid，便于长时间真实链上运行定位停在哪一步。 */
function logJourneyProgress(label: string): void {
  console.log(`[真实 testnet contact] ${new Date().toISOString()} ${label}`);
}

/**
 * 按页面预览和原始交易分别核对一笔广播：
 * 1. 先等 txid 在 testnet 可观察；
 * 2. 再从 raw transaction 确认目标输出金额；
 * 3. 确认输入消费上一笔 key01 输出，不能只看“广播成功”文本。
 */
async function reconcilePageBroadcast(
  chain: WocTestnetChainAdapter,
  receipt: TransferReceipt,
  recipientAddress: string,
  previousOutpointPrefix: string,
): Promise<string> {
  const observed = await chain.waitForTransaction(receipt.txid, { timeoutMs: 180_000, pollMs: 10_000 });
  expect(observed, "页面广播交易必须在 testnet 可观察").toMatch(/^(confirmed|unconfirmed)$/u);
  const outputs = await chain.waitForTransactionOutputs(receipt.txid, recipientAddress, { timeoutMs: 120_000, pollMs: 5_000 });
  expect(outputs.txid, "链上 canonical txid 必须与页面结果一致").toBe(receipt.txid);
  expect(outputs.outputSatoshis, "链上目标地址输出必须等于页面只读预览的收款额").toBe(receipt.amountSatoshis);
  expect(
    outputs.inputOutpointKeys.some((key) => key.startsWith(previousOutpointPrefix)),
    `本笔交易输入必须消费上一笔 key01 输出：${previousOutpointPrefix}`,
  ).toBe(true);
  return receipt.noChange ? "" : `${receipt.txid}:1`;
}

/** 资产总览也必须显示 testnet coin 的页面余额，而不是只更新钱包页。 */
async function expectAssetsTestnetBalance(page: import("@playwright/test").Page, satoshis: number): Promise<void> {
  // 资产总览同时渲染 coin 面板和 token 面板；两者都带 is-test，
  // 这里必须限定第一个 Coins/Assets 面板，避免 strict mode 命中空 token 区。
  const testnet = page.locator(".asset-workspace-panel").first().locator(".asset-workspace-network.is-test");
  await expect(testnet).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => testnet.textContent() ?? "", {
    timeout: 60_000,
    message: `资产总览 testnet 行必须跟随余额广播显示 ${satoshis} sats`,
  }).toContain(`${satoshis} sats`);
}

/** 第二 tab 可能因 15 分钟空闲自动锁定；继续做跨 tab 断言前按真实用户动作重新解锁。 */
async function ensureUnlockedBusinessTab(page: import("@playwright/test").Page, password: string): Promise<void> {
  const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/u });
  const locked = page.getByRole("heading", { name: /Wallet locked|钱包已锁定/u });
  // 全局自动锁定可能正好在状态观察和菜单点击之间触发；这里最多重放两次，
  // 避免把一次真实的自动锁定竞态变成菜单按钮无限等待 30 分钟。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await expect.poll(async () => {
      if (await navigation.isVisible().catch(() => false)) return "unlocked";
      if (await locked.isVisible().catch(() => false)) return "locked";
      return "pending";
    }, { timeout: 30_000, message: "第二 tab 必须进入可解锁或已解锁状态" }).not.toBe("pending");

    if (await locked.isVisible().catch(() => false)) {
      // S3/跨 tab 的 session 切换窗口可能让第一次解锁点击落在旧状态上；
      // 复用已有的最多一次重放逻辑，确认最终真的出现“锁定”按钮。
      await unlockWalletWithReplay(page, password);
    }

    try {
      await expect(navigation).toBeVisible({ timeout: 20_000 });
      if (!(await locked.isVisible().catch(() => false))) return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("第二 tab 解锁后仍未进入业务导航");
}

/**
 * 第二 tab 的全局自动锁定可能发生在“已解锁”检查之后、菜单点击之前；
 * 导航必须使用短超时并在锁定后重试，不能把 Playwright 测试整体拖到 30 分钟。
 */
async function navigateUnlockedBusinessTab(
  page: import("@playwright/test").Page,
  password: string,
  input: { readonly label: RegExp; readonly path: RegExp },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await ensureUnlockedBusinessTab(page, password);
    try {
      await navigateToBusinessPage(page, input, { timeoutMs: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await ensureUnlockedBusinessTab(page, password);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("第二 tab 导航失败");
}

/** 在不销毁解锁运行态的前提下切换当前页面 URL，用于测试 URL 冲突校验。 */
async function setTransferUrl(page: import("@playwright/test").Page, search: string): Promise<void> {
  await page.evaluate((nextSearch) => {
    window.history.pushState({}, "", `/transfer${nextSearch}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, search);
  await expect(page).toHaveURL(new RegExp(`/transfer${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "u"));
}

/**
 * 业务目标：真实 testnet 上用通讯录和四种收款方形态连续完成转账，验证余额
 * 广播、UTXO 序号门禁、页面结果和链上输入输出的一致性。
 *
 * 资金策略：seed 只在 Resource 侧读私钥；页面只导入固定 key01 并通过公开
 * seed 公钥创建联系人。任意页面广播开始后，finally 不再自动归集，避免未知
 * 结果时与页面交易形成双花；失败现场由维护者按提示手工处理。
 */
test(JOURNEY_ID + "：通讯录收款方与真实 testnet 多笔转账", async ({ page, context }, testInfo) => {
  test.setTimeout(1_800_000);
  const password = "real-testnet-contact-transfer-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2EConfig | undefined;
  let funding: TestnetFundingResource | undefined;
  let chain: WocTestnetChainAdapter | undefined;
  let wallet: OneTimeWallet | undefined;
  let pageTwo: import("@playwright/test").Page | undefined;
  let seedAddress = "";
  let fundingTxid = "";
  let appReturnSubmitted = false;
  let fundsReturned = false;
  let journeyError: unknown;
  let recoveryError: unknown;
  let evidenceError: unknown;
  const timing: Record<string, unknown> = { journey: JOURNEY_ID };

  try {
    logJourneyProgress("Journey 开始");
    const state = await readResourceRunState();
    expect(state, "真实资源 setup 必须先产生运行状态").not.toBeNull();
    if (!state) throw new Error("真实资源运行状态不可用");
    expect(state.testnet.seedPublicKeyHex, "资源状态必须投影 seed 压缩公钥而不是私钥").toMatch(/^0[23][0-9a-f]{64}$/iu);

    config = await loadE2EConfig();
    expect(publicConfigFingerprint(config), "Journey 与 setup 使用的公开资源配置必须一致").toBe(state.configFingerprint);
    seedAddress = state.testnet.seedAddress;
    const activeChain = createWocTestnetChainAdapter({
      baseUrl: config.satsubscription.testnetApiBaseUrl,
      ...(config.satsubscription.testnetApiAuthorization === undefined ? {} : { authorization: config.satsubscription.testnetApiAuthorization.read() }),
    });
    const activeFunding = new TestnetFundingResource(config.testnet.privateKeyHex, activeChain);
    chain = activeChain;
    funding = activeFunding;
    wallet = activeFunding.createImportedWallet(state.runId, JOURNEY_ID, config.testnet.trackingKeyPrivateKeyHex.read());

    await test.step("Phase 0：key01 零余额门禁并通过正式导入页建立身份", async () => {
      const existing = await activeChain.inspectAddress(wallet!.address);
      expect(existing.mainnetBalance, "key01 派生地址不得在 mainnet 有余额").toBe(0);
      expect(
        existing.spendableUtxoCount,
        `key01 地址 ${wallet!.address} 仍有可花费输出；请先运行 pnpm collect:testnet:key01，Journey 拒绝自动清理`,
      ).toBe(0);
      const ready = await initializeLocalUserWithImportedHexKey(page, {
        bucketLabel: "真实 testnet 通讯录转账测试桶",
        keyLabel: "真实 testnet 通讯录转账 Key",
        password,
        privateKeyHex: wallet!.privateKey.read(),
      });
      expect(ready.publicKeyHex, "页面 active Key 必须等于固定 key01 公钥").toBe(wallet!.publicKeyHex);
    });

    await test.step("Phase 0：seed 打入 200 sat 并等待 funding txid 可观察", async () => {
      const startedAt = Date.now();
      const funded = await activeFunding.fund(wallet!, FUNDING_SATOSHIS, {
        maxFundingSatoshis: FUNDING_SATOSHIS,
        maxLossSatoshis: MAX_LOSS_SATOSHIS,
        feeReserveSatoshis: 1_000,
      });
      fundingTxid = funded.txid;
      expect(fundingTxid, "充值必须返回 canonical funding txid").toMatch(/^[0-9a-f]{64}$/iu);
      const observed = await activeChain.waitForTransaction(fundingTxid, { timeoutMs: 180_000, pollMs: 10_000 });
      expect(observed).toMatch(/^(confirmed|unconfirmed)$/u);
      timing.fundingObservationMs = Date.now() - startedAt;
    });

    await test.step("Phase 1：开启 testnet、降低费率、等待页面 UTXO 快照并创建 seedkey 联系人", async () => {
      await enableTestnetAssets(page);
      await setP2pkhFeeRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);
      // 当前生产 service 对固定金额不足会尝试 sendAll 兜底。T4.5 临时
      // 使用一个合法但极高的费率，使固定金额和该兜底都无法构造交易；
      // 后续 T1–T5 仍使用中档 1 sats/kB，产品代码无需为测试改行为。
      await setP2pkhFeeRate(page, "high", INSUFFICIENT_BALANCE_FEE_RATE_SATOSHIS_PER_KB);
      await waitForP2pkhSyncIdle(page);
      await waitForTestnetUtxoSnapshot(page, 1);
      await expectTestnetWalletBalance(page, FUNDING_SATOSHIS);
      await createContact(page, { publicKeyHex: state!.testnet.seedPublicKeyHex, name: "seedkey" });
    });

    await test.step("R1：进入收款方页，先只显示收款方步骤", async () => {
      await openTransferPage(page);
      await expect(page.getByRole("tab", { name: /从通讯录选择|Contacts|联系人/iu }).first()).toBeVisible();
      await expect(page.getByRole("tab", { name: /手工输入|Manual/u }).first()).toBeVisible();
    });

    await test.step("R2：通讯录 seedkey 派生 testnet 地址并挂载 Widget", async () => {
      await selectRecipientTab(page, "contacts");
      await pickContact(page, "seedkey");
      await chooseRecipientNetwork(page, "test");
      const expected = deriveTestnetP2pkhAddress(state!.testnet.seedPublicKeyHex);
      expect(expected).toBe(seedAddress);
      await expectRecipientAddress(page, expected);
      await expectSourceBadge(page, "联系人公钥派生");
    });

    await test.step("R3：手工公钥在 mainnet/testnet 间切换，地址重派生", async () => {
      await changeRecipient(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, state!.testnet.seedPublicKeyHex);
      await chooseRecipientNetwork(page, "main");
      await expectRecipientAddress(page, deriveMainnetP2pkhAddress(state!.testnet.seedPublicKeyHex));
      await expectSourceBadge(page, "手工公钥");
      await chooseRecipientNetwork(page, "test");
      await expectRecipientAddress(page, seedAddress);
      await expect(page.getByText(/地址已更新，请重新核对|Address updated; verify again/u)).toBeVisible();
    });

    await test.step("R4：手工 testnet 地址命中 seedkey，网络选择器锁定", async () => {
      await changeRecipient(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await expectRecipientAddress(page, seedAddress);
      await expectSourceBadge(page, "地址命中联系人");
      await expect(page.getByText("seedkey", { exact: true })).toBeVisible();
      await expectNetworkSelectorLocked(page);
    });

    const strangerAddress = deriveTestnetP2pkhAddress(STRANGER_PUBLIC_KEY_HEX);
    await test.step("R5：陌生 testnet 地址显示手工地址警示并仍可挂载 Widget", async () => {
      await changeRecipient(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, strangerAddress);
      await expectRecipientAddress(page, strangerAddress);
      await expectSourceBadge(page, "手工地址");
      await expect(page.getByText(/陌生地址|Unknown address/u, { exact: true })).toBeVisible();
      await expectNetworkSelectorLocked(page);
    });

    await test.step("R6：关闭 testnet 后地址拒绝且网络选择器消失，再恢复开启", async () => {
      await disableTestnetAssets(page);
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await expectRecipientError(page, /未启用 testnet|testnet.*enabled/u);
      await expectNoNetworkSelector(page);
      await enableTestnetAssets(page);
    });

    await test.step("R7：URL 公钥与不匹配地址必须阻断且不挂载 Widget", async () => {
      const mismatchAddress = strangerAddress;
      await setTransferUrl(page, `?recipientPublicKeyHex=${encodeURIComponent(state!.testnet.seedPublicKeyHex)}&recipientAddress=${encodeURIComponent(mismatchAddress)}`);
      await expectRecipientError(page, /公钥与地址不一致|public key.*address/u);
      await expect(page.getByTestId("p2pkh-transfer-widget")).toHaveCount(0);
      await changeRecipient(page);
    });

    await test.step("R8：P2SH 和坏校验和地址明确拒绝，不落到联系人搜索空态", async () => {
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, P2SH_ADDRESS);
      await expectRecipientError(page, /不是有效的 P2PKH 地址|valid P2PKH/u);
      await expect(page.getByTestId("contact-search-results")).toHaveCount(0);
      await changeRecipient(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, invalidChecksumAddress(seedAddress));
      await expectRecipientError(page, /不是有效的 P2PKH 地址|valid P2PKH/u);
      await expect(page.getByTestId("contact-search-results")).toHaveCount(0);
    });

    await test.step("R9：预览生成后修改金额，旧预览必须消失并重新核对", async () => {
      await changeRecipient(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await setAmountValue(page, "10");
      await page.getByRole("button", { name: /生成最终交易|Generate final transaction/u }).click();
      await expect(page.locator("section.p2pkh-transfer-widget__preview")).toBeVisible({ timeout: 45_000 });
      await setAmountValue(page, "11");
      await expect(page.locator("section.p2pkh-transfer-widget__preview")).toHaveCount(0);
      await expect(page.getByTestId("p2pkh-recipient-address")).toBeVisible();
    });

    await test.step("R10：联系人行“转账”动作跳转并回填 seedkey", async () => {
      await navigateToBusinessPage(page, { label: /^Contacts$|^联系人$/u, path: /\/contacts$/u });
      const row = page.locator("tr").filter({ hasText: "seedkey" }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /Transfer|转账/u }).click();
      await expect(page).toHaveURL(/\/transfer\?recipientPublicKeyHex=/u);
      await expect(page.getByText("seedkey", { exact: true })).toBeVisible();
      await expectSourceBadge(page, "联系人公钥派生");
    });

    // T1 先使用通讯录路径；此时同时覆盖 B1 的余额参考。
    await test.step("T1/B1：通讯录固定转出 50 sat，广播前余额参考精确为 200", async () => {
      await changeRecipient(page);
      await selectRecipientTab(page, "contacts");
      await pickContact(page, "seedkey");
      await chooseRecipientNetwork(page, "test");
      await expectAmountBalanceReference(page, { network: "test", satoshis: FUNDING_SATOSHIS });
      await expectTransferFeeTierRate(page, "medium", FEE_RATE_SATOSHIS_PER_KB);
      await setAmountValue(page, "50");
    });

    await test.step("B3/B4：第二 tab 刷新快照不覆盖 tab1 金额，关闭 testnet 后参考消失", async () => {
      pageTwo = await context.newPage();
      await pageTwo.goto("/", { waitUntil: "domcontentloaded" });
      await ensureUnlockedBusinessTab(pageTwo, password);
      await openTestnetWalletPage(pageTwo);
      await refreshTestnetUtxoSnapshot(pageTwo, 1);
      await expectAmountValue(page, "50");
      await disableTestnetAssets(pageTwo);
      await expect(page.getByRole("combobox", { name: /^网络$|^Network$/u })).toHaveCount(0);
      await expect(page.locator(".p2pkh-transfer-widget__balance-reference")).not.toContainText(/测试网|testnet/u);
      await enableTestnetAssets(pageTwo);
      await ensureUnlockedBusinessTab(pageTwo, password);
      // testnet 重新开启后只重新进入正常收款方流程；不要求组件卸载前的
      // 金额草稿跨设置变化恢复，金额由下一步重新输入。
      await openTransferPage(page);
      await selectRecipientTab(page, "contacts");
      await pickContact(page, "seedkey");
      await chooseRecipientNetwork(page, "test");
      await expectAmountBalanceReference(page, { network: "test", satoshis: FUNDING_SATOSHIS });
    });

    let currentBalance = FUNDING_SATOSHIS;
    let previousOutpointPrefix = `${fundingTxid}:`;
    let totalFees = 0;
    let totalOutputs = 0;

    await test.step("T1：页面进入广播后，Node 核对 fundingTxid 输入和 seed 输出", async () => {
      logJourneyProgress("T1 开始广播");
      const startedAt = Date.now();
      await setAmountValue(page, "50");
      const receipt = await submitAndAwaitResult(page, { onBroadcastAttempt: () => { appReturnSubmitted = true; } });
      logJourneyProgress(`T1 页面返回 txid=${receipt.txid}`);
      expect(receipt.amountSatoshis).toBe(50);
      expect(receipt.noChange).toBe(false);
      previousOutpointPrefix = await reconcilePageBroadcast(chain!, receipt, seedAddress, previousOutpointPrefix);
      currentBalance = receipt.changeSatoshis;
      totalFees += receipt.feeSatoshis;
      totalOutputs += receipt.amountSatoshis;
      expect(receipt.amountSatoshis + receipt.changeSatoshis + receipt.feeSatoshis).toBe(FUNDING_SATOSHIS);
      timing.t1BroadcastMs = Date.now() - startedAt;
      await dismissTestnetTransferResult(page);
      logJourneyProgress(`T1 完成，当前余额=${currentBalance}`);
    });

    await test.step("T2：取得 T1 后的新 seq，再由手工公钥固定转出 30 sat", async () => {
      logJourneyProgress("T2 开始");
      // prepare 不在 service 内轮询 consumed 快照；先通过页面刷新动作取得
      // WoC 观察到找零后的新 seq，再重新进入转账流程。
      await refreshTestnetUtxoSnapshot(page, 1);
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, state!.testnet.seedPublicKeyHex);
      await chooseRecipientNetwork(page, "test");
      await expectSourceBadge(page, "手工公钥");
      await expectRecipientAddress(page, seedAddress);
      await setAmountValue(page, "30");
      const receipt = await submitAndAwaitResult(page, { onBroadcastAttempt: () => { appReturnSubmitted = true; } });
      logJourneyProgress(`T2 页面返回 txid=${receipt.txid}`);
      expect(receipt.amountSatoshis).toBe(30);
      expect(receipt.noChange).toBe(false);
      previousOutpointPrefix = await reconcilePageBroadcast(chain!, receipt, seedAddress, previousOutpointPrefix);
      logJourneyProgress("T2 链上输入输出核对完成");
      expect(receipt.amountSatoshis + receipt.changeSatoshis + receipt.feeSatoshis).toBe(currentBalance);
      currentBalance = receipt.changeSatoshis;
      totalFees += receipt.feeSatoshis;
      totalOutputs += receipt.amountSatoshis;
      await dismissTestnetTransferResult(page);
      await refreshTestnetUtxoSnapshot(page, 1);
      await expectTestnetWalletBalance(page, currentBalance);
      logJourneyProgress(`T2 页面刷新完成，当前余额=${currentBalance}`);
      if (pageTwo) {
        logJourneyProgress("T2 开始跨 tab 资产页核对");
        await navigateUnlockedBusinessTab(pageTwo, password, { label: /^Asset overview$|^Assets$|^资产总览$|^资产$/u, path: /\/assets$/u });
        await expectAssetsTestnetBalance(pageTwo, currentBalance);
        logJourneyProgress("T2 跨 tab 资产页核对完成");
      }
    });

    await test.step("T3：手工地址命中联系人，固定转出 30 sat", async () => {
      logJourneyProgress("T3 开始");
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await expectSourceBadge(page, "地址命中联系人");
      await expectNetworkSelectorLocked(page);
      await expectAmountBalanceReference(page, { network: "test", satoshis: currentBalance });
      await setAmountValue(page, "30");
      const receipt = await submitAndAwaitResult(page, { onBroadcastAttempt: () => { appReturnSubmitted = true; } });
      logJourneyProgress(`T3 页面返回 txid=${receipt.txid}`);
      expect(receipt.amountSatoshis).toBe(30);
      expect(receipt.noChange).toBe(false);
      previousOutpointPrefix = await reconcilePageBroadcast(chain!, receipt, seedAddress, previousOutpointPrefix);
      expect(receipt.amountSatoshis + receipt.changeSatoshis + receipt.feeSatoshis).toBe(currentBalance);
      currentBalance = receipt.changeSatoshis;
      totalFees += receipt.feeSatoshis;
      totalOutputs += receipt.amountSatoshis;
      await dismissTestnetTransferResult(page);
      await refreshTestnetUtxoSnapshot(page, 1);
      await expectTestnetWalletBalance(page, currentBalance);
      logJourneyProgress(`T3 完成，当前余额=${currentBalance}`);
    });

    await test.step("T4：陌生地址只验证 UI，不广播", async () => {
      logJourneyProgress("T4 开始");
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, strangerAddress);
      await expectSourceBadge(page, "手工地址");
      await expectNetworkSelectorLocked(page);
      await expectAmountBalanceReference(page, { network: "test", satoshis: currentBalance });
      await expect(page.getByRole("button", { name: /生成最终交易|Generate final transaction/u })).toBeVisible();
      await expect(page.locator("section.p2pkh-transfer-widget__preview")).toHaveCount(0);
      await expect(page.locator("section.p2pkh-transfer-widget__result")).toHaveCount(0);
      logJourneyProgress("T4 陌生地址 UI 核对完成，未广播、未改变资金账本");
    });

    await test.step("T4.5：超余额金额只被拒绝，不点击广播，随后仍可执行 T5", async () => {
      await openTransferPage(page);
      await selectRecipientTab(page, "manual");
      await enterManualRecipient(page, seedAddress);
      await setAmountValue(page, String(currentBalance + 1_000));
      await page.locator(".p2pkh-transfer-widget__fee-tier").getByRole("button", { name: /^高|^High/u }).click();
      await page.getByRole("button", { name: /生成最终交易|Generate final transaction/u }).click();
      await expect(page.locator(".p2pkh-transfer-widget__error")).toContainText(/余额不足|insufficient|没有可用/u);
      await expect(page.locator("section.p2pkh-transfer-widget__result")).toHaveCount(0);
      await page.locator(".p2pkh-transfer-widget__fee-tier").getByRole("button", { name: /^中|^Medium/u }).click();
    });

    await test.step("T5：命中联系人地址全部发送，最多允许一次 requires-reconfirm", async () => {
      logJourneyProgress("T5 开始");
      await setAmountValue(page, "全部");
      await page.getByRole("button", { name: /生成最终交易|Generate final transaction/u }).click();
      await expect(page.locator("section.p2pkh-transfer-widget__preview")).toBeVisible({ timeout: 45_000 });
      const receipt = await submitAndAwaitResult(page, {
        allowReconfirm: true,
        onBroadcastAttempt: () => { appReturnSubmitted = true; },
      });
      logJourneyProgress(`T5 页面返回 txid=${receipt.txid}`);
      expect(receipt.noChange).toBe(true);
      expect(receipt.amountSatoshis).toBeGreaterThan(0);
      previousOutpointPrefix = await reconcilePageBroadcast(chain!, receipt, seedAddress, previousOutpointPrefix);
      expect(previousOutpointPrefix).toBe("");
      expect(receipt.amountSatoshis + receipt.feeSatoshis).toBe(currentBalance);
      totalFees += receipt.feeSatoshis;
      totalOutputs += receipt.amountSatoshis;
      await dismissTestnetTransferResult(page);
      await refreshTestnetUtxoSnapshot(page, 0);
      await expectTestnetWalletBalance(page, 0);
      const finalObservation = await chain!.inspectAddress(wallet!.address);
      expect(finalObservation.spendableUtxoCount, "四笔页面广播完成后 key01 必须没有可花费输出").toBe(0);
      expect(totalOutputs + totalFees, "所有实际收款输出与矿工费必须闭合 200 sat 资金账本").toBe(FUNDING_SATOSHIS);
      expect(totalFees, "本轮手续费损失不得超过声明上限").toBeLessThanOrEqual(MAX_LOSS_SATOSHIS);
      timing.broadcastCount = 4;
      timing.totalFeeSatoshis = totalFees;
      logJourneyProgress(`T5 完成，四笔广播闭合，手续费=${totalFees}`);
    });

    await attachRedactedText(testInfo, "testnet-contact-transfer-timing", JSON.stringify(timing, null, 2), { contentType: "application/json" });
  } catch (error) {
    journeyError = error;
  } finally {
    // 广播前失败才允许用 Node 归集；一旦页面广播入口已进入，结果未知时必须
    // 保留现场，不能用另一笔 Node 交易竞争同一 UTXO。
    if (funding && chain && wallet && seedAddress && !fundsReturned && !appReturnSubmitted) {
      try {
        const observation = await chain.inspectAddress(wallet.address);
        if (observation.spendableUtxoCount > 0) {
          const returned = await funding.returnRemaining(wallet, seedAddress, { feeRateSatoshisPerKb: FEE_RATE_SATOSHIS_PER_KB });
          fundsReturned = true;
          await chain.waitForTransaction(returned.txid, { timeoutMs: 180_000, pollMs: 2_000 });
        }
      } catch (error) {
        recoveryError = error;
      }
    }
    try {
      const knownSecrets = [password, wallet?.privateKey.read() ?? ""];
      await attachBrowserErrors(testInfo, browserErrors, knownSecrets);
    } catch (error) {
      evidenceError = error;
    }
    if (pageTwo) await pageTwo.close().catch(() => undefined);
    wallet?.clear();
    clearSecrets(config);
  }

  if (journeyError) throw journeyError;
  if (recoveryError) throw recoveryError;
  if (evidenceError) throw evidenceError;
});
