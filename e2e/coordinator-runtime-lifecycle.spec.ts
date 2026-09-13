import { expect, test, type Page } from "@playwright/test";

/**
 * 这些 hook 只在 VITE_MSFILE_E2E=1 的隔离构建中存在；页面仍使用真实
 * WindowApp → SharedWorker → WebLoom MessagePort → Coordinator 链路。
 */
interface LifecycleHooks {
  bootstrap(): Promise<unknown>;
  ownerStorageRoundTrip(): Promise<{
    value: unknown;
    bridgeState: string;
    serviceInstanceId: string;
    ownerPeerId: string;
    ownerHandoffRevision: number;
    ownerPeerObservable: boolean;
    ownerBindingObservable: boolean;
    ownerBindingMatchesRuntime: boolean;
  }>;
  disconnectRuntime(): Promise<{
    oldServiceInstanceId: string;
    oldProxyErrorCode: string;
    connectedAfterDisconnect: boolean;
    connectionState: string;
    closeDrainSupported: boolean;
    closeDrainCompleted: boolean;
    closeDrainTimedOut: boolean;
    closeDrainPendingExecutions: number;
    wasStorageIoOwner: boolean;
    ownerPeerId: string;
    ownerHandoffRevision: number;
    ownerPeerObservable: boolean;
    ownerBindingObservable: boolean;
  }>;
  lateSessionResultAfterReconnect(): Promise<{
    barrierStarted: boolean;
    pendingBeforeClose: number;
    reconnectAttemptSettled: boolean;
    lateResultCleanupCompleted: boolean;
    connectedAfterLateResult: boolean;
    connectionStateAfterLateResult: string;
  }>;
}

declare global {
  interface Window {
    __lifecycleProductionE2E?: LifecycleHooks;
  }
}

async function lifecyclePage(page: Page, label: string): Promise<void> {
  try {
    await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined, undefined, { timeout: 30_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      url: location.href,
      hook: typeof window.__lifecycleProductionE2E,
      rootText: document.querySelector("#root")?.textContent?.slice(0, 300) ?? "",
      scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
      resourceNames: performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("e2e-hooks") || name.includes("main-")),
    }));
    console.log(`[${label}:hook-timeout] ${JSON.stringify(state)}`);
    throw error;
  }
}

interface BrowserDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
}

function collectBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error.stack ?? error.message);
  });
  return diagnostics;
}

function assertCleanBrowserDiagnostics(label: string, diagnostics: BrowserDiagnostics): void {
  expect(diagnostics.consoleErrors, `${label} browser console errors`).toEqual([]);
  expect(diagnostics.pageErrors, `${label} page errors`).toEqual([]);
}

async function grantPersistentStorage(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("Coordinator lifecycle E2E requires Chromium");
  // 先加载隔离 E2E 页面并在同一文档完成授权；先加载 permission 页面
  // 再立即导航会让上一页的异步身份切换在 unload 后命中已撤权 transport。
  await page.goto("/?lifecycleE2E=1", { waitUntil: "domcontentloaded" });
  const pageCdp = await page.context().newCDPSession(page);
  const target = await pageCdp.send("Target.getTargetInfo");
  await pageCdp.detach();
  const browserContextId = target.targetInfo.browserContextId;
  if (!browserContextId) throw new Error("Chromium browser context id is unavailable");
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.grantPermissions", {
    origin: new URL(page.url()).origin,
    browserContextId,
    permissions: ["durableStorage"],
  });
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  console.log("lifecycle test storage persisted:", persisted, "origin:", page.url());
  if (!persisted) {
    throw new Error("Chromium durableStorage permission was not applied");
  }
  await page.waitForFunction(() => window.__lifecycleProductionE2E !== undefined, undefined, { timeout: 30_000 });
}

test.describe("Coordinator WebLoom peer 生命周期真实业务链", () => {
  test.describe.configure({ mode: "serial" });

  test("关闭一个 tab 后，另一个 tab 完成 owner handoff 且旧 close 不影响新 peer", async ({ page, context }) => {
    test.setTimeout(120_000);
    const pageTwo = await context.newPage();
    const pageOneDiagnostics = collectBrowserDiagnostics(page);
    const pageTwoDiagnostics = collectBrowserDiagnostics(pageTwo);
    try {
      await grantPersistentStorage(page);
      await lifecyclePage(page, "page-one");
      // 首次 OPFS/Coordinator bootstrap 是同源全局初始化；先让一个
      // 页面完成真实 Storage health，再让第二个 peer 加入，避免把
      // 初始化竞争误判成生命周期失败。
      await page.evaluate(async () => window.__lifecycleProductionE2E!.bootstrap());
      await pageTwo.goto("/?lifecycleE2E=1", { waitUntil: "domcontentloaded" });
      await lifecyclePage(pageTwo, "page-two");
      await pageTwo.evaluate(async () => window.__lifecycleProductionE2E!.bootstrap());

      // pageTwo 的 close 在 pageOne 已经 open 后才发送，属于旧 peer 的
      // late-close 顺序；Worker 必须按完整 session binding 定向撤权。
      const closed = await pageTwo.evaluate(async () => window.__lifecycleProductionE2E!.disconnectRuntime());
      const survivor = await page.evaluate(async () => window.__lifecycleProductionE2E!.ownerStorageRoundTrip());

      expect(closed.oldServiceInstanceId).toBeTruthy();
      // 这是严格的 0.4.2 验收：缺少任一生命周期/owner 投影能力都必须
      // 失败，不能把旧 registry 版本的降级路径报告成新契约通过。
      expect(closed.closeDrainSupported).toBe(true);
      expect(closed.closeDrainCompleted).toBe(true);
      expect(closed.closeDrainTimedOut).toBe(false);
      expect(closed.closeDrainPendingExecutions).toBe(0);
      expect(closed.ownerPeerObservable).toBe(true);
      expect(closed.ownerBindingObservable).toBe(true);
      expect(closed.wasStorageIoOwner).toBe(true);
      expect(closed.ownerPeerId).toBeTruthy();
      expect(closed.ownerHandoffRevision).toBeGreaterThan(0);
      expect(["service_revoked", "transport_disconnected"]).toContain(closed.oldProxyErrorCode);
      expect(closed.connectedAfterDisconnect).toBe(false);
      expect(closed.connectionState).toBe("recoverable");
      expect(survivor.bridgeState).toBe("ready");
      expect(survivor.serviceInstanceId).toBeTruthy();
      expect(survivor.ownerPeerObservable).toBe(true);
      expect(survivor.ownerBindingObservable).toBe(true);
      expect(survivor.ownerPeerId).toBeTruthy();
      expect(survivor.ownerHandoffRevision).toBeGreaterThan(closed.ownerHandoffRevision);
      expect(survivor.ownerBindingMatchesRuntime).toBe(true);
      expect(survivor.value).toEqual({ source: "browser-shared-worker-message-port", ok: true });
      assertCleanBrowserDiagnostics("page-one", pageOneDiagnostics);
      assertCleanBrowserDiagnostics("page-two", pageTwoDiagnostics);
    } finally {
      await pageTwo.close().catch(() => undefined);
    }
  });

  test("in-flight session.open 在物理撤权后作为 late result 被丢弃", async ({ page }) => {
    test.setTimeout(120_000);
    const diagnostics = collectBrowserDiagnostics(page);
    await grantPersistentStorage(page);
    await lifecyclePage(page, "single");
    const result = await page.evaluate(async () => window.__lifecycleProductionE2E!.lateSessionResultAfterReconnect());

    // barrier.started 证明真实反向 MessagePort 请求已经进入 Window；
    // pendingBeforeClose 证明关闭发生时 Runtime 仍有实际调用槽，不能用
    // fixed sleep 代替；关闭后必须保持 recoverable 且不自动复活旧 session。
    expect(result.barrierStarted).toBe(true);
    expect(result.pendingBeforeClose).toBeGreaterThan(0);
    expect(result.reconnectAttemptSettled).toBe(true);
    expect(result.lateResultCleanupCompleted).toBe(true);
    expect(result.connectedAfterLateResult).toBe(false);
    expect(result.connectionStateAfterLateResult).toBe("recoverable");
    assertCleanBrowserDiagnostics("single", diagnostics);
  });
});
