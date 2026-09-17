import { expect, type Page } from "@playwright/test";

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

/** 初始化完成必须以业务页和 Key 同时出现为准，不能只看 URL。 */
export async function waitForReadyVaultPage(page: Page, keyLabel: string, timeoutMs = 20_000): Promise<void> {
  const outcome = async (): Promise<"ready" | "failed" | "pending"> => {
    if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
    if (await page.getByRole("alert").first().isVisible().catch(() => false)) return "failed";
    if (new URL(page.url()).pathname !== "/settings/vault") return "pending";
    return (await page.getByText(keyLabel, { exact: true }).first().isVisible().catch(() => false)) ? "ready" : "pending";
  };
  await expect.poll(outcome, {
    timeout: timeoutMs,
    message: "只有 Key 管理页和第一把 Key 同时可见，才算初始化完成",
  }).not.toBe("pending");
  expect(await outcome(), "初始化失败必须保留可诊断错误，不能假装成功").toBe("ready");
}

/** Local 初始化成功后，确认密码没有进入浏览器持久化目录。 */
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
}
