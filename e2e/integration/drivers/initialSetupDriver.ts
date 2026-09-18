import { expect, type Page } from "@playwright/test";
import { assertSetupSecretNotPersisted, openApplication, readLocalCatalog, readSessionPublicKey, waitForUnlockedHome } from "./appDriver.js";

export interface LocalInitializationInput {
  /** 用户看到的逻辑桶名称（显示名,可改）。 */
  readonly bucketLabel: string;
  /** 第一把 Key 的用户标签。 */
  readonly keyLabel: string;
  /** 仅在当前调用栈内使用的测试密码（Key 自己的密码）。 */
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
  /** 第一把 Key 自己的密码（保护 KeyHold 文档）。 */
  readonly password: string;
  /** 可选独立启动密码；缺省与 Key 密码相同（规范允许相同,但两域互不关联）。 */
  readonly startupPassword?: string;
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
export async function initializeLocalUser(page: Page, input: LocalInitializationInput): Promise<{ publicKeyHex: string; bucketId: string }> {
  await openApplication(page);
  await page.getByRole("button", { name: /Local/ }).click();
  await page.getByLabel(/桶名称|Bucket name/).fill(input.bucketLabel);
  // Local 桶 ID 由系统随机生成,页面不提供 ID 输入。
  await page.getByRole("button", { name: /开始创建|Start creating/ }).click();

  await expect(page.getByRole("heading", { name: /设置第一把 Key|Set up your first Key/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /Create a Key|新建 Key/ }).click();
  await page.getByLabel(/Tag Name|Key 标签名称/).fill(input.keyLabel);
  await page.getByRole("button", { name: /^继续$|^Next$|^Continue$/u }).click();
  await page.getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u).fill(input.password);
  await page.getByLabel(/再输入一次 Key 密码|Repeat the Key password/iu).fill(input.password);
  await page.getByRole("button", { name: /继续确认|Continue to confirm/iu }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ }).click();
  await waitForUnlockedHome(page);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "Local 初始化必须登记一个设备桶记录").toHaveLength(1);
  expect(catalog?.buckets?.[0]).toMatchObject({ label: input.bucketLabel, backend: "local" });
  expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);
  const bucketId = catalog?.buckets?.[0]?.bucketId;
  if (!bucketId) throw new Error("初始化后缺少本机桶 ID");
  await assertSetupSecretNotPersisted(page, input.password);

  // 完整公钥从 session 真值读取（Key 管理页已删除，不再抓 UI）。
  const publicKeyHex = await readSessionPublicKey(page);
  return { publicKeyHex, bucketId };
}

/**
 * 真实 S3 首次初始化：连接测试、创建逻辑桶、提交首个 Hold 和第一把 Key。
 *
 * 这里使用普通 S3-compatible 表单，是因为 Resource 配置已经给出最终
 * endpoint/region；AWS S3 和 R2 只是同一个正式 S3 Provider 的页面模板，
 * 不应在测试中复制三套初始化编排。
 */
export async function initializeS3User(page: Page, input: S3InitializationInput): Promise<{ publicKeyHex: string; bucketId: string }> {
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
  await page.getByRole("button", { name: /Test connection and continue|测试连接并探测/iu }).click();

  // 空桶 → 先设置启动密码（只保护本机保存的连接参数）。
  const startupHeading = page.getByRole("heading", { name: /设置启动密码|Set (?:the )?startup password/iu });
  try {
    await expect(startupHeading).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const alerts = await page.locator('[role="alert"]').allTextContents();
    const diagnostic = alerts.map((text) => text.trim()).filter(Boolean).join(" | ");
    throw new Error(`真实 S3 连接探测未进入启动密码步骤${diagnostic ? `：${diagnostic}` : ""}`, { cause: error });
  }
  const startupPassword = input.startupPassword ?? input.password;
  await page.getByLabel(/启动密码（至少 8 位）|Startup password \(at least 8 characters\)/u).fill(startupPassword);
  await page.getByLabel(/再输入一次启动密码|Repeat the startup password/iu).fill(startupPassword);
  await page.getByRole("button", { name: /^继续$|^Next$|^Continue$/u }).click();

  await expect(page.getByRole("heading", { name: /Set up your first Key|设置第一把 Key/iu })).toBeVisible();
  await page.getByRole("button", { name: /Create a Key|新建 Key/iu }).click();
  await page.getByLabel(/Tag Name|Key 标签名称/iu).fill(input.keyLabel);
  await page.getByRole("button", { name: /^继续$|^Next$|^Continue$/u }).click();
  await page.getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u).fill(input.password);
  await page.getByLabel(/再输入一次 Key 密码|Repeat the Key password/iu).fill(input.password);
  await page.getByRole("button", { name: /继续确认|Continue to confirm/iu }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/iu }).click();
  // 真实 S3 首次初始化包含远端 schema/快照建立与多轮条件写，耗时远高于
  // local；页面已经等待远端确认，这里给出与事务预算一致的窗口。
  await waitForUnlockedHome(page, 120_000);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "S3 初始化必须登记一个设备桶记录").toHaveLength(1);
  expect(catalog?.buckets?.[0], "设备记录中的后端必须是真实 S3，而不是 Local fallback").toMatchObject({
    label: input.bucketLabel,
    backend: "s3",
  });
  expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);

  // 密码、访问身份、访问密钥和临时令牌都不应以明文进入浏览器目录。
  // 空字符串没有检查意义，必须过滤，否则断言会退化成恒假。
  const secrets = [input.password, input.accessKeyId, input.secretAccessKey, ...(input.sessionToken ? [input.sessionToken] : [])];
  for (const secret of [...secrets, startupPassword].filter((value) => value.length > 0)) {
    await assertSetupSecretNotPersisted(page, secret);
  }

  const publicKeyHex = await readSessionPublicKey(page);
  const bucketId = catalog?.buckets?.[0]?.bucketId;
  if (!bucketId) throw new Error("初始化后缺少本机桶 ID");
  return { publicKeyHex, bucketId };
}

/**
 * 全新浏览器连接已有 S3 桶的页面输入。
 *
 * 与首次初始化不同：桶里已经有 KeyHold 数据，页面探测后必须进入
 * “解锁已有钱包”，只用 Key 自己的密码确认，不允许新建 Key 覆盖。
 */
export interface S3ExistingConnectionInput {
  /** 全新浏览器里重新填写的逻辑桶显示名。 */
  readonly bucketLabel: string;
  /** 桶内已有 Key 的用户标签，用于确认页面列出的是同一把 Key。 */
  readonly keyLabel: string;
  /** 已有 Key 自己的密码；解锁后不改变 KeyHold 文档。 */
  readonly keyPassword: string;
  /** 新浏览器的启动密码；只保护本机连接记录，不写入远端。 */
  readonly startupPassword: string;
  /** S3-compatible 服务的 HTTPS 地址，不含凭据。 */
  readonly endpoint: string;
  /** S3 签名区域。 */
  readonly region: string;
  /** 已存在的物理 S3 桶名称。 */
  readonly bucket: string;
  /** S3 访问身份。 */
  readonly accessKeyId: string;
  /** S3 访问密钥，只在当前页面调用中短暂使用。 */
  readonly secretAccessKey: string;
  /** 可选临时会话令牌。 */
  readonly sessionToken?: string;
  /** 本轮 Journey 独占的对象路径前缀。 */
  readonly prefix: string;
}

/**
 * 模拟全新浏览器（本机目录已清空）连接一个已有数据的真实 S3 桶。
 *
 * 成功标准是生产页面走“解锁已有钱包”而不是“新建 Key”：探测后列出桶内
 * 已有 Key，输入该 Key 自己的密码和新启动密码后进入首页；远端 KeyHold
 * 不允许被改写。返回本机新登记桶 ID 与解锁的 Key 公钥，供调用方做
 * KeymasterFormats 真值校验。
 */
export async function connectExistingS3User(
  page: Page,
  input: S3ExistingConnectionInput,
): Promise<{ publicKeyHex: string; bucketId: string }> {
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
  await page.getByRole("button", { name: /Test connection and continue|测试连接并探测/iu }).click();

  // 桶里已有 KeyHold：必须进入解锁分支，不能出现“设置启动密码/新建 Key”。
  await expect(page.getByRole("heading", { name: /解锁已有钱包|Unlock an existing wallet/u })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(input.keyLabel, { exact: false })).toBeVisible();
  await page.getByLabel(/这把 Key 自己的密码|This Key's own password/iu).fill(input.keyPassword);
  // 启动密码字段在“解锁已有钱包”步骤出现两次：一次输入、一次确认。
  await page.getByLabel(/启动密码（保存本机连接参数）|Startup password/iu).first().fill(input.startupPassword);
  await page.getByLabel(/再输入一次启动密码|Repeat the startup password/iu).fill(input.startupPassword);
  await page.getByRole("button", { name: /解锁并进入钱包|Unlock and enter wallet/u }).click();
  // 连接已有远端包含读取 KeyHold、抢锁和安装运行态，给足冷启动预算。
  await waitForUnlockedHome(page, 120_000);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "连接已有钱包只登记一条设备记录").toHaveLength(1);
  expect(catalog?.buckets?.[0]).toMatchObject({ label: input.bucketLabel, backend: "s3" });
  expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);
  const bucketId = catalog?.buckets?.[0]?.bucketId;
  if (!bucketId) throw new Error("连接已有钱包后缺少本机桶 ID");

  const publicKeyHex = await readSessionPublicKey(page);
  for (const secret of [input.keyPassword, input.startupPassword, input.accessKeyId, input.secretAccessKey, ...(input.sessionToken ? [input.sessionToken] : [])].filter((value) => value.length > 0)) {
    await assertSetupSecretNotPersisted(page, secret);
  }
  return { publicKeyHex, bucketId };
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
  await page.getByLabel(/桶名称|Bucket name/).fill(input.bucketLabel);
  await page.getByRole("button", { name: /开始创建|Start creating/ }).click();
  await expect(page.getByRole("heading", { name: /设置第一把 Key|Set up your first Key/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /Import a Key|导入 Key/ }).click();
  // 导入前先设置这把 Key 自己的密码（向导只负责解析材料）。
  await page.getByLabel(/^Key 密码（至少 8 位）|Key password \(at least 8 characters\)/u).fill(input.password);
  await page.getByLabel(/再输入一次 Key 密码|Repeat the Key password/iu).fill(input.password);
  await page.getByRole("button", { name: /继续确认|Continue to confirm/iu }).click();
  await page.getByRole("button", { name: /Hex/ }).click();
  await page.getByRole("button", { name: /Next|下一步/ }).click();
  const privateKeyField = page.getByLabel(/Text|文本/);
  await privateKeyField.fill(input.privateKeyHex);
  await page.getByRole("button", { name: /Parse|解析/ }).click();
  await page.getByLabel(/Label|标签/).fill(input.keyLabel);
  await page.getByRole("button", { name: /Use this Key|使用这把 Key|Import this Key|导入这把 Key/ }).click();
  await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ }).click();
  await waitForUnlockedHome(page);

  const catalog = await readLocalCatalog(page);
  expect(catalog?.buckets, "导入一次性 Key 的初始化仍必须登记一个 Local 设备桶").toHaveLength(1);
  expect(catalog?.buckets?.[0]).toMatchObject({ label: input.bucketLabel, backend: "local" });
  await assertSetupSecretNotPersisted(page, input.password);
  const persisted = await page.evaluate(() => Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key) ?? ""}`).join("\n"));
  expect(persisted, "一次性 Key 原文不能落入浏览器 localStorage").not.toContain(input.privateKeyHex);

  const publicKeyHex = await readSessionPublicKey(page);
  return { publicKeyHex };
}
