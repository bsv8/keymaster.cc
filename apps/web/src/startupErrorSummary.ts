/** 将结构化 startup 错误转换为可展示的安全摘要，不暴露底层 message/stack。 */
export function formatStartupErrorSummary(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const value = err as { name?: string; details?: unknown };
    if (value.name === "StartupPluginError" && value.details && typeof value.details === "object") {
      const d = value.details as { pluginId?: string; capabilities?: string[]; state?: string };
      return [
        `Startup prerequisite unavailable: ${(d.capabilities ?? []).join(", ") || "plugin capability"}`,
        `Provider: ${d.pluginId ?? "unknown"} (${d.state ?? "unknown"})`
      ].join("\n");
    }
    if (value.name === "StartupCapabilityError" && Array.isArray(value.details)) {
      return (value.details as Array<{ capability?: string; providerPluginId?: string; providerState?: string }>)
        .map((d) => [
          `Startup prerequisite unavailable: ${d.capability ?? "unknown"}`,
          `Provider: ${d.providerPluginId ?? "none"} (${d.providerState ?? "missing"})`
        ].join("\n"))
        .join("\n");
    }
  }
  return err instanceof Error ? err.stack ?? err.message : String(err);
}
