import { expect, test } from "@playwright/test";
import { DEPLOYMENT_APPS_SCENARIO } from "../support/scenarioMetadata.js";

export const JOURNEY_ID = DEPLOYMENT_APPS_SCENARIO.id;
export const JOURNEY_METADATA = DEPLOYMENT_APPS_SCENARIO;

/**
 * 目标部署验收的最小入口。它必须绑定不可变 Build ID；本地 preview、Git SHA
 * 或一个可变 URL 都不能替代部署身份。真实业务 Journey 按矩阵继续追加。
 */
test(JOURNEY_ID + "：公开入口返回指定不可变 Build ID", async ({ request }) => {
  const baseUrl = process.env.KEYMASTER_E2E_DEPLOYMENT_BASE_URL;
  const buildId = process.env.KEYMASTER_E2E_DEPLOYMENT_BUILD_ID;
  expect(baseUrl, "必须提供目标部署 URL").toBeTruthy();
  expect(buildId, "必须提供不可变 Build ID").toBeTruthy();
  if (!baseUrl || !buildId) return;
  const response = await request.get(new URL("/", baseUrl).toString());
  expect(response.ok()).toBe(true);
  const observed = response.headers()["x-keymaster-build-id"] ?? response.headers()["x-build-id"];
  expect(observed, "部署必须返回可验证的 Build ID 响应头").toBe(buildId);
});
