import { describe, expect, it } from "vitest";
import { validateDeviceCapabilities, validateDeviceRecord } from "./device.js";

const cipher = {
  algorithm: "aes-gcm",
  keyLengthBits: 256,
  ivB64Url: "AAAAAAAAAAAAAAAA",
  tagLengthBits: 128,
  ciphertextAndTagB64Url: "AAAAAAAAAAAAAAAAAAAAAA",
};

function s3Record(extra: Record<string, unknown> = {}) {
  return {
    format: "keymaster.device",
    version: 1,
    displayName: "团队 S3 桶",
    location: { providerId: "s3", endpoint: "https://s3.example.com", region: "auto", bucket: "keymaster-data" },
    cipher,
    ...extra,
  };
}

describe("设备记录条件写能力缓存", () => {
  it("接受 native 与 best-effort 两种探测结果", () => {
    expect(validateDeviceRecord(s3Record({ capabilities: { conditionalWrites: "native" } }))).toMatchObject({
      capabilities: { conditionalWrites: "native" },
    });
    expect(validateDeviceRecord(s3Record({ capabilities: { conditionalWrites: "best-effort" } }))).toMatchObject({
      capabilities: { conditionalWrites: "best-effort" },
    });
    expect(validateDeviceRecord(s3Record())).not.toHaveProperty("capabilities");
  });

  it("拒绝非法枚举与未知字段", () => {
    expect(() => validateDeviceRecord(s3Record({ capabilities: { conditionalWrites: "unsupported" } }))).toThrow();
    expect(() => validateDeviceRecord(s3Record({ capabilities: { conditionalWrites: "native", probedAt: 1 } }))).toThrow();
    expect(() => validateDeviceCapabilities({ conditionalWrites: "native", extra: true })).toThrow();
  });

  it("local 记录禁止出现 capabilities", () => {
    expect(() => validateDeviceRecord({
      format: "keymaster.device",
      version: 1,
      displayName: "本机桶",
      location: { providerId: "local" },
      capabilities: { conditionalWrites: "native" },
    })).toThrow();
  });
});
