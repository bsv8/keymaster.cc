import { expect, test } from "@playwright/test";
import { assertSafeArtifact, findSecretLeaks, SecretString } from "../support/redaction.js";

export const GATE_ID = "G-REDACTION-BOUNDARY";
export const GATE_METADATA = {
  id: GATE_ID,
  level: "local-integration",
  requirementIds: ["KM-TECH-002"],
  startingState: "Node 侧准备一个只存在于内存的秘密容器和模拟附件。",
  successCriteria: ["秘密容器默认字符串化为脱敏值。", "私钥形状进入附件时在上传前被阻断。"],
  resourceProfile: "none",
} as const;

/**
 * 业务结果：用户的私钥、S3 Secret 和配置原文不能出现在报告、日志或浏览器产物中。
 * 这是测试框架自己的安全 Gate，不把它伪装成业务页面 Journey。
 */
test(GATE_ID + "：附件秘密扫描在上传前阻断", () => {
  const secret = new SecretString("not-used-outside-this-test");
  expect(String(secret)).toBe("[REDACTED_SECRET]");
  expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED_SECRET]"}');

  const secretLike = "a".repeat(64);
  expect(findSecretLeaks(`diagnostic=${secretLike}`)).toEqual([{ code: "private-key-hex", index: 11 }]);
  expect(() => assertSafeArtifact(`diagnostic=${secretLike}`, "test-artifact")).toThrow(/secret-shaped/iu);
  secret.clear();
});
