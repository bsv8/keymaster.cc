import { randomUUID } from "node:crypto";

/** 只允许进入路径、对象前缀和报告的稳定标识符。 */
export function assertSafeIdentifier(value: string, field = "identifier"): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

/** 生成一轮顶层测试命令使用的 run_id。 */
export function createRunId(prefix = "e2e"): string {
  return `${assertSafeIdentifier(prefix, "run prefix")}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** 在 run_id 与 scenario_id 下隔离业务对象，拒绝模糊固定名称。 */
export function scenarioObjectPrefix(runId: string, scenarioId: string): string {
  return `${assertSafeIdentifier(runId, "run_id")}/${assertSafeIdentifier(scenarioId, "scenario_id")}/`;
}

/** 读取显式运行编号；未提供时只在当前 Node 进程创建一次。 */
let processRunId: string | undefined;
export function currentRunId(): string {
  const configured = process.env.KEYMASTER_E2E_RUN_ID?.trim();
  if (configured) return assertSafeIdentifier(configured, "KEYMASTER_E2E_RUN_ID");
  processRunId ??= createRunId();
  return processRunId;
}
