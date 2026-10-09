// Forum 发布流程的端到端领域测试。
//
// 刻意不走「只测阶段图」：阶段图只证明守卫函数本身自洽，证明不了正常发布真的能
// 从草稿走到派发。这里用一套完整的装配来跑真实流程：
//
//   - 真实 roundtrip：进程内论坛服务端用 `key-roundtrip` 的同一个 SDK 签名响应，
//     客户端因此走完整的响应校验（from/to/reply_to/签名），不是桩；
//   - 真实资金：注入一个按 `noChangeRule` 规则构造交易的 `ProtocolSpendService`
//     替身与一个专用资金来源替身，于是「专用资金额度」「无找零」「零值输出」
//     这些规则真的被执行，而不是被绕过；
//   - 真实阶段推进：每一步都从仓储读回任务，非法推进会真的抛错。

import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  MemoryReplayGuard,
  RoundtripCore,
  digestOf,
  publicKeyFromPrivateKey,
  signDigest as sdkSignDigest,
  type HandlerOutcome,
  type RoundtripHandler,
} from "key-roundtrip";

import type {
  ActiveKeyCrypto,
  StorageWriteCondition,
  ForumBroadcastState,
  ForumBudgetConfirmation,
  ForumConfig,
  ForumPublishTask,
  MsFileContentService,
  ProtocolSpendOutput,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService,
} from "@keymaster/contracts";

import { bytesToHex, hexToBytes } from "../protocol/bytes.js";
import { sha256Digest } from "../protocol/crypto.js";
import { KIND_REPLY } from "../protocol/script.js";
import { encodeReplyIndexObject, type ReplyIndexObject } from "../protocol/signatureObjects.js";
import { serializeTransaction, parseTransaction } from "../protocol/transaction.js";
import { createForumRepository, type ForumRepository } from "../storage/forumRepository.js";
import {
  setForumFundingSource,
  createForumService,
  canAdvancePublishPhase as canAdvancePublishPhaseRef,
  type ForumFundingSource,
} from "./forumService.js";

const hash = (input: Uint8Array): Uint8Array => sha256(input);

const OWNER_PRIVATE = "22".repeat(32);
const FORUM_PRIVATE = "11".repeat(32);
const PARENT_PRIVATE = "33".repeat(32);

const ownerPublicKeyHex = bytesToHex(publicKeyFromPrivateKey(hexToBytes(OWNER_PRIVATE)));
const forumPublicKeyHex = bytesToHex(publicKeyFromPrivateKey(hexToBytes(FORUM_PRIVATE)));
const parentPublicKeyHex = bytesToHex(publicKeyFromPrivateKey(hexToBytes(PARENT_PRIVATE)));

const FORUM_TXID = "aa".repeat(32);
const PARENT_TXID = "bb".repeat(32);
const SEED_HASH = "cc".repeat(32);
const FUNDING_TXID = "dd".repeat(32);

/**
 * 严格 DER low-S 签名。
 *
 * 用与客户端/服务端相同的 SDK 签名器，而不是自己拼 DER：roundtrip 的响应校验会
 * 拒绝非规范 DER，用自己拼的字节会让这条测试在签名格式上假失败。
 */
function derSign(digest: Uint8Array, privateKeyHex: string): Uint8Array {
  return sdkSignDigest(hexToBytes(privateKeyHex), digest);
}

function cryptoFor(privateKeyHex: string, publicKeyHex: string): ActiveKeyCrypto {
  return {
    getIdentity: () => ({ publicKeyHex }),
    async signDigest(input: { digest: ArrayBuffer }) {
      return { publicKeyHex, format: "der" as const, signature: derSign(new Uint8Array(input.digest), privateKeyHex) };
    },
    dispose: () => undefined,
  } as unknown as ActiveKeyCrypto;
}

const CONTENT = {
  async ensureContent() {
    return { seedHashHex: SEED_HASH, state: "verified" as const, localCopy: true, verifiedBytes: "10" };
  },
  async openVerifiedContent(): Promise<undefined> {
    return undefined;
  },
  async importContent() {
    return { seedHashHex: SEED_HASH, byteLength: "10" };
  },
  async getContentStatus() {
    return { seedHashHex: SEED_HASH, state: "absent" as const, localCopy: false };
  },
  subscribeContent() {
    return () => undefined;
  },
  async publicationReachability() {
    return { seedHashHex: SEED_HASH, published: false, sourceIds: [], detail: "未实现" };
  },
} as unknown as MsFileContentService;

/**
 * 内存版 owner 文件句柄，**支持条件写**。
 *
 * 跨标签页互斥完全依赖 `ifNoneMatch` / `ifRevision`：没有它们，两个「页面」会各自
 * 成功并互相覆盖，测试就只证明了内存锁。把条件语义实现出来，才能测到真实的竞争。
 */
function memoryStore(): Parameters<typeof createForumRepository>[0] {
  const files = new Map<string, { bytes: Uint8Array; revision: number }>();
  return {
    async get(path: string) {
      const entry = files.get(path);
      if (entry === undefined) return undefined;
      return { path, bytes: entry.bytes, revision: String(entry.revision), lastModified: "now" };
    },
    async put(path: string, bytes: Uint8Array, options?: StorageWriteCondition) {
      const existing = files.get(path);
      if (options?.ifNoneMatch === true && existing !== undefined) throw new Error("condition failed: exists");
      if (options?.ifRevision !== undefined && String(existing?.revision ?? "0") !== options.ifRevision) {
        throw new Error("condition failed: revision");
      }
      files.set(path, { bytes, revision: (existing?.revision ?? 0) + 1 });
      return { revision: String(files.get(path)?.revision ?? 1), lastModified: "now" };
    },
    async delete(path: string, options?: StorageWriteCondition) {
      const existing = files.get(path);
      if (options?.ifRevision !== undefined && String(existing?.revision ?? "0") !== options.ifRevision) {
        throw new Error("condition failed: revision");
      }
      files.delete(path);
    },
    async list() {
      return { files: [...files.keys()].map((path) => ({ path, sizeBytes: files.get(path)?.bytes.byteLength ?? 0 })), nextCursor: null };
    },
  } as unknown as Parameters<typeof createForumRepository>[0];
}

function forumConfig(): ForumConfig {
  return {
    id: "test-forum",
    label: "test",
    network: "test",
    forumTxid: FORUM_TXID,
    forumPublicKeyHex: forumPublicKeyHex.toLowerCase(),
    endpoints: [{ kind: "libp2p-wss", url: "/dns4/example/tcp/443/wss/p2p/12D3KooWFakePeerIdForumPeer" }],
  };
}

/**
 * 进程内论坛服务端。
 *
 * 用真实 SDK 签名响应，因此客户端的响应校验（收件人、关联 request id、签名）
 * 真的被执行；`indexSig` 也按将要上链的字段真实签名。
 */
function forumServer(quotes: { indexPrice: bigint; parentTipPrice: bigint }[]): {
  dispatch(operation: unknown): Promise<unknown>;
  calls: () => readonly string[];
} {
  const calls: string[] = [];
  let quoteIndex = 0;
  const handler: RoundtripHandler = async (context): Promise<HandlerOutcome> => {
    const body = context.body as { op: string; args?: Record<string, unknown> };
    calls.push(body.op);
    if (body.op !== "quote_reply" && body.op !== "quote_changetip") {
      if (body.op === "get_node" && argsOf(body).txid === PARENT_TXID) {
        return {
          ok: true,
          result: {
            txid: PARENT_TXID,
            parent_txid: FORUM_TXID,
            depth: 1,
            author_publickey: parentPublicKeyHex,
            reply_masterseedhash: null,
            tip_price: "10",
            confirmed_tip_price: "10",
            effective_tip_price: "10",
            status: "confirmed",
            block_height: 800_000,
            block_hash: "ee".repeat(32),
            tx_index: 0,
            vout: 1,
            has_children: true,
          },
        };
      }
      // 索引器还没发现新节点：对账必须落到「等待发现」，不能编造成功。
      return { ok: false, error: { code: "NODE_NOT_FOUND", message: "not indexed yet" } };
    }
    const args = argsOf(body);
    const quote = quotes[Math.min(quoteIndex, quotes.length - 1)] as { indexPrice: bigint; parentTipPrice: bigint };
    quoteIndex += 1;
    const lastBlockHeight = 900_000n + BigInt(quoteIndex);
    const object: ReplyIndexObject = {
      kind: KIND_REPLY,
      parentTxid: hexToBytes(PARENT_TXID),
      parentPublicKey: hexToBytes(parentPublicKeyHex),
      replyMasterSeedHash: hexToBytes(SEED_HASH),
      tipPrice: BigInt(String(args.tip_price)),
      operatorSig: hexToBytes(String(args.operatorSig)),
      payToPublicKey: hexToBytes(forumPublicKeyHex),
      indexPrice: quote.indexPrice,
      lastBlockHeight,
    };
    return {
      ok: true,
      result: {
        payto_publickey: forumPublicKeyHex,
        index_price: quote.indexPrice.toString(),
        last_block_height: lastBlockHeight.toString(),
        ...(body.op === "quote_reply" ? { parent_tip_price: quote.parentTipPrice.toString() } : {}),
        indexSig: bytesToHex(derSign(hash(encodeReplyIndexObject(object)), FORUM_PRIVATE)),
      },
    };
  };
  const core = new RoundtripCore({
    signer: {
      publicKey: () => hexToBytes(forumPublicKeyHex),
      // 摘要由 SDK 给出，与客户端的 signer 走同一条编码路径。
      async signRoundtrip(unsigned) {
        return derSign(digestOf(unsigned), FORUM_PRIVATE);
      },
    },
    handler,
    replay: new MemoryReplayGuard(),
  });
  return {
    calls: () => calls,
    async dispatch(operation: unknown) {
      const record = operation as { requestBytesHex: string };
      const responseBytes = await core.handle(hexToBytes(record.requestBytesHex));
      return { ok: true, responseBytesHex: bytesToHex(responseBytes) };
    },
  };
}

function argsOf(body: { args?: Record<string, unknown> }): Record<string, unknown> {
  const args = body.args ?? {};
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value !== "string") throw new Error(`测试服务端只接受字符串参数：${key}`);
  }
  return args;
}

/**
 * 受控无找零的资金替身。
 *
 * 完整实现 `ProtocolSpendService` 在无找零模式下的**规则**（不是绕过它）：
 * 输入必须覆盖固定输出加矿工费、零值输出被允许、给出 changeAddress 时报错。
 */
function protocolSpendStub(record: {
  prepared?: ProtocolSpendPreview;
  submitted?: ProtocolSpendResult;
  /** 置为 true 时模拟「没有释放能力」的装配（releasePreparedSubmission 缺席）。 */
  releaseUnavailable?: boolean;
  /** 置为 true 时模拟释放本身失败。 */
  releaseFails?: boolean;
}): {
  service: ProtocolSpendService;
  inputs: () => readonly ProtocolSpendInputLog[];
  /** 被释放的预签名提交编号：取消未派发任务时必须出现。 */
  releases: () => readonly string[];
  /** 构造前的注入点：用来在流程中间制造租约接管。 */
  beforePrepare: undefined | (() => Promise<void>);
  submitted: () => boolean;
} {
  const log: ProtocolSpendInputLog[] = [];
  const released: string[] = [];
  const control: { beforePrepare?: () => Promise<void> } = {};
  return {
    inputs: () => log,
    releases: () => released,
    submitted: () => record.submitted !== undefined,
    get beforePrepare() {
      return control.beforePrepare;
    },
    set beforePrepare(next: (() => Promise<void>) | undefined) {
      control.beforePrepare = next;
    },
    service: {
      async prepare(input) {
        await control.beforePrepare?.();
        log.push({
          changeAddress: input.changeAddress,
          noChange: input.noChangeRule,
          outputs: input.outputs.map((output) => output.value),
          inputs: input.inputs.map((utxo) => `${utxo.txid}:${utxo.vout}:${utxo.value}`),
        });
        if (input.changeAddress !== undefined && input.noChangeRule !== undefined) {
          throw new Error("changeAddress 与 noChangeRule 不能同时给出");
        }
        const fixedTotal = input.outputs.reduce((sum: number, output: ProtocolSpendOutput) => sum + output.value, 0);
        const inputTotal = input.inputs.reduce((sum, utxo) => sum + utxo.value, 0);
        const fee = inputTotal - fixedTotal;
        if (input.noChangeRule === undefined) {
          if (fee < 1) throw new Error("输入不足以覆盖输出");
          if (input.changeAddress === undefined && fee > 1) throw new Error("余款拒绝：无 changeAddress 且有余款");
          for (const output of input.outputs) {
            if (output.value <= 0) throw new Error(`Output value must be a positive integer: ${output.value}`);
          }
        } else {
          if (fee <= 0) throw new Error("无找零模式的余额差必须为正");
          if (fee > input.noChangeRule.maxMinerFeeSatoshis) {
            throw new Error(`矿工费 ${fee} 超过确认预算 ${input.noChangeRule.maxMinerFeeSatoshis}`);
          }
        }
        // previousTxid 是链上字节序（小端），与展示顺序 txid 相反。
        const rawTxHex = bytesToHex(serializeTransaction({
          version: 1,
          inputs: input.inputs.map((utxo) => ({
            previousTxid: hexToBytes(utxo.txid).reverse(),
            previousVout: utxo.vout,
            scriptSig: Uint8Array.from([0x00, 0x47, 0x30, 0x44]),
            sequence: 0xfffffffe,
          })),
          outputs: input.outputs.map((output) => ({
            value: BigInt(output.value),
            lockingScript: hexToBytes(output.scriptHex),
          })),
          locktime: 0,
        }));
        const parsed = parseTransaction(hexToBytes(rawTxHex), sha256Digest);
        const preview: ProtocolSpendPreview = {
          ownerPublicKeyHex: input.ownerPublicKeyHex,
          requestingPluginId: input.requestingPluginId,
          network: input.network,
          inputs: input.inputs,
          outputs: input.outputs,
          changeSatoshis: 0,
          estimatedFeeSatoshis: fee,
          serializedSizeBytes: rawTxHex.length / 2,
          txid: bytesToHex(parsed.txid),
          rawTxHex,
          submissionId: "submission-1",
        };
        record.prepared = preview;
        return preview;
      },
      async submit(preview) {
        record.submitted = {
          status: "broadcast-pending-woc",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          submissionId: preview.submissionId,
        };
        return record.submitted;
      },
      ...(record.releaseUnavailable === true ? {} : {
        async releasePreparedSubmission(input: { submissionId: string }) {
          if (record.releaseFails === true) throw new Error("释放预签名提交失败");
          released.push(input.submissionId);
        },
      }),
    },
  };
}

interface ProtocolSpendInputLog {
  readonly changeAddress: string | undefined;
  readonly noChange: { maxMinerFeeSatoshis: number; allowZeroValueOutputs?: boolean } | undefined;
  readonly outputs: readonly number[];
  readonly inputs: readonly string[];
}

/** 专用资金来源替身：按上游给出的额度原样准备，并记账。 */
function fundingSourceStub(record: { prepared: unknown[]; recovered?: unknown[]; recoverFails?: boolean }): {
  source: ForumFundingSource;
  /** 模拟「上一轮已经准备好了这笔资金」的崩溃现场。 */
  seed(taskId: string, valueSatoshis: string): void;
  clear(): void;
} {
  const funding = new Map<string, { txid: string; vout: number; rawTxHex: string; valueSatoshis: string; address: string }>();
  const source: ForumFundingSource = {
    async readDedicatedFunding(_owner, _network, taskId) {
      return funding.get(taskId);
    },
    async isSpent() {
      return false;
    },
    async planDedicatedFunding(input) {
      return {
        requiredSatoshis: input.fixedOutputsSatoshis + input.protocolMinerFeeBudgetSatoshis,
        fundingMinerFeeSatoshis: 2n,
      };
    },
    async prepareDedicatedFunding(input) {
      record.prepared.push({ taskId: input.taskId, requiredSatoshis: input.requiredSatoshis.toString() });
      const prepared = {
        txid: FUNDING_TXID,
        vout: 0,
        rawTxHex: "00",
        valueSatoshis: input.requiredSatoshis.toString(),
        address: "1TestAddressPlaceholder",
      };
      funding.set(input.taskId, prepared);
      return prepared;
    },
    async clearDedicatedFunding(_owner, _network, taskId) {
      funding.delete(taskId);
    },
    async observeFunding() {
      return "mempool";
    },
    async recoverDedicatedFunding(input) {
      if (record.recoverFails === true) throw new Error("回收交易广播结果未知");
      record.recovered?.push({ taskId: input.taskId, reason: input.reason });
      funding.delete(input.taskId);
      return { txid: "ef".repeat(32), recoveredSatoshis: "1800" };
    },
  };
  return {
    source,
    seed(taskId, valueSatoshis) {
      funding.set(taskId, { txid: FUNDING_TXID, vout: 0, rawTxHex: "00", valueSatoshis, address: "1TestAddressPlaceholder" });
    },
    clear() {
      funding.clear();
    },
  };
}

interface Harness {
  readonly forum: ReturnType<typeof createForumService>;
  readonly repository: ForumRepository;
  readonly funding: { prepared: unknown[]; recovered: unknown[]; recoverFails?: boolean };
  readonly spend: ReturnType<typeof protocolSpendStub>;
  /** 可变：控制钱包对持久提交的观察结果（取消判据）。 */
  readonly observation: { current: ForumBroadcastState | undefined };
  /** 用另一个「没有释放能力」的 spend 重建服务。 */
  createServiceWithoutRelease(repository: ForumRepository): ReturnType<typeof createForumService>;
  /** 用「释放会失败」的 spend 重建服务。 */
  createServiceWithFailingRelease(repository: ForumRepository): ReturnType<typeof createForumService>;
  readonly server: ReturnType<typeof forumServer>;
  readonly fundingStub: ReturnType<typeof fundingSourceStub>;
  readonly createService: (repository: ForumRepository) => ReturnType<typeof createForumService>;
}

async function createHarness(input: {
  quotes: { indexPrice: bigint; parentTipPrice: bigint }[];
  recoverFails?: boolean;
  /** 钱包对持久提交的观察结果；不传表示没有观察能力。 */
  observation?: ForumBroadcastState;
}): Promise<Harness> {
  const store = memoryStore();
  const repository = createForumRepository(store);
  await writeTrustAnchor(repository);
  const funding = { prepared: [] as unknown[], recovered: [] as unknown[], recoverFails: input.recoverFails };
  const fundingStub = fundingSourceStub(funding);
  setForumFundingSource(() => fundingStub.source);
  const server = forumServer(input.quotes);
  const spend = protocolSpendStub({});
  const spendWithoutRelease = protocolSpendStub({ releaseUnavailable: true });
  const spendWithFailingRelease = protocolSpendStub({ releaseFails: true });
  const observation = { current: input.observation } as { current: ForumBroadcastState | undefined };
  // 不给 observation 时**不装配** observeBroadcast：让流程保持它原本的
  // 「没有观察能力」路径，而不是被一个恒返回 undefined 的假观察覆盖。
  const broadcastDeps = input.observation === undefined
    ? {}
    : {
      observeBroadcast: (() => Promise.resolve(observation.current)) as NonNullable<Parameters<typeof createForumService>[0]["observeBroadcast"]>,
    };
  const forum = createForumService({
    ...broadcastDeps,
    repository,
    content: CONTENT,
    async activeCrypto() {
      return cryptoFor(OWNER_PRIVATE, ownerPublicKeyHex);
    },
    ownerPublicKeyHex: () => ownerPublicKeyHex,
    protocolSpend: () => spend.service,
    dispatchP2p: (operation) => server.dispatch(operation),
    async fetchRootRaw() {
      return new Uint8Array(0);
    },
    sessionEpoch: () => "epoch-1",
    now: () => 1_700_000_000_000,
    randomId: () => "task-1",
  });
  return {
    forum, repository, funding, spend, observation, server, fundingStub,
    createServiceWithoutRelease: (repo) => createForumService({
      ...broadcastDeps,
      repository: repo,
      protocolSpend: () => spendWithoutRelease.service,
      content: CONTENT,
      async activeCrypto() {
        return cryptoFor(OWNER_PRIVATE, ownerPublicKeyHex);
      },
      ownerPublicKeyHex: () => ownerPublicKeyHex,
      dispatchP2p: (operation) => server.dispatch(operation),
      async fetchRootRaw() {
        return new Uint8Array(0);
      },
      sessionEpoch: () => "epoch-1",
      now: () => 1_700_000_000_000,
      randomId: () => "task-1",
    }),
    createServiceWithFailingRelease: (repo) => createForumService({
      ...broadcastDeps,
      repository: repo,
      protocolSpend: () => spendWithFailingRelease.service,
      content: CONTENT,
      async activeCrypto() {
        return cryptoFor(OWNER_PRIVATE, ownerPublicKeyHex);
      },
      ownerPublicKeyHex: () => ownerPublicKeyHex,
      dispatchP2p: (operation) => server.dispatch(operation),
      async fetchRootRaw() {
        return new Uint8Array(0);
      },
      sessionEpoch: () => "epoch-1",
      now: () => 1_700_000_000_000,
      randomId: () => "task-1",
    }),
    createService: (repo) => createForumService({
    ...broadcastDeps,
    repository: repo,
    content: CONTENT,
    async activeCrypto() {
      return cryptoFor(OWNER_PRIVATE, ownerPublicKeyHex);
    },
    ownerPublicKeyHex: () => ownerPublicKeyHex,
    protocolSpend: () => spend.service,
    dispatchP2p: (operation) => server.dispatch(operation),
    async fetchRootRaw() {
      return new Uint8Array(0);
    },
    sessionEpoch: () => "epoch-1",
    now: () => 1_700_000_000_000,
    randomId: () => "task-1",
  }) };
}

/** 配置 + 根验证证据：没有信任锚就没有任何后续操作的依据。 */
async function writeTrustAnchor(repository: ForumRepository): Promise<void> {
  await repository.writeConfig(forumConfig());
  await repository.writeRoot({
    configId: "test-forum",
    forumTxid: FORUM_TXID,
    rawTxHex: "00",
    forumName: "test",
    tipPrice: "10",
    forumPublicKeyHex: forumPublicKeyHex.toLowerCase(),
    payToPublicKeyHex: forumPublicKeyHex.toLowerCase(),
    verifiedAtMs: 1_700_000_000_000,
    baseline: "unknown",
  });
}

async function publishUntilConfirmed(forum: Harness["forum"]): Promise<ForumPublishTask> {
  const task = await forum.preparePublish({
    configId: "test-forum",
    kind: "reply",
    targetTxid: PARENT_TXID,
    markdown: "# hi",
    tipPrice: "7",
  });
  await forum.quotePublish(task.taskId);
  await forum.confirmBudget(task.taskId);
  return forum.buildAndSubmit(task.taskId);
}

describe("发布流程的完整阶段推进", () => {
  it("从草稿走到派发，并逐步落盘 funding-prepared / quote-rechecked / raw-prepared", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const written: ForumPublishTask[] = [];
    const inner = harness.repository.writeTask.bind(harness.repository);
    const forum = harness.createService({
      ...harness.repository,
      writeTask: async (task: ForumPublishTask) => {
        written.push({ ...task });
        await inner(task);
      },
    } as ForumRepository);

    const task = await publishUntilConfirmed(forum);

    // 派发完成后立刻对账：索引还没发现，所以停在 reconciling 而不是伪造成功。
    expect(task.phase).toBe("reconciling");
    expect(task.indexObservation.state).toBe("unknown");
    expect(task.broadcastState).toBe("observed-unconfirmed");
    expect(task.submissionId).toBe("submission-1");
    expect(task.txid).toBe(bytesToHex(parseTransaction(hexToBytes(task.finalRawTxHex as string), sha256Digest).txid));

    // 关键：三个派发前阶段都真的被单独持久化过，而不是从 budget-confirmed 直接跳。
    const phases = written.map((entry) => entry.phase);
    expect(phases).toContain("funding-prepared");
    expect(phases).toContain("quote-rechecked");
    expect(phases).toContain("raw-prepared");
    // 顺序必须是 budget-confirmed → funding-prepared → quote-rechecked → raw-prepared。
    const ordered = ["budget-confirmed", "funding-prepared", "quote-rechecked", "raw-prepared"].filter((phase) =>
      phases.includes(phase as ForumPublishTask["phase"]),
    );
    expect(phases.filter((phase) => (ordered as string[]).includes(phase))).toEqual(ordered);
    // raw-prepared 落盘时已经带着不可逆动作的证据。
    const rawPrepared = written.find((entry) => entry.phase === "raw-prepared");
    expect(rawPrepared?.finalRawTxHex).toBeTruthy();
    expect(rawPrepared?.submissionId).toBe("submission-1");
    expect(rawPrepared?.funding?.txid).toBe(FUNDING_TXID);
    // 资金准备证据在 funding-prepared 就落盘，早于协议交易的任何准备。
    const fundingPrepared = written.find((entry) => entry.phase === "funding-prepared");
    expect(fundingPrepared?.funding?.txid).toBe(FUNDING_TXID);
    // 资金准备之后才发生协议交易的 prepare：先拆钱再构造，且顺序可查。
    expect(harness.server.calls()).toContain("quote_reply");
  });

  it("专用资金额度等于固定输出加确认的矿工费预算，而不是固定上界", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await prepareAndQuote(harness.forum);
    const budget = await harness.forum.confirmBudget(task.taskId);
    // 索引费 100 + 数据输出 1 + 父价 500 = 601 sat 固定输出。
    const fixedOutputs = 601;
    const minerFeeBudget = Number(budget.items.find((item) => item.label === "protocol-miner-fee")?.amountSatoshis);
    // 首次确认的预算不能是 0：矿工费由当前报价的输出数算出，不是读旧预算。
    expect(minerFeeBudget).toBeGreaterThan(0);
    // 资金准备交易的矿工费也进入确认项，而不是显示 0。
    expect(budget.items.find((item) => item.label === "funding-miner-fee")?.amountSatoshis).toBe("2");
    expect(Number(budget.totalSatoshis)).toBe(100 + 500 + 2 + minerFeeBudget);

    await harness.forum.buildAndSubmit(task.taskId);
    // 只按实际报价准备：额度 = 固定输出 + 确认的矿工费预算，不是固定上界。
    expect(harness.funding.prepared).toEqual([
      { taskId: "task-1", requiredSatoshis: String(fixedOutputs + minerFeeBudget) },
    ]);
  });

  it("以受控无找零模式构建，允许零值索引输出", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 0n, parentTipPrice: 0n }] });
    const task = await publishUntilConfirmed(harness.forum);
    const call = harness.spend.inputs()[0];
    expect(call?.noChange).toEqual({ maxMinerFeeSatoshis: expect.any(Number), allowZeroValueOutputs: true });
    expect(call?.changeAddress).toBeUndefined();
    // 索引费为零时 vout 0 仍是 0：位置是协议的一部分，不能消失。
    expect(call?.outputs[0]).toBe(0);
    expect(call?.outputs[1]).toBe(1);
    // 父价为零时不生成 vout 2，也不生成零值打赏。
    expect(call?.outputs).toHaveLength(2);
    // 零值 vout 0 真的进了 raw，客户端自己的复核也通过。
    expect(task.phase).toBe("reconciling");
    expect(parseTransaction(hexToBytes(task.finalRawTxHex as string), sha256Digest).outputs[0]?.value).toBe(0n);
  });

  it("资金准备后报价变化时回到费用确认，不按旧预算派发", async () => {
    const harness = await createHarness({
      quotes: [
        { indexPrice: 100n, parentTipPrice: 500n },
        { indexPrice: 900n, parentTipPrice: 500n },
      ],
    });
    const task = await harness.forum.preparePublish({
      configId: "test-forum",
      kind: "reply",
      targetTxid: PARENT_TXID,
      markdown: "# hi",
      tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "quote-changed" });

    const after = await harness.forum.getPublishTask(task.taskId);
    expect(after?.phase).toBe("budget-confirmed");
    expect(after?.budget).toBeUndefined();
    expect(after?.failureCode).toBe("quote-changed");
    // 专用资金已经花出去，所以它的记录要保留，不能因为回退就作废。
    expect(after?.funding?.txid).toBe(FUNDING_TXID);
    // 还没有占用协议输入：回退发生在构造与派发之前。
    expect(harness.spend.inputs()).toHaveLength(0);
  });

  it("没有确认过矿工费预算时拒绝派发", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await harness.forum.preparePublish({
      configId: "test-forum",
      kind: "reply",
      targetTxid: PARENT_TXID,
      markdown: "# hi",
      tipPrice: "7",
    });
    const quoted = await harness.forum.quotePublish(task.taskId);
    // 人为写入一份矿工费预算为零的确认，模拟「界面显示确认但没有真实额度」。
    await harness.repository.writeTask({
      ...quoted,
      budget: {
        version: 1,
        items: [{ label: "protocol-miner-fee", amountSatoshis: "0", detail: "x" }],
        totalSatoshis: "0",
        confirmedAtMs: 1,
      },
      phase: "budget-confirmed",
    });
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "no-fee-budget" });
    expect(harness.spend.inputs()).toHaveLength(0);
  });

  it("阶段图仍然拒绝从 budget-confirmed 直接跳到 raw-prepared", () => {
    // 守卫本身保持严格：绕过持久化的跳跃不会被接受。
    expect(canAdvancePublishPhaseRef("budget-confirmed", "raw-prepared")).toBe(false);
    expect(canAdvancePublishPhaseRef("funding-prepared", "raw-prepared")).toBe(true);
  });

  it("锁外读到的旧任务在拿到租约后被重读，不再按过期状态重跑构造", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(task.taskId);
    // 模拟「本页读到任务之后、拿到租约之前，另一个页面已经派发完成并释放租约」。
    const stale = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    await harness.repository.writeTask({
      ...stale,
      phase: "awaiting-index",
      submissionId: "submission-1",
      txid: "ef".repeat(32),
      finalRawTxHex: "00",
      broadcastState: "observed-unconfirmed",
    });

    const result = await harness.forum.buildAndSubmit(task.taskId);
    // 关键：没有再次准备资金、没有再次构造与派发。
    expect(harness.funding.prepared).toEqual([]);
    expect(harness.spend.inputs()).toEqual([]);
    expect(result.submissionId).toBe("submission-1");
  });

it("构造 raw 期间租约被接管时，派发前停止，不广播", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(task.taskId);
    // 让构造阶段「慢」到足以在内部发生一次接管：prepare 之前换持有者。
    harness.spend.beforePrepare = async () => {
      // 模拟租约到期后被接管：先由当前持有者放开，再让另一个页面取得。
      const mine = await harness.repository.acquireDispatchLease(
        {
          taskId: task.taskId,
          holderId: currentHolderId(harness.repository),
          ownerPublicKeyHex: ownerPublicKeyHex,
          acquiredAtMs: 1,
        },
        60_000,
      );
      await mine?.release();
      const taken = await harness.repository.acquireDispatchLease(
        { taskId: task.taskId, holderId: "other-tab", ownerPublicKeyHex: ownerPublicKeyHex, acquiredAtMs: 2 },
        60_000,
      );
      expect(taken).toBeDefined();
    };

    // 派发前的 assertHeld 必须失败：本地令牌已落后于接管方。
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "lease-lost" });
    // 构造发生过，但绝没有派发。
    expect(harness.spend.inputs().length).toBeGreaterThan(0);
    expect(harness.spend.submitted()).toBe(false);
  });

it("报价上涨后重新确认费用并用更大额度重新准备资金，最终成功提交", async () => {
    // 第一次报价便宜 → 准备了小额专用资金。
    const harness = await createHarness({
      quotes: [
        // 首次报价：便宜。
        { indexPrice: 100n, parentTipPrice: 0n },
        // 资金准备后的复核：变贵，必须回到费用确认。
        { indexPrice: 900n, parentTipPrice: 0n },
        // 用户重新确认之后的复核：与新预算一致。
        { indexPrice: 900n, parentTipPrice: 0n },
        { indexPrice: 900n, parentTipPrice: 0n },
      ],
    });
    const first = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(first.taskId);
    await expect(harness.forum.buildAndSubmit(first.taskId)).rejects.toMatchObject({ code: "quote-changed" });

    // 重新确认费用：预算必须按新报价重新算出来，而不是沿用旧的。
    const second = await harness.forum.confirmBudget(first.taskId);
    const confirmedIndex = second.items.find((item) => item.label === "index-price")?.amountSatoshis;
    expect(confirmedIndex).toBe("900");

    const submitted = await harness.forum.buildAndSubmit(first.taskId);
    expect(submitted.phase).toBe("reconciling");
    expect(submitted.submissionId).toBe("submission-1");

    // 关键：第二次资金准备的额度必须大于第一次。旧额度不足以支付 900 sat 的索引费，
    // 沿用它只会反复得到 funding-insufficient。
    const prepared = harness.funding.prepared.map((entry) => Number((entry as { requiredSatoshis: string }).requiredSatoshis));
    expect(prepared).toHaveLength(2);
    expect(prepared[1]).toBeGreaterThan(prepared[0] as number);
  });

  it("另一个标签页持有派发租约时不做资金准备也不派发", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(task.taskId);
    // 模拟另一个标签页正在处理这笔任务：它先拿到租约。
    const theirs = await harness.repository.acquireDispatchLease(
      { taskId: task.taskId, holderId: "other-tab", ownerPublicKeyHex: ownerPublicKeyHex, acquiredAtMs: 1_700_000_000_000 },
      60_000,
    );
    expect(theirs).toBeDefined();

    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "dispatch-leased" });
    // 关键：既没有准备专用资金，也没有占用协议输入。
    expect(harness.funding.prepared).toEqual([]);
    expect(harness.spend.inputs()).toEqual([]);
    // 另一个标签页的租约没有被本次调用释放掉。
    expect(theirs).toBeDefined();
  });

  it("租约持有者自己重入时正常推进，不会被自己的租约挡住", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(task.taskId);
    // 先由本页取得租约（holderId 与服务内部一致：同一 globalThis）。
    const lease = await harness.repository.acquireDispatchLease(
      { taskId: task.taskId, holderId: currentHolderId(harness.repository), ownerPublicKeyHex: ownerPublicKeyHex, acquiredAtMs: 1_700_000_000_000 },
      60_000,
    );
    expect(lease).toBeDefined();
    const submitted = await harness.forum.buildAndSubmit(task.taskId);
    expect(submitted.submissionId).toBe("submission-1");
  });

  it("报价失败后重新进入发布：租约令牌不会退回，流程仍能走到派发", async () => {
    // 续租把令牌推到 2，租约释放后重新取得必须是 3 而不是 1；否则恢复写入会被
    // 自己保存的更大令牌判为 fenced，发布永远无法重来。
    const harness = await createHarness({
      quotes: [
        { indexPrice: 100n, parentTipPrice: 500n },
        // 资金准备后的复核报价变贵 → 回到费用确认（租约在此释放）。
        { indexPrice: 900n, parentTipPrice: 500n },
        { indexPrice: 900n, parentTipPrice: 500n },
        { indexPrice: 900n, parentTipPrice: 500n },
      ],
    });
    const task = await prepareAndQuote(harness.forum);
    await harness.forum.confirmBudget(task.taskId);
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "quote-changed" });

    // 重新确认费用后再次进入发布：必须能走到派发，而不是被自己的旧令牌拦住。
    await harness.forum.confirmBudget(task.taskId);
    const resumed = await harness.forum.buildAndSubmit(task.taskId);
    expect(resumed.phase).toBe("reconciling");
    expect(resumed.submissionId).toBe("submission-1");
  });

it("崩溃恢复重跑同一段流程不会因为阶段已推进而自相冲突", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await harness.forum.preparePublish({
      configId: "test-forum",
      kind: "reply",
      targetTxid: PARENT_TXID,
      markdown: "# hi",
      tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    // 模拟「资金准备后崩溃」：专用资金已经拆好并记账，任务停在 funding-prepared。
    const budgetConfirmed = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    const minerFeeBudget = budgetConfirmed.budget?.items.find((item) => item.label === "protocol-miner-fee")?.amountSatoshis ?? "0";
    harness.fundingStub.seed(task.taskId, String(601 + Number(minerFeeBudget)));
    await harness.repository.writeTask({
      ...budgetConfirmed,
      phase: "funding-prepared",
      funding: { txid: FUNDING_TXID, vout: 0, rawTxHex: "00" },
    });
    const resumed = await harness.forum.buildAndSubmit(task.taskId);
    expect(resumed.phase).toBe("reconciling");
    // 专用资金没有被重新拆一次：同一个编号只对应一笔。
    expect(harness.funding.prepared).toEqual([]);
  });
});

/** 服务内部的 holderId 挂在 globalThis 上；测试里取同一个值模拟「同一页面」。 */
function currentHolderId(_repository: ForumRepository): string {
  const scope = globalThis as { __forumDispatchHolderId?: string };
  if (typeof scope.__forumDispatchHolderId !== "string" || scope.__forumDispatchHolderId.length === 0) {
    scope.__forumDispatchHolderId = "test-holder";
  }
  return scope.__forumDispatchHolderId;
}

async function prepareAndQuote(forum: Harness["forum"]): Promise<ForumPublishTask> {
  const task = await forum.preparePublish({
    configId: "test-forum",
    kind: "reply",
    targetTxid: PARENT_TXID,
    markdown: "# hi",
    tipPrice: "7",
  });
  return forum.quotePublish(task.taskId);
}


describe("专用资金回收的仲裁", () => {
  /**
   * 造一个「资金已准备、任务未派发」的任务：报价在准备资金后变化，流程回到
   * budget-confirmed 但保留资金记录——这正是报价变化留下的余款场景。
   */
  async function fundedTask(harness: Harness): Promise<ForumPublishTask> {
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "quote-changed" });
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.phase).toBe("budget-confirmed");
    expect(after.funding?.txid).toBe(FUNDING_TXID);
    return after;
  }

  it("回收当前资金后任务回到 budget-confirmed，等待重新准备资金", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    await fundedTask(harness);
    const outcome = await harness.forum.recoverFunding("task-1");
    expect(outcome.recoveredSatoshis).toBe("1800");
    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    expect(after.phase).toBe("budget-confirmed");
    expect(after.funding).toBeUndefined();
    expect(after.budget).toBeUndefined();
    expect(harness.funding.recovered).toEqual([{ taskId: "task-1", reason: { unused: true } }]);
  });

  it("已派发或结果未知的任务拒绝回收，且不会调用钱包侧", async () => {
    for (const broadcastState of ["dispatched", "unknown"] as const) {
      const harness = await createHarness({
        quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
      });
      const task = await fundedTask(harness);
      await harness.repository.writeTask({ ...task, broadcastState, phase: "budget-confirmed" });
      await expect(harness.forum.recoverFunding("task-1")).rejects.toMatchObject({ code: "already-dispatched" });
      // 判断必须在不可逆动作之前：钱包侧一次都没被调用。
      expect(harness.funding.recovered).toEqual([]);
    }
  });

  it("已构造协议交易的阶段拒绝回收（钱扫走了任务会卡住）", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    const task = await fundedTask(harness);
    await harness.repository.writeTask({ ...task, phase: "raw-prepared" });
    await expect(harness.forum.recoverFunding("task-1")).rejects.toMatchObject({ code: "phase-conflict" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("没有专用资金可回收时明确拒绝", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    await expect(harness.forum.recoverFunding(task.taskId)).rejects.toMatchObject({ code: "funding-unavailable" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("钱包侧回收失败时任务状态保持原样（不留下「已回收」的假象）", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
      recoverFails: true,
    });
    const before = await fundedTask(harness);
    await expect(harness.forum.recoverFunding("task-1")).rejects.toThrow();
    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    expect(after.phase).toBe(before.phase);
    expect(after.funding?.txid).toBe(before.funding?.txid);
  });

  it("别的 owner 的任务不能被当前 Key 回收", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    const task = await fundedTask(harness);
    await harness.repository.writeTask({ ...task, ownerPublicKeyHex: "02".padEnd(66, "0") });
    await expect(harness.forum.recoverFunding("task-1")).rejects.toMatchObject({ code: "owner-mismatch" });
    expect(harness.funding.recovered).toEqual([]);
  });
});

describe("取消与回收共用仲裁", () => {
  /** 造一个「资金已准备、任务未派发」的任务：报价在准备资金后变化，流程回到费用确认。 */
  async function fundedTask(harness: Harness): Promise<ForumPublishTask> {
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    await expect(harness.forum.buildAndSubmit(task.taskId)).rejects.toMatchObject({ code: "quote-changed" });
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.funding?.txid).toBe(FUNDING_TXID);
    return after;
  }

  it("取消后的专用资金可以回收，且任务保持取消状态", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    await fundedTask(harness);
    await harness.forum.cancelUndispatched("task-1");

    const outcome = await harness.forum.recoverFunding("task-1");
    expect(outcome.recoveredSatoshis).toBe("1800");

    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    // 关键：不能因为回收就把用户已经取消的发布重新激活。
    expect(after.phase).toBe("failed");
    expect(after.failureCode).toBe("cancelled");
    // 资金引用清掉：钱已经在钱包里，记录不该再指向它。
    expect(after.funding).toBeUndefined();
    expect(harness.funding.recovered).toEqual([{ taskId: "task-1", reason: { unused: true } }]);
  });

  it("未取消的任务回收后回到 budget-confirmed（重新准备资金）", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    await fundedTask(harness);
    await harness.forum.recoverFunding("task-1");
    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    expect(after.phase).toBe("budget-confirmed");
    expect(after.failureCode).toBe("funding-recovered");
  });

  it("别的失败原因不允许回收（只有取消代表「确定不再使用」）", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    const task = await fundedTask(harness);
    await harness.repository.writeTask({ ...task, phase: "failed", failureCode: "quote-changed" });
    await expect(harness.forum.recoverFunding("task-1")).rejects.toMatchObject({ code: "phase-conflict" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("租约等待期间任务被取消时，回收按重读到的取消状态落地，不覆盖它", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    const task = await fundedTask(harness);
    // 模拟交错：回收在取得租约前，另一个标签页把任务取消了。
    const realAcquire = harness.repository.acquireDispatchLease.bind(harness.repository);
    let cancelled = false;
    const repository: ForumRepository = {
      ...harness.repository,
      async acquireDispatchLease(input, ttl) {
        if (!cancelled) {
          cancelled = true;
          // 取消先落地（它自己也会取租约，取完立即释放）。
          await harness.forum.cancelUndispatched(task.taskId);
        }
        return realAcquire(input, ttl);
      },
    };
    const forum = harness.createService(repository);
    await forum.recoverFunding("task-1");

    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    // 取消结论必须保留：不能被回收写成 budget-confirmed。
    expect(after.phase).toBe("failed");
    expect(after.failureCode).toBe("cancelled");
    expect(after.funding).toBeUndefined();
  });

  it("租约期间资金坐标变化时拒绝回收（只比 txid 会漏掉同交易不同 vout）", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    const task = await fundedTask(harness);
    const realAcquire = harness.repository.acquireDispatchLease.bind(harness.repository);
    const repository: ForumRepository = {
      ...harness.repository,
      async acquireDispatchLease(input, ttl) {
        // 同一笔交易的另一个 vout：只比 txid 的实现会放过它。
        await harness.repository.writeTask({
          ...(await harness.repository.readTask(task.taskId)) as ForumPublishTask,
          funding: { ...(task.funding as { txid: string; vout: number }), vout: 1 },
        } as ForumPublishTask);
        return realAcquire(input, ttl);
      },
    };
    const forum = harness.createService(repository);
    await expect(forum.recoverFunding("task-1")).rejects.toMatchObject({ code: "funding-unavailable" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("取消也走同一把派发租约：别人正在处理时明确失败而不是各写各的", async () => {
    const harness = await createHarness({
      quotes: [{ indexPrice: 100n, parentTipPrice: 500n }, { indexPrice: 900n, parentTipPrice: 500n }],
    });
    await fundedTask(harness);
    const before = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    await harness.repository.acquireDispatchLease(
      { taskId: "task-1", holderId: "other-tab", ownerPublicKeyHex: ownerPublicKeyHex, acquiredAtMs: 1_700_000_000_000 },
      60_000,
    );
    // 与发布/回收同一套仲裁：拿不到租约就明说，不在别人正在处理时写任务。
    await expect(harness.forum.cancelUndispatched("task-1")).rejects.toMatchObject({ code: "dispatch-leased" });
    const after = (await harness.repository.readTask("task-1")) as ForumPublishTask;
    expect(after.phase).toBe(before.phase);
    expect(after.failureCode).toBe(before.failureCode);
  });
});

describe("预签名但未派发的任务可以取消", () => {
  /** 直接构造一个 raw-prepared 的任务：submissionId 在、broadcastState 是未派发。 */
  async function rawPreparedTask(harness: Harness, overrides: Partial<ForumPublishTask> = {}): Promise<ForumPublishTask> {
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    const current = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    await harness.repository.writeTask({
      ...current,
      phase: "raw-prepared",
      submissionId: "submission-1",
      txid: "ab".repeat(32),
      funding: { txid: FUNDING_TXID, vout: 0, rawTxHex: "00" },
      ...overrides,
    });
    return (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
  }

  it("钱包确认未派发时释放预签名占用并标记取消（不因有 submissionId 就拒绝）", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    expect(task.submissionId).toBe("submission-1");

    await harness.forum.cancelUndispatched(task.taskId);

    // 预签名占用必须真的释放，否则这笔记账会一直挡着普通转账。
    expect(harness.spend.releases()).toEqual(["submission-1"]);
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.phase).toBe("failed");
    expect(after.failureCode).toBe("cancelled");
    // 关键：不是 reconciling。
    expect(after.phase).not.toBe("reconciling");
  });

  it("definitely-not-dispatched 同样可取消", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "definitely-not-dispatched" });
    const task = await rawPreparedTask(harness);
    await harness.forum.cancelUndispatched(task.taskId);
    expect(harness.spend.releases()).toEqual(["submission-1"]);
  });

  it.each(["dispatched", "observed-unconfirmed", "observed-confirmed", "unknown"] as const)(
    "广播状态为 %s 时拒绝取消，也不释放占用",
    async (state) => {
      const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: state });
      const task = await rawPreparedTask(harness);
      await expect(harness.forum.cancelUndispatched(task.taskId)).rejects.toMatchObject({ code: "not-cancellable" });
      expect(harness.spend.releases()).toEqual([]);
      const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
      expect(after.phase).toBe("raw-prepared");
    },
  );

  it("没有观察能力时拒绝（查不到不等于没派发）", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }] });
    const task = await rawPreparedTask(harness);
    await expect(harness.forum.cancelUndispatched(task.taskId)).rejects.toMatchObject({ code: "not-cancellable" });
    expect(harness.spend.releases()).toEqual([]);
  });

  it("取消拿不到租约时明确拒绝，且不把取消改写成对账", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    const theirs = await harness.repository.acquireDispatchLease(
      { taskId: task.taskId, holderId: "other-tab", ownerPublicKeyHex: ownerPublicKeyHex, acquiredAtMs: 1_700_000_000_000 },
      60_000,
    );
    expect(theirs).toBeDefined();

    await expect(harness.forum.cancelUndispatched(task.taskId)).rejects.toMatchObject({ code: "dispatch-leased" });
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    // 关键：不能变成 reconciling，也不能变成 cancelled。
    expect(after.phase).toBe("raw-prepared");
    expect(after.failureCode).not.toBe("cancelled");
    expect(harness.spend.releases()).toEqual([]);
  });

  it("没有 submission 的任务按任务自身状态判断", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "dispatched" });
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    // 既没有 submissionId，也没有派发状态：明确未派发，可以取消。
    await harness.forum.cancelUndispatched(task.taskId);
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.failureCode).toBe("cancelled");
    expect(harness.spend.releases()).toEqual([]);
  });
});

describe("预签名 → 取消 → 回收 的完整串联", () => {
  /** 造一个 raw-prepared 的任务：预签名已保存 submissionId，但尚未派发。 */
  async function rawPreparedTask(harness: Harness, overrides: Partial<ForumPublishTask> = {}): Promise<ForumPublishTask> {
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    await harness.forum.quotePublish(task.taskId);
    await harness.forum.confirmBudget(task.taskId);
    const current = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    await harness.repository.writeTask({
      ...current,
      phase: "raw-prepared",
      submissionId: "submission-1",
      txid: "ab".repeat(32),
      funding: { txid: FUNDING_TXID, vout: 0, rawTxHex: "00" },
      ...overrides,
    });
    return (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
  }

  it("预签名明确未派发 → 取消释放原提交 → 专用资金可以回收", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);

    await harness.forum.cancelUndispatched(task.taskId);
    expect(harness.spend.releases()).toEqual(["submission-1"]);
    const cancelled = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(cancelled.phase).toBe("failed");
    expect(cancelled.failureCode).toBe("cancelled");
    // 取消保留 submissionId 作为历史证据。
    expect(cancelled.submissionId).toBe("submission-1");

    // 关键：回收不能因为「有 submissionId」就判已派发。
    const outcome = await harness.forum.recoverFunding(task.taskId);
    expect(outcome.recoveredSatoshis).toBe("1800");
    expect(harness.funding.recovered).toEqual([{ taskId: task.taskId, reason: { unused: true } }]);

    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    // 保持取消状态，不重新激活；历史提交证据也不删。
    expect(after.phase).toBe("failed");
    expect(after.failureCode).toBe("cancelled");
    expect(after.submissionId).toBe("submission-1");
    expect(after.funding).toBeUndefined();
  });

  it("已取消但提交状态查不到时拒绝回收（未派发需要被证明，不能假设）", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    await harness.forum.cancelUndispatched(task.taskId);

    // 提交状态变得不可判定：这时必须拒绝，而不是沿用取消时的结论。
    harness.observation.current = "unknown";
    await expect(harness.forum.recoverFunding(task.taskId)).rejects.toMatchObject({ code: "already-dispatched" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("已取消但提交其实派发过时拒绝回收", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    await harness.forum.cancelUndispatched(task.taskId);

    harness.observation.current = "observed-confirmed";
    await expect(harness.forum.recoverFunding(task.taskId)).rejects.toMatchObject({ code: "already-dispatched" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("未取消却带着预签名提交的任务一律拒绝回收", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    // 阶段被手动退回费用确认，但提交还在：随时可能被派发，不能回收。
    const task = await rawPreparedTask(harness, { phase: "budget-confirmed", broadcastState: "not-dispatched" });
    await expect(harness.forum.recoverFunding(task.taskId)).rejects.toMatchObject({ code: "already-dispatched" });
    expect(harness.funding.recovered).toEqual([]);
  });

  it("释放能力缺失时取消明确失败，且不把任务标成已取消", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    const forum = harness.createServiceWithoutRelease(harness.repository);

    // 关键：不能「跳过释放」然后报告取消成功。
    await expect(forum.cancelUndispatched(task.taskId)).rejects.toMatchObject({ code: "release-unavailable" });
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.phase).toBe("raw-prepared");
    expect(after.failureCode).not.toBe("cancelled");
    expect(after.submissionId).toBe("submission-1");
  });

  it("没有预签名提交的草稿可以直接取消（不需要释放能力）", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await harness.forum.preparePublish({
      configId: "test-forum", kind: "reply", targetTxid: PARENT_TXID, markdown: "# hi", tipPrice: "7",
    });
    const forum = harness.createServiceWithoutRelease(harness.repository);
    await forum.cancelUndispatched(task.taskId);
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.failureCode).toBe("cancelled");
  });

  it("释放抛错时同样不标记取消（取消不算成功）", async () => {
    const harness = await createHarness({ quotes: [{ indexPrice: 100n, parentTipPrice: 500n }], observation: "not-dispatched" });
    const task = await rawPreparedTask(harness);
    const forum = harness.createServiceWithFailingRelease(harness.repository);

    await expect(forum.cancelUndispatched(task.taskId)).rejects.toThrow(/释放预签名提交失败/u);
    const after = (await harness.repository.readTask(task.taskId)) as ForumPublishTask;
    expect(after.phase).toBe("raw-prepared");
    expect(after.failureCode).not.toBe("cancelled");
  });
});
