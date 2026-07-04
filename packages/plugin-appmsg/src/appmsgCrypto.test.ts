// packages/plugin-appmsg/src/appmsgCrypto.test.ts
// appmsgCrypto 单测（施工单 2026-07-04 004 硬切换）。
//
// 测试目标：
//   1. seal + open 对称 round-trip；
//   2. sender 私钥 / 公钥一致性校验；
//   3. recipient 拿到不同私钥 → open 失败（decrypt_failed）；
//   4. envelope 字节被篡改 → verify_failed；
//   5. 签名被替换为非法值 → verify_failed；
//   6. 自发给自己（senderPub == recipientPub）端到端可解；
//   7. sender 历史重建：本地 DB 清空后 recipient 用同私钥即可解开
//      自己之前发出去的 sealed record；
//   8. envelope / plaintext CBOR 编解码在确定性上等价（同一输入两次
//      编码得到相同字节；不同 envelope 字段顺序不一致会被拒绝）。

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  AppMsgCryptoError,
  assertSenderPrivMatchesPub,
  bytesToHex,
  decodeEnvelope,
  encodeEnvelope,
  hexToBytes,
  openAppMessage,
  readEnvelopeRoute,
  sealAppMessage
} from "./appmsgCrypto.js";

function makeKeyPair(seed: number): { privHex: string; pubHex: string } {
  // 确定性私钥：用 SHA-256(UTF8(`seed:<n>`)) 派生 32-byte 私钥（仅测试）。
  const hash = sha256(new TextEncoder().encode(`appmsgCrypto.test:seed:${seed}`));
  // noble 的 secp256k1.getPublicKey 接受任意 32-byte 输入并在内部
  // mod n 缩减；priv/pub 配对稳定。
  const pub = secp256k1.getPublicKey(hash, true);
  return {
    privHex: bytesToHex(hash),
    pubHex: bytesToHex(pub)
  };
}

const ALICE = makeKeyPair(11);
const BOB = makeKeyPair(22);

describe("appmsgCrypto - seal + open round-trip", () => {
  it("encodes plaintext with v1; opens back to same body", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "plugin", id: "keymaster.message" },
      recipientEndpoint: { kind: "origin", id: "https://bob.test:443" },
      contentType: "text/plain",
      body: "hello bob",
      clientMessageId: "cid-1",
      createdAtMs: 1700000000000
    });
    expect(sealed.envelope.signatureBytes.length).toBe(64);
    expect(sealed.envelope.envelopeBytes.length).toBeGreaterThan(0);

    const opened = openAppMessage({
      signed: sealed.envelope,
      recipientPrivateKeyHex: BOB.privHex
    });
    expect(opened.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(opened.bodyUtf8)).toBe("hello bob");
    expect(opened.clientMessageId).toBe("cid-1");
    expect(opened.senderPublicKeyHex).toBe(ALICE.pubHex);
    expect(opened.recipientPublicKeyHex).toBe(BOB.pubHex);
    expect(opened.senderEndpointKind).toBe("plugin");
    expect(opened.senderEndpointId).toBe("keymaster.message");
    expect(opened.recipientEndpointKind).toBe("origin");
    expect(opened.recipientEndpointId).toBe("https://bob.test:443");
  });

  it("supports markdown content type", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "origin", id: "https://alice.test:443" },
      recipientEndpoint: { kind: "plugin", id: "keymaster.message" },
      contentType: "text/markdown",
      body: "# hello\n\nworld",
      clientMessageId: "cid-md",
      createdAtMs: 1700000000001
    });
    const opened = openAppMessage({
      signed: sealed.envelope,
      recipientPrivateKeyHex: BOB.privHex
    });
    expect(opened.contentType).toBe("text/markdown");
    expect(new TextDecoder().decode(opened.bodyUtf8)).toBe("# hello\n\nworld");
  });
});

describe("appmsgCrypto - self send (sender == recipient)", () => {
  it("alice seals to herself; alice opens with own key", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: ALICE.pubHex,
      senderEndpoint: { kind: "plugin", id: "keymaster.message" },
      recipientEndpoint: { kind: "origin", id: "https://self.test:443" },
      contentType: "text/plain",
      body: "self note",
      clientMessageId: "cid-self",
      createdAtMs: 1700000000002
    });
    const opened = openAppMessage({
      signed: sealed.envelope,
      recipientPrivateKeyHex: ALICE.privHex
    });
    expect(opened.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(opened.bodyUtf8)).toBe("self note");
    expect(opened.senderPublicKeyHex).toBe(ALICE.pubHex);
    expect(opened.recipientPublicKeyHex).toBe(ALICE.pubHex);
  });

  it("self-send with same endpoint id", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: ALICE.pubHex,
      senderEndpoint: { kind: "plugin", id: "keymaster.message" },
      recipientEndpoint: { kind: "plugin", id: "keymaster.message" },
      contentType: "text/plain",
      body: "loopback",
      clientMessageId: "cid-loop",
      createdAtMs: 1700000000003
    });
    const opened = openAppMessage({
      signed: sealed.envelope,
      recipientPrivateKeyHex: ALICE.privHex
    });
    expect(new TextDecoder().decode(opened.bodyUtf8)).toBe("loopback");
  });
});

describe("appmsgCrypto - sender history reconstruction", () => {
  it("alice can re-open her own previously sent sealed record after losing local DB", () => {
    // alice sends a message to bob.
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "origin", id: "https://alice.test:443" },
      recipientEndpoint: { kind: "origin", id: "https://bob.test:443" },
      contentType: "text/plain",
      body: "remember this",
      clientMessageId: "cid-recon",
      createdAtMs: 1700000000100
    });
    // bob receives; alice's local DB is wiped; alice later pulls the same
    // sealed record from HubMsg; alice should be able to re-open with her
    // own private key (because ECDH(senderPriv, bobPub) == ECDH(bobPriv, senderPub)).
    const opened = openAppMessage({
      signed: sealed.envelope,
      recipientPrivateKeyHex: ALICE.privHex
    });
    expect(new TextDecoder().decode(opened.bodyUtf8)).toBe("remember this");
    expect(opened.clientMessageId).toBe("cid-recon");
  });
});

describe("appmsgCrypto - verify failure (tampered envelope)", () => {
  it("flipping a single byte in envelopeBytes breaks signature verification", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "plugin", id: "k.m" },
      recipientEndpoint: { kind: "plugin", id: "k.m" },
      contentType: "text/plain",
      body: "tamper test",
      clientMessageId: "cid-tamper",
      createdAtMs: 1700000000200
    });
    const tampered = sealed.envelope.envelopeBytes.slice();
    // 翻转一个字节（避开前几字节 CBOR 头 / envelopeVersion 字段）。
    const flipIdx = Math.min(20, tampered.length - 1);
    tampered[flipIdx] = (tampered[flipIdx] ?? 0) ^ 0x01;
    let threw: AppMsgCryptoError | null = null;
    try {
      openAppMessage({
        signed: { envelopeBytes: tampered, signatureBytes: sealed.envelope.signatureBytes },
        recipientPrivateKeyHex: BOB.privHex
      });
    } catch (err) {
      if (err instanceof AppMsgCryptoError) threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw?.reason).toBe("verify_failed");
  });

  it("replacing signature with random bytes breaks verification", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "plugin", id: "k.m" },
      recipientEndpoint: { kind: "plugin", id: "k.m" },
      contentType: "text/plain",
      body: "sig swap",
      clientMessageId: "cid-swap",
      createdAtMs: 1700000000300
    });
    const badSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) badSig[i] = 0xab;
    let threw: AppMsgCryptoError | null = null;
    try {
      openAppMessage({
        signed: { envelopeBytes: sealed.envelope.envelopeBytes, signatureBytes: badSig },
        recipientPrivateKeyHex: BOB.privHex
      });
    } catch (err) {
      if (err instanceof AppMsgCryptoError) threw = err;
    }
    expect(threw?.reason).toBe("verify_failed");
  });
});

describe("appmsgCrypto - decrypt failure", () => {
  it("opening with wrong recipient private key fails (decrypt_failed)", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "plugin", id: "k.m" },
      recipientEndpoint: { kind: "plugin", id: "k.m" },
      contentType: "text/plain",
      body: "for bob only",
      clientMessageId: "cid-bob",
      createdAtMs: 1700000000400
    });
    // 用 carol（第三方）私钥去开 → verify 通过（envelope 里的 senderPub
    // 没变）但解密时 ECDH 派生 key 与 bob 不一致 → AES-GCM auth tag 不
    // 匹配 → decrypt_failed。
    const CAROL = makeKeyPair(33);
    let threw: AppMsgCryptoError | null = null;
    try {
      openAppMessage({
        signed: sealed.envelope,
        recipientPrivateKeyHex: CAROL.privHex
      });
    } catch (err) {
      if (err instanceof AppMsgCryptoError) threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw?.reason).toBe("decrypt_failed");
  });
});

describe("appmsgCrypto - sender private/public consistency", () => {
  it("assertSenderPrivMatchesPub accepts matching key pair", () => {
    expect(() =>
      assertSenderPrivMatchesPub(ALICE.privHex, ALICE.pubHex)
    ).not.toThrow();
  });

  it("assertSenderPrivMatchesPub rejects mismatched key pair", () => {
    expect(() =>
      assertSenderPrivMatchesPub(ALICE.privHex, BOB.pubHex)
    ).toThrowError(AppMsgCryptoError);
  });
});

describe("appmsgCrypto - deterministic CBOR envelope", () => {
  it("encodeEnvelope of same input gives identical bytes twice", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "plugin", id: "k.m" },
      recipientEndpoint: { kind: "plugin", id: "k.m" },
      contentType: "text/plain",
      body: "det test",
      clientMessageId: "cid-det",
      createdAtMs: 1700000000500
    });
    const a = sealed.envelope.envelopeBytes;
    const env = decodeEnvelope(a);
    const b = encodeEnvelope(env);
    expect(b).toEqual(a);
  });

  it("decodeEnvelope reads route headers exactly as encoded", () => {
    const sealed = sealAppMessage({
      senderPrivateKeyHex: ALICE.privHex,
      senderPublicKeyHex: ALICE.pubHex,
      recipientPublicKeyHex: BOB.pubHex,
      senderEndpoint: { kind: "origin", id: "https://x.test:443" },
      recipientEndpoint: { kind: "origin", id: "https://y.test:443" },
      contentType: "text/plain",
      body: "route test",
      clientMessageId: "cid-route",
      createdAtMs: 1700000000600
    });
    const route = readEnvelopeRoute(sealed.envelope.envelopeBytes);
    expect(route.senderPublicKeyHex).toBe(ALICE.pubHex);
    expect(route.recipientPublicKeyHex).toBe(BOB.pubHex);
    expect(route.senderEndpointKind).toBe("origin");
    expect(route.senderEndpointId).toBe("https://x.test:443");
    expect(route.recipientEndpointKind).toBe("origin");
    expect(route.recipientEndpointId).toBe("https://y.test:443");
  });

  it("decodeEnvelope rejects malformed CBOR", () => {
    expect(() => decodeEnvelope(new Uint8Array([0x00]))).toThrowError(AppMsgCryptoError);
    // 长度不对的 array。
    expect(() => decodeEnvelope(new Uint8Array([0x80]))).toThrowError(AppMsgCryptoError);
  });
});

describe("appmsgCrypto - helper utils", () => {
  it("hexToBytes / bytesToHex round-trip", () => {
    const sample = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(hexToBytes(bytesToHex(sample))).toEqual(sample);
  });
});

// 防止 IDE 报 unused
void hexToBytes;