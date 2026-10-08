import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import type { ForumConfig } from "@keymaster/contracts";

import { bytesToHex, displayToRawTxid, hexToBytes } from "../protocol/bytes.js";
import { sha256Digest } from "../protocol/crypto.js";
import { buildGenesisOutputs, parseGenesisTransaction } from "../protocol/layout.js";
import { KIND_FORUM, buildLockingScript } from "../protocol/script.js";
import { encodeForumSignatureObject, signForumSignatureObject, type ForumSignatureObject, type SigningPort } from "../protocol/signatureObjects.js";
import { inputOutpointTxid, parseTransaction, serializeTransaction, type RawTransaction } from "../protocol/transaction.js";
import { FORUM_SERVER_BASELINE, ForumTrustError, rootEvidenceIsUsable, verifyForumRoot } from "./rootTrust.js";

const hash = (input: Uint8Array): Uint8Array => sha256(input);

const forumPrivateKey = hexToBytes("11".repeat(32));
const forumPublicKey = secp256k1.getPublicKey(forumPrivateKey, true);
const forumPublicKeyHex = bytesToHex(forumPublicKey);
const otherPublicKey = secp256k1.getPublicKey(hexToBytes("22".repeat(32)), true);
const otherPublicKeyHex = bytesToHex(otherPublicKey);

const localPort: SigningPort = {
  async signDigest(digest) {
    const raw = secp256k1.sign(digest, hexToBytes("11".repeat(32)), { prehash: false, lowS: true });
    const toBig = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    const int = (value: bigint): number[] => {
      let hex = value.toString(16);
      if (hex.length % 2 !== 0) hex = `0${hex}`;
      const body = [...hexToBytes(hex)];
      if ((body[0] as number) >= 0x80) body.unshift(0);
      return [0x02, body.length, ...body];
    };
    const body = [...int(toBig(raw.subarray(0, 32))), ...int(toBig(raw.subarray(32, 64)))];
    return Uint8Array.from([0x30, body.length, ...body]);
  },
  async verifyDigest() {
    throw new Error("测试端口不提供验证");
  },
};

interface RootFixture {
  readonly config: ForumConfig;
  readonly raw: Uint8Array;
  readonly txid: string;
}

/** 造一笔真实的创世声明 raw：输出结构、四项 forumSig、两个输出都点名论坛公钥。 */
async function buildRoot(options: { forumName?: string; tipPrice?: bigint; inputs?: number } = {}): Promise<RootFixture> {
  const inputCount = options.inputs ?? 1;
  const fundingTxids = Array.from({ length: inputCount }, (_unused, index) => new Uint8Array(32).fill(index + 1));
  const object = {
    kind: KIND_FORUM,
    forumName: options.forumName ?? "测试论坛",
    tipPrice: options.tipPrice ?? 4n,
    inputs: fundingTxids.map((txid, index) => ({ txid, vout: index })),
  } as ForumSignatureObject;
  const forumSig = await signForumSignatureObject(object, localPort, hash);
  const outputs = buildGenesisOutputs({
    forumName: object.forumName,
    tipPrice: object.tipPrice,
    forumSig,
    forumPublicKey: forumPublicKey,
    changeSatoshis: 999n,
  });
  const raw = serializeTransaction({
    version: 1,
    inputs: fundingTxids.map((txid, index) => ({
      previousTxid: displayToRawTxid(txid),
      previousVout: index,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff,
    })),
    outputs: outputs.map((output) => ({ ...output })),
    locktime: 0,
  });
  const txid = bytesToHex(parseTransaction(raw, hash).txid);
  return {
    config: {
      id: "forum-main",
      label: "测试论坛",
      network: "main",
      forumTxid: txid,
      forumPublicKeyHex,
      endpoints: [{ kind: "https", url: "https://forum.example/roundtrip" }],
    },
    raw,
    txid,
  };
}

describe("创世根信任验证", () => {
  it("接受结构、txid、forumSig 与两个输出公钥都一致的根", async () => {
    const fixture = await buildRoot();
    const evidence = verifyForumRoot({ config: fixture.config, rawTxBytes: fixture.raw, nowMs: 1_700_000_000_000 });
    expect(evidence.forumTxid).toBe(fixture.txid);
    expect(evidence.forumName).toBe("测试论坛");
    expect(evidence.tipPrice).toBe("4");
    expect(evidence.forumPublicKeyHex).toBe(forumPublicKeyHex);
    expect(evidence.payToPublicKeyHex).toBe(forumPublicKeyHex);
    expect(evidence.rawTxHex).toBe(bytesToHex(fixture.raw));
    expect(evidence.baseline).toBe(FORUM_SERVER_BASELINE);
    expect(evidence.configId).toBe("forum-main");
  });

  it("raw 的 txid 与配置不一致时拒绝", async () => {
    const fixture = await buildRoot();
    const wrongTxid = { ...fixture.config, forumTxid: "ff".repeat(32) };
    expect(() => verifyForumRoot({ config: wrongTxid, rawTxBytes: fixture.raw, nowMs: 0 })).toThrow(/txid/);
  });

  it("配置的论坛公钥与实际不符时拒绝：地址不替代身份", async () => {
    const fixture = await buildRoot();
    const wrongKey = { ...fixture.config, forumPublicKeyHex: otherPublicKeyHex };
    expect(() => verifyForumRoot({ config: wrongKey, rawTxBytes: fixture.raw, nowMs: 0 })).toThrow(/不一致/);
  });

  it("forumSig 用别的 key 签名时拒绝", async () => {
    const object = {
      kind: KIND_FORUM,
      forumName: "x",
      tipPrice: 1n,
      inputs: [{ txid: new Uint8Array(32).fill(1), vout: 0 }],
    } as ForumSignatureObject;
    const foreignSig = await signForumSignatureObject(
      object,
      {
        async signDigest(digest) {
          const raw = secp256k1.sign(digest, hexToBytes("22".repeat(32)), { prehash: false, lowS: true });
          const toBig = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
          const int = (value: bigint): number[] => {
            let hex = value.toString(16);
            if (hex.length % 2 !== 0) hex = `0${hex}`;
            const body = [...hexToBytes(hex)];
            if ((body[0] as number) >= 0x80) body.unshift(0);
            return [0x02, body.length, ...body];
          };
          const body = [...int(toBig(raw.subarray(0, 32))), ...int(toBig(raw.subarray(32, 64)))];
          return Uint8Array.from([0x30, body.length, ...body]);
        },
        async verifyDigest() {
          throw new Error("unused");
        },
      },
      hash,
    );
    const outputs = buildGenesisOutputs({
      forumName: "x",
      tipPrice: 1n,
      forumSig: foreignSig,
      forumPublicKey: forumPublicKey,
      changeSatoshis: 1n,
    });
    const raw = serializeTransaction({
      version: 1,
      inputs: [{ previousTxid: displayToRawTxid(object.inputs[0]!.txid), previousVout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
      outputs: outputs.map((output) => ({ ...output })),
      locktime: 0,
    });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    const config: ForumConfig = { ...(await buildRoot()).config, forumTxid: txid };
    expect(() => verifyForumRoot({ config, rawTxBytes: raw, nowMs: 0 })).toThrow(/forumSig/);
  });

  it("把找零付给别人的声明被拒绝：两个输出都必须点名论坛公钥", async () => {
    const object = {
      kind: KIND_FORUM,
      forumName: "x",
      tipPrice: 1n,
      inputs: [{ txid: new Uint8Array(32).fill(1), vout: 0 }],
    } as ForumSignatureObject;
    const forumSig = await signForumSignatureObject(object, localPort, hash);
    const raw = serializeTransaction({
      version: 1,
      inputs: [{ previousTxid: displayToRawTxid(object.inputs[0]!.txid), previousVout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
      outputs: [
        // vout 0 是找零，这里锁给另一个人。
        { value: 999n, lockingScript: buildLockingScript(otherPublicKey) },
        { value: 1n, lockingScript: buildGenesisOutputs({ forumName: "x", tipPrice: 1n, forumSig, forumPublicKey: forumPublicKey, changeSatoshis: 1n })[1]!.lockingScript },
      ],
      locktime: 0,
    });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    const config: ForumConfig = { ...(await buildRoot()).config, forumTxid: txid };
    expect(() => verifyForumRoot({ config, rawTxBytes: raw, nowMs: 0 })).toThrow(/找零输出的收款公钥/);
  });

  it("input 顺序被交换时 forumSig 失效：签名绑定全部 outpoint 的顺序", async () => {
    const first = new Uint8Array(32).fill(0x01);
    const second = new Uint8Array(32).fill(0x02);
    // 先按 [A, B] 的顺序签名。
    const orderedSig = await signForumSignatureObject(
      { kind: KIND_FORUM, forumName: "x", tipPrice: 1n, inputs: [{ txid: first, vout: 0 }, { txid: second, vout: 1 }] },
      localPort,
      hash,
    );
    const dataScript = buildGenesisOutputs({
      forumName: "x",
      tipPrice: 1n,
      forumSig: orderedSig,
      forumPublicKey: forumPublicKey,
      changeSatoshis: 1n,
    })[1]!.lockingScript;
    // 交易本身把 input 顺序换成 [B, A]；txid 因此不同，用它作为配置的根。
    const raw = serializeTransaction({
      version: 1,
      inputs: [
        { previousTxid: displayToRawTxid(second), previousVout: 1, scriptSig: new Uint8Array(0), sequence: 0xffffffff },
        { previousTxid: displayToRawTxid(first), previousVout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff },
      ],
      outputs: [
        { value: 1n, lockingScript: buildLockingScript(forumPublicKey) },
        { value: 1n, lockingScript: dataScript },
      ],
      locktime: 0,
    });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    const config: ForumConfig = { ...(await buildRoot()).config, forumTxid: txid };
    // 从 raw 重建出的 input 顺序是 [B, A]，与签名覆盖的 [A, B] 不同，因此验签失败。
    expect(() => verifyForumRoot({ config, rawTxBytes: raw, nowMs: 0 })).toThrow(/forumSig/);
  });

  it("多 input 的根按全部 outpoint 顺序重建后验签通过", async () => {
    const fixture = await buildRoot({ inputs: 3 });
    const evidence = verifyForumRoot({ config: fixture.config, rawTxBytes: fixture.raw, nowMs: 0 });
    const tx: RawTransaction = parseTransaction(fixture.raw, hash);
    const parsed = parseGenesisTransaction(tx, (index) => inputOutpointTxid(tx.inputs[index] as never));
    expect(parsed.inputs).toHaveLength(3);
    expect(parsed.inputs.map((entry) => entry.vout)).toEqual([0, 1, 2]);
    // 重建的对象与服务端当初签的是同一串字节。
    expect(
      bytesToHex(
        encodeForumSignatureObject({
          kind: KIND_FORUM,
          forumName: evidence.forumName,
          tipPrice: BigInt(evidence.tipPrice),
          inputs: parsed.inputs,
        }),
      ),
    ).toBe(
      bytesToHex(
        encodeForumSignatureObject({
          kind: KIND_FORUM,
          forumName: "测试论坛",
          tipPrice: 4n,
          inputs: [
            { txid: new Uint8Array(32).fill(1), vout: 0 },
            { txid: new Uint8Array(32).fill(2), vout: 1 },
            { txid: new Uint8Array(32).fill(3), vout: 2 },
          ],
        }),
      ),
    );
  });

  it("拒绝尾随字节、空 raw 与非法配置字段", async () => {
    const fixture = await buildRoot();
    expect(() => verifyForumRoot({ config: fixture.config, rawTxBytes: Uint8Array.from([...fixture.raw, 0]), nowMs: 0 })).toThrow(/根 raw/);
    expect(() => verifyForumRoot({ config: fixture.config, rawTxBytes: new Uint8Array(0), nowMs: 0 })).toThrow(/根 raw/);
    expect(() =>
      verifyForumRoot({ config: { ...fixture.config, forumPublicKeyHex: "not-a-key" }, rawTxBytes: fixture.raw, nowMs: 0 }),
    ).toThrow(/压缩公钥/);
    expect(() => verifyForumRoot({ config: { ...fixture.config, forumTxid: "abc" }, rawTxBytes: fixture.raw, nowMs: 0 })).toThrow(/64 字符/);
  });

  it("证据只有在根与公钥都匹配时才可用：更新公钥必须重新验证根", async () => {
    const fixture = await buildRoot();
    const evidence = verifyForumRoot({ config: fixture.config, rawTxBytes: fixture.raw, nowMs: 0 });
    expect(rootEvidenceIsUsable(evidence, fixture.config)).toBe(true);
    // 换公钥后旧证据失效。
    expect(rootEvidenceIsUsable(evidence, { ...fixture.config, forumPublicKeyHex: otherPublicKeyHex })).toBe(false);
    // 换根后旧证据失效。
    expect(rootEvidenceIsUsable(evidence, { ...fixture.config, forumTxid: "ff".repeat(32) })).toBe(false);
    expect(rootEvidenceIsUsable(undefined, fixture.config)).toBe(false);
    expect(rootEvidenceIsUsable(evidence, undefined)).toBe(false);
  });

  it("错误码是稳定标识，便于界面按 code 展示", async () => {
    const fixture = await buildRoot();
    try {
      verifyForumRoot({ config: { ...fixture.config, forumTxid: "ff".repeat(32) }, rawTxBytes: fixture.raw, nowMs: 0 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForumTrustError);
      expect((error as ForumTrustError).code).toBe("root-txid");
    }
  });

  it("摘要只用一次 SHA-256（与双 SHA-256 的 txid 区分）", async () => {
    // 直接证明 forumSig 覆盖的是单次 SHA-256 的 CBOR 字节。
    const object = { kind: KIND_FORUM, forumName: "v", tipPrice: 1n, inputs: [{ txid: new Uint8Array(32).fill(1), vout: 0 }] } as ForumSignatureObject;
    const encoded = encodeForumSignatureObject(object);
    expect(sha256Digest(encoded)).toEqual(sha256(encoded));
    expect(bytesToHex(sha256Digest(encoded))).not.toBe(bytesToHex(sha256(sha256(encoded))));
  });
});