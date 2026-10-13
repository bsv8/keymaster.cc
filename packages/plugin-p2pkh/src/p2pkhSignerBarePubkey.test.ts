// 裸公钥单签签名（FT05 归集依赖它）。
//
// 判据不是「能产出一笔交易」，而是两处形状都对：
//   - **scriptCode** 必须是调用方给出的完整锁定脚本（P2PKH 路径由地址重建，两者不同）；
//   - **解锁脚本**只推签名，公钥已经在锁定脚本里。
//
// 这两处任一错，sighash 或 scriptSig 就对不上，网络必然拒单，而本地完全看不出问题。

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { signMixedInputs, signP2pkhTx, deriveP2pkhAddress, type UnsignedTx } from "./p2pkhSigner.js";
/**
 * 从 raw 里读出每个输入的 scriptSig。
 *
 * 用现成的交易解析器拿不到 scriptSig（它只暴露 outpoint），而「解锁脚本长什么样」
 * 正是这里要断言的东西，所以自己按 varint 走一遍字节。
 */
function readScriptSigs(rawHex: string): Uint8Array[] {
  const bytes = Uint8Array.from(rawHex.match(/../gu)!.map((b) => parseInt(b, 16)));
  let offset = 4; // version
  const varint = (): number => {
    const first = bytes[offset++] as number;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const value = (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
      offset += 2;
      return value;
    }
    throw new Error("unsupported varint in test");
  };
  const inputCount = varint();
  const scripts: Uint8Array[] = [];
  for (let i = 0; i < inputCount; i += 1) {
    offset += 36; // outpoint
    const length = varint();
    scripts.push(bytes.slice(offset, offset + length));
    offset += length + 4; // scriptSig + sequence
  }
  return scripts;
}

const PRIV = "22".repeat(32);
const PUB = secp256k1.getPublicKey(Uint8Array.from(PRIV.match(/../gu)!.map((b) => parseInt(b, 16))), true);
const PUB_HEX = [...PUB].map((b) => b.toString(16).padStart(2, "0")).join("");
const ADDRESS = deriveP2pkhAddress(PRIV, "main").address;

function signDigest(digest: Uint8Array): Promise<Uint8Array> {
  const raw = secp256k1.sign(digest, Uint8Array.from(PRIV.match(/../gu)!.map((b) => parseInt(b, 16))), { prehash: false, lowS: true });
  const toBig = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const int = (value: bigint): number[] => {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const body = [...Uint8Array.from(hex.match(/../gu)!.map((b) => parseInt(b, 16)))];
    if ((body[0] as number) >= 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  return Promise.resolve(Uint8Array.from([0x30, ...int(toBig(raw.subarray(0, 32))), ...int(toBig(raw.subarray(32, 64)))]));
}

/** `<pubkey> OP_CHECKSIG`：Forum 的 data / tip 输出形状。 */
function barePubkeyScript(): Uint8Array {
  return Uint8Array.from([33, ...PUB, 0xac]);
}

function unsigned(inputCount: number): UnsignedTx {
  return {
    version: 1,
    inputs: Array.from({ length: inputCount }, () => ({
      prevTxid: "ab".repeat(32),
      prevVout: 0,
      scriptSig: new Uint8Array(0),
      sequence: 0xfffffffe,
    })),
    outputs: [{ value: 900, script: Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac]) }],
    lockTime: 0,
  };
}

describe("裸公钥单签签名", () => {
  it("解锁脚本只有签名，不推公钥", async () => {
    const rawHex = await signMixedInputs(
      unsigned(1),
      [{ scriptCode: barePubkeyScript(), value: 1000, pushPublicKeyInUnlock: false }],
      signDigest,
      { publicKey: PUB },
    );
    const scriptSig = readScriptSigs(rawHex)[0] as Uint8Array;
    // 签名（含 FORKASH 类型字节）后就是结束：没有 33 字节公钥推。
    const pushLength = scriptSig[0] as number;
    expect(scriptSig.byteLength).toBe(pushLength + 1);
    expect(scriptSig[scriptSig.byteLength - 1]).toBe(0x41);
  });

  it("P2PKH 输入的解锁脚本仍然是「签名 + 公钥」", async () => {
    const rawHex = await signP2pkhTx(
      unsigned(1),
      [{ txid: "ab".repeat(32), vout: 0, value: 1000, address: ADDRESS, status: "confirmed", isSpentInMempoolTx: false, id: "x", resourceId: "r", publicKeyHex: PUB_HEX, network: "main", syncedAt: "t" }],
      signDigest,
      PUB_HEX,
    );
    const scriptSig = readScriptSigs(rawHex)[0] as Uint8Array;
    const pushLength = scriptSig[0] as number;
    // 签名段 + 33 字节公钥段。
    expect(scriptSig.byteLength).toBe(pushLength + 1 + 1 + 33);
    expect([...scriptSig.slice(scriptSig.byteLength - 33)]).toEqual([...PUB]);
  });

  it("混合形状时逐笔使用各自的解锁策略与 scriptCode", async () => {
    const p2pkhScript = Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(2), 0x88, 0xac]);
    const rawHex = await signMixedInputs(
      unsigned(2),
      [
        { scriptCode: barePubkeyScript(), value: 1, pushPublicKeyInUnlock: false },
        { scriptCode: p2pkhScript, value: 1000, pushPublicKeyInUnlock: true },
      ],
      signDigest,
      { publicKey: PUB },
    );
    const scripts = readScriptSigs(rawHex);
    const bare = scripts[0] as Uint8Array;
    const p2pkh = scripts[1] as Uint8Array;
    // 两笔的解锁脚本长度不同：逐笔策略生效，而不是「先按一种签再覆盖」。
    expect((bare[0] as number) + 1).toBe(bare.byteLength);
    expect((p2pkh[0] as number) + 1 + 1 + 33).toBe(p2pkh.byteLength);
  });

  it("scriptCode 与锁定脚本不一致时签名不随调用方地址变化", async () => {
    // 同一笔 UTXO，用错的 scriptCode 得到的 scriptSig 必须与正确时不同——
    // 否则「形状正确」这个断言就落空了。
    const wrong = Uint8Array.from([33, ...PUB, 0xad]);
    const correctHex = await signMixedInputs(
      unsigned(1),
      [{ scriptCode: barePubkeyScript(), value: 1000, pushPublicKeyInUnlock: false }],
      signDigest,
      { publicKey: PUB },
    );
    const wrongHex = await signMixedInputs(
      unsigned(1),
      [{ scriptCode: wrong, value: 1000, pushPublicKeyInUnlock: false }],
      signDigest,
      { publicKey: PUB },
    );
    expect(correctHex).not.toBe(wrongHex);
  });

  it("输入数量与签名材料不匹配时拒绝", async () => {
    await expect(signMixedInputs(
      unsigned(2),
      [{ scriptCode: barePubkeyScript(), value: 1, pushPublicKeyInUnlock: false }],
      signDigest,
      { publicKey: PUB },
    )).rejects.toThrow(/must match/u);
  });
});
