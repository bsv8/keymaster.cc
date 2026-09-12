import { expect } from "@playwright/test";
import { createContact } from "../drivers/contactDriver.js";
import { openMessages, openNewChat, rejectInvalidNewChat } from "../drivers/messageDriver.js";
import type { ReadyUserState } from "../support/types.js";

export interface ContactMessageInput {
  /** 一次性测试对端公钥，不对应长期资金或长期秘密。 */
  readonly peerPublicKeyHex: string;
  readonly contactName: string;
}

/** 保存联系人，并验证消息入口的输入错误与合法路由。 */
export async function saveContactAndOpenConversation(
  state: ReadyUserState,
  input: ContactMessageInput,
): Promise<void> {
  await createContact(state.page, { publicKeyHex: input.peerPublicKeyHex, name: input.contactName });
  await openMessages(state.page);
  await rejectInvalidNewChat(state.page);
  await openNewChat(state.page, input.peerPublicKeyHex);
  // 这里的 ready 只代表消息页已按正确对端身份打开；没有远端 Channel 时，
  // 不把本地页面通过升级成“已发送/已接收”。
  await expect(state.page.locator("[data-peer-public-key-hex]")).toHaveAttribute("data-peer-public-key-hex", input.peerPublicKeyHex);
}
