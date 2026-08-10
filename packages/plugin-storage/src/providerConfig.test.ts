import { describe, expect, it } from "vitest";
import { normalizeProviderConfig, summaryForConfig } from "./providerConfig.js";
import { StorageServiceError } from "./storageErrors.js";

const credentials = { mode: "replace" as const, accessKeyId: "access-key-1234", secretAccessKey: "secret-value" };

describe("storage provider config", () => {
  it("normalizes compatible HTTPS config and keeps summaries secret-free", () => {
    const config = normalizeProviderConfig({
      providerId: "s3-compatible",
      connection: { endpoint: "https://objects.example.test/", region: "us-east-1", bucket: "bucket-name", prefix: "tenant/", forcePathStyle: true },
      credentials
    });
    expect(config.connection).toMatchObject({ endpoint: "https://objects.example.test", prefix: "tenant/" });
    const summary = summaryForConfig(config, 3, 100);
    expect(JSON.stringify(summary)).not.toContain("secret-value");
    expect(JSON.stringify(summary)).not.toContain("access-key-1234");
    expect(summary.accessKeyHint).toBe("••••1234");
  });

  it.each([
    { endpoint: "http://objects.example.test" },
    { endpoint: "https://user:pass@objects.example.test" },
    { endpoint: "https://objects.example.test?redirect=1" }
  ])("rejects unsafe endpoint: $endpoint", ({ endpoint }) => {
    expect(() => normalizeProviderConfig({ providerId: "s3-compatible", connection: { endpoint, region: "us-east-1", bucket: "bucket-name", prefix: "", forcePathStyle: false }, credentials })).toThrow(StorageServiceError);
  });

  it("requires replacement credentials when changing provider", () => {
    const existing = normalizeProviderConfig({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name", prefix: "" }, credentials });
    expect(() => normalizeProviderConfig({ providerId: "cloudflare-r2", connection: { accountId: "a".repeat(32), endpointVariant: "default", bucket: "bucket-name", prefix: "" }, credentials: { mode: "retain" } }, existing)).toThrow(StorageServiceError);
  });
});
