import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import { lockWallet, unlockWallet } from "../../drivers/vaultDriver.js";
import { readWalletPublicKey, readWalletSnapshot, waitForUnlockedHome } from "../../drivers/appDriver.js";
import { assertWalletStorage, identityFileMap, readRawLocalStorage, readRawWalletObjects } from "../../support/walletStorageFormats.js";
import { captureBrowserErrors, attachBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { LOCAL_INIT_MENU_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_INIT_MENU_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_INIT_MENU_SCENARIO;

/**
 * 业务目标：
 * 新用户建立唯一钱包 Key，并在刷新、锁定后继续使用 Keymaster。
 *
 * 用户价值：
 * 证明用户首次打开浏览器时能完成存储优先的初始化，而不是只看到一个已改变的 URL。
 *
 * 开始状态：
 * - 一个全新的 Chromium context；
 * - 没有历史钱包数据、Vault 或钱包 Key；
 * - 不读取 testnet 或任何长期秘密。
 *
 * 成功标准：
 * - 初始化事务只执行一次并创建唯一一把带标签的 Key；
 * - 固定路径 `key.json` 与 `.keymaster/meta` 内容正确，密码没有进入浏览器存储；
 * - 刷新和锁定/重新解锁后仍是同一业务身份。
 *
 * 业务风险：
 * 如果页面过早宣布 ready，用户可能在快照或 Key 尚未落盘时继续操作，刷新后丢失身份。
 * 如果锁定后旧运行态仍可用，私钥相关能力会越过用户的安全边界。
 *
 * 外部资源与收尾：
 * 只使用本次浏览器 context 的本地数据；context 关闭后由 Playwright 丢弃。
 *
 * 覆盖需求：KM-INIT-001、KM-VAULT-001、KM-NAV-001。
 */
test(JOURNEY_ID + "：新用户初始化、刷新恢复、锁定和重新解锁", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const password = "local-e2e-password-123";
  const browserErrors = captureBrowserErrors(page, context);

  try {
    const ready = await test.step("用户创建唯一钱包 Key", async () => initializeNewLocalUser(
      { page },
      { keyLabel: "集成测试钱包 Key", password },
    ));

    // 存储真值：按 KeymasterFormats 检查 `key.json` 与 `.keymaster/meta`。
    const initialStorage = await test.step("检查钱包固定路径符合 KeymasterFormats", async () =>
      assertWalletStorage(page, {
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      }));
    expect(initialStorage.walletGeneration, "钱包 meta 必须记录 walletGeneration").toBe(ready.walletGeneration);

    await test.step("用户刷新后直接回到锁定页,并用 Key 密码重新解锁", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const snapshotBeforeWrongPassword = await readWalletSnapshot(page);
      const filesBeforeWrongPassword = identityFileMap(await readRawLocalStorage(page), await readRawWalletObjects(page));
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
      await expect(readWalletSnapshot(page), "错误密码不能删除或改写钱包存储").resolves.toEqual(snapshotBeforeWrongPassword);
      // 文件真值：错误密码不能改动 key.json 或 meta 中任何一个字节。
      expect(identityFileMap(await readRawLocalStorage(page), await readRawWalletObjects(page)), "错误密码不能改动身份文件").toEqual(filesBeforeWrongPassword);

      await passwordField.fill(password);
      const unlockButton = page.getByRole("button", { name: /解锁|Unlock/ });
      await expect(unlockButton).toBeEnabled();
      await unlockButton.click();
      await waitForUnlockedHome(page);
      // 解锁后必须还是同一把 Key（存储真值,不依赖页面文案）。
      await expect(readWalletPublicKey(page)).resolves.toBe(ready.publicKeyHex);
      // 解锁成功后 KeyHold 与 meta 都不变，钱包世代也不变。
      await assertWalletStorage(page, {
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
    });

    await test.step("用户锁定后重新解锁自己的钱包", async () => {
      await lockWallet(page);
      // 主动锁定不删除 KeyHold，也不推进钱包世代。
      const lockedStorage = await assertWalletStorage(page, {
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
      expect(lockedStorage.walletGeneration, "锁定不推进 walletGeneration").toBe(ready.walletGeneration);
      await unlockWallet(page, password, ready.keyLabel);
      await expect(readWalletPublicKey(page)).resolves.toBe(ready.publicKeyHex);
      await assertWalletStorage(page, {
        ownerPublicKeyHex: ready.publicKeyHex,
        keyLabel: ready.keyLabel,
      });
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
