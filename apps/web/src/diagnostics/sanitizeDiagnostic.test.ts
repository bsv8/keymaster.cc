import { describe, expect, it } from "vitest";
import { buildDiagnosticText, sanitizeDiagnosticText, sanitizeDiagnosticValue } from "./sanitizeDiagnostic.js";

describe("sanitizeDiagnostic", () => {
  it("removes secrets, URL details, paths and private-key shaped values", () => {
    const privateHex = "11".repeat(32);
    const text = sanitizeDiagnosticText(
      `password=hunter2 secretAccessKey=secret-value https://user:pass@example.test/path?q=token ` +
      `/home/david/private.json ${privateHex}`
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("user:pass");
    expect(text).not.toContain("/home/david");
    expect(text).not.toContain(privateHex);
    expect(text).toContain("https://example.test");
  });

  it("serializes circular causes with bounded recursion", () => {
    const cause: Record<string, unknown> = { password: "do-not-show", nested: { value: "ok" } };
    cause.self = cause;
    const output = sanitizeDiagnosticValue(cause);
    expect(output).toContain("<redacted>");
    expect(output).toContain("<circular>");
    expect(output).toContain("ok");
    expect(output.length).toBeLessThanOrEqual(12_000);
  });

  it("uses one-line fields rather than spreading diagnostic strings into characters", () => {
    const output = buildDiagnosticText({
      phase: "runtime",
      code: "storage_failed",
      incidentId: "incident-1",
      message: "boom",
      stack: "Error: boom\n at app.ts:1:1"
    });
    expect(output).toContain("摘要: boom");
    expect(output).toContain("Stack: Error: boom");
    expect(output).not.toContain("摘\n要");
  });

  it("keeps details on one line and truncates public identifiers", () => {
    const output = buildDiagnosticText({
      phase: "catalog-commit",
      code: "storage_conflict",
      incidentId: "incident-1234567890",
      occurredAt: "2026-09-08T00:00:00.000Z",
      redactionVersion: "diagnostic-v2",
      details: {
        bucketId: "setup-very-long-public-bucket-id-1234567890",
        publicKeyHex: "02abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        message: "candidate lost CAS"
      }
    });
    expect(output).toContain("时间: 2026-09-08T00:00:00.000Z");
    expect(output).toContain("脱敏规则: diagnostic-v2");
    expect(output).toContain("详情: {");
    expect(output).not.toContain("setup-very-long-public-bucket-id-1234567890");
    expect(output).not.toContain("02abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });
});
