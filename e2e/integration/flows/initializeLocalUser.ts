import { expect, type Page } from "@playwright/test";
import { initializeLocalUser } from "../drivers/initialSetupDriver.js";
import type { FreshUserState, ReadyUserState } from "../support/types.js";

export interface InitializeLocalUserInput {
  readonly bucketLabel: string;
  readonly keyLabel: string;
  /** 仅用于当前业务过程，不能写入结果、附件或浏览器存储。 */
  readonly password: string;
}

/**
 * 业务过程：全新用户建立一个 Local 桶和第一把身份 Key。
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
  return {
    page: state.page,
    bucketLabel: input.bucketLabel,
    keyLabel: input.keyLabel,
    publicKeyHex: result.publicKeyHex,
  };
}
