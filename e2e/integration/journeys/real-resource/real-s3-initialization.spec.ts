import { expect, test } from "@playwright/test";
import { connectExistingS3User, initializeS3User } from "../../drivers/initialSetupDriver.js";
import { readLocalCatalog, readSessionPublicKey } from "../../drivers/appDriver.js";
import { lockWallet, reloadS3BucketAndUnlock, unlockWallet, unlockWalletWithReplay } from "../../drivers/vaultDriver.js";
import { assertS3BucketStorage, assertS3IdentityStorage, readS3SessionId } from "../../support/s3BucketFormats.js";
import { loadE2ES3Config, publicS3ConfigFingerprint } from "../../resources/config/loader.js";
import { S3CleanupResource, createAwsS3Api } from "../../resources/s3/s3CleanupResource.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { readS3ResourceRunState } from "../../support/s3ResourceState.js";
import { REAL_S3_INITIALIZATION_SCENARIO } from "../../support/scenarioMetadata.js";
import { scenarioObjectPrefix } from "../../support/ids.js";
import type { LoadedE2ES3Config } from "../../resources/config/types.js";

export const JOURNEY_ID = REAL_S3_INITIALIZATION_SCENARIO.id;
export const JOURNEY_METADATA = REAL_S3_INITIALIZATION_SCENARIO;

const SETUP_PASSWORD = "real-s3-e2e-password-123";
// 两个密码域必须独立验证：启动密码保护本机连接参数，Key 密码保护 KeyHold。
const STARTUP_PASSWORD = "real-s3-startup-password-456";
const LOGICAL_BUCKET_LABEL = "真实 S3 集成测试桶";
const FIRST_KEY_LABEL = "真实 S3 首 Key";
// 全新浏览器重新登记本机记录时可以换显示名；桶内数据不变。
const FRESH_BROWSER_BUCKET_LABEL = "全新浏览器接入的 S3 桶";

function clearSecrets(config: LoadedE2ES3Config | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
}

/**
 * 业务目标：首次用户把 Keymaster 的逻辑桶建立在真实 S3 物理桶中，
 * 完成首个 Hold/Key 初始化，并在刷新后继续使用同一身份。
 *
 * 开始状态：resource-setup 已按 s3.json 使用物理桶，取得排他 lease 并完成
 * 开场清理；浏览器 context 没有本地目录或 Vault。物理 S3 桶不会由页面
 * 创建，页面只在本轮隔离前缀下创建 Keymaster 逻辑桶对象。
 *
 * 成功标准：页面的正式 S3 provider probe 和初始化事务成功，页面显示真实
 * 逻辑桶、首 Key，并在刷新后恢复同一目录和身份。随后清空本机目录模拟
 * 全新浏览器，再次连接同一个已有数据的桶时必须走“解锁已有钱包”，用 Key
 * 自己的密码确认后进入首页，且远端 KeyHold 不被改写。Node Resource 只负责
 * 租约、本场景 prefix 的清理和生命周期安全，不把直接 S3 API 观察当作页面成功。
 *
 * 外部资源与收尾：只使用 setup 已取得的 S3 lease；Journey 只清理自己的
 * prefix，resource-teardown 再负责非前缀的全量收口、版本、delete marker
 * 和 multipart，并在确认清理后释放 lease。凭据只短暂填入页面，禁止进入
 * resource-state、附件或 Playwright 自动产物。
 *
 * 覆盖需求：KM-INIT-002。
 */
test(JOURNEY_ID + "：真实 S3 首次初始化、刷新/锁定恢复与全新浏览器接入", async ({ page, context }, testInfo) => {
  test.setTimeout(420_000);
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2ES3Config | undefined;
  let accessKeyId = "";
  let secretAccessKey = "";
  let sessionToken = "";
  let s3: S3CleanupResource | undefined;
  let resourceRunId: string | undefined;
  let prefix: string | undefined;
  let journeyError: unknown;
  let evidenceError: unknown;
  let cleanupError: unknown;

  try {
    const state = await readS3ResourceRunState();
    expect(state, "真实 S3 初始化必须依赖成功的 resource-setup").not.toBeNull();
    if (!state) throw new Error("真实资源运行状态不可用");
    expect(state.s3LeaseAcquired).toBe(true);

    config = await loadE2ES3Config();
    expect(publicS3ConfigFingerprint(config), "Journey 与 setup 使用的公开 S3 配置必须一致").toBe(state.configFingerprint);

    const scenarioPrefix = scenarioObjectPrefix(state.runId, JOURNEY_ID);
    prefix = scenarioPrefix;
    resourceRunId = state.runId;
    const resource = new S3CleanupResource(config.s3);
    s3 = resource;
    await resource.adoptLease(state.runId);
    expect(
      await resource.countBusinessObjects(state.runId, scenarioPrefix),
      "开场清理后本场景前缀不能残留旧业务对象",
    ).toBe(0);

    accessKeyId = config.s3.accessKeyId;
    secretAccessKey = config.s3.secretAccessKey.read();
    sessionToken = config.s3.sessionToken?.read() ?? "";

    const ready = await test.step("用户填写真实 S3 参数并完成首桶初始化", async () => initializeS3User(page, {
      bucketLabel: LOGICAL_BUCKET_LABEL,
      keyLabel: FIRST_KEY_LABEL,
      password: SETUP_PASSWORD,
      startupPassword: STARTUP_PASSWORD,
      endpoint: config!.s3.endpoint,
      region: config!.s3.region,
      bucket: config!.s3.bucket,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      prefix: scenarioPrefix,
    }));

    // publicKeyHex 由真实页面 Key 行读取；它是页面初始化结果的技术辅助值，
    // 不是 Node S3 API 的业务成功判定。
    expect(ready.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/iu);

    await test.step("S3 桶与本机身份文件符合 KeymasterFormats", async () => {
      const sessionId = await readS3SessionId(page);
      await assertS3IdentityStorage(page, { bucketId: ready.bucketId, ownerPublicKeyHex: ready.publicKeyHex, sessionId });
      // Node 侧直接读取真实 S3 对象：KeyHold 文档、Key 应用锁与旧格式缺席。
      await assertS3BucketStorage(config!.s3, {
        prefix: scenarioPrefix,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: FIRST_KEY_LABEL,
        sessionId,
      });
    });

    await test.step("用户刷新页面后从真实 S3 恢复同一逻辑桶和 Key", async () => {
      // s3 设备记录由启动密码保护：先过存储认证页，再输入该 Key 自己的密码。
      await reloadS3BucketAndUnlock(page, STARTUP_PASSWORD, SETUP_PASSWORD, FIRST_KEY_LABEL);
      const catalog = await readLocalCatalog(page);
      expect(catalog?.buckets).toHaveLength(1);
      expect(catalog?.buckets?.[0]).toMatchObject({ label: LOGICAL_BUCKET_LABEL, backend: "s3" });
      expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);
      const sessionId = await readS3SessionId(page);
      await assertS3IdentityStorage(page, { bucketId: ready.bucketId, ownerPublicKeyHex: ready.publicKeyHex, sessionId });
      // 恢复后锁必须重新被本 session 持有；同一条 Node 真值校验再跑一次。
      await assertS3BucketStorage(config!.s3, {
        prefix: scenarioPrefix,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: FIRST_KEY_LABEL,
        sessionId,
      });
    });

    await test.step("用户主动锁定后只需 Key 密码解锁，桶密码不被遗忘", async () => {
      const activeKeyBefore = await readSessionPublicKey(page);
      expect(activeKeyBefore, "锁定前应使用初始化的同一把 Key").toBe(ready.publicKeyHex);
      const catalogBefore = await readLocalCatalog(page);
      const sessionId = await readS3SessionId(page);
      await lockWallet(page);
      await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/u })).toBeVisible();
      await expect(page.getByTestId("storage-authentication"), "主动锁定不能要求重新认证桶").toHaveCount(0);
      await expect(page.getByRole("navigation", { name: /Primary navigation|主导航/u })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /Selected private key|已选私钥|当前选择的私钥/u })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByLabel(/密码|password/iu), "Key 密码输入必须清空").toHaveValue("");
      await expect(page.getByRole("button", { name: /^Unlock$|^解锁$/u })).toBeDisabled();
      expect(await readLocalCatalog(page), "锁定不能改变已选桶").toEqual(catalogBefore);
      expect(await readSessionPublicKey(page)).toBe(activeKeyBefore);
      await unlockWallet(page, SETUP_PASSWORD, FIRST_KEY_LABEL);
      expect(await readSessionPublicKey(page)).toBe(activeKeyBefore);
      await expect(page.getByTestId("storage-authentication")).toHaveCount(0);
      await assertS3IdentityStorage(page, { bucketId: ready.bucketId, ownerPublicKeyHex: ready.publicKeyHex, sessionId });
      await assertS3BucketStorage(config!.s3, {
        prefix: scenarioPrefix,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: FIRST_KEY_LABEL,
        sessionId,
      });
    });

    await test.step("重新解锁后刷新会忘记桶认证，需要再次输入桶密码和 Key 密码", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const authHeading = page.getByTestId("storage-authentication");
      const lockedHeading = page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ });
      await expect(authHeading).toBeVisible({ timeout: 60_000 });
      await authHeading.getByLabel(/密码|password/iu).fill(STARTUP_PASSWORD);
      await authHeading.getByRole("button", { name: /^解锁$|^Unlock$/u }).click();
      await expect(lockedHeading).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("heading", { name: /Selected private key|已选私钥/u })).toBeVisible({ timeout: 60_000 });
      await unlockWalletWithReplay(page, SETUP_PASSWORD);
      const catalog = await readLocalCatalog(page);
      expect(catalog?.buckets).toHaveLength(1);
      expect(catalog?.selectedBucketId).toBe(ready.bucketId);
    });

    await test.step("全新浏览器清空本机目录后接入已有 S3 桶：只解锁既有 Key，不新建覆盖", async () => {
      // scenarioObjectPrefix 带尾斜杠；Node 侧直接读对象时必须去掉，避免 `//`。
      const prefixBase = scenarioPrefix.replace(/\/+$/u, "");
      const keyHoldPath = `${prefixBase}/keys/${ready.publicKeyHex}.keyhold`;
      const api = createAwsS3Api(config!.s3);
      const keyHoldBefore = await api.getObject(keyHoldPath);
      expect(keyHoldBefore?.body, "接入前必须能读到初始化写入的 KeyHold").toBeTruthy();
      expect(keyHoldBefore?.etag).toBeTruthy();

      // 先锁定释放 Key 锁（旧浏览器不再持有），再清空本机目录并刷新：
      // 新 session 会落到一个全新的 SharedWorker，模拟干净浏览器。
      await lockWallet(page);
      await page.evaluate(() => { window.localStorage.clear(); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: /Choose a bucket type|选择桶类型/u }),
        "清空本机目录后必须回到首次初始化入口",
      ).toBeVisible({ timeout: 60_000 });

      const connected = await connectExistingS3User(page, {
        bucketLabel: FRESH_BROWSER_BUCKET_LABEL,
        keyLabel: FIRST_KEY_LABEL,
        keyPassword: SETUP_PASSWORD,
        startupPassword: STARTUP_PASSWORD,
        endpoint: config!.s3.endpoint,
        region: config!.s3.region,
        bucket: config!.s3.bucket,
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
        prefix: scenarioPrefix,
      });

      // 页面必须解锁桶里已有的同一把 Key，而不是生成新 Key。
      expect(connected.publicKeyHex, "接入已有桶必须解锁原有 Key").toBe(ready.publicKeyHex);
      const sessionId = await readS3SessionId(page);
      await assertS3IdentityStorage(page, { bucketId: connected.bucketId, ownerPublicKeyHex: ready.publicKeyHex, sessionId });
      // keys/ 下仍然只有原 KeyHold，锁由新 session 持有。
      await assertS3BucketStorage(config!.s3, {
        prefix: scenarioPrefix,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: FIRST_KEY_LABEL,
        sessionId,
      });
      // 解锁既有钱包不得改写远端 KeyHold：字节与 ETag 必须保持原样。
      const keyHoldAfter = await api.getObject(keyHoldPath);
      expect(keyHoldAfter?.body, "接入已有桶不能改写 KeyHold 内容").toBe(keyHoldBefore?.body);
      expect(keyHoldAfter?.etag, "接入已有桶不能覆写 KeyHold 对象").toBe(keyHoldBefore?.etag);
      const catalog = await readLocalCatalog(page);
      expect(catalog?.buckets, "全新浏览器只登记一条设备记录").toHaveLength(1);
      expect(catalog?.selectedBucketId).toBe(connected.bucketId);
    });
  } catch (error) {
    journeyError = error;
  } finally {
    try {
      // 真实资源项目关闭 trace/video/screenshot；浏览器错误也必须经过已知
      // 凭据替换和秘密形状扫描后才允许进入报告。
      await attachBrowserErrors(testInfo, browserErrors, [SETUP_PASSWORD, STARTUP_PASSWORD, accessKeyId, secretAccessKey, sessionToken]);
    } catch (error) {
      evidenceError = error;
    }
    try {
      if (s3 && resourceRunId && prefix) {
        // 这是前缀测试：只清理本 Journey 创建的对象。桶级收尾仍由
        // 非前缀 teardown 负责处理其他意外残留。
        await s3.cleanup(resourceRunId, prefix);
      }
    } catch (error) {
      cleanupError = error;
    }
    clearSecrets(config);
    accessKeyId = "";
    secretAccessKey = "";
    sessionToken = "";
  }

  if (journeyError) throw journeyError;
  if (evidenceError) throw evidenceError;
  if (cleanupError) throw cleanupError;
});
