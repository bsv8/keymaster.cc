import { expect, type Page } from "@playwright/test";
import { assertSetupSecretNotPersisted, openApplication, readWalletPublicKey, readWalletSnapshot, waitForUnlockedHome } from "./appDriver.js";

export interface LocalInitializationInput {
  /**
   * 唯一钱包 Key 的用户标签；只用于导入向导的 Label 输入框。
   *
   * 新建路径的生产 UI 只要求密码，标签由应用写入默认标签，所以新建时
   * 这个字段被忽略，调用方应以返回值里的 keyLabel 为准。
   */
  readonly keyLabel: string;
  /** 仅在当前调用栈内使用的测试密码（Key 密码）。 */
  readonly password: string;
}

/**
 * 走过生产页面的完整首次初始化：新建钱包 Key。
 *
 * 首启只有两条路径（新建 / 导入），没有存储类型、桶名称或 Key 列表；
 * 所有控件定位集中在 Driver，Flow 只表达“用户建立身份”的业务过程。
 */
export async function initializeLocalUser(page: Page, input: LocalInitializationInput): Promise<{ publicKeyHex: string; walletGeneration: string; keyLabel: string }> {
  await openApplication(page);
  // 欢迎页的两张卡片把标题 / 说明 / CTA 都放进同一个 <button>，可访问名
  // 因此是整张卡片的拼接文本；用 data-intent 锚定具体入口，不依赖文案。
  await page.locator('button[data-intent="new"]').click();
  await page.getByLabel(/^新密码$|^New password$/u).fill(input.password);
  await page.getByLabel(/^确认密码$|^Confirm password$/u).fill(input.password);
  await page.getByRole("button", { name: /^创建$|^Create$/u }).click();
  await waitForUnlockedHome(page);

  const snapshot = await readWalletSnapshot(page);
  expect(snapshot?.initialized, "初始化必须把钱包 meta.initialized 提交为 true").toBe(true);
  const keyLabel = snapshot?.keyLabel;
  expect(keyLabel, "key.json 必须保存唯一 Key 的标签").toBeTruthy();
  const walletGeneration = snapshot?.walletGeneration;
  if (!walletGeneration) throw new Error("初始化后缺少钱包世代");
  await assertSetupSecretNotPersisted(page, input.password);

  // 完整公钥从 key.json 真值读取（Key 管理页已删除，不再抓 UI）。
  const publicKeyHex = await readWalletPublicKey(page);
  return { publicKeyHex, walletGeneration, keyLabel: keyLabel ?? "" };
}

/**
 * 真实资金 Journey 专用的首启导入过程。
 *
 * 只接受 Resource 刚生成的一次性 testnet Key；长期 seed 不得传入这个
 * Driver。浏览器需要看到私钥文本是因为正式产品支持导入，但测试结束
 * 后由调用方清除一次性 Key，且真实资源执行档不保留 trace/video。
 */
export async function initializeLocalUserWithImportedHexKey(
  page: Page,
  input: LocalInitializationInput & { readonly privateKeyHex: string },
): Promise<{ publicKeyHex: string }> {
  await openApplication(page);
  await page.locator('button[data-intent="import"]').click();
  // PageHeader 渲染 <h1>，所以第 1 步标题是 heading 而不是 dialog。
  await expect(page.getByRole("heading", { name: /导入私钥|Import a key/iu })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /Hex/ }).click();
  await page.getByRole("button", { name: /下一步|^Next$/u }).click();
  const privateKeyField = page.getByLabel(/Text|文本/);
  await privateKeyField.fill(input.privateKeyHex);
  await page.getByRole("button", { name: /Parse|解析/ }).click();
  await page.getByLabel(/Label|标签/).fill(input.keyLabel);
  // 首启导入是自持模式（LockedShell 不传 draftMode），确认步骤的提交按钮
  // 仍是"下一步"，密码在第 4 步收集。
  await page.getByRole("button", { name: /下一步|^Next$/u }).click();
  await page.getByLabel(/^新密码$|^New password$/u).fill(input.password);
  await page.getByLabel(/^确认密码$|^Confirm password$/u).fill(input.password);
  await page.getByRole("button", { name: /创建并导入|导入并创建|Create wallet and import/iu }).click();
  await waitForUnlockedHome(page);

  const snapshot = await readWalletSnapshot(page);
  expect(snapshot?.initialized, "导入一次性 Key 同样只产生一把钱包 Key").toBe(true);
  await assertSetupSecretNotPersisted(page, input.password);
  await assertSetupSecretNotPersisted(page, input.privateKeyHex);

  const publicKeyHex = await readWalletPublicKey(page);
  return { publicKeyHex };
}
