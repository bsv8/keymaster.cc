import { expect, type Page } from "@playwright/test";
import { initializeLocalUser } from "../drivers/initialSetupDriver.js";
import type { FreshUserState, ReadyUserState } from "../support/types.js";

export interface InitializeLocalUserInput {
  /**
   * 期望的唯一 Key 标签。
   *
   * 新建钱包的生产 UI 不让用户输入标签，应用写入默认标签，所以这里传入
   * 的值只作为语义标注；返回值里的 `ReadyUserState.keyLabel` 才是真值。
   */
  readonly keyLabel: string;
  /** 仅用于当前业务过程，不能写入结果、附件或浏览器存储。 */
  readonly password: string;
}

/**
 * 业务过程：全新用户建立唯一钱包 Key。
 *
 * 输入是 FreshUserState，输出是可以继续其他业务的 ReadyUserState；因此
 * 调用者看得出这个 Flow 的前置条件，也不会误把另一个 test 的状态当依赖。
 */
export async function initializeNewLocalUser(
  state: FreshUserState,
  input: InitializeLocalUserInput,
): Promise<ReadyUserState> {
  const result = await initializeLocalUser(state.page, input);
  expect(result.publicKeyHex, "初始化结果必须有可归属后续业务的 active publicKeyHex").toMatch(/^(02|03)[0-9a-f]{64}$/iu);
  expect(result.walletGeneration, "初始化结果必须能定位钱包世代").toMatch(/^[0-9a-f-]{36}$/iu);
  return {
    page: state.page,
    walletGeneration: result.walletGeneration,
    keyLabel: result.keyLabel,
    publicKeyHex: result.publicKeyHex,
  };
}
