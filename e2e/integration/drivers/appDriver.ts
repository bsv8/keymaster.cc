import { expect, type Page } from "@playwright/test";
import { readRawLocalBucketObjects } from "../support/localBucketFormats.js";

/**
 * 本机桶的最小非敏感投影（新模型）。
 *
 * 真值来源：一桶一条的 `keymaster.device.<ID>` 记录 + `keymaster.session`
 * 的 activeBucketId。密码与凭据都不允许出现在这里。
 */
export interface LocalCatalogSnapshot {
  readonly selectedBucketId?: string;
  readonly buckets?: readonly {
    readonly bucketId?: string;
    readonly label?: string;
    readonly backend?: string;
  }[];
}

/** 打开生产 preview，确认页面本身已进入可观察状态。 */
export async function openApplication(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("KeyMaster");
}

/**
 * 从真实页面的 localStorage 读取桶投影，不读取业务私钥。
 *
 * 新模型没有目录键：桶清单 = `keymaster.device.<ID>`（一桶一条）；
 * 当前桶 = `keymaster.session` 的 activeBucketId。
 */
export async function readLocalCatalog(page: Page): Promise<LocalCatalogSnapshot | null> {
  return page.evaluate(() => {
    const buckets: Array<{ bucketId?: string; label?: string; backend?: string }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith("keymaster.device.")) continue;
      const bucketId = key.slice("keymaster.device.".length);
      let label: string | undefined;
      let backend: string | undefined;
      try {
        const record = JSON.parse(window.localStorage.getItem(key) ?? "null") as { displayName?: unknown; location?: { providerId?: unknown } } | null;
        if (record && typeof record === "object") {
          if (typeof record.displayName === "string") label = record.displayName;
          if (record.location && typeof record.location === "object" && typeof record.location.providerId === "string") backend = record.location.providerId;
        }
      } catch {
        // 损坏记录仍然如实报告键名,由上层判断。
      }
      buckets.push({
        bucketId,
        ...(label === undefined ? {} : { label }),
        ...(backend === undefined ? {} : { backend }),
      });
    }
    let selectedBucketId: string | undefined;
    try {
      const session = JSON.parse(window.localStorage.getItem("keymaster.session") ?? "null") as { activeBucketId?: unknown } | null;
      if (session && typeof session === "object" && typeof session.activeBucketId === "string") selectedBucketId = session.activeBucketId;
    } catch {
      // 无 session 或损坏:不报告选择。
    }
    if (buckets.length === 0 && selectedBucketId === undefined) return null;
    return {
      ...(selectedBucketId === undefined ? {} : { selectedBucketId }),
      buckets: buckets.sort((left, right) => (left.bucketId ?? "").localeCompare(right.bucketId ?? "")),
    };
  });
}

/**
 * 初始化/解锁完成 = 已解锁壳层可用（主导航可见，且不在任何安全入口页）。
 *
 * Key 管理页（/settings/vault）已删除，初始化后落在首页；这里不再依赖
 * 具体业务页或 Key 标签文案，Key 真值由 readSessionPublicKey 与
 * KeymasterFormats 文件校验负责。
 */
export async function waitForUnlockedHome(page: Page, timeoutMs = 20_000): Promise<void> {
  const outcome = async (): Promise<"ready" | "failed" | "pending"> => {
    if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
    if (await page.getByRole("alert").first().isVisible().catch(() => false)) return "failed";
    const gateway = page.getByRole("heading", {
      name: /Choose a bucket type|选择桶类型|存储需要认证|Storage authentication required|钱包已锁定|Wallet locked/u,
    });
    if (await gateway.first().isVisible().catch(() => false)) return "pending";
    const navigation = page.getByRole("navigation", { name: /Primary navigation|主导航/ });
    if (!(await navigation.isVisible().catch(() => false))) return "pending";
    return "ready";
  };
  await expect.poll(outcome, {
    timeout: timeoutMs,
    message: "只有已解锁壳层可用，才算初始化/解锁完成",
  }).not.toBe("pending");
  expect(await outcome(), "初始化/解锁失败必须保留可诊断错误，不能假装成功").toBe("ready");
  // 解锁瞬间窗口仍可能在重建 owner 插件实例；给一个很短的稳定窗口，避免
  // 紧接着的点击/导航落在实例替换的空档里。
  await page.waitForTimeout(600);
}

/** 读取浏览器 session 的 active Key（存储真值；不读私钥）。 */
export async function readSessionPublicKey(page: Page): Promise<string> {
  const activeKey = await page.evaluate(() => {
    try {
      const session = JSON.parse(window.localStorage.getItem("keymaster.session") ?? "null") as { activeKey?: unknown } | null;
      return session && typeof session === "object" && typeof session.activeKey === "string" ? session.activeKey : null;
    } catch {
      return null;
    }
  });
  expect(activeKey, "session 必须记录 active Key 公钥").toMatch(/^(02|03)[0-9a-f]{64}$/u);
  return (activeKey ?? "").toLowerCase();
}

/** Local 初始化成功后，确认密码没有进入浏览器持久化目录（localStorage + IndexedDB）。 */
export async function assertSetupSecretNotPersisted(page: Page, password: string): Promise<void> {
  const persisted = await page.evaluate(() => {
    const entries: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) entries.push(`${key}=${window.localStorage.getItem(key) ?? ""}`);
    }
    return entries.join("\n");
  });
  expect(persisted, "初始化密码不能写入浏览器 localStorage").not.toContain(password);
  const bucketObjects = await readRawLocalBucketObjects(page);
  const persistedObjects = bucketObjects.map((entry) => `${entry.bucketId}/${entry.path}=${entry.text}`).join("\n");
  expect(persistedObjects, "初始化密码不能写入浏览器 IndexedDB").not.toContain(password);
}
