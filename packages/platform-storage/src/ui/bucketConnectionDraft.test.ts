import { describe, expect, it } from "vitest";
import type { StorageBucketConnectionConfigV1 } from "@keymaster/contracts";
import { configFromBytes, configToBytes } from "../bucket-providers/s3/s3ClientFactory.js";
import {
  EMPTY_BUCKET_DRAFT,
  bucketDraftFingerprint,
  connectionFromBucketDraft,
  providerConfigFromBucketDraft,
  updateBucketDraft,
  validateBucketDraft,
  type BucketDraft
} from "./bucketConnectionDraft.js";

const ACCOUNT_ID = "a".repeat(32);

function s3Draft(overrides: Partial<BucketDraft> = {}): BucketDraft {
  return {
    ...EMPTY_BUCKET_DRAFT,
    label: "工作桶",
    backend: "s3",
    s3ConfigMode: "aws-s3",
    region: "us-east-1",
    bucket: "workspace",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    ...overrides
  };
}

describe("BucketDraft S3 conversion", () => {
  it("converts AWS to the standard S3 connection and keeps optional generic fields", () => {
    const connection = connectionFromBucketDraft(s3Draft({ sessionToken: "temporary-token", prefix: "team-a" }));
    expect(connection).toEqual({
      kind: "s3",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "workspace",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      sessionToken: "temporary-token",
      prefix: "team-a/",
      forcePathStyle: false
    });
    expect(providerConfigFromBucketDraft(s3Draft({ prefix: "team-a" }))).toMatchObject({
      providerId: "s3-compatible",
      connection: { endpoint: "https://s3.us-east-1.amazonaws.com", prefix: "team-a" }
    });
  });

  it.each([
    ["default", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com"],
    ["eu", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eu.r2.cloudflarestorage.com"],
    ["fedramp", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.fedramp.r2.cloudflarestorage.com"],
    ["us", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.us.r2.cloudflarestorage.com"]
  ] as const)("converts R2 %s to auto-region endpoint", (endpointVariant, endpoint) => {
    expect(connectionFromBucketDraft(s3Draft({ s3ConfigMode: "cloudflare-r2", accountId: ACCOUNT_ID, endpointVariant, sessionToken: "r2-session-token", prefix: "project" }))).toMatchObject({
      kind: "s3",
      endpoint,
      region: "auto",
      sessionToken: "r2-session-token",
      prefix: "project/",
      forcePathStyle: false
    });
  });

  it("normalizes an ordinary S3-compatible connection without guessing its provider", () => {
    const connection = connectionFromBucketDraft(s3Draft({
      s3ConfigMode: "s3-compatible",
      endpoint: "https://objects.example.test/",
      region: "custom-region",
      prefix: "tenant/root/",
      forcePathStyle: true
    }));
    expect(connection).toMatchObject({
      endpoint: "https://objects.example.test",
      region: "custom-region",
      prefix: "tenant/root/",
      forcePathStyle: true
    });
    expect(providerConfigFromBucketDraft(s3Draft({ s3ConfigMode: "s3-compatible", endpoint: "https://objects.example.test", region: "custom-region" })).providerId).toBe("s3-compatible");
  });

  it.each([
    ["aws-s3", { region: "" }, "aws-region-required"],
    ["aws-s3", { accessKeyId: "" }, "s3-credentials-required"],
    ["cloudflare-r2", { accountId: "not-an-account" }, "r2-account-invalid"],
    ["s3-compatible", { endpoint: "http://objects.example.test" }, "s3-endpoint-invalid"],
    ["s3-compatible", { endpoint: "https://objects.example.test", region: "" }, "s3-region-required"]
  ] as const)("rejects invalid %s draft locally", (mode, overrides, code) => {
    expect(validateBucketDraft(s3Draft({ s3ConfigMode: mode, ...overrides }))).toMatchObject({ code });
  });

  it("clears mode-specific target and secret fields when switching configuration mode", () => {
    const draft = s3Draft({ accountId: ACCOUNT_ID, endpoint: "https://objects.example.test", sessionToken: "token", prefix: "team-a" });
    const switched = updateBucketDraft(draft, "s3ConfigMode", "cloudflare-r2");
    expect(switched).toMatchObject({
      label: draft.label,
      password: draft.password,
      passwordConfirm: draft.passwordConfirm,
      s3ConfigMode: "cloudflare-r2",
      endpointVariant: "default",
      accountId: "",
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      prefix: "",
      forcePathStyle: false
    });
    expect(bucketDraftFingerprint(switched)).not.toBe(bucketDraftFingerprint(draft));
  });

  it("keeps backend switching fail-closed by clearing hidden S3 credentials", () => {
    const draft = s3Draft({ password: "bucket-password", passwordConfirm: "bucket-password" });
    const local = updateBucketDraft(draft, "backend", "local");
    expect(local).toMatchObject({ backend: "local", label: "工作桶", password: "bucket-password", accessKeyId: "", secretAccessKey: "" });
    expect(connectionFromBucketDraft(local)).toEqual({ kind: "local" });
  });

  it("does not change legacy AWS v1 bytes when UI-only fields are present", () => {
    const legacy = configToBytes({
      version: 1,
      providerId: "aws-s3",
      connection: { region: "us-east-1", bucket: "workspace" },
      credentials: { kind: "access-key", accessKeyId: "access", secretAccessKey: "secret" }
    });
    expect(configFromBytes(legacy).connection).toEqual({ region: "us-east-1", bucket: "workspace" });
  });
});
