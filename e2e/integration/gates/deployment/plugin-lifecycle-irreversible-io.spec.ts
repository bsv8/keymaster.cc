// 目标部署不可逆 I/O smoke 合约。
//
// 供应商上传、远端订阅、广播和支付不能由本地 fixture 代替。目标部署
// 的验收页需要提供一个只在测试/验收环境开放的 runner，runner 内部
// 通过真实应用入口执行故障注入并返回脱敏结果；本测试只验证报告结构、
// 幂等编号、领域仓库对账和“未知结果不重放”约束。

import { expect, test } from "@playwright/test";
import { DEPLOYMENT_IRREVERSIBLE_IO_GATE } from "../../support/scenarioMetadata.js";

export const GATE_ID = DEPLOYMENT_IRREVERSIBLE_IO_GATE.id;
export const GATE_METADATA = DEPLOYMENT_IRREVERSIBLE_IO_GATE;

const SMOKE_URL = process.env.KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL;
const REQUIRED_SCENARIOS = [
  "owner-storage",
  "platform-storage",
  "msfile-upload",
  "remote-subscription",
  "p2pkh-broadcast",
  "sat-payment-unknown-result",
  "unknown-result-no-replay",
] as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

interface IrreversibleIoSmokeScenario {
  /** 审计场景稳定标识。 */
  id: string;
  /** 真实供应商调用的最终结果分类。 */
  status: "completed" | "failed" | "unknown";
  /** 业务幂等编号；不能用 transport callId 代替。 */
  operationId: string;
  /** 领域仓库对远端结果的最终判断。 */
  repositoryResolution: "confirmed" | "not-submitted" | "unknown" | "manual";
  /** 故障注入后没有再次提交同一不可逆操作。 */
  replayPrevented: boolean;
  /** 目标环境原始 smoke 记录引用。 */
  evidenceRef: string;
}

interface IrreversibleIoSmokeReport {
  schemaVersion: 1;
  buildId: string;
  generatedAt: string;
  scenarios: IrreversibleIoSmokeScenario[];
}

declare global {
  interface Window {
    /** 由目标部署验收页注入，生产主包不提供此测试入口。 */
    __KEYMASTER_IRREVERSIBLE_IO_SMOKE__?: () => Promise<IrreversibleIoSmokeReport> | IrreversibleIoSmokeReport;
  }
}

function isRealReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/<[^>]+>/u.test(value);
}

function isImmutableBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}-[0-9a-f]{16}$/iu.test(value);
}

test(GATE_ID + "：目标部署完成不可逆 I/O smoke 且未知结果不重放", async ({ page }) => {
  test.setTimeout(180_000);
  if (!SMOKE_URL) throw new Error("部署验收必须设置 KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL");
  const target = new URL(SMOKE_URL!);
  expect(["http:", "https:"]).toContain(target.protocol);
  expect(LOCAL_HOSTS.has(target.hostname)).toBe(false);

  await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  await expect.poll(
    () => page.evaluate(() => typeof window.__KEYMASTER_IRREVERSIBLE_IO_SMOKE__),
    { timeout: 60_000 },
  ).toBe("function");

  const report = await page.evaluate(async () => {
    const runner = window.__KEYMASTER_IRREVERSIBLE_IO_SMOKE__;
    if (!runner) throw new Error("目标验收页未提供不可逆 I/O smoke runner");
    return await runner();
  });

  expect(report.schemaVersion).toBe(1);
  expect(isImmutableBuildId(report.buildId)).toBe(true);
  expect(isImmutableBuildId(process.env.KEYMASTER_DEPLOYED_BUILD_ID)).toBe(true);
  expect(report.buildId).toBe(process.env.KEYMASTER_DEPLOYED_BUILD_ID);
  expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  expect(report.scenarios).toHaveLength(REQUIRED_SCENARIOS.length);

  const ids = new Set<string>();
  const operationIds = new Set<string>();
  for (const scenario of report.scenarios) {
    expect(REQUIRED_SCENARIOS).toContain(scenario.id as (typeof REQUIRED_SCENARIOS)[number]);
    expect(ids.has(scenario.id)).toBe(false);
    ids.add(scenario.id);
    expect(["completed", "failed", "unknown"]).toContain(scenario.status);
    expect(isRealReference(scenario.operationId)).toBe(true);
    expect(operationIds.has(scenario.operationId)).toBe(false);
    operationIds.add(scenario.operationId);
    expect(["confirmed", "not-submitted", "unknown", "manual"]).toContain(scenario.repositoryResolution);
    expect(scenario.replayPrevented).toBe(true);
    expect(isRealReference(scenario.evidenceRef)).toBe(true);
    if (scenario.status === "unknown") {
      expect(["unknown", "manual"]).toContain(scenario.repositoryResolution);
    }
  }
  for (const scenarioId of REQUIRED_SCENARIOS) expect(ids.has(scenarioId)).toBe(true);

  const unknownResult = report.scenarios.find((scenario) => scenario.id === "sat-payment-unknown-result");
  expect(unknownResult?.status).toBe("unknown");
  expect(unknownResult?.replayPrevented).toBe(true);
  expect(["unknown", "manual"]).toContain(unknownResult?.repositoryResolution);
  const noReplay = report.scenarios.find((scenario) => scenario.id === "unknown-result-no-replay");
  expect(noReplay?.replayPrevented).toBe(true);
});
