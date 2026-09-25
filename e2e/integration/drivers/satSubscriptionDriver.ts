import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 页面 SatSubscription 供应商表单字段：编号、显示名称、身份公钥和 libp2p 地址。
 * 这些字段对应业务配置含义，不把 websocket multiaddr 当成 wss:// URL。
 */
export interface SatSupplierFormInput {
  /** 本地稳定引用供应商的 ASCII 编号。 */
  readonly supplierId: string;
  /** 只用于页面展示的供应商名称。 */
  readonly name: string;
  /** 用于 libp2p 身份 pin 的压缩公钥 hex。 */
  readonly supplierPublicKeyHex: string;
  /** 按连接优先级排列的完整 libp2p multiaddr。 */
  readonly multiaddrs: readonly string[];
  /** 是否启用该供应商连接。 */
  readonly enabled: boolean;
}

/** 返回真实页面上的 SatSubscription 设置区域；不访问应用内部 service。 */
function satSettings(page: Page): Locator {
  return page.locator(".sat-subscription-settings");
}

/**
 * 通过真实输入控件填写并保存一份供应商配置。
 *
 * 保存成功只由页面 role=status 反馈确认；连接是否在线由
 * waitForSatSupplierConnectionState 读取页面中供应商行的可见文本确认。
 */
export async function saveSatSupplierFromPage(page: Page, input: SatSupplierFormInput): Promise<void> {
  const settings = satSettings(page);
  await settings.getByRole("button", { name: /^Add supplier$|^新增供应商$/u }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel(/Supplier id|供应商编号/iu).fill(input.supplierId);
  await editor.getByLabel(/^Display name$|^名称$|^显示名称$/iu).fill(input.name);
  await editor.getByLabel(/Supplier public key|供应商公钥/iu).fill(input.supplierPublicKeyHex);
  await editor.getByLabel(/libp2p addresses|Dialable addresses|libp2p 地址/iu).fill(input.multiaddrs.join("\n"));
  const enabled = editor.getByRole("checkbox", { name: /Enable supplier|Enabled|启用供应商/iu });
  if ((await enabled.isChecked()) !== input.enabled) await enabled.click();
  await editor.getByRole("button", { name: /Save supplier|Add supplier|保存供应商/iu }).click();
  await expect(editor).toHaveCount(0, { timeout: 15_000 });
  await expect(settings.getByRole("status")).toContainText(/saved|保存/iu, { timeout: 15_000 });
}

/**
 * 等待真实页面显示供应商的连接结果。
 * online 表示页面实际连接并通过了供应商身份认证；disconnected 或
 * degraded 表示页面可见的真实失败结果，不能由 Node 探针替代。
 */
export async function waitForSatSupplierConnectionState(
  page: Page,
  supplierId: string,
  state: "online" | "disconnected" | "degraded",
): Promise<void> {
  const settings = satSettings(page);
  const row = settings.locator(".sat-subscription-settings__supplier").filter({ hasText: supplierId }).first();
  await expect.poll(
    async () => (await row.innerText()).replace(/\s+/gu, " "),
    { timeout: 45_000, intervals: [250, 500, 1_000], message: "页面未显示供应商 " + supplierId + " 的 " + state + " 连接结果" },
  ).toMatch(new RegExp("(?:连接(?:状态)?|Connection(?: state)?)\\s*[:：]\\s*" + state + "\\b", "iu"));
}

/** 等待页面显示真实连接失败态；允许实现选择 disconnected 或 degraded。 */
export async function waitForSatSupplierConnectionFailure(page: Page, supplierId: string): Promise<void> {
  const settings = satSettings(page);
  const row = settings.locator(".sat-subscription-settings__supplier").filter({ hasText: supplierId }).first();
  await expect.poll(
    async () => (await row.innerText()).replace(/\s+/gu, " "),
    { timeout: 45_000, intervals: [250, 500, 1_000], message: "页面未显示供应商 " + supplierId + " 的真实连接失败结果" },
  ).toMatch(/(?:连接(?:状态)?|Connection(?: state)?)\s*[:：]\s*(?:disconnected|degraded)\b/iu);
}

/** 从页面供应商行读取当前可见连接状态，用于错误/成功结果对比。 */
export async function readSatSupplierRow(page: Page, supplierId: string): Promise<string> {
  const settings = satSettings(page);
  const row = settings.locator(".sat-subscription-settings__supplier").filter({ hasText: supplierId }).first();
  await expect(row).toBeVisible();
  return (await row.innerText()).replace(/\s+/gu, " ");
}

/** 返回指定供应商卡片；优先用 data-supplier-id，兼容旧 hasText 过滤。 */
export function satSupplierRow(page: Page, supplierId: string): Locator {
  const settings = satSettings(page);
  const byId = settings.locator(`[data-supplier-id="${supplierId}"]`);
  return byId.first();
}

/**
 * 等待红绿灯显示指定连接状态。
 * 绿灯=已连接 online，红灯=未连接 disconnected，黄灯=连接中/已降级，灰灯=已停用。
 * 同时校验灯的 data-state 与中文无障碍说明，避免只看文字误判。
 */
export async function waitForSatSupplierConnectionLight(
  page: Page,
  supplierId: string,
  state: "online" | "disconnected" | "degraded" | "connecting" | "disabled",
): Promise<void> {
  const light = page.getByTestId(`ss-connection-light-${supplierId}`);
  await expect(light, `供应商 ${supplierId} 缺少连接红绿灯`).toBeVisible({ timeout: 45_000 });
  await expect.poll(
    async () => await light.getAttribute("data-state"),
    { timeout: 45_000, intervals: [250, 500, 1_000], message: `红绿灯未变为 ${state}` },
  ).toBe(state);
  const label = (await light.getAttribute("aria-label")) ?? "";
  const expectedChinese = state === "online" ? "已连接" : state === "disconnected" ? "未连接" : state === "connecting" ? "连接中" : state === "degraded" ? "已降级" : "已停用";
  expect(label, `红绿灯无障碍说明必须含中文“${expectedChinese}”`).toContain(expectedChinese);
}

/** 读取红绿灯当前状态（data-state），用于断言与诊断。 */
export async function readSatSupplierConnectionLight(page: Page, supplierId: string): Promise<string> {
  const light = page.getByTestId(`ss-connection-light-${supplierId}`);
  await expect(light).toBeVisible();
  return (await light.getAttribute("data-state")) ?? "";
}

/**
 * 点击“刷新 SPI 余额”并确认远端事实已回显。
 * 成功标准：无 role=alert，状态栏提示 SPI 已刷新，且行内出现 BSV 账户余额。
 */
export async function refreshSpiBalanceFromPage(page: Page, supplierId: string): Promise<void> {
  const row = satSupplierRow(page, supplierId);
  await row.getByRole("button", { name: /刷新 SPI 余额|Refresh SPI balance/iu }).click();
  await expect(satSettings(page).getByRole("status")).toContainText(/SPI.*刷新|SPI.*balance|余额/iu, { timeout: 30_000 });
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  await expect(row).toContainText(/BSV\/testnet|BSV\/mainnet/u, { timeout: 30_000 });
}

/**
 * 点击“刷新远端订阅”并确认远端事实已回显。
 * 成功标准：无 alert，状态栏含“已刷新远端订阅”，行内远端观察字段可见。
 */
export async function refreshRemoteSubscriptionsFromPage(page: Page, supplierId: string): Promise<void> {
  const row = satSupplierRow(page, supplierId);
  await row.getByRole("button", { name: /刷新远端订阅|Refresh remote subscriptions/iu }).click();
  await expect(satSettings(page).getByRole("status")).toContainText(/已刷新远端订阅|Remote subscriptions refreshed/iu, { timeout: 30_000 });
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  await expect(row).toContainText(/远端观察|Remote observed/u, { timeout: 30_000 });
}

/**
 * 查询服务器账单首页（可指定每页条数），并确认分页状态与记录渲染。
 * 返回首页记录数，供调用方决定是否继续翻页。
 */
export async function queryServerBillingFirstPage(
  page: Page,
  supplierId: string,
  limit?: number,
): Promise<number> {
  const row = satSupplierRow(page, supplierId);
  if (limit !== undefined) {
    const select = page.getByTestId(`ss-billing-limit-${supplierId}`);
    await select.selectOption(String(limit));
    // 切换每页条数会自动重新查询首页；等待状态栏与记录稳定。
    await expect(page.getByTestId(`ss-billing-status-${supplierId}`)).toContainText(/第 1 页/u, { timeout: 30_000 });
  } else {
    await row.getByRole("button", { name: /查询服务器账单|Query server billing/iu }).click();
    await expect(page.getByTestId(`ss-billing-status-${supplierId}`)).toContainText(/第 1 页|尚未查询/u, { timeout: 30_000 });
    await expect(page.getByTestId(`ss-billing-status-${supplierId}`)).toContainText(/第 1 页/u, { timeout: 30_000 });
  }
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  const records = page.getByTestId(new RegExp(`^ss-billing-record-${supplierId}-`));
  // 账单可能为空（新用户无扣费）：允许 0 条，但面板与状态必须可见。
  await expect(page.getByTestId(`ss-billing-panel-${supplierId}`)).toBeVisible();
  return records.count();
}

/** 点击“下一页”并确认页码+1；无下一页时直接返回 false。 */
export async function billingNextPage(page: Page, supplierId: string): Promise<boolean> {
  const nextButton = satSupplierRow(page, supplierId).getByRole("button", { name: /^下一页$|^Next page$/u });
  if (!(await nextButton.isEnabled())) return false;
  const status = page.getByTestId(`ss-billing-status-${supplierId}`);
  const before = await status.innerText();
  await nextButton.click();
  await expect.poll(async () => status.innerText(), { timeout: 30_000, message: "点击下一页后账单状态未变化" }).not.toBe(before);
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  return true;
}

/** 点击“上一页”并确认页码-1；已是首页时直接返回 false。 */
export async function billingPrevPage(page: Page, supplierId: string): Promise<boolean> {
  const prevButton = satSupplierRow(page, supplierId).getByRole("button", { name: /^上一页$|^Previous page$/u });
  if (!(await prevButton.isEnabled())) return false;
  const status = page.getByTestId(`ss-billing-status-${supplierId}`);
  const before = await status.innerText();
  await prevButton.click();
  await expect.poll(async () => status.innerText(), { timeout: 30_000, message: "点击上一页后账单状态未变化" }).not.toBe(before);
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  return true;
}

/**
 * 读取 SPI 行内余额（余额，单位 sats）与充值地址（充值地址）。
 * 行内结构：`BSV/testnet: <余额>（充值地址 <地址>）`，两个 <code> 按顺序出现。
 */
export async function readSpiBalanceSatoshis(page: Page, supplierId: string): Promise<bigint> {
  const account = page.getByTestId(`ss-spi-account-${supplierId}-BSV-testnet`);
  await expect(account).toBeVisible({ timeout: 30_000 });
  const text = (await account.innerText()).replace(/\s+/gu, " ");
  const match = /BSV\/testnet:\s*([0-9]+)/u.exec(text);
  if (!match?.[1]) throw new Error(`SPI 行未解析到余额：${text.slice(0, 120)}`);
  return BigInt(match[1]);
}

export async function readSpiPaymentAddress(page: Page, supplierId: string): Promise<string> {
  const account = page.getByTestId(`ss-spi-account-${supplierId}-BSV-testnet`);
  await expect(account).toBeVisible({ timeout: 30_000 });
  const codes = account.locator("code");
  const count = await codes.count();
  if (count < 2) throw new Error("SPI 行缺少充值地址");
  return ((await codes.nth(1).textContent()) ?? "").trim();
}

/**
 * 填写充值金额（充值金额，单位 sats，正整数）并生成充值预览。
 * 调用方必须先 `page.on("dialog", accept)`，因为确认广播时会弹 window.confirm。
 */
export async function prepareTopUpFromPage(page: Page, supplierId: string, amountSatoshis: number): Promise<void> {
  const settings = satSettings(page);
  await settings.getByLabel(/充值金额（satoshis，正整数）|topupAmount/iu).fill(String(amountSatoshis));
  const row = satSupplierRow(page, supplierId);
  await row.getByRole("button", { name: /生成充值预览|prepare/iu }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 60_000 });
}

/** 在预览弹窗点确认并广播，返回页面显示的充值 txid（链上交易编号）。 */
export async function submitTopUpFromPage(page: Page): Promise<string> {
  await page.getByRole("button", { name: /确认并广播|confirm/iu }).click();
  const status = satSettings(page).getByRole("status");
  await expect(status).toContainText(/充值结果/u, { timeout: 120_000 });
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  const text = (await status.textContent()) ?? "";
  const match = /txid=([0-9a-f]{64})/iu.exec(text);
  if (!match) throw new Error(`充值结果缺少 txid：${text.slice(0, 160)}`);
  return match[1]!.toLowerCase();
}

/**
 * 填写回收金额（回收金额，单位 sats）并回收到当前 owner 地址。
 * 注意：服务端 Collect 只扣减账本进清算账，不会链上打款；链上找零靠归集回 seed。
 */
export async function collectFromPage(page: Page, supplierId: string, amountSatoshis: number): Promise<string> {
  const settings = satSettings(page);
  await settings.getByLabel(/回收金额（satoshis，正整数）|collectAmount/iu).fill(String(amountSatoshis));
  const row = satSupplierRow(page, supplierId);
  await row.getByRole("button", { name: /回收余额|Collect balance/iu }).click();
  const status = satSettings(page).getByRole("status");
  await expect(status).toContainText(/Collect 结果/u, { timeout: 60_000 });
  await expect(satSettings(page).getByRole("alert")).toHaveCount(0);
  return ((await status.textContent()) ?? "").replace(/\s+/gu, " ");
}

/** 读取账单面板状态文本（第 X 页，本页 N 条，是否还有下一页）。 */
export async function readBillingStatus(page: Page, supplierId: string): Promise<string> {
  const status = page.getByTestId(`ss-billing-status-${supplierId}`);
  await expect(status).toBeVisible();
  return ((await status.innerText()) ?? "").replace(/\s+/gu, " ");
}

/**
 * 在真实设置页把某个供应商设为接收方和默认发布方。
 *
 * 只通过行内按钮完成：接收按钮会在保存后变成“关闭接收”，并以页面行内
 * 期望订阅出现 `bsv8.inbox.` 作为物理对账已开始的可见证据；默认发布没有
 * 单独的回显字段，保存成功由后续真实 Publish 结果负责证明。
 */
export async function enableSatSupplierReceiveAndDefault(page: Page, supplierId: string): Promise<void> {
  const settings = satSettings(page);
  const row = settings.locator(".sat-subscription-settings__supplier").filter({ hasText: supplierId }).first();
  await row.getByRole("button", { name: /启用接收|Enable receive/iu }).click();
  await expect(row.getByRole("button", { name: /关闭接收|Disable receive/iu })).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(/bsv8\.inbox\./u, { timeout: 20_000 });
  await row.getByRole("button", { name: /设为(新消息)?默认发布|Use for new Publish/iu }).click();
  await expect(settings.getByRole("alert")).toHaveCount(0);
}
