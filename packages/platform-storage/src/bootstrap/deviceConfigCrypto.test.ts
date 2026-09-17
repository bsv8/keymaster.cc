import { describe, expect, it } from "vitest";
import type { KeymasterSessionKeyDerivationV1 } from "@keymaster/contracts";
import { decryptDeviceConfig, encryptDeviceConfig, type DeviceS3LocationV1 } from "./deviceConfigCrypto.js";

const SALT = "AAECAwQFBgcICQoLDA0ODw";
const keyDerivation: KeymasterSessionKeyDerivationV1 = {
  algorithm: "pbkdf2-hmac-sha-256",
  passwordEncoding: "utf-8",
  iterations: 1_000,
  outputLengthBits: 256,
  saltB64Url: SALT,
};
const location: DeviceS3LocationV1 = {
  providerId: "s3",
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "keymaster-data",
  prefix: "team",
};
const plaintext = {
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "keymaster-data",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  prefix: "team",
};

describe("device config crypto", () => {
  it("用 session KDF 加密后能解回同一份明文", async () => {
    const cipher = await encryptDeviceConfig({ password: "päss🔑", keyDerivation, location, plaintext });
    expect(cipher).toMatchObject({ algorithm: "aes-gcm", keyLengthBits: 256, tagLengthBits: 128 });
    const decrypted = await decryptDeviceConfig({ password: "päss🔑", keyDerivation, location, cipher });
    expect(decrypted).toEqual(plaintext);
  });

  it("密码错误时按认证失败抛错", async () => {
    const cipher = await encryptDeviceConfig({ password: "right", keyDerivation, location, plaintext });
    await expect(decryptDeviceConfig({ password: "wrong", keyDerivation, location, cipher })).rejects.toThrow();
  });

  it("明文坐标与公开 location 不一致时拒绝", async () => {
    const cipher = await encryptDeviceConfig({ password: "p", keyDerivation, location, plaintext });
    await expect(decryptDeviceConfig({
      password: "p",
      keyDerivation,
      location: { ...location, bucket: "other-bucket" },
      cipher,
    })).rejects.toThrow(/does not match/u);
  });

  it("明文字段白名单拒绝未知字段", async () => {
    await expect(encryptDeviceConfig({ password: "p", keyDerivation, location, plaintext: { ...plaintext, kind: "s3" } as unknown as typeof plaintext })).rejects.toThrow();
  });
});
