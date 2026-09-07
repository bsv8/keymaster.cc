// 目标部署 Coordinator 崩溃恢复验收。
//
// 本地 worker test 只能证明协议实现；生产放行还需要在目标部署中实际
// 观察“旧 lease 存在 → 新 Worker 拒绝接管 → 旧操作结束 → retry 接管”
// 这一完整链路。目标验收页提供 runner，本测试只接受结构化、脱敏结果。

import { expect, test } from "@playwright/test";

const DRILL_URL = process.env.KEYMASTER_RECOVERY_DRILL_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

interface CoordinatorRecoveryDrillReport {
  /** 目标部署恢复验收报告版本。 */
  schemaVersion: 1;
  /** 实际被演练的 Worker 构建标识。 */
  buildId: string;
  /** 报告生成时间。 */
  generatedAt: string;
  /** 演练前观察到的旧 final-I/O lease 数量。 */
  activeLeaseCountBefore: number;
  /** retry 成功接管后活动 lease 数量。 */
  activeLeaseCountAfter: number;
  /** 旧 Worker 有活动 lease。 */
  oldLeaseObserved: boolean;
  /** 新 Worker 正确拒绝抢占。 */
  authorityRejected: boolean;
  /** 旧操作真实结束后 retry 成功。 */
  retrySucceeded: boolean;
  /** 旧句柄在新权威下失败。 */
  oldLeaseRejected: boolean;
  /** 未知外部结果没有被自动再次提交。 */
  unknownResultNotReplayed: boolean;
  /** 目标环境原始演练记录。 */
  evidenceRef: string;
}

declare global {
  interface Window {
    /** 由目标部署恢复验收页注入，生产主包不提供此测试入口。 */
    __KEYMASTER_COORDINATOR_RECOVERY_DRILL__?: () => Promise<CoordinatorRecoveryDrillReport> | CoordinatorRecoveryDrillReport;
  }
}

function isRealReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/<[^>]+>/u.test(value);
}

function isImmutableBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

test("目标部署完成 Coordinator 活动 lease 崩溃恢复演练", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!DRILL_URL, "设置 KEYMASTER_RECOVERY_DRILL_URL 后执行目标部署恢复验收");
  const target = new URL(DRILL_URL!);
  expect(["http:", "https:"]).toContain(target.protocol);
  expect(LOCAL_HOSTS.has(target.hostname)).toBe(false);

  await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  await expect.poll(
    () => page.evaluate(() => typeof window.__KEYMASTER_COORDINATOR_RECOVERY_DRILL__),
    { timeout: 60_000 },
  ).toBe("function");
  const report = await page.evaluate(async () => {
    const runner = window.__KEYMASTER_COORDINATOR_RECOVERY_DRILL__;
    if (!runner) throw new Error("目标验收页未提供 Coordinator recovery drill runner");
    return await runner();
  });

  expect(report.schemaVersion).toBe(1);
  expect(isImmutableBuildId(report.buildId)).toBe(true);
  expect(isImmutableBuildId(process.env.KEYMASTER_DEPLOYED_BUILD_ID)).toBe(true);
  expect(report.buildId).toBe(process.env.KEYMASTER_DEPLOYED_BUILD_ID);
  expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  expect(report.activeLeaseCountBefore).toBeGreaterThan(0);
  expect(report.activeLeaseCountAfter).toBe(0);
  expect(report.oldLeaseObserved).toBe(true);
  expect(report.authorityRejected).toBe(true);
  expect(report.retrySucceeded).toBe(true);
  expect(report.oldLeaseRejected).toBe(true);
  expect(report.unknownResultNotReplayed).toBe(true);
  expect(isRealReference(report.evidenceRef)).toBe(true);
});
