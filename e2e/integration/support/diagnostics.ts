import type { Page, TestInfo } from "@playwright/test";
import { attachRedactedText, redactText } from "./redaction.js";

/** 读取页面已有的脱敏诊断，不展开长期秘密。 */
export async function attachVisibleDiagnostic(page: Page, testInfo: TestInfo): Promise<void> {
  const details = page.locator("details").first();
  if (!(await details.isVisible().catch(() => false))) return;
  const summary = details.locator("summary");
  if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
  const diagnostic = await details.locator("pre").textContent().catch(() => null);
  if (diagnostic) await attachRedactedText(testInfo, "visible-diagnostic", redactText(diagnostic));
}

/** 用业务语境保留底层错误码，便于检查者把技术失败映射回用户影响。 */
export function businessFailureMessage(code: string, message: string): string {
  return `业务链路未完成（错误码 ${code}）：${redactText(message)}`;
}
