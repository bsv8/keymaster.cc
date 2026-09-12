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

/** 用户从正式业务菜单进入转账页，并等待 testnet 资产 Offer 出现。 */
export async function openTestnetTransfer(page: Page): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Transfer$|^转账$/u,
    path: /\/transfer$/u,
  });
  await expect(page.getByRole("heading", { name: /Asset type|资产类型/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /BSV Testnet/ }).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /BSV Testnet/ }).first().click();
  await expect(page.getByRole("heading", { name: /Verify addresses and enter amount|核对地址与填写金额/ })).toBeVisible();
}

export interface TestnetTransferInput {
  /** 接收方的 testnet P2PKH 地址；Journey 在资源层之外生成公开目标。 */
  readonly recipientAddress: string;
  /** 金额，单位 satoshis；必须与资金预算分开声明。 */
  readonly amountSatoshis: number;
}

/**
 * 完成一次用户可见的 testnet P2PKH 转账，并只返回页面显示的 canonical txid。
 * rawTxHex 不写入测试结果；它只在正式 Widget 的预览阶段供用户核对。
 */
export async function submitTestnetTransfer(page: Page, input: TestnetTransferInput): Promise<string> {
  const recipient = page.getByLabel(/Recipient address|接收方地址/);
  await expect(recipient).toBeVisible();
  await recipient.fill(input.recipientAddress);
  await page.getByLabel(/Amount \(sats\)|金额 \(sats\)/).fill(String(input.amountSatoshis));

  await page.getByRole("button", { name: /Generate final transaction|生成最终交易/ }).click();
  const previewHeading = page.getByRole("heading", { name: /Final transaction preview|最终交易预览/ });
  await expect(previewHeading).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(input.recipientAddress, { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: /Confirm and broadcast transaction|确认并广播交易/ }).click();
  const resultHeading = page.getByRole("heading", { name: /Broadcast result|广播结果/ });
  await expect(resultHeading).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("local-confirmed", { exact: true })).toBeVisible();
  const resultCard = page.locator("section").filter({ has: resultHeading }).first();
  const txid = (await resultCard.locator("code").first().textContent())?.trim() ?? "";
  // 组件的结果卡片只有一个 txid code；如果 DOM 结构调整，下面的业务
  // 断言仍会把“广播完成但没有可对账身份”判为失败。
  expect(txid, "广播结果必须展示可对账的 canonical txid").toMatch(/^[0-9a-f]{64}$/iu);
  return txid.toLowerCase();
}
