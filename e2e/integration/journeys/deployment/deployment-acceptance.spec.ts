import { expect, test } from "@playwright/test";
import { DEPLOYMENT_APPS_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = DEPLOYMENT_APPS_SCENARIO.id;
export const JOURNEY_METADATA = DEPLOYMENT_APPS_SCENARIO;

/**
 * 目标部署验收的最小入口。它必须绑定不可变 Build ID；本地 preview、Git SHA
 * 或一个可变 URL 都不能替代部署身份。真实业务 Journey 按矩阵继续追加。
 */
test(JOURNEY_ID + "：公开入口返回指定不可变 Build ID", async ({ request }) => {
  const baseUrl = process.env.KEYMASTER_E2E_DEPLOYMENT_BASE_URL;
  // 发布流水线统一使用 KEYMASTER_DEPLOYED_BUILD_ID；保留旧变量作为过渡，
  // 避免历史调用方因为目录迁移而把目标部署验收误判成未配置。
  const buildId = process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? process.env.KEYMASTER_E2E_DEPLOYMENT_BUILD_ID;
  if (!baseUrl) throw new Error("部署验收必须提供 KEYMASTER_E2E_DEPLOYMENT_BASE_URL");
  if (!buildId) throw new Error("部署验收必须提供 KEYMASTER_DEPLOYED_BUILD_ID（兼容 KEYMASTER_E2E_DEPLOYMENT_BUILD_ID）");
  expect(buildId, "Build ID 必须是 commit(40位)-sourceDigest(16位) 的不可变标识").toMatch(/^[0-9a-f]{40}-[0-9a-f]{16}$/iu);
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol)
    || ["localhost", "127.0.0.1", "::1"].includes(target.hostname)
    || /<[^>]+>/u.test(target.toString())) {
    throw new Error("KEYMASTER_E2E_DEPLOYMENT_BASE_URL 必须是非本机 http(s) 部署地址");
  }
  const response = await request.get(new URL("/", target).toString());
  expect(response.ok()).toBe(true);
  const observed = response.headers()["x-keymaster-build-id"] ?? response.headers()["x-build-id"];
  expect(observed, "部署必须返回可验证的 Build ID 响应头").toBe(buildId);
});
