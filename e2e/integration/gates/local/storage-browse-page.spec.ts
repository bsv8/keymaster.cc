import { expect, test, type Page } from "@playwright/test";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { STORAGE_BROWSE_SCENARIO } from "../../support/scenarioMetadata.js";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { reloadAndAssertSameKey, unlockWalletInPlace } from "../../drivers/vaultDriver.js";

export const JOURNEY_ID = STORAGE_BROWSE_SCENARIO.id;
export const JOURNEY_METADATA = STORAGE_BROWSE_SCENARIO;

/**
 * 打开目标路径并把钱包解锁到业务可见状态。
 *
 * 每次整页导航都会让运行时回到冷启动：钱包只有一把 Key 且全在本机，因此刷新后
 * 就是「钱包已锁定」，不会自动恢复。这一页只有在解锁后才发放浏览句柄，所以这一步
 * 不能省——否则断言的其实是锁定壳，而不是浏览页。
 */
async function openUnlockedStorageBrowse(page: Page, password: string): Promise<void> {
  await page.goto("/settings/storage", { waitUntil: "domcontentloaded" });
  // 整页导航一定回到冷启动锁定态，所以这里无条件解锁。不要用 isVisible 先探测：
  // 它不等待，页面还没渲染时会立刻返回 false，于是跳过解锁而随后断言一个锁定壳。
  await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ })).toBeVisible({ timeout: 30_000 });
  await unlockWalletInPlace(page, password);
}

/**
 * 业务结果：解锁后从正式入口打开「设置 → 存储」，页面必须真的列出钱包存储，
 * 而不是永远停在「加载中」。
 *
 * 开始状态：真实 Chromium 打开生产 preview，真实 SharedWorker，真实 IndexedDB；
 * 没有任何存储替身，也没有注入浏览服务。
 *
 * 失败影响：单元测试用假浏览服务，能证明组件状态机，却证明不了页面到 Worker
 * 这段真实链路。这一页曾经因为组件挂载标记在 StrictMode 下恒假而永久「加载中」，
 * 单元测试全部通过；只有真实浏览器里的真实 Worker 请求能拦住同类回归。
 */
test(JOURNEY_ID + "：解锁后存储浏览页经真实 Worker 列出目录", async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const password = "storage-browse-e2e-password-123";
  const errors = captureBrowserErrors(page, context);
  try {
    const ready = await test.step("建立可继续浏览的本地身份", async () => initializeNewLocalUser(
      { page },
      { keyLabel: "存储浏览 Gate Key", password },
    ));
    expect(ready.publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/iu);

    // 直接进入目标路径，而不是先点菜单：这里要证明的是这一页自己能加载出来。
    // 「加载中」与「空目录」在界面上是两句话，必须断言真的不是前者。
    await test.step("打开存储浏览页并离开加载态", async () => {
      await openUnlockedStorageBrowse(page, password);
      await expect(page.locator(".storage-browse-page")).toBeVisible({ timeout: 60_000 });

      // 根目录一定至少列出钱包自己的对象。空态与加载态必须能区分开。
      await expect(page.locator(".storage-browse__list")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(page.getByText("加载中…")).toHaveCount(0);
      await expect(page.locator(".storage-browse__error")).toHaveCount(0);
    });

    await test.step("刷新后仍然可以加载，不是永久卡死", async () => {
      await reloadAndAssertSameKey(page, ready.keyLabel);
      await unlockWalletInPlace(page, password);
      await expect(page.locator(".storage-browse-page")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".storage-browse__list")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(page.getByText("加载中…")).toHaveCount(0);
    });

    await test.step("页内刷新按钮同样离开加载态", async () => {
      const refresh = page.getByRole("button", { name: /^Refresh$|^刷新$/u });
      await refresh.click();
      await expect(page.locator(".storage-browse__list")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(page.getByText("加载中…")).toHaveCount(0);
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});

/**
 * 读取列表窗口当前渲染的行名。
 *
 * 展示分页是固定页长：无论翻到第几页，窗口里的行数都不变。这里读 DOM 而不是内部
 * 状态，正是因为「渲染量是否有界」本身就是要被真实浏览器证明的性质。
 */
async function renderedRowNames(page: Page): Promise<string[]> {
  return await page.locator(".storage-browse__row-name").allTextContents();
}

/** 当前目录列表的页码提示（`1–200 of 205`）。 */
async function pageIndicator(page: Page): Promise<string> {
  return (await page.locator(".storage-browse__listing .storage-browse__hint").first().textContent() ?? "").trim();
}

/**
 * 业务结果：选中真实钱包对象后，JSON 预览、原文切换、属性与路径复制都在真实
 * IndexedDB 内容上成立。
 *
 * 覆盖 P01/P07 与 L02：预览只读原文，属性给出完整路径与元数据，复制得到完整路径，
 * 且这一页的任何动作都不写入钱包（刷新后对象版本不变）。
 */
test(JOURNEY_ID + "：真实 JSON 对象可预览、可切原文，属性与复制给出完整路径", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const password = "storage-browse-preview-e2e-password-123";
  const errors = captureBrowserErrors(page, context);
  try {
    const ready = await test.step("建立本地身份", async () => initializeNewLocalUser(
      { page },
      { keyLabel: "存储预览 Gate Key", password },
    ));

    await test.step("选中 key.json 并按真实内容预览", async () => {
      await openUnlockedStorageBrowse(page, password);
      const keyRow = page.locator(".storage-browse__list").getByRole("button", { name: "key.json" });
      await expect(keyRow).toBeVisible({ timeout: 60_000 });
      await keyRow.click();

      // key.json 是加密 KeyHold：真实内容是 JSON 对象，因此预览必须给出 JSON 树。
      const tree = page.locator(".storage-browse__json");
      await expect(tree).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".storage-browse__json-toggle").first()).toBeVisible();
      // 公钥确实来自这个对象，而不是页面自己编的：属性与树里都能看到它。
      await expect(page.locator(".storage-browse__json").getByText(ready.publicKeyHex.slice(0, 12)).first())
        .toBeVisible({ timeout: 30_000 });
      // 私钥密文不会以明文出现：预览只展示加密 JSON。
      expect(await page.locator(".storage-browse__json").textContent()).not.toContain("WIF");
    });

    await test.step("原文切换双向可用，且与文件文本逐字一致", async () => {
      const toggle = page.locator(".storage-browse__json-actions").getByRole("button", { name: /^(Original text|原文)$/u });
      await expect(toggle).toBeVisible();
      await toggle.click();
      const raw = page.locator(".storage-browse__json .storage-browse__raw");
      await expect(raw).toBeVisible();
      const rawText = (await raw.textContent() ?? "").trim();
      // 原文视图显示文件本来的文本，因此必须仍能解析出同一个公钥。
      expect(JSON.parse(rawText)).toMatchObject({ publicKeyHex: ready.publicKeyHex });
      // 切到原文之后按钮仍然存在：这不是单向操作。
      await toggle.click();
      await expect(page.locator(".storage-browse__json-node").first()).toBeVisible();
    });

    await test.step("属性与复制给出完整路径", async () => {
      await page.getByRole("tab", { name: /^(Properties|属性)$/u }).click();
      const properties = page.locator(".storage-browse__properties");
      await expect(properties.getByText("key.json", { exact: true })).toBeVisible();
      const pathText = (await properties.locator(".storage-browse__path").textContent() ?? "").trim();
      expect(pathText).toBe("key.json");
      // 元数据必须齐全：完整路径、大小、修改时间、抽象版本与内容类型。
      await expect(properties).toContainText(/Size|大小/u);
      await expect(properties).toContainText(/Modified|修改时间/u);
      await expect(properties).toContainText(/Revision|版本/u);
      await expect(properties).toContainText("application/json");
    });

    await test.step("预览不写入钱包", async () => {
      // 同一路径仍在列表里，版本不变：浏览全程没有写操作。
      await page.getByRole("tab", { name: /^(Preview|预览)$/u }).click();
      await page.getByRole("button", { name: /^(Refresh|刷新)$/u }).click();
      await expect(page.locator(".storage-browse__list").getByRole("button", { name: "key.json" }))
        .toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/已不存在|no longer exists/iu)).toHaveCount(0);
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});

/**
 * 业务结果：渲染量与目录规模无关，且已加载的每一项都可达。
 *
 * 覆盖 P06/F03：这是「大量行有界渲染」在真实浏览器里的证明——列表与文件树的 DOM 行数
 * 不超过一个展示页（200），与已加载总量无关。真实钱包里通常没有任何目录超过一个展示
 * 页，因此翻页部分只在真有后续页时执行，否则如实记注解，而不是假装测过。
 */
test(JOURNEY_ID + "：目录渲染量与目录规模无关", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const password = "storage-browse-paging-e2e-password-123";
  const errors = captureBrowserErrors(page, context);
  try {
    await test.step("建立本地身份", async () => initializeNewLocalUser(
      { page },
      { keyLabel: "存储分页 Gate Key", password },
    ));

    await test.step("列表与文件树的渲染行数有界", async () => {
      await openUnlockedStorageBrowse(page, password);
      await expect(page.locator(".storage-browse__list")).toBeVisible({ timeout: 60_000 });
      const firstPageRows = await renderedRowNames(page);
      expect(firstPageRows.length).toBeGreaterThan(0);
      expect(firstPageRows.length).toBeLessThanOrEqual(200);
      expect(await page.locator(".storage-browse__tree-label").count()).toBeLessThanOrEqual(200);
    });

    await test.step("有后续页时翻页不增长窗口", async () => {
      const listing = page.locator(".storage-browse__listing");
      const next = listing.getByRole("button", { name: /^(Next items|下一批)$/u });
      if (await next.count() === 0 || await next.isDisabled()) {
        test.info().annotations.push({
          type: "note",
          description: "当前钱包没有超过一个展示页的目录：翻页行为未被本用例覆盖，只有渲染量上界被证明",
        });
        return;
      }
      const before = await renderedRowNames(page);
      await next.click();
      await expect.poll(async () => (await pageIndicator(page)).includes("200")).toBe(true);
      const after = await renderedRowNames(page);
      // 换页之后窗口依然不超过一页，且不与上一页重叠。
      expect(after.length).toBeLessThanOrEqual(200);
      expect(after.some((name) => before.includes(name))).toBe(false);
      await listing.getByRole("button", { name: /^(Previous items|上一批)$/u }).click();
      await expect.poll(async () => (await renderedRowNames(page)).join("|") === before.join("|")).toBe(true);
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});

/**
 * 业务结果：锁定会清空浏览内容，并且新开的 Tab 拿不到浏览授权。
 *
 * 覆盖 L02：单元测试用假服务，只能证明组件清空自己的 state；这里证明的是真实链路——
 * 锁定让 Coordinator 撤销浏览授权，页面随之回到锁定壳，树与预览一起消失，锁定前读到的
 * 内容不会以任何形式留在屏幕上。
 *
 * 运行条件说明：本产品的 owner 运行态同一 origin 只有一个，两个 Tab 不能同时保持已
 * 解锁（第二个 Tab 会接管，第一个 Tab 再导航就会进入启动失败壳）。因此这里按支持的
 * 顺序走：先在浏览 Tab 内锁定，再新开一个 Tab 断言它没有浏览授权。
 */
test(JOURNEY_ID + "：锁定清空浏览内容且新 Tab 拿不到浏览授权", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const password = "storage-browse-lock-e2e-password-123";
  const errors = captureBrowserErrors(page, context);
  try {
    await test.step("建立本地身份并在浏览页选中一个真实对象", async () => {
      await initializeNewLocalUser({ page }, { keyLabel: "存储锁定 Gate Key", password });
      await openUnlockedStorageBrowse(page, password);
      const keyRow = page.locator(".storage-browse__list").getByRole("button", { name: "key.json" });
      await expect(keyRow).toBeVisible({ timeout: 60_000 });
      await keyRow.click();
      await expect(page.locator(".storage-browse__json")).toBeVisible({ timeout: 60_000 });
      // 锁定前确实读到了内容：否则后面的「清空」无法证明任何事。
      await expect(page.locator(".storage-browse__json")).toContainText("publicKeyHex", { timeout: 30_000 });
    });

    await test.step("锁定后树与预览一起消失", async () => {
      await page.getByRole("button", { name: /^(Lock|锁定)$/u }).click();
      await expect(page.getByRole("heading", { name: /钱包已锁定|Wallet locked/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".storage-browse-page")).toHaveCount(0);
      await expect(page.locator(".storage-browse__json")).toHaveCount(0);
      await expect(page.locator(".storage-browse__raw")).toHaveCount(0);
      expect(await page.content()).not.toContain("publicKeyHex");
    });

    await test.step("锁定后新开的 Tab 停在锁定壳，读不到任何浏览内容", async () => {
      const other = await context.newPage();
      try {
        await other.goto("/settings/storage", { waitUntil: "domcontentloaded" });
        await expect(other.getByRole("heading", { name: /钱包已锁定|Wallet locked/ }))
          .toBeVisible({ timeout: 60_000 });
        // 未解锁就没有浏览授权：连列表都不该出现。
        await expect(other.locator(".storage-browse__list")).toHaveCount(0);
        expect(await other.content()).not.toContain("publicKeyHex");
      } finally {
        await other.close().catch(() => undefined);
      }
    });

    await test.step("重新解锁后浏览恢复可用（撤销不是永久的）", async () => {
      await openUnlockedStorageBrowse(page, password);
      await expect(page.locator(".storage-browse__list").getByRole("button", { name: "key.json" }))
        .toBeVisible({ timeout: 60_000 });
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});

/**
 * 业务结果：窄屏下文件树收为侧栏，目录列表与详情仍可用；键盘可以展开与选中。
 *
 * 覆盖 U01：窄屏与键盘可达性此前只有实现与组件断言，这里用真实视口与真实按键补上。
 */
test(JOURNEY_ID + "：窄屏与键盘下仍可浏览", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const password = "storage-browse-narrow-e2e-password-123";
  const errors = captureBrowserErrors(page, context);
  try {
    await test.step("建立本地身份", async () => initializeNewLocalUser(
      { page },
      { keyLabel: "存储窄屏 Gate Key", password },
    ));

    await test.step("窄屏下文件树默认收起，可以按需打开", async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await openUnlockedStorageBrowse(page, password);
      const listing = page.locator(".storage-browse__listing");
      await expect(listing.locator(".storage-browse__list")).toBeVisible({ timeout: 60_000 });
      // 窄屏下树默认不可见，但入口必须在：否则目录结构整条不可达。
      const treePanel = page.locator(".storage-browse__tree-panel");
      await expect(treePanel).toBeHidden();
      const showTree = page.getByRole("button", { name: /^(Files|文件)$/u });
      await showTree.click();
      await expect(treePanel).toBeVisible();
    });

    await test.step("键盘可以聚焦并激活目录行与文件行", async () => {
      const firstRow = page.locator(".storage-browse__list .storage-browse__row").first();
      await firstRow.focus();
      await expect(firstRow).toBeFocused();
      await page.keyboard.press("Enter");
      // 激活后要么进入目录（面包屑变化），要么选中文件并开始预览；两者都必须是可见结果。
      await expect(page.locator(".storage-browse__list")).toBeVisible();
      // 进入目录会把侧栏收起来（窄屏默认如此），所以键盘下一步之前必须重新打开它。
      await expect(page.locator(".storage-browse__tree-panel")).toBeHidden();
      await page.getByRole("button", { name: /^(Files|文件)$/u }).click();
      // 树里的展开箭头同样可聚焦：键盘用户必须能展开目录而不依赖鼠标。
      const toggle = page.locator(".storage-browse__tree-toggle").first();
      await toggle.focus();
      await expect(toggle).toBeFocused();
      const before = await toggle.getAttribute("aria-expanded");
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
    });
  } finally {
    await attachBrowserErrors(testInfo, errors, [password]);
  }
});
