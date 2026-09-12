import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

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
  messages: WorkerMessageEvidence[];
}

interface WorkerMessageEvidence {
  at: number;
  direction: "inbound" | "outbound";
  type?: string;
  kind?: string;
  requestId?: string;
  controlType?: string;
  operationType?: string;
  ackStatus?: string;
  code?: string;
  message?: string;
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
    const evidence: WorkerEvidence = { constructed: 0, urls: [], snapshots: [], messages: [] };
    Object.defineProperty(window, "__keymasterDevHttpWorkerEvidence", {
      configurable: true,
      value: evidence,
    });

    function summarizeMessage(direction: WorkerMessageEvidence["direction"], value: unknown): void {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      const control = record.control;
      const operation = record.operation;
      const ack = record.ack;
      const error = record.error;
      const summary: WorkerMessageEvidence = {
        at: Math.round(performance.now()),
        direction,
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
        ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
        ...(control && typeof control === "object" && typeof (control as Record<string, unknown>).type === "string"
          ? { controlType: (control as Record<string, unknown>).type as string }
          : {}),
        ...(operation && typeof operation === "object" && typeof (operation as Record<string, unknown>).type === "string"
          ? { operationType: (operation as Record<string, unknown>).type as string }
          : {}),
        ...(ack && typeof ack === "object" && typeof (ack as Record<string, unknown>).status === "string"
          ? { ackStatus: (ack as Record<string, unknown>).status as string }
          : {}),
        ...(typeof record.code === "string" ? { code: record.code } : {}),
        ...(typeof record.message === "string" ? { message: record.message.slice(0, 240) } : {}),
        ...(error && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string"
          ? { code: (error as Record<string, unknown>).code as string } : {}),
      };
      evidence.messages.push(summary);
    }

    // Record only protocol metadata. Never retain raw messages because setup
    // requests contain the one-time password and private-key material.
    const workerPorts = new WeakSet<MessagePort>();
    const nativePostMessage = MessagePort.prototype.postMessage;
    Object.defineProperty(MessagePort.prototype, "postMessage", {
      configurable: true,
      writable: true,
      value: function (this: MessagePort, message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        if (workerPorts.has(this)) summarizeMessage("outbound", message);
        const args = arguments.length > 1 ? [message, options] : [message];
        return Reflect.apply(nativePostMessage, this, args);
      },
    });

    const nativeSharedWorker = window.SharedWorker;
    if (typeof nativeSharedWorker !== "function") return;

    const wrappedSharedWorker = function (url: string | URL, options?: SharedWorkerOptions): SharedWorker {
      const worker = new nativeSharedWorker(url, options);
      evidence.constructed += 1;
      evidence.urls.push(String(url));
      workerPorts.add(worker.port);
      worker.port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        summarizeMessage("inbound", data);
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
    if (message.type() === "error" || message.type() === "warning") errors.push(`page console.${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", (request) => errors.push(`requestfailed: ${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`));
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`response.${response.status()}: ${response.url()}`);
  });
  context.on("console", (message) => {
    if (message.page() === page || message.type() !== "error") return;
    errors.push(`worker console: ${message.text()}`);
  });
  return errors;
}

async function attachDiagnostics(page: Page, testInfo: TestInfo, browserErrors: string[]): Promise<void> {
  const evidence = await page.evaluate(() => window.__keymasterDevHttpWorkerEvidence).catch(() => undefined);
  await testInfo.attach("http-worker-evidence", {
    body: JSON.stringify(evidence ?? { unavailable: true }, null, 2),
    contentType: "application/json",
  });
  if (browserErrors.length > 0) {
    await testInfo.attach("http-browser-errors", {
      body: browserErrors.join("\n"),
      contentType: "text/plain",
    });
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  await testInfo.attach("http-page-text", {
    body: bodyText.slice(0, 20_000),
    contentType: "text/plain",
  });
}

test("Vite dev Coordinator completes Local initial setup in a non-secure HTTP context", async ({ page, context }, testInfo) => {
  // Keep the business completion barrier at 60s below. The larger outer
  // budget leaves enough time for finally{} to attach Worker/bridge evidence
  // when the barrier fails; it does not turn a hung transaction into a pass.
  test.setTimeout(120_000);
  await installWorkerEvidence(context);
  const browserErrors = collectBrowserErrors(page, context);

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const environment = await page.evaluate(() => ({
      origin: window.location.origin,
      isSecureContext: window.isSecureContext,
      hasSharedWorker: typeof window.SharedWorker === "function",
      hasServiceWorker: "serviceWorker" in navigator,
      hasEffectiveSubtle: Boolean(window.crypto?.subtle),
    }));
    expect(environment.isSecureContext).toBe(false);
    expect(environment.hasSharedWorker).toBe(true);
    expect(environment.hasServiceWorker).toBe(false);
    expect(environment.hasEffectiveSubtle).toBe(true);

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

  // Exercise the exact user-reported final step. This crosses Window -> real
  // SharedWorker -> LocalStorage bridge -> keymaster-hold/browser, including
  // its HMAC-SHA-256 document-integrity operation. The setup page itself is
  // not sufficient evidence because the failure happens only on submission.
    await page.getByRole("button", { name: /Local/ }).click();
    await page.getByLabel(/Bucket name|桶名称/u).fill("http-dev-bucket");
    await page.getByRole("button", { name: /Next|Continue|继续/u }).click();
    await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/u).fill("http-dev-password-123");
    await page.getByLabel(/Confirm password|确认密码/u).fill("http-dev-password-123");
    await page.getByRole("button", { name: /Next|Continue|继续/u }).click();
    await page.getByRole("button", { name: /Create a Key|新建 Key/u }).click();
    await page.getByLabel(/Tag Name|Key 标签名称/u).fill("http-dev-key");
    await page.getByRole("button", { name: /Next|继续确认/u }).click();
    await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/u }).click();

    await expect.poll(async () => page.evaluate(() => {
      const catalogRaw = localStorage.getItem("keymaster.storage.catalog.v2");
      let catalogReady = false;
      if (catalogRaw) {
        try {
          const catalog = JSON.parse(catalogRaw) as {
            format?: unknown;
            version?: unknown;
            selectedBucketId?: unknown;
            buckets?: Array<{ bucketId?: unknown; label?: unknown; backend?: unknown }>;
          };
          const bucket = catalog.buckets?.[0];
          catalogReady = catalog.format === "keymaster.storage.catalog"
            && catalog.version === 2
            && catalog.buckets?.length === 1
            && catalog.selectedBucketId === bucket?.bucketId
            && bucket?.label === "http-dev-bucket"
            && bucket?.backend === "local";
        } catch {
          catalogReady = false;
        }
      }
      const localKeys = Object.keys(localStorage);
      const holdReady = ["storage.json", "keys.json", "header.json", "head.json"].every((leaf) =>
        localKeys.some((key) => key.includes(".keymaster/hold/v1/") && key.endsWith(`/${leaf}`))
      );
      return {
        path: new URL(location.href).pathname,
        failed: Boolean(document.querySelector("[role=alert]")),
        keyVisible: document.body.innerText.includes("http-dev-key"),
        catalogReady,
        holdReady,
      };
    }), {
      timeout: 60_000,
      message: "HTTP non-secure initial setup should complete the final HMAC-backed transaction",
    }).toEqual({ path: "/settings/vault", failed: false, keyVisible: true, catalogReady: true, holdReady: true });
    await expect(page.getByText("http-dev-key", { exact: true }).first()).toBeVisible();
    await expect(page.locator("[data-fatal-crash]")).toHaveCount(0);

    const workerBootstrapErrors = browserErrors.filter((message) => /@react-refresh|window is not defined|pre-bootstrap\.plugins/u.test(message));
    expect(workerBootstrapErrors, workerBootstrapErrors.join("\n")).toEqual([]);
  } finally {
    await attachDiagnostics(page, testInfo, browserErrors);
  }
});
