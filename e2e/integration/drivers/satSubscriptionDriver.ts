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
  await settings.getByLabel(/Supplier id|供应商编号/iu).fill(input.supplierId);
  await settings.getByLabel(/^Display name$|^名称$|^显示名称$/iu).fill(input.name);
  await settings.getByLabel(/Supplier public key|供应商公钥/iu).fill(input.supplierPublicKeyHex);
  await settings.getByLabel(/libp2p addresses|Dialable addresses|libp2p 地址/iu).fill(input.multiaddrs.join("\n"));
  const enabled = settings.getByRole("checkbox", { name: /Enable supplier|Enabled|启用供应商/iu });
  if ((await enabled.isChecked()) !== input.enabled) await enabled.click();
  await settings.getByRole("button", { name: /Save supplier|Add supplier|保存供应商/iu }).click();
  await expect(settings.getByRole("status")).toContainText(/saved|保存/iu);
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
