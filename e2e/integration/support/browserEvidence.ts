import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import type { BrowserErrorEvidence } from "./types.js";
import { attachRedactedText, redactText } from "./redaction.js";

/** 收集页面和 SharedWorker 的错误，但不吞掉原始失败。 */
export function captureBrowserErrors(page: Page, context: BrowserContext): BrowserErrorEvidence {
  const evidence: { pageErrors: string[]; consoleErrors: string[]; workerErrors: string[] } = {
    pageErrors: [],
    consoleErrors: [],
    workerErrors: [],
  };
  page.on("pageerror", (error) => evidence.pageErrors.push(`pageerror: ${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      evidence.consoleErrors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  context.on("console", (message) => {
    if (message.page() === page) return;
    if (message.type() === "error" || message.type() === "warning") {
      evidence.workerErrors.push(`worker.${message.type()}: ${message.text()}`);
    }
  });
  return evidence;
}

/** 失败时追加脱敏错误证据；成功时也保留非空错误，避免为了报告好看吞错。 */
export async function attachBrowserErrors(
  testInfo: TestInfo,
  evidence: BrowserErrorEvidence,
  knownSecrets: readonly string[] = []
): Promise<void> {
  const sections = [
    evidence.pageErrors.length ? `页面异常\n${evidence.pageErrors.join("\n")}` : "",
    evidence.consoleErrors.length ? `页面控制台\n${evidence.consoleErrors.join("\n")}` : "",
    evidence.workerErrors.length ? `Worker 控制台\n${evidence.workerErrors.join("\n")}` : "",
  ].filter(Boolean);
  if (sections.length === 0) return;
  await attachRedactedText(testInfo, "browser-errors", redactText(sections.join("\n\n"), knownSecrets), { knownSecrets });
}
