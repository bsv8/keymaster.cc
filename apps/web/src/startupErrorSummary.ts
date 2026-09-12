import { getBootstrapErrorContext } from "./bootstrapErrorContext.js";
import { sanitizeDiagnosticText } from "./diagnostics/sanitizeDiagnostic.js";

/** 将结构化 startup 错误转换为可展示的安全摘要，不暴露底层 message/stack。 */
export function formatStartupErrorSummary(err: unknown): string {
  const context = getBootstrapErrorContext(err);
  const contextSummary = context
    ? [
        `Bootstrap stage: ${sanitizeDiagnosticText(context.stage)}`,
        `Bootstrap operation: ${sanitizeDiagnosticText(context.operation)}`,
        ...(context.pluginId ? [`Plugin: ${sanitizeDiagnosticText(context.pluginId)}`] : [])
      ].join("\n")
    : undefined;
  let summary: string;
  if (err && typeof err === "object" && "name" in err) {
    const value = err as { name?: string; details?: unknown };
    if (value.name === "StartupPluginError" && value.details && typeof value.details === "object") {
      const d = value.details as { pluginId?: string; capabilities?: string[]; state?: string };
      summary = [
        `Startup prerequisite unavailable: ${(d.capabilities ?? []).map((capability) => sanitizeDiagnosticText(String(capability))).join(", ") || "plugin capability"}`,
        `Provider: ${sanitizeDiagnosticText(String(d.pluginId ?? "unknown"))} (${sanitizeDiagnosticText(String(d.state ?? "unknown"))})`
      ].join("\n");
      return contextSummary ? `${summary}\n${contextSummary}` : summary;
    }
    if (value.name === "StartupCapabilityError" && Array.isArray(value.details)) {
      if (value.details.length === 0) {
        summary = "StartupCapabilityError: Startup prerequisite unavailable (no capability details).";
        return contextSummary ? `${summary}\n${contextSummary}` : summary;
      }
      summary = (value.details as Array<{ capability?: string; providerPluginId?: string; providerState?: string }>)
        .map((d) => [
          `Startup prerequisite unavailable: ${sanitizeDiagnosticText(String(d.capability ?? "unknown"))}`,
          `Provider: ${sanitizeDiagnosticText(String(d.providerPluginId ?? "none"))} (${sanitizeDiagnosticText(String(d.providerState ?? "missing"))})`
        ].join("\n"))
        .join("\n");
      return contextSummary ? `${summary}\n${contextSummary}` : summary;
    }
  }
  // 未知错误不能把任意 message/stack 当成稳定阶段或脱敏摘要；原始值
  // 仍通过 fatal cause 保留，fatal 诊断页会对 cause/stack 再做脱敏。
  summary = "Bootstrap startup failed.";
  return contextSummary ? `${summary}\n${contextSummary}` : summary;
}
