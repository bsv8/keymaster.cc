import { expect, test, type Page } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { readLocalCatalog } from "../../drivers/appDriver.js";
import {
  createKeyInCurrentBucket,
  createS3BucketViaManager,
  deleteKeyFromBucketList,
} from "../../drivers/bucketManagerDriver.js";
import {
  openBucketManagerFromSwitcher,
  switchToCurrentBucketKey,
  switchToLocalBucketKey,
  switchToS3BucketKey,
} from "../../drivers/bucketSwitcherDriver.js";
import { readMyInfoPublicKey } from "../../drivers/myInfoDriver.js";
import { navigateToBusinessPage } from "../../drivers/navigationDriver.js";
import { readS3SessionId } from "../../support/s3BucketFormats.js";
import { loadE2ES3Config, publicS3ConfigFingerprint } from "../../resources/config/loader.js";
import { S3CleanupResource, createAwsS3Api } from "../../resources/s3/s3CleanupResource.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { readS3ResourceRunState } from "../../support/s3ResourceState.js";
import { scenarioObjectPrefix } from "../../support/ids.js";
import { REAL_S3_BUCKET_KEY_SWITCH_SCENARIO } from "../../support/scenarioMetadata.js";
import type { LoadedE2ES3Config } from "../../resources/config/types.js";

export const JOURNEY_ID = REAL_S3_BUCKET_KEY_SWITCH_SCENARIO.id;
export const JOURNEY_METADATA = REAL_S3_BUCKET_KEY_SWITCH_SCENARIO;

const LOCAL_BUCKET_LABEL = "切换测试 Local 桶";
const LOCAL_KEY_1 = "Local Key 1";
const LOCAL_KEY_2 = "Local Key 2";
const LOCAL_PASSWORD_1 = "local-key1-password-123";
const LOCAL_PASSWORD_2 = "local-key2-password-456";

const S3_BUCKET_LABEL = "切换测试 S3 桶";
const S3_KEY_1 = "S3 Key 1";
const S3_KEY_2 = "S3 Key 2";
const S3_KEY_PASSWORD_1 = "s3-key1-password-123";
const S3_KEY_PASSWORD_2 = "s3-key2-password-456";
const S3_STARTUP_PASSWORD = "s3-startup-password-789";

function clearSecrets(config: LoadedE2ES3Config | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
}

/** 通过主导航回到首页（新 Key 已 active，组件内的 push 不保证赢过壳层重建）。 */
async function navigateHome(page: Page): Promise<void> {
  await navigateToBusinessPage(page, { label: /Home|首页/u, path: /\/$/u });
}

/**
 * 等待“刚变成 active”的新 Key 稳定，并返回首页“我的信息”显示的完整公钥。
 *
 * 同桶内切换/新建 Key 的 active 选择只由首页“我的信息”（keyspace active）
 * 表达；身份切换会重建已解锁壳层，直接读页面可能落在旧实例上，因此先用
 * “不等于 previous”等到新身份出现，再复读一次确认稳定。
 */
async function settleActiveIdentity(page: Page, previous?: string): Promise<string> {
  await expect.poll(async () => {
    try {
      const key = await readMyInfoPublicKey(page);
      if (!key) return "";
      if (previous !== undefined && key === previous) return "";
      return key;
    } catch {
      return "";
    }
  }, { timeout: 30_000, message: "等待首页“我的信息”显示新的 active Key" }).not.toBe("");
  const key = await readMyInfoPublicKey(page);
  await expect.poll(async () => {
    try { return await readMyInfoPublicKey(page); } catch { return ""; }
  }, { timeout: 15_000, message: "首页“我的信息”必须保持稳定" }).toBe(key);
  return key;
}

/** 断言当前 active 身份就是目标 Key：以首页“我的信息”公钥为准。 */
async function expectActiveIdentity(page: Page, expected: string, label: string): Promise<void> {
  await expect.poll(async () => {
    try { return await readMyInfoPublicKey(page); } catch { return ""; }
  }, { timeout: 30_000, message: `${label}：首页“我的信息”必须显示目标 Key` }).toBe(expected);
}

/**
 * 业务目标：同一浏览器里同时拥有一个 Local 桶和一个真实 S3 桶，每个桶
 * 两把 Key；用户通过顶栏快捷切换在四个身份之间任意交叉切换。
 *
 * 用户价值：证明“桶 → Keys”切换入口在真实 Local/S3 混用场景下始终把
 * 用户带到正确的身份，而不是只在本机 or 只读列表里看起来正确。
 *
 * 开始状态：s3-resource-setup 已取得真实 S3 lease 并完成开场清理；
 * 浏览器是全新 Chromium context，没有本机目录或 Vault。
 *
 * 成功标准：第二把 Key 通过 /storage/buckets 的“新建 Key”产生；每次切换
 * 后首页“我的信息”显示的公钥与 session.activeKey 都等于目标 Key；真实
 * S3 前缀下 keys/ 只有本场景的两把 KeyHold，当前 Key 的应用锁由当前
 * session 持有。
 *
 * 业务风险：切换如果先改本机目录后验密码，用户会看到“换桶成功但身份没
 * 换”或退不回旧桶；因此这里每一步都以页面可见身份为准，远端真值由
 * Node S3 API 只读校验。
 *
 * 外部资源与收尾：只使用 setup 已取得的 S3 lease；Journey 结束时只清理
 * 自己 run_id/scenario_id 前缀，teardown 再负责非前缀全量收口与释放
 * lease。凭据只短暂填入页面，禁止进入附件或 Playwright 产物。
 *
 * 覆盖需求：KM-STORAGE-001。
 */
test(JOURNEY_ID + "：Local/S3 双桶双 Key 交叉切换以首页我的信息为准", async ({ page, context }, testInfo) => {
  test.setTimeout(600_000);
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
  let s3Bucket: { bucketId?: string } | undefined;
  let s3BucketId = "";

  try {
    const state = await readS3ResourceRunState();
    expect(state, "真实 S3 切换 Journey 必须依赖成功的 resource-setup").not.toBeNull();
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

    const localReady = await test.step("创建 Local 桶与第一把 Key", async () => initializeNewLocalUser({ page }, {
      bucketLabel: LOCAL_BUCKET_LABEL,
      keyLabel: LOCAL_KEY_1,
      password: LOCAL_PASSWORD_1,
    }));

    const localKey1 = await test.step("首页“我的信息”显示 Local Key 1", async () => {
      const shown = await settleActiveIdentity(page);
      expect(shown).toBe(localReady.publicKeyHex);
      return shown;
    });

    let localKey2 = "";
    await test.step("在桶管理页为 Local 桶创建第二把 Key", async () => {
      await openBucketManagerFromSwitcher(page);
      await expect(page.getByTestId("bucket-current")).toBeVisible();
      await createKeyInCurrentBucket(page, { label: LOCAL_KEY_2, password: LOCAL_PASSWORD_2 });
      // 新 Key 自动 active；显式回首页后以“我的信息”记录真实身份。
      await navigateHome(page);
      localKey2 = await settleActiveIdentity(page, localKey1);
      expect(localKey2, "第二把 Key 必须是新的身份").not.toBe(localKey1);
    });

    await test.step("Local 桶内切换到第一把 Key", async () => {
      await switchToCurrentBucketKey(page, { keyLabel: LOCAL_KEY_1, keyPassword: LOCAL_PASSWORD_1 });
      await expectActiveIdentity(page, localKey1, "Local 桶切换到第一把 Key");
    });

    await test.step("Local 桶内切换到第二把 Key", async () => {
      await switchToCurrentBucketKey(page, { keyLabel: LOCAL_KEY_2, keyPassword: LOCAL_PASSWORD_2 });
      await expectActiveIdentity(page, localKey2, "Local 桶切换到第二把 Key");
    });

    let s3Key1 = "";
    await test.step("通过桶管理页向导创建真实 S3 桶与首把 Key", async () => {
      await openBucketManagerFromSwitcher(page);
      await createS3BucketViaManager(page, {
        bucketLabel: S3_BUCKET_LABEL,
        keyLabel: S3_KEY_1,
        keyPassword: S3_KEY_PASSWORD_1,
        startupPassword: S3_STARTUP_PASSWORD,
        endpoint: config!.s3.endpoint,
        region: config!.s3.region,
        bucket: config!.s3.bucket,
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
        prefix: scenarioPrefix,
      });
      s3Key1 = await settleActiveIdentity(page, localKey2);
      expect(s3Key1, "S3 首 Key 必须是新的身份").not.toBe(localKey1);
      expect(s3Key1).not.toBe(localKey2);

      // 探测阶段的能力必须随设备记录一起持久化，之后不再自动探测。
      const catalog = await readLocalCatalog(page);
      s3BucketId = catalog?.selectedBucketId ?? "";
      expect(s3BucketId, "S3 初始化后必须有当前桶 ID").not.toBe("");
      const persistedMode = await page.evaluate((bucketId) => {
        const raw = window.localStorage.getItem(`keymaster.device.${bucketId}`);
        if (!raw) return null;
        return (JSON.parse(raw) as { capabilities?: { conditionalWrites?: string } }).capabilities?.conditionalWrites ?? null;
      }, s3BucketId);
      expect(persistedMode, `设备记录必须缓存条件写能力，实际：${persistedMode ?? "缺失"}`).toMatch(/^(native|best-effort)$/u);
    });

    let s3Key2 = "";
    await test.step("在桶管理页为 S3 桶创建第二把 Key", async () => {
      await openBucketManagerFromSwitcher(page);
      await expect(page.getByTestId("bucket-current")).toBeVisible();
      await createKeyInCurrentBucket(page, { label: S3_KEY_2, password: S3_KEY_PASSWORD_2 });
      await navigateHome(page);
      s3Key2 = await settleActiveIdentity(page, s3Key1);
      expect(s3Key2).not.toBe(s3Key1);
    });

    await test.step("S3 桶内切换到第一把 Key", async () => {
      await switchToCurrentBucketKey(page, { keyLabel: S3_KEY_1, keyPassword: S3_KEY_PASSWORD_1 });
      await expectActiveIdentity(page, s3Key1, "S3 桶切换到第一把 Key");
    });

    await test.step("S3 桶内切换到第二把 Key", async () => {
      await switchToCurrentBucketKey(page, { keyLabel: S3_KEY_2, keyPassword: S3_KEY_PASSWORD_2 });
      await expectActiveIdentity(page, s3Key2, "S3 桶切换到第二把 Key");
    });

    await test.step("跨桶切换回 Local 桶第一把 Key", async () => {
      await switchToLocalBucketKey(page, {
        bucketLabel: LOCAL_BUCKET_LABEL,
        keyLabel: LOCAL_KEY_1,
        keyPassword: LOCAL_PASSWORD_1,
      });
      await expectActiveIdentity(page, localKey1, "跨桶切换到 Local 第一把 Key");
    });

    await test.step("跨桶切换回 Local 桶第二把 Key", async () => {
      await switchToLocalBucketKey(page, {
        bucketLabel: LOCAL_BUCKET_LABEL,
        keyLabel: LOCAL_KEY_2,
        keyPassword: LOCAL_PASSWORD_2,
      });
      await expectActiveIdentity(page, localKey2, "跨桶切换到 Local 第二把 Key");
    });

    await test.step("最终跨桶切换回 S3 桶第一把 Key", async () => {
      await switchToS3BucketKey(page, {
        bucketLabel: S3_BUCKET_LABEL,
        bucketPassword: S3_STARTUP_PASSWORD,
        keyLabel: S3_KEY_1,
        keyPassword: S3_KEY_PASSWORD_1,
      });
      await expectActiveIdentity(page, s3Key1, "最终跨桶切换回 S3 第一把 Key");
    });

    await test.step("本机目录与真实 S3 远端真值符合双桶双 Key", async () => {
      const catalog = await readLocalCatalog(page);
      expect(catalog?.buckets, "本机目录必须登记 Local 与 S3 两个桶").toHaveLength(2);
      expect([...(catalog?.buckets ?? [])].map((bucket) => bucket.label).sort()).toEqual([LOCAL_BUCKET_LABEL, S3_BUCKET_LABEL].sort());
      const bucket = catalog?.buckets?.find((row) => row.backend === "s3");
      expect(bucket, "必须存在真实 S3 后端记录").toBeTruthy();
      s3Bucket = bucket;
      expect(catalog?.selectedBucketId, "最终当前桶必须是 S3 桶").toBe(bucket?.bucketId);

      // Node 侧只读真实 S3：keys/ 下只有本场景创建的两把 KeyHold，且当前
      // active Key 的应用锁由当前 session 持有。
      const sessionId = await readS3SessionId(page);
      const prefixBase = scenarioPrefix.replace(/\/+$/u, "");
      const api = createAwsS3Api(config!.s3);
      let cursor: string | undefined;
      const objectKeys: string[] = [];
      do {
        const listed = await api.listObjectsV2(cursor);
        objectKeys.push(...listed.keys);
        cursor = listed.nextCursor;
      } while (cursor);
      const keyFiles = objectKeys.filter((key) => key.startsWith(`${prefixBase}/keys/`)).sort();
      expect(keyFiles).toEqual([
        `${prefixBase}/keys/${s3Key1}.keyhold`,
        `${prefixBase}/keys/${s3Key2}.keyhold`,
      ].sort());
      const lock = await api.getObject(`${prefixBase}/${s3Key1}/lock.json`);
      expect(lock?.body, "S3 当前 Key 必须持有应用锁").toBeTruthy();
      expect(lock?.body, "应用锁 holder 必须是当前 session").toContain(sessionId);
      const legacy = objectKeys.filter((key) =>
        key === `${prefixBase}/keys.json`
        || key === `${prefixBase}/keymaster/keys.json`
        || key.startsWith(`${prefixBase}/.keymaster/buckets/`));
      expect(legacy, `S3 桶出现旧格式对象: ${legacy.join(", ")}`).toEqual([]);
    });

    await test.step("桶管理页列出非当前 Local 桶的 Key 并删除一把（本机 localStorage 权限）", async () => {
      await openBucketManagerFromSwitcher(page);
      const list = page.getByTestId(`bucket-key-list-${localReady.bucketId}`);
      await expect(list).toBeVisible();
      // 非当前 Local 桶不需要桶密码，直接列出两把 Key。
      await expect(list.getByText(LOCAL_KEY_1)).toBeVisible();
      await expect(list.getByText(LOCAL_KEY_2)).toBeVisible();

      await deleteKeyFromBucketList(page, {
        bucketId: localReady.bucketId,
        publicKeyHex: localKey2,
        keyLabel: LOCAL_KEY_2,
      });
      // 列表按 localStorage 真值重新加载：只剩第一把 Key。
      await expect(list.getByText(LOCAL_KEY_2)).toHaveCount(0);
      await expect(list.getByText(LOCAL_KEY_1)).toBeVisible();
      // 当前桶仍是 S3，删除非当前 Local Key 不影响当前身份。
      await expect(page.getByTestId(`bucket-row-${s3Bucket?.bucketId}`)).toBeVisible();

      // S3 桶行展示已缓存的能力，并可直接手工重新探测写回记录。
      const chip = page.getByTestId(`bucket-capability-${s3BucketId}`);
      await expect(chip).toHaveText(/原生条件写|模拟条件写|Native conditional writes|Simulated conditional writes/u);
      await page.getByTestId(`bucket-reprobe-${s3BucketId}`).click();
      await expect.poll(async () => page.evaluate((bucketId) => {
        const raw = window.localStorage.getItem(`keymaster.device.${bucketId}`);
        if (!raw) return null;
        return (JSON.parse(raw) as { capabilities?: { conditionalWrites?: string } }).capabilities?.conditionalWrites ?? null;
      }, s3BucketId), {
        timeout: 30_000,
        message: "手工重新探测后设备记录仍必须带有条件写能力",
      }).toMatch(/native|best-effort/u);
      await expect(chip).toHaveText(/原生条件写|模拟条件写|Native conditional writes|Simulated conditional writes/u);
    });
  } catch (error) {
    journeyError = error;
  } finally {
    try {
      await attachBrowserErrors(testInfo, browserErrors, [
        LOCAL_PASSWORD_1, LOCAL_PASSWORD_2,
        S3_KEY_PASSWORD_1, S3_KEY_PASSWORD_2, S3_STARTUP_PASSWORD,
        accessKeyId, secretAccessKey, sessionToken,
      ]);
    } catch (error) {
      evidenceError = error;
    }
    try {
      if (s3 && resourceRunId && prefix) {
        // 这是前缀测试：只清理本 Journey 创建的对象。
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
