import { expect, test } from "@playwright/test";
import { readResourceRunState } from "../support/resourceState.js";

/** 资源依赖项目已成功时才进入；不读取或展示任何长期秘密。 */
test("真实资源 Journey 只在同一 run_id 的受保护资源准备完成后运行", async () => {
  const state = await readResourceRunState();
  expect(state, "resource-setup 未产生非敏感运行状态").not.toBeNull();
  expect(state?.s3LeaseAcquired).toBe(true);
  expect(state?.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
});

