import { expect, type Page } from "@playwright/test";
import { waitForUnlockedHome } from "./appDriver.js";

/**
 * 桶管理页（/storage/buckets）的页面操作：
 *   - 当前桶新建 Key（走正式 Vault 加密落库，新建后自动 active）；
 *   - 通过页内 Modal 向导新建真实 S3 桶与首把 Key（与初始化共用同一
 *     业务状态机，但入口在这里）。
 *
 * 非当前桶不提供 Key 操作；调用方必须先确保目标桶是当前桶。
 */

/**
 * 在当前桶新建一把 Key。
 *
 * 新 Key 会成为 active 身份，页面与顶栏切换一致进入首页（身份切换会重建
 * 已解锁壳层内容，弹窗状态无法保留）。调用方以首页“我的信息”为准。
 */
export async function createKeyInCurrentBucket(
  page: Page,
  input: { readonly label: string; readonly password: string },
): Promise<void> {
  await page.getByRole("button", { name: /^新建 Key$|^New Key$/u }).click();
  const modal = page.getByTestId("bucket-create-key");
  await expect(modal).toBeVisible();
  await modal.getByLabel(/Key 标签|Key label/iu).fill(input.label);
  await modal.getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u).fill(input.password);
  await modal.getByLabel(/再输入一次 Key 密码|Enter the Key password again/iu).fill(input.password);
  await modal.getByRole("button", { name: /^创建 Key$|^Create Key$/u }).click();
  await waitForUnlockedHome(page, 60_000);
}

/**
 * 在桶管理页某个桶行的 Key 列表里删除一把 Key（输入标签确认）。
 * 列表会重新加载；调用方负责断言删除后的可见结果。
 */
export async function deleteKeyFromBucketList(
  page: Page,
  input: { readonly bucketId: string; readonly publicKeyHex: string; readonly keyLabel: string },
): Promise<void> {
  const list = page.getByTestId(`bucket-key-list-${input.bucketId}`);
  await expect(list).toBeVisible();
  await list.getByTestId(`bucket-key-delete-${input.publicKeyHex}`).click();
  await page.getByLabel(/请输入目标标签以确认|Type the target label to confirm/iu).fill(input.keyLabel);
  await page.getByRole("button", { name: /^确认删除$|^Confirm delete$/u }).click();
  await expect(page.getByLabel(/请输入目标标签以确认|Type the target label to confirm/iu)).toBeHidden({ timeout: 60_000 });
}

export interface ManagerS3BucketInput {
  readonly bucketLabel: string;
  readonly keyLabel: string;
  readonly keyPassword: string;
  readonly startupPassword: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly prefix: string;
}

/**
 * 通过桶管理页的 Modal 向导创建真实 S3 桶 + 首把 Key。
 *
 * 已初始化状态下的 initialSetup 由 Coordinator 先写新桶数据、再锁定并
 * 替换旧运行态；成功后页面进入新桶首页。
 */
export async function createS3BucketViaManager(page: Page, input: ManagerS3BucketInput): Promise<void> {
  await page.getByTestId("bucket-setup-toggle").click();
  const modal = page.getByTestId("bucket-setup-modal");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: /S3-compatible/u }).click();
  await modal.getByLabel(/桶名称（本机显示名称）|Bucket name \(local display name\)/iu).fill(input.bucketLabel);
  await modal.getByLabel(/配置方式|Configuration mode/iu).selectOption("s3-compatible");
  await modal.getByLabel(/Endpoint.*HTTPS|Endpoint.*service URL|Endpoint.*服务地址/iu).fill(input.endpoint);
  await modal.getByLabel(/Region.*signing|Region.*签名区域/iu).fill(input.region);
  await modal.getByLabel(/Bucket.*physical|Bucket.*物理桶名称/iu).fill(input.bucket);
  await modal.getByLabel(/Access Key ID/iu).fill(input.accessKeyId);
  await modal.getByLabel(/Secret Access Key/iu).fill(input.secretAccessKey);
  if (input.sessionToken !== undefined) await modal.getByLabel(/Session Token/iu).fill(input.sessionToken);
  await modal.getByLabel(/Prefix/iu).fill(input.prefix);
  await modal.getByRole("button", { name: /测试连接并探测|Test connection and continue/iu }).click();

  // 空桶 → 先设置启动密码（只保护本机保存的连接参数）。
  const startupHeading = modal.getByRole("heading", { name: /设置启动密码|Set (?:the )?startup password/iu });
  try {
    await expect(startupHeading).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    const alerts = await modal.locator('[role="alert"]').allTextContents();
    const diagnostic = alerts.map((text) => text.trim()).filter(Boolean).join(" | ");
    throw new Error(`桶管理页 S3 探测未进入启动密码步骤${diagnostic ? `：${diagnostic}` : ""}`, { cause: error });
  }
  await modal.getByLabel(/启动密码（至少 8 位）|Startup password \(at least 8 characters\)/u).fill(input.startupPassword);
  await modal.getByLabel(/再输入一次启动密码|Repeat the startup password/iu).fill(input.startupPassword);
  await modal.getByRole("button", { name: /^继续$|^Next$|^Continue$/u }).click();

  await expect(modal.getByRole("heading", { name: /设置第一把 Key|Set up your first Key/iu })).toBeVisible();
  await modal.getByRole("button", { name: /Create a Key|新建 Key/iu }).click();
  await modal.getByLabel(/Tag Name|Key 标签名称/iu).fill(input.keyLabel);
  await modal.getByRole("button", { name: /^继续$|^Next$|^Continue$/u }).click();
  await modal.getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u).fill(input.keyPassword);
  await modal.getByLabel(/再输入一次 Key 密码|Repeat the Key password/iu).fill(input.keyPassword);
  await modal.getByRole("button", { name: /继续确认|Continue to confirm/iu }).click();
  await modal.getByRole("button", { name: /创建桶和第一把 Key|Create bucket and first Key/iu }).click();

  // 已初始化模式下 Coordinator 会先锁定旧桶再安装新桶；真实 S3 还需要
  // 写入设备记录与 KeyHold，给足与初始化事务一致的窗口。
  await waitForUnlockedHome(page, 120_000);
}
