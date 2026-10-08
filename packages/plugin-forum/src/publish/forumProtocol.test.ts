import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import { forumAmountToBigInt } from "@keymaster/contracts";

import { bytesToHex, displayToRawTxid, hexToBytes } from "../protocol/bytes.js";
import { sha256Digest } from "../protocol/crypto.js";
import { buildLockingScript, KIND_CHANGETIP, KIND_REPLY } from "../protocol/script.js";
import {
  encodeChangeTipIndexObject,
  encodeReplyIndexObject,
  signChangeTipOperatorObject,
  signReplyOperatorObject,
  type ChangeTipIndexObject,
  type ReplyIndexObject,
  type SigningPort,
} from "../protocol/signatureObjects.js";
import { parseTransaction, serializeTransaction } from "../protocol/transaction.js";
import {
  buildFeeBreakdown,
  buildForumProtocolOutputs,
  estimateMinerFeeBudget,
  FORUM_MAX_INPUT_SIGNATURE_BYTES,
  ForumProtocolError,
  planForumFunding,
  reconcileMinerFee,
  totalFeeSatoshis,
  verifyChangeTipQuote,
  verifyFinalRaw,
  verifyReplyQuote,
} from "./forumProtocol.js";

const hash = (input: Uint8Array): Uint8Array => sha256(input);

function portFor(privateKeyHex: string): SigningPort {
  return {
    async signDigest(digest) {
      const raw = secp256k1.sign(digest, hexToBytes(privateKeyHex), { prehash: false, lowS: true });
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
}

const forumPort = portFor("11".repeat(32));
const clientPort = portFor("22".repeat(32));
const forumPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes("11".repeat(32)), true));
const clientPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes("22".repeat(32)), true));
const parentPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes("33".repeat(32)), true));

const PARENT_TXID = "11".repeat(32);
const SEED_HASH = "22".repeat(32);

async function replyFixtures(input: { parentTipPrice?: bigint; indexPrice?: bigint; tipPrice?: bigint } = {}) {
  const tipPrice = input.tipPrice ?? 7n;
  const indexPrice = input.indexPrice ?? 100n;
  const operatorSig = await signReplyOperatorObject(
    { kind: KIND_REPLY, parentTxid: hexToBytes(PARENT_TXID), parentPublicKey: hexToBytes(parentPublicKeyHex), replyMasterSeedHash: hexToBytes(SEED_HASH), tipPrice },
    clientPort,
    hash,
  );
  // satisfies 让 fixture 的字面量 kind 保持协议要求的精确类型。
  const indexObject = {
    kind: KIND_REPLY,
    parentTxid: hexToBytes(PARENT_TXID),
    parentPublicKey: hexToBytes(parentPublicKeyHex),
    replyMasterSeedHash: hexToBytes(SEED_HASH),
    tipPrice,
    operatorSig,
    payToPublicKey: hexToBytes(forumPublicKeyHex),
    indexPrice,
    lastBlockHeight: 900_000n,
  } satisfies ReplyIndexObject;
  const indexSig = await forumPort.signDigest(hash(encodeReplyIndexObject(indexObject)));
  return { tipPrice, indexPrice, operatorSig, indexSig, indexObject };
}

async function changeTipFixtures(input: { indexPrice?: bigint } = {}) {
  const indexPrice = input.indexPrice ?? 50n;
  const operatorSig = await signChangeTipOperatorObject(
    { kind: KIND_CHANGETIP, parentTxid: hexToBytes(PARENT_TXID), tipPrice: 9n },
    clientPort,
    hash,
  );
  const indexObject = {
    kind: KIND_CHANGETIP,
    parentTxid: hexToBytes(PARENT_TXID),
    tipPrice: 9n,
    payToPublicKey: hexToBytes(forumPublicKeyHex),
    indexPrice,
    lastBlockHeight: 900_000n,
  } satisfies ChangeTipIndexObject;
  const indexSig = await forumPort.signDigest(hash(encodeChangeTipIndexObject(indexObject)));
  return { indexPrice, operatorSig, indexSig };
}

describe("报价验证", () => {
  it("用将要上链的字段验证 reply 的 indexSig 通过", async () => {
    const f = await replyFixtures();
    const object = verifyReplyQuote({
      forumPublicKeyHex,
      parentTxid: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHash: SEED_HASH,
      tipPrice: f.tipPrice.toString(),
      operatorSigHex: bytesToHex(f.operatorSig),
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: f.indexPrice.toString(),
        lastBlockHeight: "900000",
        parentTipPrice: "500",
        indexSigHex: bytesToHex(f.indexSig),
      },
    });
    expect(object.indexPrice).toBe(100n);
    expect(object.lastBlockHeight).toBe(900_000n);
  });

  it("indexSig 覆盖的任一字段被改动都失败", async () => {
    const f = await replyFixtures();
    const base = {
      forumPublicKeyHex,
      parentTxid: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHash: SEED_HASH,
      tipPrice: "7",
      operatorSigHex: bytesToHex(f.operatorSig),
      clientPublicKeyHex,
      quote: {
        payto_publickey: undefined,
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        parentTipPrice: "500",
        indexSigHex: bytesToHex(f.indexSig),
      },
    };
    const quote = base.quote;
    // 只进入 indexSig 的字段（父节点作者的付款目标、索引费、报价有效期）：
    // 改动后失败点就是 indexSig。
    expect(() => verifyReplyQuote({ ...base, quote: { ...quote, indexPrice: "101" } })).toThrow(/indexSig/);
    expect(() => verifyReplyQuote({ ...base, quote: { ...quote, lastBlockHeight: "900001" } })).toThrow(/indexSig/);
    expect(() => verifyReplyQuote({ ...base, quote: { ...quote, payToPublicKeyHex: parentPublicKeyHex } })).toThrow(/indexSig/);
    // 同时进入两个签名对象的字段（父节点、正文 hash、未来回复价）：改动后在
    // operatorSig 上就失败，因为 operatorSig 先被验证——两种失败都说明该字段
    // 被签名覆盖。
    expect(() => verifyReplyQuote({ ...base, tipPrice: "8" })).toThrow(/operatorSig/);
    expect(() => verifyReplyQuote({ ...base, replyMasterSeedHash: "33".repeat(32) })).toThrow(/operatorSig/);
    expect(() => verifyReplyQuote({ ...base, parentTxid: "44".repeat(32) })).toThrow(/operatorSig/);
    const otherParent = bytesToHex(secp256k1.getPublicKey(hexToBytes("44".repeat(32)), true));
    expect(() => verifyReplyQuote({ ...base, parentPublicKeyHex: otherParent })).toThrow(/operatorSig/);
  });

  it("operatorSig 必须能用 clientpublickey 验证", async () => {
    const f = await replyFixtures();
    const otherClient = bytesToHex(secp256k1.getPublicKey(hexToBytes("44".repeat(32)), true));
    expect(() =>
      verifyReplyQuote({
        forumPublicKeyHex,
        parentTxid: PARENT_TXID,
        parentPublicKeyHex,
        replyMasterSeedHash: SEED_HASH,
        tipPrice: "7",
        operatorSigHex: bytesToHex(f.operatorSig),
        clientPublicKeyHex: otherClient,
        quote: {
          payToPublicKeyHex: forumPublicKeyHex,
          indexPrice: "100",
          lastBlockHeight: "900000",
          indexSigHex: bytesToHex(f.indexSig),
        },
      }),
    ).toThrow(/operatorSig/);
  });

  it("changetip 的 indexSig 同样必须覆盖将要上链的字段", async () => {
    const f = await changeTipFixtures();
    const quote = {
      payToPublicKeyHex: forumPublicKeyHex,
      indexPrice: "50",
      lastBlockHeight: "900000",
      indexSigHex: bytesToHex(f.indexSig),
    };
    expect(
      verifyChangeTipQuote({
        forumPublicKeyHex,
        parentTxid: PARENT_TXID,
        tipPrice: "9",
        operatorSigHex: bytesToHex(f.operatorSig),
        clientPublicKeyHex,
        quote,
      }).indexPrice,
    ).toBe(50n);
    expect(() =>
      verifyChangeTipQuote({
        forumPublicKeyHex,
        parentTxid: PARENT_TXID,
        tipPrice: "10",
        operatorSigHex: bytesToHex(f.operatorSig),
        clientPublicKeyHex,
        quote,
      }),
    ).toThrow(/indexSig/);
  });

  it("非规范金额与非法 hex 直接拒绝，不截断也不隐式转换", async () => {
    const f = await replyFixtures();
    const base = {
      forumPublicKeyHex,
      parentTxid: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHash: SEED_HASH,
      tipPrice: "7",
      operatorSigHex: bytesToHex(f.operatorSig),
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
    };
    expect(() => verifyReplyQuote({ ...base, tipPrice: "007" })).toThrow(/规范十进制/);
    expect(() => verifyReplyQuote({ ...base, quote: { ...base.quote, indexPrice: "+100" } })).toThrow(/规范十进制/);
    expect(() => verifyReplyQuote({ ...base, quote: { ...base.quote, indexSigHex: "ABCDEF" } })).toThrow(/偶数长度/);
    // uint64 上限是合法金额。
    expect(forumAmountToBigInt("18446744073709551615")).toBe(0xffffffffffffffffn);
    expect(forumAmountToBigInt("18446744073709551616")).toBeUndefined();
  });
});

describe("无找零输出布局", () => {
  it("reply 在父价非零时是三个输出，且没有找零", async () => {
    const f = await replyFixtures({ parentTipPrice: 500n });
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        parentTipPrice: "500",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 500n,
    });
    expect(outputs).toHaveLength(3);
    expect(outputs.map((output) => output.value)).toEqual([100n, 1n, 500n]);
  });

  it("父价为零时省略 vout 2，不生成零值打赏", async () => {
    const f = await replyFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        parentTipPrice: "0",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 0n,
    });
    expect(outputs).toHaveLength(2);
  });

  it("索引费为零仍保留 vout 0，固定输出位置不改变", async () => {
    const f = await replyFixtures({ indexPrice: 0n });
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "0",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 0n,
    });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.value).toBe(0n);
    // vout 0 仍然是 <payto> OP_CHECKSIG，vout 1 仍然固定 1 sat。
    expect(outputs[0]?.lockingScript).toEqual(buildLockingScript(hexToBytes(forumPublicKeyHex)));
    expect(outputs[1]?.value).toBe(1n);
  });

  it("changetip 恰好两个输出", async () => {
    const f = await changeTipFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "changetip",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      tipPrice: 9n,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "50",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
    });
    expect(outputs).toHaveLength(2);
    expect(outputs[1]?.value).toBe(1n);
  });

  it("reply 缺少已冻结正文 hash 时拒绝", async () => {
    const f = await replyFixtures();
    expect(() =>
      buildForumProtocolOutputs({
        kind: "reply",
        parentTxidHex: PARENT_TXID,
        parentPublicKeyHex,
        tipPrice: f.tipPrice,
        operatorSig: f.operatorSig,
        lastBlockHeight: 900_000n,
        indexSig: f.indexSig,
        clientPublicKeyHex,
        quote: {
          payToPublicKeyHex: forumPublicKeyHex,
          indexPrice: "100",
          lastBlockHeight: "900000",
          indexSigHex: bytesToHex(f.indexSig),
        },
      }),
    ).toThrow(/seed hash/);
  });
});

describe("最终 raw 自检", () => {
  const fundingInput = () => ({
    previousTxid: displayToRawTxid(new Uint8Array(32).fill(0x01)),
    previousVout: 0,
    scriptSig: new Uint8Array(0),
    sequence: 0xffffffff,
  });

  it("reply 的 raw 从输出重建并验签通过", async () => {
    const f = await replyFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        parentTipPrice: "500",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 500n,
    });
    const raw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: outputs.map((o) => ({ ...o })), locktime: 0 });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    const verified = verifyFinalRaw({ forumPublicKeyHex, kind: "reply", rawTxBytes: raw, expectedTxid: txid });
    expect(verified).toEqual({ txid, indexPrice: 100n, parentTipPrice: 500n });
  });

  it("txid 与记录不一致时拒绝广播", async () => {
    const f = await replyFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 0n,
    });
    const raw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: outputs.map((o) => ({ ...o })), locktime: 0 });
    expect(() => verifyFinalRaw({ forumPublicKeyHex, kind: "reply", rawTxBytes: raw, expectedTxid: "ff".repeat(32) })).toThrow(/txid/);
  });

  it("被加了一个找零输出的 raw 被拒绝", async () => {
    const f = await replyFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "100",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
      parentTipPriceSatoshis: 0n,
    });
    // 追加一个找零输出：reply 最多三个输出，且第三个位置只能是 tip。
    const withChange = [...outputs, { value: 50n, lockingScript: buildLockingScript(hexToBytes(clientPublicKeyHex)) }];
    const raw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: withChange.map((o) => ({ ...o })), locktime: 0 });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    // vout 2 位置上的东西不是 bsv8.tip.1 脚本，解析层先拒绝：
    // 这正是「reply 没有找零、第三个输出只能是 tip」的执行方式。
    expect(() => verifyFinalRaw({ forumPublicKeyHex, kind: "reply", rawTxBytes: raw, expectedTxid: txid })).toThrow(/tip 输出/);
  });

  it("changetip 的 raw 多一个输出时被拒绝", async () => {
    const f = await changeTipFixtures();
    const outputs = buildForumProtocolOutputs({
      kind: "changetip",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      tipPrice: 9n,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      indexSig: f.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "50",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(f.indexSig),
      },
    });
    const withExtra = [...outputs, { value: 1n, lockingScript: outputs[1]!.lockingScript }];
    const raw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: withExtra.map((o) => ({ ...o })), locktime: 0 });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    expect(() => verifyFinalRaw({ forumPublicKeyHex, kind: "changetip", rawTxBytes: raw, expectedTxid: txid })).toThrow(/必须是 2 个输出/);
  });

  it("被换掉 indexSig 的 raw 验签失败", async () => {
    const f = await replyFixtures();
    const other = await replyFixtures({ indexPrice: 200n });
    const outputs = buildForumProtocolOutputs({
      kind: "reply",
      parentTxidHex: PARENT_TXID,
      parentPublicKeyHex,
      replyMasterSeedHashHex: SEED_HASH,
      tipPrice: f.tipPrice,
      operatorSig: f.operatorSig,
      lastBlockHeight: 900_000n,
      // 把 index_price 改成 100 的 indexSig 装进一个声明 200 的数据输出。
      indexSig: other.indexSig,
      clientPublicKeyHex,
      quote: {
        payToPublicKeyHex: forumPublicKeyHex,
        indexPrice: "200",
        lastBlockHeight: "900000",
        indexSigHex: bytesToHex(other.indexSig),
      },
      parentTipPriceSatoshis: 0n,
    });
    const raw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: outputs.map((o) => ({ ...o })), locktime: 0 });
    const txid = bytesToHex(parseTransaction(raw, hash).txid);
    // indexSig 覆盖 index_price=200，但 vout 0 实际付的是 200；改 vout 0 制造不一致。
    const tampered = [...outputs];
    tampered[0] = { value: 100n, lockingScript: outputs[0]!.lockingScript };
    const tamperedRaw = serializeTransaction({ version: 1, inputs: [fundingInput()], outputs: tampered.map((o) => ({ ...o })), locktime: 0 });
    const tamperedTxid = bytesToHex(parseTransaction(tamperedRaw, hash).txid);
    expect(() =>
      verifyFinalRaw({ forumPublicKeyHex, kind: "reply", rawTxBytes: tamperedRaw, expectedTxid: tamperedTxid }),
    ).toThrow(/indexSig/);
    // 未篡改的那笔通过。
    expect(verifyFinalRaw({ forumPublicKeyHex, kind: "reply", rawTxBytes: raw, expectedTxid: txid }).indexPrice).toBe(200n);
  });
});

describe("资金准备与费用预算", () => {
  it("按输入签名长度上界估算：预算等于 ceil(最坏字节数 × 费率 / 1000)", () => {
    expect(FORUM_MAX_INPUT_SIGNATURE_BYTES).toBe(1 + 73 + 1 + 33);
    // 费率单位是 sat/KB，预算因此是按 KB 向上取整的，不在低费率上线性。
    const worstCaseBytes = 1 * (36 + 4 + FORUM_MAX_INPUT_SIGNATURE_BYTES) + 3 * (8 + 10 + 128) + 1024;
    for (const rate of [1, 7, 50, 500, 1000]) {
      expect(estimateMinerFeeBudget({ inputCount: 1, outputCount: 3, feeRateSatoshisPerKb: rate })).toBe(
        (BigInt(worstCaseBytes) * BigInt(rate) + 999n) / 1000n,
      );
    }
    // 输出更多时上界更大：预算跟着上界走而不是取常数。
    expect(estimateMinerFeeBudget({ inputCount: 1, outputCount: 3, feeRateSatoshisPerKb: 1000 })).toBeGreaterThan(
      estimateMinerFeeBudget({ inputCount: 1, outputCount: 2, feeRateSatoshisPerKb: 1000 }),
    );
    // 费率单调：更高的费率不会给出更小的预算。
    let previous = 0n;
    for (const rate of [1, 10, 100, 1000, 10_000]) {
      const budget = estimateMinerFeeBudget({ inputCount: 1, outputCount: 3, feeRateSatoshisPerKb: rate });
      expect(budget >= previous).toBe(true);
      previous = budget;
    }
  });

  it("拒绝非法输入数与费率", () => {
    expect(() => estimateMinerFeeBudget({ inputCount: 0, outputCount: 3, feeRateSatoshisPerKb: 1 })).toThrow(/至少/);
    expect(() => estimateMinerFeeBudget({ inputCount: 1, outputCount: 3, feeRateSatoshisPerKb: 0 })).toThrow(/正数/);
    expect(() => estimateMinerFeeBudget({ inputCount: 1, outputCount: 3, feeRateSatoshisPerKb: Number.NaN })).toThrow(/正数/);
  });

  it("资金不足时要求重新准备而不是把余额差给矿工", () => {
    expect(() =>
      planForumFunding({ availableSatoshis: 200n, fixedOutputsSatoshis: 101n, maxMinerFeeSatoshis: 1000n, feeRateSatoshisPerKb: 1 }),
    ).toThrow(/不足/);
    const plan = planForumFunding({
      availableSatoshis: 100_000n,
      fixedOutputsSatoshis: 101n,
      maxMinerFeeSatoshis: 1_500n,
      feeRateSatoshisPerKb: 1,
    });
    expect(plan.requiredSatoshis).toBe(1_601n);
    expect(plan.minerFeeBudgetSatoshis).toBe(1_500n);
    // 多余专用资金显式可见，可以被回收而不是自动变成矿工费。
    expect(plan.surplusSatoshis).toBe(98_399n);
  });

  it("完成签名后复核实际费用；超出预算拒绝", () => {
    const outputs = [{ value: 100n, lockingScript: new Uint8Array(35) }, { value: 1n, lockingScript: new Uint8Array(35) }];
    const ok = reconcileMinerFee({
      totalInputSatoshis: 1_601n,
      outputs,
      serializedSizeBytes: 200,
      feeRateSatoshisPerKb: 1,
      maxMinerFeeSatoshis: 1_500n,
    });
    expect(ok.actualMinerFeeSatoshis).toBe(1_500n);
    expect(ok.actualFeeRatePerKb).toBe(7_500);
    // 超出预算：拒绝而不是照发。
    expect(() =>
      reconcileMinerFee({
        totalInputSatoshis: 5_000n,
        outputs,
        serializedSizeBytes: 200,
        feeRateSatoshisPerKb: 1,
        maxMinerFeeSatoshis: 1_500n,
      }),
    ).toThrow(/超过确认的预算/);
    // 输出比输入还多：无法构造。
    expect(() =>
      reconcileMinerFee({
        totalInputSatoshis: 101n,
        outputs: [{ value: 1_000n, lockingScript: new Uint8Array(35) }],
        serializedSizeBytes: 200,
        feeRateSatoshisPerKb: 1,
        maxMinerFeeSatoshis: 1_500n,
      }),
    ).toThrow(/输入总额小于输出总额/);
  });
});

describe("费用确认项", () => {
  it("每一项都有可读来源，父价为零时不列出打赏项", () => {
    const withTip = buildFeeBreakdown({ kind: "reply", indexPrice: "100", parentTipPrice: "500", protocolMinerFee: "1500" });
    expect(withTip.map((item) => item.label)).toEqual(["index-price", "parent-author-tip", "protocol-miner-fee"]);
    expect(withTip.every((item) => item.detail.length > 0)).toBe(true);
    expect(totalFeeSatoshis(withTip)).toBe("2100");

    const withoutTip = buildFeeBreakdown({ kind: "reply", indexPrice: "100", parentTipPrice: "0", protocolMinerFee: "1500" });
    expect(withoutTip.map((item) => item.label)).toEqual(["index-price", "protocol-miner-fee"]);
    expect(totalFeeSatoshis(withoutTip)).toBe("1600");
  });

  it("正文获取/发布费用与资金准备矿工费只在有值时出现", () => {
    const items = buildFeeBreakdown({
      kind: "reply",
      indexPrice: "0",
      protocolMinerFee: "1200",
      contentAcquisition: "300",
      contentPublication: "200",
      fundingMinerFee: "900",
    });
    expect(items.map((item) => item.label)).toEqual([
      "content-acquisition",
      "content-publication",
      "funding-miner-fee",
      "index-price",
      "protocol-miner-fee",
    ]);
    expect(totalFeeSatoshis(items)).toBe("2600");
  });

  it("非规范金额让费用确认失败，不做隐式转换", () => {
    expect(() => totalFeeSatoshis([{ label: "index-price", amountSatoshis: "007", detail: "" }])).toThrow(/规范十进制/);
    expect(() =>
      totalFeeSatoshis([
        { label: "index-price", amountSatoshis: "18446744073709551616", detail: "" },
      ]),
    ).toThrow(ForumProtocolError);
  });
});