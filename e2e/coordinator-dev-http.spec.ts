import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface WorkerSnapshotEvidence {
  state: string;
  runtimeKind: string;
  revision: number;
  runtimeInstanceId: string;
}

interface WorkerEvidence {
  constructed: number;
  urls: string[];
  snapshots: WorkerSnapshotEvidence[];
}

declare global {
  interface Window {
    __keymasterDevHttpWorkerEvidence?: WorkerEvidence;
  }
}

/**
 * Observe the real SharedWorker boundary without replacing the Worker with a
 * test double. The wrapper only records constructor arguments and raw
 * WebLoom snapshots before returning the native SharedWorker instance.
 */
async function installWorkerEvidence(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const evidence: WorkerEvidence = { constructed: 0, urls: [], snapshots: [] };
    Object.defineProperty(window, "__keymasterDevHttpWorkerEvidence", {
      configurable: true,
      value: evidence,
    });

    const nativeSharedWorker = window.SharedWorker;
    if (typeof nativeSharedWorker !== "function") return;

    const wrappedSharedWorker = function (url: string | URL, options?: SharedWorkerOptions): SharedWorker {
      const worker = new nativeSharedWorker(url, options);
      evidence.constructed += 1;
      evidence.urls.push(String(url));
      worker.port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (!data || typeof data !== "object") return;
        const snapshot = data as Partial<WorkerSnapshotEvidence> & { type?: unknown };
        if (snapshot.type !== "webloom.runtime.v1.snapshot") return;
        if (typeof snapshot.state !== "string" || typeof snapshot.runtimeKind !== "string" ||
          !Number.isSafeInteger(snapshot.revision) || typeof snapshot.runtimeInstanceId !== "string") return;
        evidence.snapshots.push({
          state: snapshot.state,
          runtimeKind: snapshot.runtimeKind,
          revision: snapshot.revision,
          runtimeInstanceId: snapshot.runtimeInstanceId,
        });
      });
      return worker;
    };

    Object.setPrototypeOf(wrappedSharedWorker, nativeSharedWorker);
    Object.defineProperty(wrappedSharedWorker, "prototype", { value: nativeSharedWorker.prototype });
    Object.defineProperty(window, "SharedWorker", {
      configurable: true,
      writable: true,
      value: wrappedSharedWorker,
    });
  });
}

function collectBrowserErrors(page: Page, context: BrowserContext): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`page console: ${message.text()}`);
  });
  context.on("console", (message) => {
    if (message.page() === page || message.type() !== "error") return;
    errors.push(`worker console: ${message.text()}`);
  });
  return errors;
}

test("Vite dev Coordinator starts in a non-secure HTTP context", async ({ page, context }) => {
  test.setTimeout(30_000);
  await installWorkerEvidence(context);
  const browserErrors = collectBrowserErrors(page, context);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const environment = await page.evaluate(() => ({
    origin: window.location.origin,
    isSecureContext: window.isSecureContext,
    hasSharedWorker: typeof window.SharedWorker === "function",
    hasServiceWorker: "serviceWorker" in navigator,
  }));
  expect(environment.isSecureContext).toBe(false);
  expect(environment.hasSharedWorker).toBe(true);
  expect(environment.hasServiceWorker).toBe(false);

  // This is the readiness barrier: the page is considered bootstrapped only
  // after a raw ready snapshot from the real Worker and the first setup page
  // have both arrived. No fixed sleep is used to guess startup completion.
  await page.waitForFunction(() => {
    const evidence = window.__keymasterDevHttpWorkerEvidence;
    const workerReady = evidence?.snapshots.some((snapshot) =>
      snapshot.state === "ready" &&
      snapshot.runtimeKind === "shared-worker" &&
      snapshot.runtimeInstanceId.length > 0
    );
    const setupPage = document.body.innerText.includes("Choose a bucket type") ||
      document.body.innerText.includes("选择一个桶类型");
    return evidence?.constructed === 1 && workerReady && setupPage;
  }, undefined, { timeout: 20_000 });

  const evidence = await page.evaluate(() => window.__keymasterDevHttpWorkerEvidence);
  expect(evidence?.constructed).toBe(1);
  expect(evidence?.urls[0]).toMatch(/keymasterSessionCoordinator\.worker\.ts\?worker_file/u);
  expect(evidence?.snapshots.some((snapshot) =>
    snapshot.state === "ready" && snapshot.runtimeKind === "shared-worker" && snapshot.runtimeInstanceId.length > 0
  )).toBe(true);
  await expect(page.locator("[data-fatal-crash]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Choose a bucket type|选择一个桶类型/u })).toBeVisible();

  const workerBootstrapErrors = browserErrors.filter((message) => /@react-refresh|window is not defined|pre-bootstrap\.plugins/u.test(message));
  expect(workerBootstrapErrors, workerBootstrapErrors.join("\n")).toEqual([]);
});
