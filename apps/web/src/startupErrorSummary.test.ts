import { describe, expect, it } from "vitest";
import { formatStartupErrorSummary } from "./startupErrorSummary.js";

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
});
