import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { lockWallet, unlockWallet } from "../../drivers/vaultDriver.js";
import { readLocalCatalog, readSessionPublicKey, waitForUnlockedHome } from "../../drivers/appDriver.js";
import { assertLocalBucketLockReleased, assertLocalBucketStorage, identityFileMap, readRawLocalStorage } from "../../support/localBucketFormats.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { LOCAL_INIT_MENU_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_INIT_MENU_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_INIT_MENU_SCENARIO;

/**
 * 业务目标：
 * 新用户建立第一个 Local 保险箱和身份，并在刷新、锁定后继续使用 Keymaster。
 *
 * 用户价值：
 * 证明用户首次打开浏览器时能完成存储优先的初始化，而不是只看到一个已改变的 URL。
 *
 * 开始状态：
 * - 一个全新的 Chromium context；
 * - 没有历史 Local catalog、Vault 或 active Key；
 * - 不读取 S3、testnet 或任何长期秘密。
 *
 * 成功标准：
 * - 初始化事务只执行一次并创建一把带标签的 Key；
 * - Local catalog 只有一个选中桶，密码没有进入 localStorage；
 * - 刷新和锁定/重新解锁后仍是同一业务身份。
 *
 * 业务风险：
 * 如果页面过早宣布 ready，用户可能在快照或 Key 尚未落盘时继续操作，刷新后丢失身份。
 * 如果锁定后旧运行态仍可用，私钥相关能力会越过用户的安全边界。
 *
 * 外部资源与收尾：
 * 只使用本次浏览器 context 的 Local 数据；context 关闭后由 Playwright 丢弃，未产生远端影响。
 *
 * 覆盖需求：KM-INIT-001、KM-VAULT-001、KM-NAV-001。
 */
test(JOURNEY_ID + "：新用户初始化、刷新恢复、锁定和重新解锁", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const password = "local-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);

  try {
    const ready = await test.step("用户创建第一个本地保险箱和身份", async () => initializeNewLocalUser(
      { page },
      { bucketLabel: "Local 集成测试桶", keyLabel: "集成测试首 Key", password },
    ));

    // 存储真值：按 KeymasterFormats 检查桶内实际文件（device 记录、session、
    // keys/<公钥>.keyhold、lock.json）是否齐全且内容正确。
    const initialStorage = await test.step("检查桶内实际文件符合 KeymasterFormats", async () =>
      assertLocalBucketStorage(page, {
        bucketId: ready.bucketId,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      }));
    expect(initialStorage.keyLock, "解锁使用中的 Key 必须持有未过期的应用锁").toBeDefined();

    await test.step("用户刷新后直接回到锁定页,并用该 Key 的密码重新解锁", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const catalogBeforeWrongPassword = await readLocalCatalog(page);
      const filesBeforeWrongPassword = identityFileMap(await readRawLocalStorage(page));
      await expect(page.getByText(/选择桶类型|Choose a bucket type/)).toHaveCount(0);
      await expect(page.getByRole("heading", {
        name: /钱包已锁定|Wallet locked/,
      })).toBeVisible();

      const passwordField = page.getByLabel(/密码|password/iu);
      await passwordField.fill(`${password}-wrong`);
      await page.getByRole("button", { name: /解锁|Unlock/ }).click();
      // 失败提交会在 finally 清空密码框；必须等它稳定后再输入新密码,
      // 否则刚填入的密码会被这次清理一起清掉。
      await expect(page.getByText(/Invalid password|密码错误|密码不正确/)).toBeVisible();
      await expect(passwordField).toHaveValue("");
      await expect(page.getByRole("heading", {
        name: /钱包已锁定|Wallet locked/,
      })).toBeVisible();
      await expect(page.getByText(/选择桶类型|Choose a bucket type/)).toHaveCount(0);
      await expect(readLocalCatalog(page), "错误密码不能删除设备记录或 session").resolves.toEqual(catalogBeforeWrongPassword);
      // 文件真值：错误密码不能改动设备记录/session/KeyHold 中任何一个字节。
      expect(identityFileMap(await readRawLocalStorage(page)), "错误密码不能改动身份文件").toEqual(filesBeforeWrongPassword);

      await passwordField.fill(password);
      const unlockButton = page.getByRole("button", { name: /解锁|Unlock/ });
      await expect(unlockButton).toBeEnabled();
      await unlockButton.click();
      await waitForUnlockedHome(page);
      // 解锁后 session 必须还是同一把 Key（存储真值,不再依赖页面文案）。
      await expect(readSessionPublicKey(page)).resolves.toBe(ready.publicKeyHex);
      // 解锁成功后重新持锁，KeyHold 文件不变。
      await assertLocalBucketStorage(page, {
        bucketId: ready.bucketId,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
    });

    await test.step("用户锁定后重新解锁自己的钱包", async () => {
      await lockWallet(page);
      // 主动锁定 = 释放该 Key 的应用锁。
      await assertLocalBucketLockReleased(page, {
        bucketId: ready.bucketId,
        ownerPublicKeyHex: ready.publicKeyHex,
      });
      await unlockWallet(page, password, ready.keyLabel);
      await expect(readSessionPublicKey(page)).resolves.toBe(ready.publicKeyHex);
      await assertLocalBucketStorage(page, {
        bucketId: ready.bucketId,
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
