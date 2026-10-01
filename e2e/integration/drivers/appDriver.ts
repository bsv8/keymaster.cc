import { expect, type Page } from "@playwright/test";
import { readRawWalletObjects } from "../support/walletStorageFormats.js";

/**
 * 本地钱包的最小非敏感投影。
 *
 * 真值来源只有一个：`keymaster.wallet` 里的 `key.json` 与 `.keymaster/meta`。
 * 没有桶目录、没有 Key 列表，密码与凭据都不允许出现在这里。
 */
export interface WalletSnapshot {
  readonly initialized?: boolean;
  readonly walletGeneration?: string;
  readonly publicKeyHex?: string;
  readonly keyLabel?: string;
}

/** 打开生产 preview，确认页面本身已进入可观察状态。 */
export async function openApplication(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("KeyMaster");
}

/**
 * 从真实页面的 IndexedDB 读取钱包投影，不读取业务私钥。
 *
 * 只读两份固定路径：`key.json`（唯一 KeyHold）与 `.keymaster/meta`
 * （initialized 与 walletGeneration）。仍未初始化时返回 null。
 */
export async function readWalletSnapshot(page: Page): Promise<WalletSnapshot | null> {
  const objects = await readRawWalletObjects(page, "^(?:key\\.json|\\.keymaster/meta)$");
  const metaText = objects.find((entry) => entry.path === ".keymaster/meta")?.text;
  const keyHoldText = objects.find((entry) => entry.path === "key.json")?.text;
  if (metaText === undefined) return null;
  const snapshot: { -readonly [K in keyof WalletSnapshot]: WalletSnapshot[K] } = {};
  try {
    const meta = JSON.parse(metaText) as { initialized?: unknown; walletGeneration?: unknown };
    if (typeof meta.initialized === "boolean") snapshot.initialized = meta.initialized;
    if (typeof meta.walletGeneration === "string") snapshot.walletGeneration = meta.walletGeneration;
  } catch {
    // 损坏的 meta 仍然如实报告已解析到的字段,由上层判断。
  }
  if (keyHoldText !== undefined) {
    try {
      const keyHold = JSON.parse(keyHoldText) as { publicKeyHex?: unknown; label?: unknown };
      if (typeof keyHold.publicKeyHex === "string") snapshot.publicKeyHex = keyHold.publicKeyHex;
      if (typeof keyHold.label === "string") snapshot.keyLabel = keyHold.label;
    } catch {
      // 同上：损坏的 KeyHold 不伪造字段。
    }
  }
  return snapshot;
}

/**
 * 初始化/解锁完成 = 已解锁壳层可用（主导航可见，且不在任何安全入口页）。
 *
 * Key 管理页（/settings/vault）已删除，初始化后落在首页；这里不再依赖
 * 具体业务页或 Key 标签文案，Key 真值由 readWalletPublicKey 与
 * KeymasterFormats 文件校验负责。
 */
export async function waitForUnlockedHome(page: Page, timeoutMs = 20_000): Promise<void> {
  const outcome = async (): Promise<"ready" | "failed" | "pending"> => {
    if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
    if (await page.getByRole("alert").first().isVisible().catch(() => false)) return "failed";
    const gateway = page.getByRole("heading", {
      name: /欢迎使用 Keymaster|Welcome to Keymaster|钱包已锁定|Wallet locked/u,
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

/** 读取唯一钱包 Key 的公钥（`key.json` 的存储真值；不读私钥）。 */
export async function readWalletPublicKey(page: Page): Promise<string> {
  const snapshot = await readWalletSnapshot(page);
  expect(snapshot?.publicKeyHex, "key.json 必须记录唯一钱包 Key 的公钥").toMatch(/^(02|03)[0-9a-f]{64}$/u);
  return (snapshot?.publicKeyHex ?? "").toLowerCase();
}

/** 初始化成功后，确认密码没有进入浏览器持久化目录（localStorage + IndexedDB）。 */
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
  const walletObjects = await readRawWalletObjects(page);
  const persistedObjects = walletObjects.map((entry) => `${entry.path}=${entry.text}`).join("\n");
  expect(persistedObjects, "初始化密码不能写入浏览器 IndexedDB").not.toContain(password);
}
