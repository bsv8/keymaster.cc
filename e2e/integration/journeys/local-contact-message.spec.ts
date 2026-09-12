import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../flows/initializeLocalUser.js";
import { saveContactAndOpenConversation } from "../flows/contactAndMessage.js";
import { captureBrowserErrors, attachBrowserErrors } from "../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../support/diagnostics.js";
import { LOCAL_CONTACT_MESSAGE_SCENARIO } from "../support/scenarioMetadata.js";

export const JOURNEY_ID = LOCAL_CONTACT_MESSAGE_SCENARIO.id;
export const JOURNEY_METADATA = LOCAL_CONTACT_MESSAGE_SCENARIO;

/**
 * 业务目标：
 * 用户初始化后保存一名联系人，并从消息入口打开属于该联系人的会话。
 *
 * 用户价值：
 * 证明联系人身份以 publicKeyHex 归属当前 active Key，错误的对端输入不会把用户带到无意义页面。
 *
 * 开始状态：
 * - 一个全新的 Chromium context，没有身份和联系人；
 * - 对端使用本次场景内的确定性测试公钥，不包含任何私钥或资金。
 *
 * 成功标准：
 * - 初始化只执行一次；
 * - 联系人保存后能在列表中读回；
 * - 非法 publicKeyHex 在消息表单内失败，合法公钥打开正确对端的会话页。
 *
 * 业务风险：
 * 联系人或会话归属错误会让用户把私密内容发给错误身份。没有真实 Channel 时，
 * 本场景不把“会话页面打开”升级为“消息已发送/已接收”。
 *
 * 外部资源与收尾：
 * 只使用本地浏览器存储；结束时由独立 context 丢弃联系人和消息历史，没有远端网络副作用。
 *
 * 覆盖需求：KM-INIT-001、KM-CONTACT-001、KM-MESSAGE-001。
 */
test(JOURNEY_ID + "：保存联系人并打开会话入口", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const password = "contact-e2e-password-123";
  const peerPublicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const browserErrors = captureBrowserErrors(page, context);

  try {
    const ready = await test.step("用户先建立可恢复的本地身份", async () => initializeNewLocalUser(
      { page },
      { bucketLabel: "联系人集成测试桶", keyLabel: "联系人测试首 Key", password },
    ));

    await test.step("用户把对方保存为联系人", async () => {
      await saveContactAndOpenConversation(ready, { peerPublicKeyHex, contactName: "集成测试联系人" });
    });

    await test.step("消息页面按正确公钥打开对端会话", async () => {
      await expect(page.locator("[data-message-detail=\"ok\"]")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/message/${peerPublicKeyHex}`));
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [password]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
