import { describe, expect, it } from "vitest";
import { awsS3EndpointForRegion, configFromBytes, normalizeProviderConfig, r2EndpointForAccount, summaryForConfig } from "./s3ClientFactory.js";
import { StorageRuntimeError } from "../../runtime/storageError.js";

const credentials = { mode: "replace" as const, accessKeyId: "access-key-1234", secretAccessKey: "secret-value" };

describe("storage provider config", () => {
  it("normalizes compatible HTTPS config and keeps summaries secret-free", () => {
    const config = normalizeProviderConfig({
      providerId: "s3-compatible",
      connection: { endpoint: "https://objects.example.test/", region: "us-east-1", bucket: "bucket-name", forcePathStyle: true, sessionToken: "temporary", prefix: "tenant" },
      credentials
    });
    expect(config.connection).toMatchObject({ endpoint: "https://objects.example.test", sessionToken: "temporary", prefix: "tenant/" });
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
    expect(() => normalizeProviderConfig({ providerId: "s3-compatible", connection: { endpoint, region: "us-east-1", bucket: "bucket-name", forcePathStyle: false }, credentials })).toThrow(StorageRuntimeError);
  });

  it("requires replacement credentials when changing provider", () => {
    const existing = normalizeProviderConfig({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket-name" }, credentials });
    expect(() => normalizeProviderConfig({ providerId: "cloudflare-r2", connection: { accountId: "a".repeat(32), endpointVariant: "default", bucket: "bucket-name" }, credentials: { mode: "retain" } }, existing)).toThrow(StorageRuntimeError);
  });

  it.each([
    ["us-east-1", "https://s3.us-east-1.amazonaws.com"],
    ["cn-north-1", "https://s3.cn-north-1.amazonaws.com.cn"],
    ["us-gov-west-1", "https://s3.us-gov-west-1.amazonaws.com"]
  ] as const)("generates a supported AWS endpoint for %s", (awsRegion, expected) => {
    expect(awsS3EndpointForRegion(awsRegion)).toBe(expected);
  });

  it("rejects AWS ISO and Secret partitions instead of generating an unsafe endpoint", () => {
    expect(() => awsS3EndpointForRegion("us-iso-east-1")).toThrow(StorageRuntimeError);
    expect(() => awsS3EndpointForRegion("us-isob-east-1")).toThrow(StorageRuntimeError);
    expect(() => awsS3EndpointForRegion("us-secret-east-1")).toThrow(StorageRuntimeError);
    expect(() => awsS3EndpointForRegion("eusc-de-east-1")).toThrow(StorageRuntimeError);
    expect(() => awsS3EndpointForRegion("eu-isoe-west-1")).toThrow(StorageRuntimeError);
  });

  it.each([
    ["default", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com"],
    ["eu", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eu.r2.cloudflarestorage.com"],
    ["fedramp", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.fedramp.r2.cloudflarestorage.com"],
    ["us", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.us.r2.cloudflarestorage.com"]
  ] as const)("generates the R2 %s endpoint", (variant, expected) => {
    expect(r2EndpointForAccount("A".repeat(32), variant)).toBe(expected);
  });

  it("keeps the legacy R2 v1 normalizer closed to the UI-only US variant", () => {
    expect(() => normalizeProviderConfig({
      providerId: "cloudflare-r2",
      connection: { accountId: "a".repeat(32), endpointVariant: "us" as never, bucket: "bucket-name" },
      credentials
    })).toThrow(StorageRuntimeError);
  });

  it("ignores a legacy provider prefix when reading a stored v1 config", () => {
    const legacy = {
      version: 1,
      providerId: "aws-s3",
      connection: { region: "us-east-1", bucket: "bucket-name", prefix: "legacy-root/" },
      credentials: { kind: "access-key", accessKeyId: "access", secretAccessKey: "secret" }
    };
    const restored = configFromBytes(new TextEncoder().encode(JSON.stringify(legacy)));
    expect(restored.connection).toEqual({ region: "us-east-1", bucket: "bucket-name" });
  });
});
