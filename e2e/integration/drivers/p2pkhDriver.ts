import { expect, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

/**
 * 在正式系统设置工作区打开 P2PKH 的 testnet 开关。
 *
 * 这里不直接改 Coordinator K-V，也不访问页面内部 service；真实用户只能
 * 通过 registry 提供的设置控件打开 testnet。选择器只留在 Driver，Journey
 * 只表达“用户允许查看并使用 testnet 资产”。
 */
export async function enableTestnetAssets(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^System$|^系统$/u,
    path: /\/settings\/system$/u,
  });
  const p2pkhSettings = page.locator("#p2pkh");
  await expect(p2pkhSettings).toBeVisible();
  const includeTestnet = p2pkhSettings.getByRole("combobox").first();
  await expect(includeTestnet).toBeVisible();
  await includeTestnet.selectOption("yes");
  await expect.poll(() => includeTestnet.inputValue(), {
    timeout: 20_000,
    message: "用户打开 testnet 后，P2PKH 设置必须立即保存并回显",
  }).toBe("yes");
}

/** 用户从正式业务菜单进入转账页，不选择资产；供需要先核对余额的 Journey 使用。 */
export async function openTransferPage(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Transfer$|^转账$/u,
    path: /\/transfer$/u,
  });
  await expect(page.getByRole("heading", { name: /Asset type|资产类型/ })).toBeVisible();
}

/** 选择 BSV Testnet Offer 并等待转账表单出现。 */
export async function selectTestnetTransferOffer(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /BSV Testnet/ }).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /BSV Testnet/ }).first().click();
  await expect(page.getByRole("heading", { name: /Verify addresses and enter amount|核对地址与填写金额/ })).toBeVisible();
}

/** 用户从正式业务菜单进入转账页，并等待 testnet 资产 Offer 出现。 */
export async function openTestnetTransfer(page: Page): Promise<void> {
  await openTransferPage(page);
  await selectTestnetTransferOffer(page);
}

/** 关闭广播结果卡片，回到资产选择，用于继续观察余额。 */
export async function dismissTestnetTransferResult(page: Page): Promise<void> {
  await page.getByRole("button", { name: /确认并关闭|Confirm and close/u }).click();
  await expect(page.getByRole("heading", { name: /Asset type|资产类型/ })).toBeVisible();
}

export interface TestnetTransferInput {
  /** 接收方的 testnet P2PKH 地址；Journey 在资源层之外生成公开目标。 */
  readonly recipientAddress: string;
  /** 金额，单位 satoshis；必须与资金预算分开声明。 */
  readonly amountSatoshis: number;
}

/** P2PKH 矿工费率档位；与设置页的三个 sats/kB 输入一一对应。 */
export type P2pkhFeeTier = "low" | "medium" | "high";

/** 设置页费率输入的可访问名称。 */
const FEE_TIER_SETTINGS_LABELS: Record<P2pkhFeeTier, RegExp> = {
  low: /低|Low/u,
  medium: /中（默认）|Medium \(default\)/u,
  high: /高|High/u,
};

/** 转账 Widget 费率按钮的可见文案（与设置页标签不同）。 */
const FEE_TIER_WIDGET_LABELS: Record<P2pkhFeeTier, RegExp> = {
  low: /^低|^Low/u,
  medium: /^中|^Medium/u,
  high: /^高|^High/u,
};

/**
 * 在正式系统设置中修改一个矿工费率档位。
 *
 * 10 sat 级别的余额要完成“全部”转出，必须让预览使用最小的合法费率；
 * 这里只通过页面控件修改，不写 Coordinator K-V 或 service 内部状态。
 */
export async function setP2pkhFeeRate(page: Page, tier: P2pkhFeeTier, satsPerKb: number): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^System$|^系统$/u,
    path: /\/settings\/system$/u,
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

/**
 * 在 testnet 钱包页等待 keymaster 完成一次覆盖 testnet 资源的 confirmed-sync。
 *
 * “最近完整同步”只在 worker 真的把该网络资源同步成功后才会有时间；
 * 这是比 Offer 余额更早、更直接的同步完成证据，也能把“同步没跑”与
 * “同步跑了但没看到钱”区分开。
 */
export async function waitForTestnetConfirmedSync(page: Page, timeoutMs = 180_000): Promise<void> {
  await page.getByRole("button", { name: /^On-chain transactions$|^链上交易$/u }).click();
  await page.getByRole("button", { name: /^Testnet$|^测试网$/u }).click();
  const syncLine = page.getByText(/Last complete sync|最近完整同步/u).first();
  await expect(syncLine).toBeVisible();
  await expect.poll(async () => (await syncLine.textContent()) ?? "", {
    timeout: timeoutMs,
    message: "keymaster 必须在开启 testnet 后完成一次覆盖 testnet 的 confirmed-sync",
  }).toMatch(/\d/u);
}

/**
 * 等待转账 Offer 上由 keymaster 余额计算出的 BSV Testnet 金额。
 *
 * Offer 余额来自 P2PKH service 对 confirmed-sync 归属投影的现算结果；
 * 这里断言的是页面真值，不是 Node 侧重新查询的链上余额。
 */
export async function expectTestnetOfferBalance(page: Page, satoshis: number, timeoutMs = 120_000): Promise<void> {
  const offer = page.getByRole("button", { name: /BSV Testnet/ }).first();
  await expect(offer).toBeVisible({ timeout: 45_000 });
  // 余额元素必须精确等于目标值；用整个按钮文本做子串匹配会让 "10 sats"
  // 在断言 0 sats 时误通过。
  const balance = offer.locator(".transfer-picker__balance").first();
  await expect(balance).toBeVisible();
  await expect.poll(async () => (await balance.textContent())?.trim() ?? "", {
    timeout: timeoutMs,
    message: `BSV Testnet Offer 余额必须由 keymaster confirmed-sync 刷新为 ${satoshis} sats`,
  }).toBe(`${satoshis} sats`);
}

/**
 * 断言转账 Widget 的费率档位显示指定费率。
 *
 * 设置页写入 P2PKH service 缓存的费率不会立即反映到已挂载的 Widget；
 * 这个轮询证明“设置真的进入了新建交易预览的取值路径”，而不是只改了输入框。
 */
export async function expectTransferFeeTierRate(page: Page, tier: P2pkhFeeTier, satsPerKb: number): Promise<void> {
  const group = page.locator(".p2pkh-transfer-widget__fee-tier");
  await expect(group).toBeVisible({ timeout: 20_000 });
  const button = group.getByRole("button", { name: FEE_TIER_WIDGET_LABELS[tier] });
  await expect.poll(async () => (await button.textContent()) ?? "", {
    timeout: 20_000,
    message: `转账 Widget 的 ${tier} 档费率必须显示为 ${satsPerKb} sats/kB`,
  }).toContain(`${satsPerKb} sats/kB`);
}

/**
 * 完成一次用户可见的 testnet P2PKH 转账，并只返回页面显示的 canonical txid。
 * rawTxHex 不写入测试结果；它只在正式 Widget 的预览阶段供用户核对。
 */
export async function submitTestnetTransfer(page: Page, input: TestnetTransferInput): Promise<string> {
  const receipt = await prepareAndBroadcast(page, input.recipientAddress, String(input.amountSatoshis));
  expect(receipt.amountSatoshis, "固定金额转账的收款输出必须等于声明金额").toBe(input.amountSatoshis);
  return receipt.txid;
}

export interface TestnetSendAllInput {
  /** 接收方的 testnet P2PKH 地址；通常是 Resource 的 seed 地址。 */
  readonly recipientAddress: string;
}

/** “全部”转出后的页面回执；金额和矿工费来自正式 Widget 的最终预览。 */
export interface TestnetSendAllReceipt {
  readonly txid: string;
  /** 预览中的收款输出金额（= 可用输入 - 实际矿工费）。 */
  readonly amountSatoshis: number;
  readonly feeSatoshis: number;
  readonly serializedSizeBytes: number;
  /** 预览是否明确显示没有找零输出。 */
  readonly noChange: boolean;
}

/**
 * 使用正式 Widget 的“全部”完成 testnet 转出，并返回预览中对账所需的
 * 数值和 canonical txid。
 *
 * 这里只解构页面已展示的预览数字；rawTxHex 和链上金额核对的真值由
 * Journey 的链适配器按原始交易另行验证。
 */
export async function submitTestnetSendAll(page: Page, input: TestnetSendAllInput): Promise<TestnetSendAllReceipt> {
  const receipt = await prepareAndBroadcast(page, input.recipientAddress, "全部");
  expect(receipt.noChange, "“全部”转出必须没有找零输出").toBe(true);
  expect(receipt.amountSatoshis, "“全部”转出的收款输出必须为正").toBeGreaterThan(0);
  expect(receipt.feeSatoshis, "“全部”转出必须按费率扣除矿工费").toBeGreaterThan(0);
  return receipt;
}

async function prepareAndBroadcast(page: Page, recipientAddress: string, amount: string): Promise<TestnetSendAllReceipt> {
  const recipient = page.getByLabel(/Recipient address|接收方地址/);
  await expect(recipient).toBeVisible();
  await recipient.fill(recipientAddress);
  await page.getByLabel(/Amount \(sats\)|金额 \(sats\)/).fill(amount);

  await page.getByRole("button", { name: /Generate final transaction|生成最终交易/ }).click();
  const preview = page.locator("section.p2pkh-transfer-widget__preview").first();
  await expect(preview.getByRole("heading", { name: /Final transaction preview|最终交易预览/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(recipientAddress, { exact: true }).last()).toBeVisible();

  // 预览数字必须在广播前读取：点击广播后 Widget 会用结果卡片替换整个预览区。
  const amountSatoshis = readSats(await preview.locator(".p2pkh-transfer-widget__recipient-output strong").first().textContent());
  const feeSatoshis = readSats(await preview.locator("p").filter({ hasText: /最终矿工费|Final fee/u }).first().textContent());
  const serializedSizeBytes = readSats(await preview.locator("p").filter({ hasText: /序列化大小|Serialized size/u }).first().textContent());
  const changeText = await preview.locator("p").filter({ hasText: /找零输出|Change output/u }).first().textContent() ?? "";

  await page.getByRole("button", { name: /Confirm and broadcast transaction|确认并广播交易/ }).click();
  const resultHeading = page.getByRole("heading", { name: /Broadcast result|广播结果/ });
  await expect(resultHeading).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("local-confirmed", { exact: true })).toBeVisible();
  const resultCard = page.locator("section").filter({ has: resultHeading }).first();
  const txid = (await resultCard.locator("code").first().textContent())?.trim() ?? "";
  // 组件的结果卡片只有一个 txid code；如果 DOM 结构调整，下面的业务
  // 断言仍会把“广播完成但没有可对账身份”判为失败。
  expect(txid, "广播结果必须展示可对账的 canonical txid").toMatch(/^[0-9a-f]{64}$/iu);
  return { txid: txid.toLowerCase(), amountSatoshis, feeSatoshis, serializedSizeBytes, noChange: !/sats/u.test(changeText) };
}

/** 从页面文案里提取整数金额；预览字段可能带千位分隔符。 */
function readSats(text: string | null): number {
  const match = (text ?? "").match(/([0-9][0-9,]*)/u);
  if (!match?.[1]) throw new Error("transfer preview number is not readable");
  return Number(match[1].replaceAll(",", ""));
}

