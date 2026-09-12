import { expect, test, type Page, type TestInfo } from "@playwright/test";

const DEMO_BUCKET_NAME = "demo";
const TEST_KEY_NAME = "test";
const SETUP_PASSWORD = "demo-test-password-123";

async function attachRuntimeEvidence(page: Page, testInfo: TestInfo, browserErrors: string[]): Promise<void> {
  const details = page.locator("details").first();
  if (await details.isVisible().catch(() => false)) {
    await details.locator("summary").click();
    const diagnostic = await details.locator("pre").textContent();
    if (diagnostic) {
      await testInfo.attach("initial-setup-diagnostic", {
        body: diagnostic,
        contentType: "text/plain",
      });
    }
  }
  if (browserErrors.length > 0) {
    await testInfo.attach("browser-errors", {
      body: browserErrors.join("\n"),
      contentType: "text/plain",
    });
  }
}

/**
 * 真实浏览器冒烟：不注入 localStorage、Web Locks 或 Worker 测试替身。
 * 覆盖 Window -> SharedWorker -> Window localStorage bridge -> runtime 安装。
 */
test("Local runtime smoke creates demo bucket and generated test private key", async ({ page, context }, testInfo) => {
  test.setTimeout(30_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserErrors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  context.on("console", (message) => {
    if (message.page() === page) return;
    if (message.type() === "error" || message.type() === "warning") {
      browserErrors.push(`worker.${message.type()}: ${message.text()}`);
    }
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: /Local/ }).click();
    await page.getByLabel(/Bucket name|桶名称/).fill(DEMO_BUCKET_NAME);
    await page.getByRole("button", { name: /Next|Continue|继续/ }).click();
    await page.getByLabel(/Password \(at least 8 characters\)|密码（至少 8 位）/).fill(SETUP_PASSWORD);
    await page.getByLabel(/Confirm password|确认密码/).fill(SETUP_PASSWORD);
    await page.getByRole("button", { name: /Next|Continue|继续/ }).click();
    await page.getByRole("button", { name: /Create a Key|新建 Key/ }).click();
    await page.getByLabel(/Tag Name/).fill(TEST_KEY_NAME);
    await page.getByRole("button", { name: /Next|继续确认/ }).click();
    await page.getByRole("button", { name: /Create bucket and first Key|创建桶和第一把 Key/ }).click();

    const runtimeOutcome = async () => {
      if (await page.getByRole("alert").first().isVisible().catch(() => false)) return "failed";
      if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
      // URL 会在插件装配完成前改变；必须同时看到首 Key，才算运行态就绪。
      if (new URL(page.url()).pathname === "/settings/vault"
        && await page.getByText(TEST_KEY_NAME, { exact: true }).first().isVisible()) return "ready";
      return "pending";
    };
    await expect.poll(runtimeOutcome, {
      timeout: 15_000,
      message: "首次初始化应进入运行态，或显示可诊断的失败信息",
    }).not.toBe("pending");
    expect(await runtimeOutcome(), "首次初始化不得回滚到错误页").toBe("ready");
    const catalog = await page.evaluate(() => {
      const encoded = localStorage.getItem("keymaster.storage.catalog.v2");
      return encoded ? JSON.parse(encoded) as { selectedBucketId?: string; buckets?: Array<{ bucketId?: string; label?: string; backend?: string }> } : null;
    });
    expect(catalog?.buckets).toHaveLength(1);
    expect(catalog?.buckets?.[0]).toMatchObject({ label: DEMO_BUCKET_NAME, backend: "local" });
    expect(catalog?.selectedBucketId).toBe(catalog?.buckets?.[0]?.bucketId);

    // 首次初始化成功不是终点：新页面必须能从已持久化的 Local 桶恢复，
    // 不能在 configStore.hydrate() 阶段退化成 pre-bootstrap fatal。
    await page.reload();
    const refreshOutcome = async () => {
      if (await page.getByRole("heading", { name: /启动\/运行失败/ }).isVisible().catch(() => false)) return "failed";
      if (await page.getByText(/Keymaster 脱敏诊断/).isVisible().catch(() => false)) return "failed";
      const selectedKey = page.getByRole("region", { name: /Selected private key|当前选择的私钥/ });
      if (new URL(page.url()).pathname === "/settings/vault"
        && await selectedKey.getByText(new RegExp(`^${TEST_KEY_NAME}\\s*·`)).isVisible().catch(() => false)) return "ready";
      return "pending";
    };
    await expect.poll(refreshOutcome, {
      timeout: 15_000,
      message: "刷新后应从 Local 桶恢复并显示首 Key，或显示可诊断的启动失败",
    }).not.toBe("pending");
    expect(await refreshOutcome(), "刷新后不得进入 pre-bootstrap fatal").toBe("ready");
  } finally {
    await attachRuntimeEvidence(page, testInfo, browserErrors);
  }
});
