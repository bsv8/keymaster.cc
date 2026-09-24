import { expect, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

/** P2PKH 页面支持的网络字段；main=主网，test=testnet 测试网。 */
export type P2pkhNetwork = "main" | "test";

/** 在 BSV 链页面切换 testnet 纳入范围；设置值由正式页面保存。 */
export async function setTestnetAssets(page: Page, enabled: boolean): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^BSV Chain$|^BSV 链$/u,
    path: /\/settings\/bsv-chain$/u,
  });
  const p2pkhSettings = page.locator("#p2pkh");
  await expect(p2pkhSettings).toBeVisible();
  const includeTestnet = p2pkhSettings.getByRole("combobox").first();
  await expect(includeTestnet).toBeVisible();
  await includeTestnet.selectOption(enabled ? "yes" : "no");
  await expect.poll(() => includeTestnet.inputValue(), {
    timeout: 20_000,
    message: `P2PKH testnet 开关必须保存为 ${enabled ? "开启" : "关闭"} 并回显`,
  }).toBe(enabled ? "yes" : "no");
}

/** 用户允许在业务页面使用 testnet。 */
export async function enableTestnetAssets(page: Page): Promise<void> {
  await setTestnetAssets(page, true);
}

/** 用户关闭 testnet；用于验证跨 tab 设置传播和边界。 */
export async function disableTestnetAssets(page: Page): Promise<void> {
  await setTestnetAssets(page, false);
}

/** 进入普通转账页；页面第一步必须是收款方。 */
export async function openTransferPage(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Transfer$|^转账$/u,
    path: /\/transfer(?:\?.*)?$/u,
  });
  await expect(page.getByRole("heading", { name: /Recipient|收款方/u })).toBeVisible();
  await expect(page.getByTestId("p2pkh-transfer-widget")).toHaveCount(0);
}

/** 进入 testnet 钱包页；只通过正式菜单和页面按钮导航。 */
export async function openTestnetWalletPage(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^On-chain transactions$|^链上交易$/u,
    path: /\/p2pkh\/mainnet\/transactions(?:\?.*)?$/u,
  });
  const testnetButton = page.getByRole("button", { name: /^Testnet$|^测试网$/u });
  await expect(testnetButton).toBeVisible();
  await testnetButton.click();
  await expect(page).toHaveURL(/\/p2pkh\/testnet\/transactions(?:\?.*)?$/u);
}

/** 关闭成功结果卡，回到“收款方”空态。 */
export async function dismissTestnetTransferResult(page: Page): Promise<void> {
  await page.getByRole("button", { name: /确认并关闭|Confirm and close/u }).click();
  await expect(page).toHaveURL(/\/transfer$/u);
  await expect(page.getByRole("heading", { name: /Recipient|收款方/u })).toBeVisible();
  await expect(page.getByRole("tab", { name: /通讯录|联系人|Contacts/iu }).first()).toBeVisible();
}

/** P2PKH 矿工费率字段；单位是 sats/kB。 */
export type P2pkhFeeTier = "low" | "medium" | "high";

/** 设置页费率输入的中文/英文可访问名称。 */
const FEE_TIER_SETTINGS_LABELS: Record<P2pkhFeeTier, RegExp> = {
  low: /低|Low/u,
  medium: /中（默认）|Medium \(default\)/u,
  high: /高|High/u,
};

/** 转账 Widget 费率按钮的可见文案。 */
const FEE_TIER_WIDGET_LABELS: Record<P2pkhFeeTier, RegExp> = {
  low: /^低|^Low/u,
  medium: /^中|^Medium/u,
  high: /^高|^High/u,
};

/** 通过正式 BSV 链页面修改矿工费率。 */
export async function setP2pkhFeeRate(page: Page, tier: P2pkhFeeTier, satsPerKb: number): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^BSV Chain$|^BSV 链$/u,
    path: /\/settings\/bsv-chain$/u,
  });
  const p2pkhSettings = page.locator("#p2pkh");
  await expect(p2pkhSettings).toBeVisible();
  const input = p2pkhSettings.getByLabel(FEE_TIER_SETTINGS_LABELS[tier]).first();
  await expect(input).toBeVisible();
  await input.fill(String(satsPerKb));
  await input.blur();
  await expect.poll(() => input.inputValue(), {
    timeout: 20_000,
    message: `矿工费率档位 ${tier} 必须保存为 ${satsPerKb} sats/kB 并回显`,
  }).toBe(String(satsPerKb));
}

/** 设置变更触发的同步有已知竞态；此等待仅用于让 owner 同步完成。 */
export async function waitForP2pkhSyncIdle(page: Page, settleMs = 12_000): Promise<void> {
  await page.waitForTimeout(settleMs);
}

/** 等待 testnet 钱包页自己的 UTXO 快照输出数。 */
export async function waitForTestnetUtxoSnapshot(page: Page, minOutputs = 1, timeoutMs = 180_000): Promise<void> {
  await openTestnetWalletPage(page);
  const snapshotLine = page.getByText(/UTXO 快照：|UTXO snapshot:/u);
  await expect.poll(async () => {
    try {
      if (await snapshotLine.count() === 0) return 0;
      const text = (await snapshotLine.first().textContent()) ?? "";
      const match = text.match(/（([0-9,]+)\s*个输出）|\(([0-9,]+)\s*outputs?\)/u);
      const raw = match?.[1] ?? match?.[2];
      return raw ? Number(raw.replaceAll(",", "")) : 0;
    } catch {
      return 0;
    }
  }, {
    timeout: timeoutMs,
    message: `keymaster 必须刷新出至少 ${minOutputs} 个可花费 testnet UTXO 输出`,
  }).toBeGreaterThanOrEqual(minOutputs);
}

/** 在钱包页点击“刷新 UTXO”，并等待页面快照输出数精确变化。 */
export async function refreshTestnetUtxoSnapshot(page: Page, expectedOutputs: number, timeoutMs = 120_000): Promise<void> {
  if (!/\/p2pkh\/testnet\/transactions(?:\?.*)?$/u.test(page.url())) await openTestnetWalletPage(page);
  const refresh = page.getByRole("button", { name: /刷新 UTXO|Refresh UTXOs?/u });
  await expect(refresh).toBeVisible({ timeout: 30_000 });
  const readOutputs = async (): Promise<number> => {
    try {
      const snapshotLine = page.getByText(/UTXO 快照：|UTXO snapshot:/u);
      if (await snapshotLine.count() === 0) return -1;
      const text = (await snapshotLine.first().textContent()) ?? "";
      const match = text.match(/（([0-9,]+)\s*个输出）|\(([0-9,]+)\s*outputs?\)/u);
      const raw = match?.[1] ?? match?.[2];
      return raw ? Number(raw.replaceAll(",", "")) : -1;
    } catch {
      return -1;
    }
  };
  let lastClick = 0;
  await expect.poll(async () => {
    const now = Date.now();
    if (now - lastClick > 10_000) {
      lastClick = now;
      await refresh.click().catch(() => undefined);
    }
    return readOutputs();
  }, {
    timeout: timeoutMs,
    message: `keymaster 快照必须刷新为 ${expectedOutputs} 个 testnet 输出`,
  }).toBe(expectedOutputs);
}

/** 读取钱包页显示的 testnet sats 余额；未知状态直接失败。 */
export async function readTestnetWalletBalance(page: Page): Promise<number> {
  const balance = page.locator(".p2pkh-wallet__balances strong").first();
  await expect(balance).toBeVisible({ timeout: 30_000 });
  const text = (await balance.textContent())?.trim() ?? "";
  if (/未知|unknown/i.test(text)) throw new Error(`testnet 钱包余额仍未知：${text}`);
  return readSats(text, "testnet 钱包余额");
}

/** 断言 testnet 钱包页余额；余额真值来自页面全局广播而不是 Node 查询。 */
export async function expectTestnetWalletBalance(page: Page, satoshis: number, timeoutMs = 120_000): Promise<void> {
  if (!/\/p2pkh\/testnet\/transactions(?:\?.*)?$/u.test(page.url())) await openTestnetWalletPage(page);
  const balance = page.locator(".p2pkh-wallet__balances strong").first();
  const refresh = page.getByRole("button", { name: /刷新 UTXO|Refresh UTXOs?/u });
  await expect(balance).toBeVisible({ timeout: 30_000 });
  let lastRefreshAt = 0;
  await expect.poll(async () => {
    try {
      const value = await readTestnetWalletBalance(page);
      if (value === satoshis) return value;
    } catch {
      // unknown 只表示余额投影还没完成；下面的按钮是只读 WoC 快照刷新，
      // 不会构造交易或触发广播。
    }
    const now = Date.now();
    if (now - lastRefreshAt >= 10_000) {
      lastRefreshAt = now;
      await refresh.click().catch(() => undefined);
    }
    return -1;
  }, {
    timeout: timeoutMs,
    message: `testnet 钱包页面余额必须为 ${satoshis} sats`,
  }).toBe(satoshis);
}

/** 断言转账金额旁余额参考；unknown 只能显示“未知”，不能伪装成 0。 */
export async function expectAmountBalanceReference(
  page: Page,
  input: { readonly network: P2pkhNetwork; readonly satoshis?: number; readonly unknown?: boolean },
  timeoutMs = 20_000,
): Promise<void> {
  const reference = page.locator(".p2pkh-transfer-widget__balance-reference").first();
  await expect(reference).toBeVisible();
  const networkText = input.network === "test" ? /测试网|testnet/iu : /主网|mainnet/iu;
  if (input.unknown) {
    await expect.poll(() => reference.textContent() ?? "", { timeout: timeoutMs }).toMatch(/可用余额未知|available balance unknown/u);
    await expect(reference).not.toContainText(/(?:^|\D)0(?:\D|$)/u);
    await expect(reference).toContainText(networkText);
    return;
  }
  if (input.satoshis === undefined) throw new Error("已知余额参考必须提供 satoshis");
  await expect.poll(() => reference.textContent() ?? "", { timeout: timeoutMs }).toContain(`${input.satoshis} sats`);
  await expect(reference).not.toContainText(/可用余额未知|available balance unknown/u);
  await expect(reference).toContainText(networkText);
}

/** 读取金额输入框；字段含义是转出 sats，不是网络余额。 */
export async function readAmountValue(page: Page): Promise<string> {
  const amount = page.getByLabel(/金额 \(sats\)|Amount \(sats\)/u).first();
  await expect(amount).toBeVisible();
  return amount.inputValue();
}

/** 断言金额输入值不会被跨 tab 的余额刷新覆盖。 */
export async function expectAmountValue(page: Page, value: string): Promise<void> {
  await expect(page.getByLabel(/金额 \(sats\)|Amount \(sats\)/u).first()).toHaveValue(value);
}

/** 写入金额输入；输入变化会按产品语义清除旧预览。 */
export async function setAmountValue(page: Page, value: string): Promise<void> {
  const amount = page.getByLabel(/金额 \(sats\)|Amount \(sats\)/u).first();
  await expect(amount).toBeVisible();
  await amount.fill(value);
}

/** 断言设置变更后当前 Widget 的费率按钮显示真实费率。 */
export async function expectTransferFeeTierRate(page: Page, tier: P2pkhFeeTier, satsPerKb: number): Promise<void> {
  const group = page.locator(".p2pkh-transfer-widget__fee-tier");
  await expect(group).toBeVisible({ timeout: 20_000 });
  const button = group.getByRole("button", { name: FEE_TIER_WIDGET_LABELS[tier] });
  await expect.poll(async () => (await button.textContent()) ?? "", {
    timeout: 20_000,
    message: `转账 Widget 的 ${tier} 档费率必须显示为 ${satsPerKb} sats/kB`,
  }).toContain(`${satsPerKb} sats/kB`);
}

export interface TransferReceipt {
  readonly txid: string;
  /** 预览中收款输出金额；单位 sats。 */
  readonly amountSatoshis: number;
  /** 预览中最终矿工费；单位 sats。 */
  readonly feeSatoshis: number;
  /** 序列化交易字节数；只用于页面预览与链上诊断，不进入附件。 */
  readonly serializedSizeBytes: number;
  /** 是否没有找零输出。 */
  readonly noChange: boolean;
  /** 找零输出金额；没有找零时为 0。 */
  readonly changeSatoshis: number;
}

/** 从当前只读预览读取金额、矿工费、大小和找零，不读取 rawTxHex。 */
async function readPreview(page: Page): Promise<Omit<TransferReceipt, "txid">> {
  const preview = page.locator("section.p2pkh-transfer-widget__preview").first();
  await expect(preview.getByRole("heading", { name: /只读核对|Final transaction preview|最终交易预览/u })).toBeVisible({ timeout: 45_000 });
  const amountSatoshis = readSats(await preview.locator(".p2pkh-transfer-widget__recipient-output strong").first().textContent(), "收款输出");
  const feeSatoshis = readSats(await preview.locator("p").filter({ hasText: /最终矿工费|Final fee/u }).first().textContent(), "最终矿工费");
  const serializedSizeBytes = readSats(await preview.locator("p").filter({ hasText: /序列化大小|Serialized size/u }).first().textContent(), "序列化大小");
  const change = await preview.locator("p").filter({ hasText: /找零输出|Change output/u }).first().textContent() ?? "";
  const noChange = /无|none/i.test(change);
  return {
    amountSatoshis,
    feeSatoshis,
    serializedSizeBytes,
    noChange,
    changeSatoshis: noChange ? 0 : readSats(change, "找零输出"),
  };
}

/** 等待广播结果卡；isolated 是结果未知，必须立即让 Journey 失败。 */
async function waitForBroadcastResult(page: Page): Promise<{ readonly card: ReturnType<Page["locator"]>; readonly text: string }> {
  const card = page.locator("section.p2pkh-transfer-widget__result").first();
  await expect(card.getByRole("heading", { name: /本地确认结果|Broadcast result|广播结果/u })).toBeVisible({ timeout: 120_000 });
  const text = (await card.textContent()) ?? "";
  if (/\bisolated\b|广播结果未知|交易已隔离/u.test(text)) throw new Error(`页面广播结果未知（isolated），必须停止：${text}`);
  return { card, text };
}

/**
 * 提交当前预览并等待结果。sendAll 遇到 requires-reconfirm 时只允许点一次
 * “再来一次”并重新生成预览；固定金额不自动重放。
 */
export async function submitAndAwaitResult(page: Page, options: {
  readonly allowReconfirm?: boolean;
  /** 进入页面广播动作前调用；用于禁止未知结果后的 Node 侧竞争归集。 */
  readonly onBroadcastAttempt?: () => void;
} = {}): Promise<TransferReceipt> {
  const preview = page.locator("section.p2pkh-transfer-widget__preview").first();
  if (await preview.count() === 0) {
    // 固定金额 Journey 可以先填写金额再调用本 helper；这里补齐用户真实的
    // “生成最终交易”动作，保证读取和提交的始终是同一份只读预览。
    await page.getByRole("button", { name: /生成最终交易|Generate final transaction/u }).click();
  }
  let previewValues = await readPreview(page);
  options.onBroadcastAttempt?.();
  await page.getByRole("button", { name: /确认并广播交易|Broadcast transaction/u }).click();
  let result = await waitForBroadcastResult(page);
  const requiresReconfirm = /requires-reconfirm|余额已变化，请重新确认全部发送金额/u.test(result.text);
  if (requiresReconfirm) {
    if (!options.allowReconfirm) throw new Error("页面要求重新确认金额，但当前转账不允许自动重确认");
    await result.card.getByRole("button", { name: /再来一次|Again/u }).click();
    await expect(page.locator("section.p2pkh-transfer-widget__preview")).toHaveCount(0);
    await page.getByRole("button", { name: /生成最终交易|Generate final transaction/u }).click();
    previewValues = await readPreview(page);
    options.onBroadcastAttempt?.();
    await page.getByRole("button", { name: /确认并广播交易|Broadcast transaction/u }).click();
    result = await waitForBroadcastResult(page);
    if (/requires-reconfirm|余额已变化，请重新确认全部发送金额/u.test(result.text)) {
      throw new Error("sendAll 第二次仍要求重新确认；按约定停止，不循环重试");
    }
  }
  if (!/local-confirmed/u.test(result.text)) throw new Error(`页面广播未达到 local-confirmed：${result.text}`);
  const txid = (await result.card.locator("code").first().textContent())?.trim() ?? "";
  expect(txid, "广播结果必须展示可对账的 canonical txid").toMatch(/^[0-9a-f]{64}$/iu);
  return { txid: txid.toLowerCase(), ...previewValues };
}

/** 兼容旧 Journey 的“全部”动作；收款地址必须已经由收款方页面锁定。 */
export async function submitTestnetSendAll(
  page: Page,
  input: {
    readonly recipientAddress: string;
    /** 进入广播动作前调用，避免准备阶段失败时误禁用安全归集。 */
    readonly onBroadcastAttempt?: () => void;
  },
): Promise<TransferReceipt> {
  const readonlyRecipient = page.getByTestId("p2pkh-recipient-address").locator("code");
  await expect(readonlyRecipient).toHaveText(input.recipientAddress);
  await page.getByRole("button", { name: /^全部$|^All$/u }).click();
  return submitAndAwaitResult(page, { allowReconfirm: true, onBroadcastAttempt: input.onBroadcastAttempt });
}

/** 从页面字段文本提取整数 sats；字段标签已经在调用处限定。 */
function readSats(text: string | null, label: string): number {
  // 找零字段还包含找零地址；优先读取紧邻单位的数字，不能误读地址中的
  // Base58 数字。钱包余额和预览金额也统一走这个解析规则。
  const match = (text ?? "").match(/([0-9][0-9,]*)\s*(?:sats|bytes|聪)/iu)
    ?? (text ?? "").match(/([0-9][0-9,]*)/u);
  if (!match?.[1]) throw new Error(`${label}不可解析：${text ?? ""}`);
  return Number(match[1].replaceAll(",", ""));
}
