import { expect, type Page } from "@playwright/test";
import { navigateToBusinessPage } from "./navigationDriver.js";

export interface ContactInput {
  /** 联系人的压缩公钥；这是联系人 canonical 身份。 */
  readonly publicKeyHex: string;
  readonly name: string;
}

/** 在当前 active Key 下保存一个联系人，并等待列表读回。 */
export async function createContact(page: Page, input: ContactInput): Promise<void> {
  await navigateToBusinessPage(page, {
    label: /^Contacts$|^联系人$/,
    path: /\/contacts$/,
  });
  await expect(page.getByRole("heading", { name: /Contacts|联系人/ })).toBeVisible();
  await page.getByRole("button", { name: /New|新建/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const publicKeyField = dialog.getByLabel(/^Contact publicKeyHex$|^联系人 publicKeyHex$|^联系人公钥$/);
  const nameField = dialog.getByLabel(/^Name$|^名称$/);
  await publicKeyField.fill(input.publicKeyHex);
  await expect(publicKeyField).toHaveValue(input.publicKeyHex);
  await nameField.fill(input.name);
  await expect(nameField).toHaveValue(input.name);
  await dialog.getByRole("button", { name: /Save|保存/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(input.name, { exact: true })).toBeVisible();
}
