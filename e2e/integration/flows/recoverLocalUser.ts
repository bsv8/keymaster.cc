import type { Page } from "@playwright/test";
import { lockWallet, reloadAndAssertSameKey, unlockWallet } from "../drivers/vaultDriver.js";
import type { ReadyUserState } from "../support/types.js";

/** 用户锁定后重新解锁同一身份；不创建第二个 Vault 或第二把 Key。 */
export async function lockAndUnlockUser(state: ReadyUserState, password: string): Promise<void> {
  await lockWallet(state.page);
  await unlockWallet(state.page, password, state.keyLabel);
}

/** 刷新恢复是同一业务状态的重新读取，不重复执行初始化。 */
export async function refreshReadyUser(state: ReadyUserState, password: string): Promise<void> {
  await reloadAndAssertSameKey(state.page, state.keyLabel);
  await unlockWallet(state.page, password, state.keyLabel);
}

/** 允许其他 Flow 复用 Page 类型而不复制业务状态字段。 */
export function readyPage(state: ReadyUserState): Page {
  return state.page;
}
