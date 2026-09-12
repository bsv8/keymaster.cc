import { describe, expect, it } from "vitest";
import { formatStartupErrorSummary } from "./startupErrorSummary.js";
import { attachBootstrapErrorContext } from "./bootstrapErrorContext.js";

describe("formatStartupErrorSummary", () => {
  it("only exposes safe structured startup fields", () => {
    const error = Object.assign(new Error("private raw message"), {
      name: "StartupPluginError",
      details: {
        pluginId: "vault",
        capabilities: ["vault.service"],
        state: "error-disabled",
        error: "private raw message"
      }
    });
    const summary = formatStartupErrorSummary(error);
    expect(summary).toContain("vault.service");
    expect(summary).toContain("error-disabled");
    expect(summary).not.toContain("private raw message");
  });

  it("adds structured stage and plugin context without changing the original diagnostic", () => {
    const error = Object.assign(new Error("private raw message"), {
      name: "StartupPluginError",
      details: { pluginId: "vault", capabilities: ["vault.service"], state: "error-disabled" }
    });
    attachBootstrapErrorContext(error, {
      stage: "vault-selection",
      pluginId: "vault",
      operation: "register-plugin"
    });
    const summary = formatStartupErrorSummary(error);
    expect(summary).toContain("Bootstrap stage: vault-selection");
    expect(summary).toContain("Plugin: vault");
    expect(summary).toContain("Bootstrap operation: register-plugin");
    expect(error.name).toBe("StartupPluginError");
    expect(error.details).toMatchObject({ capabilities: ["vault.service"] });
  });

  it("keeps StartupCapabilityError semantics when details are empty", () => {
    const error = Object.assign(new Error("raw unavailable detail"), {
      name: "StartupCapabilityError",
      details: []
    });
    attachBootstrapErrorContext(error, {
      stage: "owner-apps-ready",
      pluginId: "msfile",
      operation: "register-plugin"
    });
    const summary = formatStartupErrorSummary(error);
    expect(summary).toContain("StartupCapabilityError");
    expect(summary).toContain("Startup prerequisite unavailable");
    expect(summary).toContain("no capability details");
    expect(summary).toContain("Bootstrap stage: owner-apps-ready");
    expect(summary).toContain("Plugin: msfile");
    expect(summary).not.toContain("raw unavailable detail");
  });

  it("uses a safe generic summary for unknown errors", () => {
    const error = new Error("password=hunter2");
    const summary = formatStartupErrorSummary(error);
    expect(summary).toBe("Bootstrap startup failed.");
    expect(summary).not.toContain("hunter2");
  });
});
