// KMP-001 / KMP-002：真实 Chromium 页面 -> SharedWorker -> MessagePort 服务桥。
// 测试使用临时浏览器上下文和临时 Vault，不接触真实付款、广播或生产私钥。

import { expect, test, type Page } from "@playwright/test";
import { PLUGIN_LIFECYCLE_PRODUCTION_GATE } from "../../support/scenarioMetadata.js";

export const GATE_ID = PLUGIN_LIFECYCLE_PRODUCTION_GATE.id;
export const GATE_METADATA = PLUGIN_LIFECYCLE_PRODUCTION_GATE;

interface LifecycleHooks {
  bootstrap(): Promise<{
    ownerPublicKeyHex: string;
    sessionEpoch: string;
    buildId: string;
    bridgeState: string;
    services: Array<{ capabilityId: string; serviceInstanceId: string; status: string; hasServerGrant: boolean }>;
  }>;
  ownerStorageRoundTrip(): Promise<{ key: string; value: unknown; bridgeState: string; serviceInstanceId: string }>;
  deriveAddress(): Promise<{ address: string; ownerPublicKeyHex: string; serviceInstanceId: string }>;
  lockRevokesOldProxy(): Promise<{
    lockStatus: string;
    unlockStatus: string;
    oldProxyErrorCode: string;
    oldServiceInstanceId: string;
    newServiceInstanceId: string;
    oldProxyRejected: boolean;
  }>;
  dedicatedWorkerRoundTrip(): Promise<{ address: string; signatureLength: number; revoked: boolean }>;
}

async function lifecycleHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined, undefined, { timeout: 30_000 });
}

async function grantPersistentStorage(page: Page): Promise<void> {
  // Chromium 的 Playwright API 没有暴露 persistent-storage 这个 Web
  // permission 名称；用 CDP 授予 durableStorage，模拟用户已允许 OPFS
  // 持久化，避免 E2E 受无头浏览器权限策略影响。业务代码仍通过
  // navigator.storage.persisted() 做真实校验。
  const browser = page.context().browser();
  if (!browser) throw new Error("Lifecycle E2E requires a Chromium browser");
  // 先让页面进入目标 origin；about:blank target 的权限状态不会可靠地
  // 反映到后续 SharedWorker。
  // 先加载隔离 E2E 页面并等待同一页面的 hook；若先加载 permission
  // 页面再立刻导航，前一页的异步身份切换可能在 unload 后向已撤权的
  // transport 写入，造成与业务无关的 console error。
  await page.goto("/?lifecycleE2E=1", { waitUntil: "domcontentloaded" });
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("Lifecycle E2E page browser context is unavailable");
  const localOrigin = new URL(page.url()).origin;
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: localOrigin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  if (!persisted) {
    await cdp.detach();
    throw new Error("Lifecycle E2E durableStorage permission was not applied");
  }
  await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined, undefined, { timeout: 30_000 });
  // 不能在这里 detach：Chromium 会随 Browser CDP session 结束撤销该
  // context 的权限；测试结束时 Playwright 会统一关闭 Browser。
}

test.describe(GATE_ID + "：插件生命周期生产跨环境链", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await grantPersistentStorage(page);
  });

  test("真实 SharedWorker/MessagePort 提供 owner K-V 与 crypto，并具备服务端 grant", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => {
      const hooks = window.__lifecycleProductionE2E!;
      const bootstrap = await hooks.bootstrap();
      const storage = await hooks.ownerStorageRoundTrip();
      const crypto = await hooks.deriveAddress();
      return { bootstrap, storage, crypto };
    });

    expect(evidence.bootstrap.bridgeState).toBe("ready");
    expect(evidence.bootstrap.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "coordinator.owner-storage", status: "ready", hasServerGrant: true }),
      expect.objectContaining({ capabilityId: "coordinator.crypto", status: "ready", hasServerGrant: true }),
    ]));
    expect(evidence.storage.value).toEqual({ source: "browser-shared-worker-message-port", ok: true });
    expect(evidence.storage.serviceInstanceId).toBeTruthy();
    expect(evidence.crypto.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/u);
    expect(evidence.crypto.ownerPublicKeyHex).toHaveLength(66);
    expect(evidence.crypto.serviceInstanceId).toBeTruthy();
  });

  test("锁屏立即拒绝旧代理，解锁后生成新的 Provider 实例", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => window.__lifecycleProductionE2E!.lockRevokesOldProxy());

    expect(evidence.lockStatus).toBe("accepted");
    expect(["accepted", "already-unlocked"]).toContain(evidence.unlockStatus);
    expect(evidence.oldProxyRejected).toBe(true);
    expect(evidence.oldProxyErrorCode).not.toBe("none");
    expect(evidence.oldServiceInstanceId).toBeTruthy();
    expect(evidence.newServiceInstanceId).toBeTruthy();
    expect(evidence.newServiceInstanceId).not.toBe(evidence.oldServiceInstanceId);
  });

  test("真实启动 Dedicated Worker 的 Session Crypto 并在 dispose 后撤权", async ({ page }) => {
    test.setTimeout(90_000);
    await lifecycleHooks(page);
    const evidence = await page.evaluate(async () => window.__lifecycleProductionE2E!.dedicatedWorkerRoundTrip());

    expect(evidence.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/u);
    expect(evidence.signatureLength).toBeGreaterThan(0);
    expect(evidence.revoked).toBe(true);
  });

});
