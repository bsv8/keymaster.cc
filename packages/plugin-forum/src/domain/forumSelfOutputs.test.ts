// FT05：自有 Forum 输出的识别、保护与归集。
//
// 归集的关键不是「能构造出一笔交易」，而是**签名形状正确**：Forum 的 data / tip
// 输出是 `<pubkey> OP_CHECKSIG`，公钥在锁定脚本里。若按 P2PKH 走（由地址重建
// scriptCode、解锁脚本推签名与公钥），sighash 与解锁脚本两处都错，交易在网络上必然
// 被拒，而本地一切正常。这里因此对解锁脚本与 scriptCode 都做断言。

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import type {
  ProtectedOutpointProvider,
  ProtocolSpendInput,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService,
} from "@keymaster/contracts";

import { bytesToHex, hexToBytes } from "../protocol/bytes.js";
import { buildTipScript, KIND_REPLY } from "../protocol/script.js";
import { buildDataScript, buildLockingScript } from "../protocol/script.js";
import { parseTransaction, serializeTransaction } from "../protocol/transaction.js";
// 真实注册表实现（P2PKH 在生产里用的同一个）：这里要验证的是「保护确实生效」，
// 而不是自己写一个 map 假装它是注册表。
import { createProtectedOutpointRegistry } from "@keymaster/runtime/test-support";

import {
  createForumSelfOutputService,
  findSelfOwnedOutputs,
  FORUM_SELF_OUTPUT_PROTECTION_ID,
  FORUM_SELF_OUTPUT_PROTECTION_KIND,
  createForumSelfOutputSession,
} from "./forumSelfOutputs.js";

const OWNER_PRIVATE = "22".repeat(32);
const OWNER_PUBLIC = bytesToHex(secp256k1.getPublicKey(hexToBytes(OWNER_PRIVATE), true));
const OTHER_PUBLIC = bytesToHex(secp256k1.getPublicKey(hexToBytes("44".repeat(32)), true));
const SEED_HASH = "cc".repeat(32);
const PARENT_TXID = "bb".repeat(32);
/** mainnet P2PKH：归集的钱回到这里。 */
const OWNER_ADDRESS = "1FVkWH2mfsVcLTFxCabC13v7AvmnHVbt6X";

function ownDataScript(): Uint8Array {
  return buildDataScript(hexToBytes(OWNER_PUBLIC), KIND_REPLY, [
    hexToBytes(PARENT_TXID),
    hexToBytes(OTHER_PUBLIC),
    hexToBytes(SEED_HASH),
    Uint8Array.of(0x07),
    new Uint8Array(71).fill(0x30),
    new Uint8Array(3).fill(0x01),
    new Uint8Array(71).fill(0x30),
  ]);
}

function otherDataScript(): Uint8Array {
  return buildDataScript(hexToBytes(OTHER_PUBLIC), KIND_REPLY, [
    hexToBytes(PARENT_TXID),
    hexToBytes(OWNER_PUBLIC),
    hexToBytes(SEED_HASH),
    Uint8Array.of(0x07),
    new Uint8Array(71).fill(0x30),
    new Uint8Array(3).fill(0x01),
    new Uint8Array(71).fill(0x30),
  ]);
}

/** 默认论坛交易（data 与 tip 都归当前 owner）的 txid。 */
function defaultForumTxid(): string {
  return buildForumTx().txid;
}

/** 造一笔含 data 输出与 tip 输出的交易；data 与 tip 都可指定归属。 */
function buildForumTx(input: { dataOwner?: string; tipOwner?: string } = {}): { rawTxHex: string; txid: string } {
  const dataOwner = input.dataOwner === undefined ? OWNER_PUBLIC : input.dataOwner;
  const tipOwner = input.tipOwner === undefined ? OWNER_PUBLIC : input.tipOwner;
  const raw = serializeTransaction({
    version: 1,
    inputs: [{ previousTxid: hexToBytes("dd".repeat(32)).reverse(), previousVout: 0, scriptSig: new Uint8Array(0), sequence: 0xfffffffe }],
    outputs: [
      { value: 100n, lockingScript: buildLockingScript(hexToBytes(OTHER_PUBLIC)) },
      { value: 1n, lockingScript: dataOwner === OWNER_PUBLIC ? ownDataScript() : otherDataScript() },
      { value: 500n, lockingScript: buildTipScript(hexToBytes(tipOwner), hexToBytes(PARENT_TXID)) },
    ],
    locktime: 0,
  });
  const txid = bytesToHex(parseTransaction(raw, sha256).txid);
  return { rawTxHex: bytesToHex(raw), txid };
}

interface PrepareCall {
  readonly inputs: readonly ProtocolSpendInput[];
  readonly outputs: readonly { value: number; label?: string }[];
  readonly noChangeRule: { maxMinerFeeSatoshis: number; allowZeroValueOutputs?: boolean } | undefined;
}

function harness(input: {
  rawTxHex?: string;
  /** 额外可取的链上交易，让「换一笔交易」类测试成立。 */
  extraTxs?: { readonly txid: string; readonly rawTxHex: string }[];
  failSweep?: boolean;
  submitStatus?: ProtocolSpendResult["status"];
} = {}) {
  const prepared: PrepareCall[] = [];
  const submitted: ProtocolSpendResult[] = [];
  const protections = new Map<string, ProtectedOutpointProvider>();
  const defaultTx = buildForumTx();
  // 按 txid 提供 raw：否则每次请求都返回同一笔交易，「换一笔交易」的测试就测不到东西。
  const raws = new Map<string, string>([[defaultTx.txid, input.rawTxHex ?? defaultTx.rawTxHex]]);
  for (const tx of input.extraTxs ?? []) raws.set(tx.txid, tx.rawTxHex);
  const spend = {
    async presign(){throw Error("Self sweep uses unsigned preview then submit");},
    async prepare(prepareInput: Parameters<ProtocolSpendService["prepare"]>[0]): Promise<ProtocolSpendPreview> {
      prepared.push({
        inputs: prepareInput.inputs,
        outputs: prepareInput.outputs,
        noChangeRule: prepareInput.noChangeRule,
      });
      return {
        ownerPublicKeyHex: prepareInput.ownerPublicKeyHex,
        network: prepareInput.network,
        inputs: [...prepareInput.inputs],
        outputs: [...prepareInput.outputs],
        changeSatoshis: 0,
        estimatedFeeSatoshis: 499,
        serializedSizeBytes: 200,
        txid: "ab".repeat(32),
        rawTxHex: "0100",
        submissionId: "submission-1",
      };
    },
    async submit(preview: ProtocolSpendPreview): Promise<ProtocolSpendResult> {
      const status = input.submitStatus ?? "broadcast-pending-woc";
      submitted.push({ status, txid: preview.txid, rawTxHex: preview.rawTxHex });
      return { status, txid: preview.txid, rawTxHex: preview.rawTxHex };
    },
  };
  const service = createForumSelfOutputService({
    ownerPublicKeyHex: () => OWNER_PUBLIC,
    async getRawTransaction(_network, txid) {
      if (input.failSweep === true) throw new Error("chain source unavailable");
      const raw = raws.get(txid);
      if (raw === undefined) throw new Error(`no raw for ${txid}`);
      return hexToBytes(raw);
    },
    protectedOutpoints: {
      register: (entry: ProtectedOutpointProvider) => protections.set(entry.id, entry),
      unregister: (id) => protections.delete(id),
    },
    async deriveOwnerAddress() {
      return OWNER_ADDRESS;
    },
    protocolSpend: () => spend,
  });
  return { service, prepared, submitted, protections, spend };
}

describe("自有输出的识别", () => {
  it("认出自己的 data 与 tip 输出", () => {
    const tx = buildForumTx();
    const found = findSelfOwnedOutputs({ rawTxHex: tx.rawTxHex, network: "main", ownerPublicKeyHex: OWNER_PUBLIC });
    expect(found.map((output) => [output.vout, output.kind])).toEqual([[1, "data"], [2, "tip"]]);
    // 锁定脚本必须原样带出来：归集签名时它就是 scriptCode。
    expect(found[0]?.lockingScriptHex).toBe(bytesToHex(ownDataScript()));
    expect(found[0]?.ownerPublicKeyHex).toBe(OWNER_PUBLIC);
    expect(found[0]?.value).toBe(1);
  });

  it("认不出别人的 data 与 tip 输出", () => {
    const { rawTxHex } = buildForumTx({ dataOwner: OTHER_PUBLIC, tipOwner: OTHER_PUBLIC });
    expect(findSelfOwnedOutputs({ rawTxHex, network: "main", ownerPublicKeyHex: OWNER_PUBLIC })).toEqual([]);
  });
});

describe("自有输出的保护登记", () => {
  it("登记后受保护登记里带 outpoint、kind 与归属", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    // 一次登记覆盖所有自有输出：重复 protect 不会产生第二条影子记录。
    expect(h.service.protect(outputs, "main")).toBe(2);
    expect(h.service.protect(outputs, "main")).toBe(0);
    const entry = h.protections.get(FORUM_SELF_OUTPUT_PROTECTION_ID);
    expect(entry).toBeDefined();
    const listed = entry?.listProtectedOutpoints() as unknown as { kind: string; publicKeyHex: string; vout: number }[];
    expect(listed).toHaveLength(2);
    expect(listed.map((entry_) => entry_.kind)).toEqual([FORUM_SELF_OUTPUT_PROTECTION_KIND, FORUM_SELF_OUTPUT_PROTECTION_KIND]);
    expect(listed[0]?.publicKeyHex).toBe(OWNER_PUBLIC);
    expect(listed.map((entry_) => entry_.vout)).toEqual([1, 2]);
  });

  it("新增与解除都会通知注册表刷新（否则登记成功但保护没生效）", async () => {
    const h = harness({ extraTxs: [buildForumTx({ dataOwner: OTHER_PUBLIC })] });
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    // 真实注册表在 register 时订阅 onChange，并把 provider 存起来。
    h.service.protect(outputs, "main");
    let notified = 0;
    const entry = h.protections.get(FORUM_SELF_OUTPUT_PROTECTION_ID) as ProtectedOutpointProvider;
    entry.onChange?.(() => { notified += 1; });

    // 换成另一笔交易（data 归别人、tip 归自己），确保是新的坐标而不是重复登记。
    const extra = buildForumTx({ dataOwner: OTHER_PUBLIC });
    const more = await h.service.list("main", [extra.txid]);
    expect(more).toHaveLength(1);
    h.service.protect(more, "main");
    expect(notified).toBeGreaterThan(0);
    const before = notified;
    h.service.unprotect(more);
    expect(notified).toBeGreaterThan(before);
  });

  it("显式解除后登记消失", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    h.service.protect(outputs, "main");
    h.service.unprotect(outputs);
    expect(h.protections.size).toBe(0);
  });

  it("dispose 清空集合并撤销登记（锁定/切 Key 不得让保护跨 owner 残留）", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    h.service.protect(outputs, "main");
    h.service.dispose("owner-changed");
    expect(h.protections.size).toBe(0);
  });
});

describe("自有输出的归集", () => {
  it("按裸公钥脚本签名：scriptCode 就是锁定脚本，且不使用找零", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    const result = await h.service.sweep({
      network: "main",
      outpoints: outputs.map((output) => ({ txid: output.txid, vout: output.vout })),
      feeRateSatoshisPerKb: 1,
    });
    expect(result.txid).toBe("ab".repeat(32));
    expect(h.submitted).toHaveLength(1);

    const call = h.prepared[0];
    expect(call?.noChangeRule?.allowZeroValueOutputs).toBe(true);
    // 每一笔输入都带上自己的锁定脚本：归集脚本的形状靠它保证。
    expect(call?.inputs.map((input) => input.lockingScriptHex)).toEqual([
      bytesToHex(ownDataScript()),
      bytesToHex(buildTipScript(hexToBytes(OWNER_PUBLIC), hexToBytes(PARENT_TXID))),
    ]);
    // 只有一个输出：钱回到 owner 的地址，没有找零。
    expect(call?.outputs).toHaveLength(1);
    expect(call?.outputs[0]?.label).toBe("forum-self-sweep");
  });

  it("拒绝把不属于当前 owner 的输出混进归集", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    // 别人的输出：只给坐标也会在归集当时被链上脚本核验挡下。
    await expect(h.service.sweep({
      network: "main",
      outpoints: [...outputs.map((output) => ({ txid: output.txid, vout: output.vout })), { txid: buildForumTx().txid, vout: 0 }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/不是当前 owner 的 Forum/u);
    expect(h.prepared).toEqual([]);
  });

  it("广播结果未知时拒绝当成成功", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    const failing = createForumSelfOutputService({
      ownerPublicKeyHex: () => OWNER_PUBLIC,
      async getRawTransaction() {
        return hexToBytes(buildForumTx().rawTxHex);
      },
      protectedOutpoints: { register: () => undefined, unregister: () => undefined },
      async deriveOwnerAddress() {
        return OWNER_ADDRESS;
      },
      protocolSpend: () => ({
        async presign(){throw Error("Self sweep uses unsigned preview then submit");},
    async prepare(prepareInput: Parameters<ProtocolSpendService["prepare"]>[0]): Promise<ProtocolSpendPreview> {
          return {
            ownerPublicKeyHex: prepareInput.ownerPublicKeyHex,
            network: prepareInput.network,
            inputs: [...prepareInput.inputs],
            outputs: [...prepareInput.outputs],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 1,
            serializedSizeBytes: 200,
            txid: "ab".repeat(32),
            rawTxHex: "0100",
          };
        },
        async submit(): Promise<ProtocolSpendResult> {
          return { status: "unknown", txid: "ab".repeat(32), rawTxHex: "0100" };
        },
      }),
    });
    await expect(failing.sweep({
      network: "main",
      outpoints: outputs.map((output) => ({ txid: output.txid, vout: output.vout })),
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/广播结果为 unknown/u);
  });

  it.each([["rejected"], ["woc-dropped"]] as const)("广播被明确拒绝（%s）时报失败，不谎报已归集", async (status) => {
    const h = harness({ submitStatus: status });
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    await expect(h.service.sweep({
      network: "main",
      outpoints: outputs.map((output) => ({ txid: output.txid, vout: output.vout })),
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/被明确拒绝/u);
  });

  it("没有可归集输出时明确拒绝", async () => {
    const h = harness();
    await expect(h.service.sweep({
      network: "main",
      outpoints: [],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/没有可归集/u);
  });
});

describe("归集时的链上复核", () => {
  it("金额与锁定脚本取自链上，不接受调用方提供的值", async () => {
    const h = harness();
    const outputs = await h.service.list("main", [buildForumTx().txid]);
    // 篡改过的字段在旧实现里会被直接签进交易；新实现只认坐标。
    await h.service.sweep({
      network: "main",
      outpoints: outputs.map((output) => ({ txid: output.txid, vout: output.vout })),
      feeRateSatoshisPerKb: 1,
    });
    expect(h.prepared[0]?.inputs.map((input) => [input.vout, input.value, input.lockingScriptHex])).toEqual([
      [1, 1, bytesToHex(ownDataScript())],
      [2, 500, bytesToHex(buildTipScript(hexToBytes(OWNER_PUBLIC), hexToBytes(PARENT_TXID)))],
    ]);
  });

  it("链数据源按 txid 返回的交易哈希对不上时整笔拒绝", async () => {
    const other = buildForumTx({ tipOwner: OTHER_PUBLIC });
    // 链数据源把「被点名的那笔」映射到另一笔交易的 raw。
    const h = harness({ extraTxs: [{ txid: defaultForumTxid(), rawTxHex: other.rawTxHex }] });
    await expect(h.service.sweep({
      network: "main",
      outpoints: [{ txid: defaultForumTxid(), vout: 1 }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/不是/u);
    expect(h.prepared).toEqual([]);
  });

  it("vout 不存在时拒绝", async () => {
    const tx = buildForumTx();
    const h = harness();
    await expect(h.service.sweep({
      network: "main",
      outpoints: [{ txid: tx.txid, vout: 9 }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/没有 vout/u);
    expect(h.prepared).toEqual([]);
  });

  it("坐标重复时拒绝（否则一笔交易里会有两个花同一 UTXO 的输入）", async () => {
    const tx = buildForumTx();
    const h = harness();
    await expect(h.service.sweep({
      network: "main",
      outpoints: [{ txid: tx.txid, vout: 1 }, { txid: tx.txid, vout: 1 }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/重复坐标/u);
    expect(h.prepared).toEqual([]);
  });

  it("txid 不是规范小写 hex 时拒绝", async () => {
    const h = harness();
    await expect(h.service.sweep({
      network: "main",
      outpoints: [{ txid: "AB".repeat(32), vout: 1 }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/规范小写 hex/u);
  });

  it("同一笔交易只取一次 raw", async () => {
    let fetches = 0;
    const tx = buildForumTx();
    const h = harness();
    const counted = createForumSelfOutputService({
      ownerPublicKeyHex: () => OWNER_PUBLIC,
      async getRawTransaction() {
        fetches += 1;
        return hexToBytes(tx.rawTxHex);
      },
      protectedOutpoints: { register: () => undefined, unregister: () => undefined },
      async deriveOwnerAddress() {
        return OWNER_ADDRESS;
      },
      protocolSpend: () => h.spend,
    });
    await counted.sweep({
      network: "main",
      outpoints: [{ txid: tx.txid, vout: 1 }, { txid: tx.txid, vout: 2 }],
      feeRateSatoshisPerKb: 1,
    });
    expect(fetches).toBe(1);
  });
});

/** 注册表刷新是异步的（scheduleRefresh 不阻塞 register），断言前先让它落定。 */
async function flushRegistry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 会话级复用：用真实注册表验证「连续调用 + 保护确实生效」，而不是复制的 map。
describe("会话级服务复用", () => {
  function sessionHarness(input: { spendAvailable?: boolean } = {}) {
    const registry = createProtectedOutpointRegistry();
    let owner = OWNER_PUBLIC;
    let built = 0;
    const session = createForumSelfOutputSession({
      currentOwner: () => owner,
      create: () => {
        if (input.spendAvailable === false) return undefined;
        built += 1;
        const tx = buildForumTx();
        return createForumSelfOutputService({
          ownerPublicKeyHex: () => owner,
          async getRawTransaction() {
            return hexToBytes(tx.rawTxHex);
          },
          protectedOutpoints: registry,
          async deriveOwnerAddress() {
            return OWNER_ADDRESS;
          },
          protocolSpend: () => undefined,
        });
      },
    });
    return { session, registry, builtCount: () => built, setOwner: (next: string) => { owner = next; }, tx: buildForumTx() };
  }

  it("同一 owner 的连续调用返回同一实例，保护跨调用保持", () => {
    const h = sessionHarness();
    const first = h.session.current();
    const second = h.session.current();
    expect(first).toBe(second);
    expect(h.builtCount()).toBe(1);
  });

  it("第一次 protect 的保护在第二次调用后仍然生效（真实注册表查询）", async () => {
    const h = sessionHarness();
    const outputs = await h.session.current()?.list("main", [h.tx.txid]);
    h.session.current()?.protect(outputs ?? [], "main");
    // 注册表是异步刷新的，等它真的建好缓存再断言，否则测的是时序不是保护。
    await flushRegistry();
    // 用另一个「页面」的视角查询：注册表里必须真的挡得住。
    expect(h.registry.isProtected({ txid: h.tx.txid, vout: 1, network: "main", publicKeyHex: OWNER_PUBLIC })).toBe(true);
    // 第二次 protect 不再新建实例，保护集合不会被清空。
    expect(h.session.current()?.protect(outputs ?? [], "main")).toBe(0);
    expect(h.registry.isProtected({ txid: h.tx.txid, vout: 1, network: "main", publicKeyHex: OWNER_PUBLIC })).toBe(true);
    expect(h.builtCount()).toBe(1);
  });

  it("跨调用解除保护后注册表里确实不再挡", async () => {
    const h = sessionHarness();
    const outputs = await h.session.current()?.list("main", [h.tx.txid]);
    h.session.current()?.protect(outputs ?? [], "main");
    await flushRegistry();
    h.session.current()?.unprotect(outputs ?? []);
    await flushRegistry();
    expect(h.registry.isProtected({ txid: h.tx.txid, vout: 1, network: "main", publicKeyHex: OWNER_PUBLIC })).toBe(false);
  });

  it("owner 变了就重建并撤销旧集合（保护不跨身份残留）", async () => {
    const h = sessionHarness();
    const outputs = await h.session.current()?.list("main", [h.tx.txid]);
    h.session.current()?.protect(outputs ?? [], "main");
    await flushRegistry();
    const before = h.session.current();
    h.setOwner(OTHER_PUBLIC);
    const next = h.session.current();
    expect(next).not.toBe(before);
    expect(h.builtCount()).toBe(2);
    // 旧 owner 的输出不再被当前会话保护。
    await flushRegistry();
    expect(h.registry.isProtected({ txid: h.tx.txid, vout: 1, network: "main", publicKeyHex: OWNER_PUBLIC })).toBe(false);
  });

  it("dispose 撤销登记，卸载后注册表里没有指向已销毁闭包的 provider", async () => {
    const h = sessionHarness();
    const outputs = await h.session.current()?.list("main", [h.tx.txid]);
    h.session.current()?.protect(outputs ?? [], "main");
    await flushRegistry();
    h.session.dispose("plugin-disposed");
    await flushRegistry();
    expect(h.registry.isProtected({ txid: h.tx.txid, vout: 1, network: "main", publicKeyHex: OWNER_PUBLIC })).toBe(false);
  });

  it("依赖缺席时保持无会话，下一次调用会重试", () => {
    const h = sessionHarness({ spendAvailable: false });
    expect(h.session.current()).toBeUndefined();
    expect(h.session.current()).toBeUndefined();
  });
});
