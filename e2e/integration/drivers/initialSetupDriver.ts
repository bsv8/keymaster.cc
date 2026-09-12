import { expect, type Page } from "@playwright/test";
import { assertSetupSecretNotPersisted, openApplication, readLocalCatalog, waitForReadyVaultPage } from "./appDriver.js";

export interface LocalInitializationInput {
  /** 用户看到的逻辑桶名称。 */
  readonly bucketLabel: string;
  /** 第一把 Key 的用户标签。 */
  readonly keyLabel: string;
  /** 仅在当前调用栈内使用的测试密码。 */
  readonly password: string;
}

/**
 * 真实 S3 首次初始化的页面输入。
 *
 * `bucket` 是已经存在的物理 S3 桶；页面真正创建的是该物理桶下面的
 * Keymaster 逻辑桶和 Hold 快照。凭据只在本次 Driver 调用期间填入页面，
 * 不应被写进 Journey 状态、附件或长期测试上下文。
 */
export interface S3InitializationInput {
  /** 用户在 Keymaster 目录中看到的逻辑桶名称。 */
  readonly bucketLabel: string;
  /** 第一把 Key 的用户标签。 */
  readonly keyLabel: string;
  /** 只用于本次逻辑桶加密和初始化提交的桶密码。 */
  readonly password: string;
  /** S3-compatible 服务的 HTTPS 地址，不含凭据。 */
  readonly endpoint: string;
  /** S3 签名区域。 */
  readonly region: string;
  /** 已存在的物理 S3 桶名称，不是逻辑桶名称。 */
  readonly bucket: string;
  /** S3 访问身份，不是 Keymaster 用户身份。 */
  readonly accessKeyId: string;
  /** S3 访问密钥，只在当前页面调用中短暂使用。 */
  readonly secretAccessKey: string;
  /** 可选临时会话令牌。 */
  readonly sessionToken?: string;
  /** 本轮 Journey 独占的对象路径前缀。 */
  readonly prefix: string;
}

/**
 * 走过生产页面的完整 Local 首次初始化。
 *
 * 所有控件定位集中在 Driver；Flow 只表达“用户建立身份”的业务过程。
 */
export async function initializeLocalUser(page: Page, input: LocalInitializationInput): Promise<{ publicKeyHex: string }> {
  await openApplication(page);
  await page.getByRole("button", { name: /Local/ }).click();
  await page.getByLabel(/Bucket name|桶名称/).fill(input.bucketLabel);
  await page.getByRole("button", { name: /Next|Continue|继续/ }).click();

  await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/).fill(input.password);
  await page.getByLabel(/Confirm password|确认密码/).fill(input.password);
  await page.getByRole("button", { name: /Next|Continue|继续/ }).click();
  await expect(page.getByRole("heading", { name: /Set up your first Key|设置第一把 Key/ })).toBeVisible();

  await page.getByRole("button", { name: /Create a Key|新建 Key/ }).click();
  await page.getByLabel(/Tag Name|Key 标签名称/).fill(input.keyLabel);
  await page.getByRole("button", { name: /Next|继续确认/ }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ }).click();
  await waitForReadyVaultPage(page, input.keyLabel);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "Local 初始化必须发布一个目录桶").toHaveLength(1);
  expect(catalog?.buckets?.[0]).toMatchObject({ label: input.bucketLabel, backend: "local" });
  expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);
  await assertSetupSecretNotPersisted(page, input.password);

  // Key 管理页默认只显示短公钥；先通过用户可理解的“展开公钥”动作，
  // 再从同一条 Key 记录读取完整身份。不能依赖不存在或会随布局变化的 CSS class。
  const keyRow = page.getByRole("row").filter({ hasText: input.keyLabel }).first();
  await keyRow.getByRole("button", { name: /Expand public key|展开公钥/ }).click();
  const publicKeyHex = (await keyRow.locator("code").first().textContent())?.trim() ?? "";
  // 完整公钥是后续联系人/协议归属的技术真值；短标签或 URL 不能替代它。
  expect(publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/iu);
  return { publicKeyHex };
}

/**
 * 真实 S3 首次初始化：连接测试、创建逻辑桶、提交首个 Hold 和第一把 Key。
 *
 * 这里使用普通 S3-compatible 表单，是因为 Resource 配置已经给出最终
 * endpoint/region；AWS S3 和 R2 只是同一个正式 S3 Provider 的页面模板，
 * 不应在测试中复制三套初始化编排。
 */
export async function initializeS3User(page: Page, input: S3InitializationInput): Promise<{ publicKeyHex: string }> {
  await openApplication(page);
  await page.getByRole("button", { name: /^S3\b/u }).click();
  await page.getByLabel(/Bucket name \(local display name\)|桶名称（本机显示名称）/iu).fill(input.bucketLabel);
  await page.getByLabel(/Configuration mode|S3 connection template|配置方式/iu).selectOption("s3-compatible");
  await page.getByLabel(/Endpoint.*HTTPS|Endpoint.*service URL|Endpoint.*服务地址/iu).fill(input.endpoint);
  await page.getByLabel(/Region.*signing|Region.*签名区域/iu).fill(input.region);
  await page.getByLabel(/Bucket.*physical|Bucket.*物理桶名称/iu).fill(input.bucket);
  await page.getByLabel(/Access Key ID/iu).fill(input.accessKeyId);
  await page.getByLabel(/Secret Access Key/iu).fill(input.secretAccessKey);
  if (input.sessionToken !== undefined) await page.getByLabel(/Session Token/iu).fill(input.sessionToken);
  await page.getByLabel(/Prefix/iu).fill(input.prefix);
  await page.getByRole("button", { name: /Test connection and continue|测试连接并继续/iu }).click();

  const passwordHeading = page.getByRole("heading", { name: /Set (?:a )?password|设置密码/iu });
  try {
    await expect(passwordHeading).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const alerts = await page.locator('[role="alert"]').allTextContents();
    const diagnostic = alerts.map((text) => text.trim()).filter(Boolean).join(" | ");
    throw new Error(`真实 S3 连接探测未进入密码步骤${diagnostic ? `：${diagnostic}` : ""}`, { cause: error });
  }
  await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/u).fill(input.password);
  await page.getByLabel(/Confirm password|确认密码/iu).fill(input.password);
  await page.getByRole("button", { name: /Next|Continue|继续/iu }).click();
  await expect(page.getByRole("heading", { name: /Set up your first Key|设置第一把 Key/iu })).toBeVisible();

  await page.getByRole("button", { name: /Create a Key|新建 Key/iu }).click();
  await page.getByLabel(/Tag Name|Key 标签名称/iu).fill(input.keyLabel);
  await page.getByRole("button", { name: /Next|继续确认/iu }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/iu }).click();
  await waitForReadyVaultPage(page, input.keyLabel);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "S3 初始化必须发布一个目录桶").toHaveLength(1);
  expect(catalog?.buckets?.[0], "目录中的后端必须是真实 S3，而不是 Local fallback").toMatchObject({
    label: input.bucketLabel,
    backend: "s3",
  });
  expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);

  // 密码、访问身份、访问密钥和临时令牌都不应以明文进入浏览器目录。
  for (const secret of [input.password, input.accessKeyId, input.secretAccessKey, input.sessionToken ?? ""]) {
    await assertSetupSecretNotPersisted(page, secret);
  }

  const keyRow = page.getByRole("row").filter({ hasText: input.keyLabel }).first();
  await keyRow.getByRole("button", { name: /Expand public key|展开公钥/iu }).click();
  const publicKeyHex = (await keyRow.locator("code").first().textContent())?.trim() ?? "";
  expect(publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/iu);
  return { publicKeyHex };
}

/**
 * 真实资金 Journey 专用的首启导入过程。
 *
 * 只接受 Resource 刚生成的一次性 testnet Key；长期 seed 不得传入这个
 * Driver。浏览器需要看到私钥文本是因为正式产品支持导入，但测试结束
 * 后由调用方清除一次性 Key，且 real-resource 项目不保留 trace/video。
 */
export async function initializeLocalUserWithImportedHexKey(
  page: Page,
  input: LocalInitializationInput & { readonly privateKeyHex: string },
): Promise<{ publicKeyHex: string }> {
  await openApplication(page);
  await page.getByRole("button", { name: /Local/ }).click();
  await page.getByLabel(/Bucket name|桶名称/).fill(input.bucketLabel);
  await page.getByRole("button", { name: /Next|Continue|继续/ }).click();

  await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/).fill(input.password);
  await page.getByLabel(/Confirm password|确认密码/).fill(input.password);
  await page.getByRole("button", { name: /Next|Continue|继续/ }).click();
  await expect(page.getByRole("heading", { name: /Set up your first Key|设置第一把 Key/ })).toBeVisible();

  await page.getByRole("button", { name: /Import a Key|导入 Key/ }).click();
  await page.getByRole("button", { name: /Hex/ }).click();
  await page.getByRole("button", { name: /Next|下一步/ }).click();
  const privateKeyField = page.getByLabel(/Text|文本/);
  await privateKeyField.fill(input.privateKeyHex);
  await page.getByRole("button", { name: /Parse|解析/ }).click();
  await page.getByLabel(/Label|标签/).fill(input.keyLabel);
  await page.getByRole("button", { name: /Use this Key|使用这把 Key|Import this Key|导入这把 Key/ }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ }).click();
  await waitForReadyVaultPage(page, input.keyLabel);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "导入一次性 Key 的初始化仍必须发布一个 Local 目录桶").toHaveLength(1);
  expect(catalog?.buckets?.[0]).toMatchObject({ label: input.bucketLabel, backend: "local" });
  await assertSetupSecretNotPersisted(page, input.password);
  const persisted = await page.evaluate(() => Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key) ?? ""}`).join("\n"));
  expect(persisted, "一次性 Key 原文不能落入浏览器 localStorage").not.toContain(input.privateKeyHex);

  const keyRow = page.getByRole("row").filter({ hasText: input.keyLabel }).first();
  await keyRow.getByRole("button", { name: /Expand public key|展开公钥/ }).click();
  const publicKeyHex = (await keyRow.locator("code").first().textContent())?.trim() ?? "";
  expect(publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/iu);
  return { publicKeyHex };
}
