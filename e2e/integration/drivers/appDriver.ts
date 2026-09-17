import { expect, type Page } from "@playwright/test";

/** Local catalog 的最小非敏感投影；密码和 S3 凭据不应出现在这里。 */
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
 * 从真实页面的 localStorage 读取目录投影，不读取业务私钥。
 *
 * 生产真值统一在设备引导记录 `keymaster.device-bootstrap.v1` 中；旧的
 * `keymaster.storage.catalog.v2` 键已从生产代码删除，测试不能继续读旧键，
 * 否则会把“本机引导记录丢失”误报成“目录字段缺失”。
 */
export async function readLocalCatalog(page: Page): Promise<LocalCatalogSnapshot | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("keymaster.device-bootstrap.v1");
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const value = parsed as { selectedRemoteStorageId?: unknown; connections?: unknown };
      const buckets = Array.isArray(value.connections)
        ? value.connections.map((connection) => {
            if (!connection || typeof connection !== "object") return {};
            const item = connection as { remoteStorageId?: unknown; displayName?: unknown; providerId?: unknown };
            return {
              ...(typeof item.remoteStorageId === "string" ? { bucketId: item.remoteStorageId } : {}),
              ...(typeof item.displayName === "string" ? { label: item.displayName } : {}),
              ...(typeof item.providerId === "string" ? { backend: item.providerId } : {}),
            };
          })
        : undefined;
      return {
        ...(typeof value.selectedRemoteStorageId === "string" ? { selectedBucketId: value.selectedRemoteStorageId } : {}),
        ...(buckets === undefined ? {} : { buckets }),
      };
    } catch {
      return null;
    }
  });
}

/** 初始化完成必须以业务页和 Key 同时出现为准，不能只看 URL。 */
export async function waitForReadyVaultPage(page: Page, keyLabel: string): Promise<void> {
  const outcome = async (): Promise<"ready" | "failed" | "pending"> => {
    if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
    if (await page.getByRole("alert").first().isVisible().catch(() => false)) return "failed";
    if (new URL(page.url()).pathname !== "/settings/vault") return "pending";
    return (await page.getByText(keyLabel, { exact: true }).first().isVisible().catch(() => false)) ? "ready" : "pending";
  };
  await expect.poll(outcome, {
    timeout: 20_000,
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
