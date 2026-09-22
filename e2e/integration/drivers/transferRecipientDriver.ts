import { expect, type Page } from "@playwright/test";

/** 收款方输入 tab；contacts=通讯录，manual=手工输入。 */
export type RecipientTab = "contacts" | "manual";

/** 切换“从通讯录选择 / 手工输入”标签页。 */
export async function selectRecipientTab(page: Page, tab: RecipientTab): Promise<void> {
  const name = tab === "contacts" ? /从通讯录选择|Contacts|联系人/iu : /手工输入|Manual/iu;
  const button = page.getByRole("tab", { name }).first();
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
}

/** 在正式 ContactPicker 中按联系人名称选择；公钥只由页面返回给转账页。 */
export async function pickContact(page: Page, name: string): Promise<void> {
  const picker = page.getByRole("combobox", { name: /^Contacts$|^联系人$/u }).first();
  await expect(picker).toBeVisible();
  const option = picker.locator("option").filter({ hasText: new RegExp(`^${escapeRegExp(name)}\\s*-`, "u") }).first();
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value, `通讯录联系人 ${name} 必须有 publicKeyHex value`).toMatch(/^0[23][0-9a-f]{64}$/iu);
  await picker.selectOption(value!);
  await expect(page.getByTestId("recipient-source")).toBeVisible({ timeout: 30_000 });
}

/** 填写手工收款值；值可以是压缩公钥或 P2PKH 地址。 */
export async function enterManualRecipient(page: Page, value: string): Promise<void> {
  const field = page.getByLabel(/^收款地址$|^Recipient address$/u).first();
  await expect(field).toBeVisible();
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

/** 为公钥模式选择 mainnet 或 testnet；地址模式的选择器由页面锁定。 */
export async function chooseRecipientNetwork(page: Page, network: "main" | "test"): Promise<void> {
  const selector = page.getByRole("combobox", { name: /^网络$|^Network$/u }).last();
  await expect(selector).toBeVisible();
  await expect(selector).toBeEnabled();
  await selector.selectOption(network);
}

/** 断言页面显示的 canonical 收款地址和 Widget 只读地址一致。 */
export async function expectRecipientAddress(page: Page, address: string): Promise<void> {
  await expect(page.getByTestId("recipient-address").first()).toHaveText(address);
  const widgetAddress = page.getByTestId("p2pkh-recipient-address").locator("code");
  await expect(widgetAddress).toHaveText(address);
}

/** 断言四种固定收款来源徽标之一。 */
export async function expectSourceBadge(page: Page, badge: "联系人公钥派生" | "地址命中联系人" | "手工公钥" | "手工地址"): Promise<void> {
  // 浏览器默认语言可能是英文；同一个业务来源允许中英文文案，但不放宽为任意文本。
  const englishBadge: Record<typeof badge, string> = {
    "联系人公钥派生": "Contact public-key derivation",
    "地址命中联系人": "Address matched contact",
    "手工公钥": "Manual public key",
    "手工地址": "Manual address",
  };
  const expected = new RegExp(`^(?:${escapeRegExp(badge)}|${escapeRegExp(englishBadge[badge])})$`, "u");
  await expect(page.getByTestId("recipient-source")).toHaveText(expected);
}

/** 断言显式收款方错误；错误必须来自地址/网络校验而不是联系人搜索空态。 */
export async function expectRecipientError(page: Page, error: RegExp): Promise<void> {
  await expect(page.getByText(error).first()).toBeVisible();
}

/** 地址模式网络必须由解析出的地址锁定，用户不能手工改网。 */
export async function expectNetworkSelectorLocked(page: Page): Promise<void> {
  const selector = page.getByRole("combobox", { name: /^网络$|^Network$/u }).last();
  await expect(selector).toBeVisible();
  await expect(selector).toBeDisabled();
}

/** testnet 关闭时，地址模式不应伪造一个可编辑网络选择器。 */
export async function expectNoNetworkSelector(page: Page): Promise<void> {
  await expect(page.getByRole("combobox", { name: /^网络$|^Network$/u })).toHaveCount(0);
}

/** 清除 URL 收款方，回到两个输入 tab 的空态。 */
export async function changeRecipient(page: Page): Promise<void> {
  const clearButton = page.getByRole("button", { name: /更换收款方|清除收款方|Change recipient|Clear recipient/u }).first();
  if (await clearButton.count() > 0) {
    await clearButton.click();
  } else {
    // 手工输入的 candidate 仍停留在同一表单，正式页面没有额外的清除按钮；
    // 清空可访问输入框就是用户可见的“更换收款方”动作。
    const field = page.getByLabel(/^收款地址$|^Recipient address$/u).first();
    await expect(field).toBeVisible();
    await field.fill("");
  }
  // 等待 URL 状态真正清除；仅等待 tab 出现会与旧的 URL 收款方状态竞态。
  await expect(page).toHaveURL(/\/transfer$/u);
  await expect(page.getByTestId("recipient-source")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /从通讯录选择|Contacts|联系人/iu }).first()).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
