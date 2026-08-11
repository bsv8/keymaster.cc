// packages/plugin-vault/src/sessionCryptoCore.test.ts
// sessionCryptoCore 签名函数专项测试。
//
// 关键不变量：
//   - 同一 digest 分别请求 DER/compact，两者均可验签
//   - compact 固定 64 字节
//   - digest 非 32 字节必须失败
//   - 非法 format 必须失败
//   - DER 输出能被 strict DER parser 解析

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import {
  buildOpenedAppMsgMessage,
  signEcdsaDigest,
  hexToBytes,
  bytesToHex,
  openAppMessageLocalBytes,
  sealAppMessageLocalBytes
} from "./sessionCryptoCore.js";

// 测试私钥（n=1，仅测试用）
const TEST_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIV_BYTES = hexToBytes(TEST_PRIV_HEX);
const TEST_PUB_HEX = bytesToHex(secp256k1.getPublicKey(TEST_PRIV_BYTES, true));

describe("signEcdsaDigest", () => {
  const digest32 = new Uint8Array(32);
  digest32.fill(0xab);

  it("compact 签名固定 64 字节", async () => {
    const sig = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest32,
      format: "compact"
    });
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it("DER 签名以 0x30 开头且长度 >= 8", async () => {
    const sig = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest32,
      format: "der"
    });
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig[0]).toBe(0x30);
    expect(sig.length).toBeGreaterThanOrEqual(8);
  });

  it("同一 digest 的 DER 和 compact 签名均可被 secp256k1.verify 验证", async () => {
    const derSig = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest32,
      format: "der"
    });
    const compactSig = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest32,
      format: "compact"
    });

    const pubBytes = hexToBytes(TEST_PUB_HEX);

    // DER 验签
    const derValid = secp256k1.verify(derSig, digest32, pubBytes, {
      prehash: false,
      format: "der"
    });
    expect(derValid).toBe(true);

    // compact 验签
    const compactValid = secp256k1.verify(compactSig, digest32, pubBytes, {
      prehash: false,
      format: "compact"
    });
    expect(compactValid).toBe(true);
  });

  it("compact 签名的 r 和 s 各 32 字节，总长 64", async () => {
    const sig = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest32,
      format: "compact"
    });
    // compact 格式: r(32) || s(32)
    // noble 的 toCompactRawBytes 保证 64 字节
    expect(sig.length).toBe(64);
    // 验签确认结构正确
    const pubBytes = hexToBytes(TEST_PUB_HEX);
    expect(secp256k1.verify(sig, digest32, pubBytes, { prehash: false, format: "compact" })).toBe(true);
  });

  it("非 32 字节 digest 必须失败", async () => {
    const badDigest16 = new Uint8Array(16);
    badDigest16.fill(1);
    await expect(
      signEcdsaDigest({
        privateKeyBytes: TEST_PRIV_BYTES,
        digest: badDigest16,
        format: "compact"
      })
    ).rejects.toThrow("digest must be 32 bytes");

    const badDigest64 = new Uint8Array(64);
    badDigest64.fill(2);
    await expect(
      signEcdsaDigest({
        privateKeyBytes: TEST_PRIV_BYTES,
        digest: badDigest64,
        format: "der"
      })
    ).rejects.toThrow("digest must be 32 bytes");
  });

  it("非法 format 必须失败", async () => {
    await expect(
      signEcdsaDigest({
        privateKeyBytes: TEST_PRIV_BYTES,
        digest: digest32,
        format: "invalid" as "compact"
      })
    ).rejects.toThrow('unknown format');
  });

  it("不同 digest 生成不同签名", async () => {
    const digest1 = new Uint8Array(32);
    digest1.fill(0x01);
    const digest2 = new Uint8Array(32);
    digest2.fill(0x02);

    const sig1 = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest1,
      format: "compact"
    });
    const sig2 = await signEcdsaDigest({
      privateKeyBytes: TEST_PRIV_BYTES,
      digest: digest2,
      format: "compact"
    });

    // 不同 digest 应产生不同签名
    expect(bytesToHex(sig1)).not.toBe(bytesToHex(sig2));
  });
});

describe("AppMsg message projection", () => {
  it("preserves both plugin endpoints for recipient receive and sender replay", () => {
    const recipientPrivateKeyBytes = hexToBytes(
      "0000000000000000000000000000000000000000000000000000000000000002"
    );
    const recipientPublicKeyBytes = secp256k1.getPublicKey(recipientPrivateKeyBytes, true);
    const sealed = sealAppMessageLocalBytes({
      senderPrivateKeyBytes: TEST_PRIV_BYTES,
      senderPublicKeyBytes: hexToBytes(TEST_PUB_HEX),
      recipientPublicKeyBytes,
      senderEndpoint: { kind: "plugin", id: "keymaster.message" },
      recipientEndpoint: { kind: "plugin", id: "keymaster.message" },
      contentType: "text/plain",
      body: "hello recipient",
      clientMessageId: "client-two-party",
      createdAtMs: 100
    });
    const record = {
      messageId: "message-two-party",
      senderPublicKeyHex: TEST_PUB_HEX,
      senderEndpointKind: "plugin" as const,
      senderEndpointId: "keymaster.message",
      recipientPublicKeyHex: bytesToHex(recipientPublicKeyBytes),
      recipientEndpointKind: "plugin" as const,
      recipientEndpointId: "keymaster.message",
      clientMessageId: "client-two-party",
      createdAtMs: 100,
      insertedAtMs: 101,
      envelope: {
        envelopeBytes: sealed.envelope,
        signatureBytes: sealed.signatureBytes
      }
    };

    const recipientOpened = openAppMessageLocalBytes({
      signed: record.envelope,
      recipientPrivateKeyBytes,
      recipientPublicKeyBytes
    });
    const recipientMessage = buildOpenedAppMsgMessage(record, recipientOpened);
    expect(recipientMessage).toMatchObject({
      senderPublicKeyHex: TEST_PUB_HEX,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: bytesToHex(recipientPublicKeyBytes),
      recipientAppId: "keymaster.message",
      body: "hello recipient"
    });

    const senderOpened = openAppMessageLocalBytes({
      signed: record.envelope,
      recipientPrivateKeyBytes: TEST_PRIV_BYTES,
      recipientPublicKeyBytes: hexToBytes(TEST_PUB_HEX)
    });
    expect(buildOpenedAppMsgMessage(record, senderOpened)).toEqual(recipientMessage);
  });
});
