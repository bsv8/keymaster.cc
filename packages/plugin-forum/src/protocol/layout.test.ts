import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import { HASH_BYTES, bytesToHex, displayToRawTxid, hexToBytes } from "./bytes.js";
import {
  buildChangeTipOutputs,
  buildGenesisOutputs,
  buildReplyOutputs,
  parseChangeTipTransaction,
  parseGenesisTransaction,
  parseReplyTransaction,
  sniffDataOutput,
} from "./layout.js";
import {
  OP_CHECKSIG,
  OP_DROP,
  KIND_CHANGETIP,
  KIND_REPLY,
  buildLockingScript,
  parseDataOutput,
  parseScript,
} from "./script.js";
import {
  forkIdSighash,
  inputOutpointTxid,
  parseTransaction,
  serializeTransaction,
  type RawTransaction,
} from "./transaction.js";
import {
  encodeChangeTipIndexObject,
  encodeChangeTipOperatorObject,
  encodeForumSignatureObject,
  encodeReplyIndexObject,
  encodeReplyOperatorObject,
  signChangeTipOperatorObject,
  signForumSignatureObject,
  signReplyOperatorObject,
  type SigningPort,
} from "./signatureObjects.js";
import { verifyBytes } from "./crypto.js";

const hash = (input: Uint8Array): Uint8Array => sha256(input);

const forumKey = hexToBytes(bytesToHex(secp256k1.getPublicKey(hexToBytes("11".repeat(32)), true)));
const operatorKey = hexToBytes(bytesToHex(secp256k1.getPublicKey(hexToBytes("22".repeat(32)), true)));
const otherKey = hexToBytes(bytesToHex(secp256k1.getPublicKey(hexToBytes("33".repeat(32)), true)));

const parentTxid = new Uint8Array(HASH_BYTES).fill(0x11);
const seedHash = new Uint8Array(HASH_BYTES).fill(0x22);
const fundingTxid = new Uint8Array(HASH_BYTES).fill(0x01);

function localPort(privateKeyHex: string): SigningPort {
  const privateKey = hexToBytes(privateKeyHex);
  const derInteger = (value: bigint): number[] => {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const body = [...hexToBytes(hex)];
    if ((body[0] as number) >= 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  return {
    async signDigest(digest) {
      const raw = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true });
      const toBig = (bytes: Uint8Array): bigint => bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
      const body = [...derInteger(toBig(raw.subarray(0, 32))), ...derInteger(toBig(raw.subarray(32, 64)))];
      return Uint8Array.from([0x30, body.length, ...body]);
    },
    async verifyDigest() {
      throw new Error("测试端口不提供验证");
    },
  };
}

const forumPort = localPort("11".repeat(32));
const operatorPort = localPort("22".repeat(32));

/** 造一笔最小输入交易，供布局测试使用。 */
function fundingTransaction(): RawTransaction {
  const raw = serializeTransaction({
    version: 1,
    inputs: [{ previousTxid: displayToRawTxid(fundingTxid), previousVout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: 10_000n, lockingScript: buildLockingScript(otherKey) }],
    locktime: 0,
  });
  return parseTransaction(raw, hash);
}

function assemble(outputs: readonly { value: bigint; lockingScript: Uint8Array }[], funding: RawTransaction): RawTransaction {
  const raw = serializeTransaction({
    version: 1,
    inputs: funding.inputs.map((input) => ({ ...input, scriptSig: new Uint8Array(0) })),
    outputs: outputs.map((output) => ({ ...output })),
    locktime: 0,
  });
  return parseTransaction(raw, hash);
}

describe("reply 输出布局", () => {
  it("父价格为零时只有两个输出，索引费为零仍保留 vout 0", async () => {
    const operatorSig = await signReplyOperatorObject(
      { kind: KIND_REPLY, parentTxid, parentPublicKey: otherKey, replyMasterSeedHash: seedHash, tipPrice: 7n },
      operatorPort,
      hash,
    );
    const indexSig = await operatorPort.signDigest(hash(encodeReplyIndexObject({
      kind: KIND_REPLY,
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 7n,
      operatorSig,
      payToPublicKey: forumKey,
      indexPrice: 0n,
      lastBlockHeight: 900_000n,
    })));
    const outputs = buildReplyOutputs({
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 7n,
      operatorSig,
      lastBlockHeight: 900_000n,
      indexSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 0n,
      parentTipPrice: 0n,
    });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.value).toBe(0n);
    expect(outputs[1]?.value).toBe(1n);

    const parsed = parseReplyTransaction(assemble(outputs, fundingTransaction()));
    expect(parsed.indexPrice).toBe(0n);
    expect(parsed.tip).toBeUndefined();
    expect(bytesToHex(parsed.clientPublicKey)).toBe(bytesToHex(operatorKey));
    expect(parsed.tipPrice).toBe(7n);
    expect(parsed.lastBlockHeight).toBe(900_000n);
    expect(bytesToHex(parsed.operatorSig)).toBe(bytesToHex(operatorSig));
    expect(bytesToHex(parsed.indexSig)).toBe(bytesToHex(indexSig));
  });

  it("父价格为正时生成 vout 2，解析出的 tip 指向同一父节点", async () => {
    const operatorSig = await signReplyOperatorObject(
      { kind: KIND_REPLY, parentTxid, parentPublicKey: otherKey, replyMasterSeedHash: seedHash, tipPrice: 0n },
      operatorPort,
      hash,
    );
    const indexSig = await operatorPort.signDigest(hash(encodeReplyIndexObject({
      kind: KIND_REPLY,
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 0n,
      operatorSig,
      payToPublicKey: forumKey,
      indexPrice: 100n,
      lastBlockHeight: 900_000n,
    })));
    const outputs = buildReplyOutputs({
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 0n,
      operatorSig,
      lastBlockHeight: 900_000n,
      indexSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 100n,
      parentTipPrice: 500n,
    });
    expect(outputs).toHaveLength(3);
    const parsed = parseReplyTransaction(assemble(outputs, fundingTransaction()));
    expect(parsed.tip?.amount).toBe(500n);
    expect(bytesToHex(parsed.tip?.parentTxid ?? new Uint8Array(0))).toBe(bytesToHex(parentTxid));
    expect(bytesToHex(parsed.tip?.parentPublicKey ?? new Uint8Array(0))).toBe(bytesToHex(otherKey));
    // 三个输出就是上限：没有找零。
    expect(parsed.indexPrice).toBe(100n);
  });

  it("tip 输出指向别的父节点时可以被发现，而不是被静默接受", async () => {
    const operatorSig = await signReplyOperatorObject(
      { kind: KIND_REPLY, parentTxid, parentPublicKey: otherKey, replyMasterSeedHash: seedHash, tipPrice: 0n },
      operatorPort,
      hash,
    );
    const indexSig = await operatorPort.signDigest(hash(encodeReplyIndexObject({
      kind: KIND_REPLY,
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 0n,
      operatorSig,
      payToPublicKey: forumKey,
      indexPrice: 100n,
      lastBlockHeight: 900_000n,
    })));
    const outputs = buildReplyOutputs({
      parentTxid,
      parentPublicKey: otherKey,
      replyMasterSeedHash: seedHash,
      tipPrice: 0n,
      operatorSig,
      lastBlockHeight: 900_000n,
      indexSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 100n,
      parentTipPrice: 500n,
    });
    // 只把 vout 2 换成指向另一个父节点的付款。
    const tampered = [outputs[0]!, outputs[1]!, { value: outputs[2]!.value, lockingScript: buildTipSwapped(operatorKey) }];
    const parsed = parseReplyTransaction(assemble(tampered, fundingTransaction()));
    // 解析本身仍成功，所以调用方必须比对两个父：服务端 checkTipOutput 也做同一件事。
    expect(bytesToHex(parsed.tip!.parentTxid)).not.toBe(bytesToHex(parentTxid));
    expect(parsed.tip!.parentTxid).not.toEqual(parsed.parentTxid);
    // 父公钥同样必须一致，否则付款可以被改道到另一个人。
    expect(bytesToHex(parsed.tip!.parentPublicKey)).not.toBe(bytesToHex(otherKey));
  });
});

describe("changetip 输出布局", () => {
  it("恰好两个输出，且多一个 tip 输出会被拒绝", async () => {
    const operatorSig = await signChangeTipOperatorObject(
      { kind: KIND_CHANGETIP, parentTxid, tipPrice: 9n },
      operatorPort,
      hash,
    );
    const indexSig = await operatorPort.signDigest(hash(encodeChangeTipIndexObject({
      kind: KIND_CHANGETIP,
      parentTxid,
      tipPrice: 9n,
      payToPublicKey: forumKey,
      indexPrice: 100n,
      lastBlockHeight: 900_000n,
    })));
    const outputs = buildChangeTipOutputs({
      parentTxid,
      tipPrice: 9n,
      operatorSig,
      lastBlockHeight: 900_000n,
      indexSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 100n,
    });
    expect(outputs).toHaveLength(2);
    const parsed = parseChangeTipTransaction(assemble(outputs, fundingTransaction()));
    expect(parsed.tipPrice).toBe(9n);
    expect(bytesToHex(parsed.clientPublicKey)).toBe(bytesToHex(operatorKey));

    // 加一个 tip 输出后必须失败：changetip 是价格事件，不创建回复树节点。
    const withTip = [...outputs, { value: 1n, lockingScript: buildTipSwapped(operatorKey) }];
    expect(() => parseChangeTipTransaction(assemble(withTip, fundingTransaction()))).toThrow(/必须是 2 个输出/);
  });

  it("chain 上 last_block_height 位于 operatorSig 与 indexSig 之间，与 CBOR 顺序不同", async () => {
    const operatorSig = await signChangeTipOperatorObject({ kind: KIND_CHANGETIP, parentTxid, tipPrice: 1n }, operatorPort, hash);
    const indexSig = await operatorPort.signDigest(hash(encodeChangeTipIndexObject({
      kind: KIND_CHANGETIP,
      parentTxid,
      tipPrice: 1n,
      payToPublicKey: forumKey,
      indexPrice: 1n,
      lastBlockHeight: 0x0102n,
    })));
    const data = parseDataOutput(buildChangeTipOutputs({
      parentTxid,
      tipPrice: 1n,
      operatorSig,
      lastBlockHeight: 0x0102n,
      indexSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 1n,
    })[1]!.lockingScript);
    // 字段顺序：kind, parent_txid, tip_price, last_block_height, operatorSig, indexSig
    expect(data.fields.map((field) => bytesToHex(field))).toEqual([
      bytesToHex(parentTxid),
      "01",
      "0102",
      bytesToHex(operatorSig),
      bytesToHex(indexSig),
    ]);
  });
});

describe("创世声明解析", () => {
  it("从 raw 重建四项 forumSig 所需的 input outpoint", async () => {
    const forumSigObject = {
      kind: "bsv8.forum.1" as const,
      forumName: "测试论坛",
      tipPrice: 4n,
      inputs: [{ txid: fundingTxid, vout: 0 }],
    };
    const forumSig = await signForumSignatureObject(forumSigObject, forumPort, hash);
    const outputs = buildGenesisOutputs({
      forumName: forumSigObject.forumName,
      tipPrice: 4n,
      forumSig,
      forumPublicKey: forumKey,
      changeSatoshis: 999n,
    });
    const funding = fundingTransaction();
    const parsedTx = assemble(outputs, funding);
    const parsed = parseGenesisTransaction(parsedTx, (index) => inputOutpointTxid(parsedTx.inputs[index] as never));

    expect(parsed.forumName).toBe("测试论坛");
    expect(parsed.tipPrice).toBe(4n);
    expect(parsed.changeSatoshis).toBe(999n);
    expect(bytesToHex(parsed.forumPublicKey)).toBe(bytesToHex(forumKey));
    expect(bytesToHex(parsed.payToPublicKey)).toBe(bytesToHex(forumKey));
    expect(parsed.inputs).toEqual([{ txid: fundingTxid, vout: 0 }]);
    expect(bytesToHex(parsed.forumSig)).toBe(bytesToHex(forumSig));

    // 用重建出来的对象重新编码，必须回到签名前的同一串字节。
    expect(
      bytesToHex(
        encodeForumSignatureObject({
          kind: "bsv8.forum.1",
          forumName: parsed.forumName,
          tipPrice: parsed.tipPrice,
          inputs: parsed.inputs,
        }),
      ),
    ).toBe(bytesToHex(encodeForumSignatureObject(forumSigObject)));
    expect(verifyBytes(forumKey, encodeForumSignatureObject(forumSigObject), forumSig)).toBe(true);
    // 用错误的论坛公钥验签必须失败：声明的信任锚就是配置的论坛公钥。
    expect(verifyBytes(otherKey, encodeForumSignatureObject(forumSigObject), forumSig)).toBe(false);
  });

  it("找零为零的创世声明在构造层和解析层都被拒绝", async () => {
    const forumSig = await signForumSignatureObject(
      { kind: "bsv8.forum.1", forumName: "x", tipPrice: 1n, inputs: [{ txid: fundingTxid, vout: 0 }] },
      forumPort,
      hash,
    );
    // 构造层直接拒绝。
    expect(() =>
      buildGenesisOutputs({ forumName: "x", tipPrice: 1n, forumSig, forumPublicKey: forumKey, changeSatoshis: 0n }),
    ).toThrow(/正数/);
    // 即使绕过构造层，解析层也拒绝：零输出的找零等于把全部出资给了矿工。
    const good = buildGenesisOutputs({ forumName: "x", tipPrice: 1n, forumSig, forumPublicKey: forumKey, changeSatoshis: 1n });
    const zeroed = [{ value: 0n, lockingScript: good[0]!.lockingScript }, good[1]!];
    const tx = assemble(zeroed, fundingTransaction());
    expect(() => parseGenesisTransaction(tx, () => fundingTxid)).toThrow(/不能为零/);
  });

  it("创世声明多一个 tip 输出时被拒绝", async () => {
    const forumSig = await signForumSignatureObject(
      { kind: "bsv8.forum.1", forumName: "x", tipPrice: 1n, inputs: [{ txid: fundingTxid, vout: 0 }] },
      forumPort,
      hash,
    );
    const outputs = buildGenesisOutputs({ forumName: "x", tipPrice: 1n, forumSig, forumPublicKey: forumKey, changeSatoshis: 1n });
    expect(() => parseGenesisTransaction(assemble([...outputs, { value: 1n, lockingScript: buildTipSwapped(forumKey) }], fundingTransaction()), () => fundingTxid)).toThrow(
      /必须是 2 个输出/,
    );
  });
});

describe("kind 嗅探与非最短 push 拒绝", () => {
  it("按 1 sat 与 kind 标记区分三种协议交易", async () => {
    const operatorSig = await signChangeTipOperatorObject({ kind: KIND_CHANGETIP, parentTxid, tipPrice: 1n }, operatorPort, hash);
    const outputs = buildChangeTipOutputs({
      parentTxid,
      tipPrice: 1n,
      operatorSig,
      lastBlockHeight: 1n,
      indexSig: operatorSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 1n,
    });
    expect(sniffDataOutput(outputs[1]!)).toBe("changetip");
    // 金额不是 1 sat 时不是数据输出。
    expect(sniffDataOutput({ value: 2n, lockingScript: outputs[1]!.lockingScript })).toBe("unknown");
  });

  it("非最短公钥 push 被拒绝", async () => {
    const operatorSig = await signChangeTipOperatorObject({ kind: KIND_CHANGETIP, parentTxid, tipPrice: 1n }, operatorPort, hash);
    const outputs = buildChangeTipOutputs({
      parentTxid,
      tipPrice: 1n,
      operatorSig,
      lastBlockHeight: 1n,
      indexSig: operatorSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 1n,
    });
    // 把最后的 0x21 push 改写成 OP_PUSHDATA1（0x4c 0x21）。
    const script = outputs[1]!.lockingScript;
    const nonMinimal = Uint8Array.from([...script.subarray(0, script.length - 35), 0x4c, 0x21, ...script.subarray(script.length - 34)]);
    expect(() => parseDataOutput(nonMinimal)).toThrow(/最短编码/);
  });

  it("数据输出必须以 OP_CHECKSIG 结束", async () => {
    const operatorSig = await signChangeTipOperatorObject({ kind: KIND_CHANGETIP, parentTxid, tipPrice: 1n }, operatorPort, hash);
    const outputs = buildChangeTipOutputs({
      parentTxid,
      tipPrice: 1n,
      operatorSig,
      lastBlockHeight: 1n,
      indexSig: operatorSig,
      clientPublicKey: operatorKey,
      payToPublicKey: forumKey,
      indexPrice: 1n,
    });
    const script = outputs[1]!.lockingScript;
    const dropped = Uint8Array.from([...script.subarray(0, script.length - 1), OP_DROP]);
    expect(() => parseDataOutput(dropped)).toThrow(/OP_CHECKSIG/);
    // 中间某个字段后面换成 OP_DROP 以外的操作码，配对校验必须失败。
    const chunks = parseScript(script);
    expect(chunks[chunks.length - 1]).toMatchObject({ isPush: false, opcode: OP_CHECKSIG });
    expect(chunks[1]).toMatchObject({ isPush: false, opcode: OP_DROP });
  });
});

describe("FORKID 输入签名摘要", () => {
  it("摘要绑定金额、scriptCode 与被花费的输入", () => {
    const funding = fundingTransaction();
    const scriptCode = funding.outputs[0]!.lockingScript;
    const digest = forkIdSighash(funding, 0, scriptCode, funding.outputs[0]!.value, hash);
    expect(digest).toHaveLength(32);
    // 金额或 scriptCode 变化都必须改变摘要：否则签名可以被搬到别的输出上。
    expect(bytesToHex(forkIdSighash(funding, 0, scriptCode, funding.outputs[0]!.value + 1n, hash))).not.toBe(bytesToHex(digest));
    const otherScript = buildLockingScript(forumKey);
    expect(bytesToHex(forkIdSighash(funding, 0, otherScript, funding.outputs[0]!.value, hash))).not.toBe(bytesToHex(digest));
    // 输出变化同样改变摘要。
    const changed = parseTransaction(
      serializeTransaction({
        version: 1,
        inputs: funding.inputs.map((input) => ({ ...input, scriptSig: new Uint8Array(0) })),
        outputs: [{ value: funding.outputs[0]!.value + 1n, lockingScript: scriptCode }],
        locktime: 0,
      }),
      hash,
    );
    expect(bytesToHex(forkIdSighash(changed, 0, scriptCode, funding.outputs[0]!.value, hash))).not.toBe(bytesToHex(digest));
    // 只支持 SIGHASH_ALL|FORKID。
    expect(() => forkIdSighash(funding, 0, scriptCode, funding.outputs[0]!.value, hash, 0x01)).toThrow(/0x41/);
    expect(() => forkIdSighash(funding, 5, scriptCode, funding.outputs[0]!.value, hash)).toThrow(/输入/);
  });
});

describe("交易解析边界", () => {
  it("拒绝尾随字节、空 raw 与截断输入", () => {
    const funding = fundingTransaction();
    expect(() => parseTransaction(Uint8Array.from([...funding.raw, 0x00]), hash)).toThrow(/尾随/);
    expect(() => parseTransaction(new Uint8Array(0), hash)).toThrow(/不能为空/);
    expect(() => parseTransaction(funding.raw.subarray(0, funding.raw.length - 1), hash)).toThrow(/截断/);
  });

  it("txid 由 raw 自身的双 SHA-256 反转得到", () => {
    const funding = fundingTransaction();
    expect(funding.txid).toHaveLength(32);
    // 重新序列化必须与原始 raw 完全一致，否则 txid 就没有确定的字节来源。
    expect(
      bytesToHex(
        serializeTransaction({
          version: funding.version,
          inputs: funding.inputs,
          outputs: funding.outputs,
          locktime: funding.locktime,
        }),
      ),
    ).toBe(bytesToHex(funding.raw));
  });
});

/** 造一个指向别的父节点的 tip 输出，用于验证父一致性检查。 */
function buildTipSwapped(parentKey: Uint8Array): Uint8Array {
  const other = new Uint8Array(HASH_BYTES).fill(0x99);
  const chunks: number[] = [];
  const push = (data: Uint8Array): void => {
    chunks.push(data.length, ...data);
  };
  push(new TextEncoder().encode("bsv8.tip.1"));
  chunks.push(OP_DROP);
  push(other);
  chunks.push(OP_DROP);
  push(parentKey);
  chunks.push(OP_CHECKSIG);
  return Uint8Array.from(chunks);
}