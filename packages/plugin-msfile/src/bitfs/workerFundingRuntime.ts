import type { BorrowedModuleFileStore, ProtocolSpendPreview, ProtocolSpendService, P2pkhUtxoSnapshotResult, P2pkhUtxoBinding } from "@keymaster/contracts";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { createBitfsFundingLedger, prepareBitfsFundingSplit, recoverBitfsFundingSplits, type BitfsFundingLedger, type BitfsFundingSplitPrepareDeps, type BitfsFundingTransactionView, type PreparedBitfsFundingSplit } from "./funding.js";
import { createBitfsTransactionJournal, type BitfsTransactionJournal } from "./broadcast.js";
import type { BitfsTransactionBroadcaster, BitfsBroadcastOutcome } from "./broadcast.js";

type FundingSnapshotResource = { resourceId: string; publicKeyHex: string; network: "main" | "test"; address: string; generation: number };
type P2pkhUtxoSnapshotResource = FundingSnapshotResource;
interface FundingSnapshots {
  reconcileConsumed(resource: FundingSnapshotResource, options?: { thresholdMs?: number }): Promise<boolean>;
  refresh(resource: FundingSnapshotResource): Promise<P2pkhUtxoSnapshotResult>;
  consume(resource: FundingSnapshotResource, input: { binding?: P2pkhUtxoBinding; inputOutpointKeys: readonly string[]; txid?: string }): { status: "consumed" | "untouched" } | { status: "rejected"; reason: string };
  rollbackConsume(resource: FundingSnapshotResource, binding: P2pkhUtxoBinding): boolean;
}
export interface WorkerFundingDependencies {
  session(): { vaultStatus: string; activePublicKeyHex?: string; sessionEpoch: string };
  journalStore(): BorrowedModuleFileStore;
  executor(operation: WindowP2pExecutorOperation): Promise<unknown>;
  ensureResources(owner: string, includeTestnet: boolean): Promise<FundingSnapshotResource[]>;
  snapshots(): FundingSnapshots | undefined;
  readP2pkhSettings(): Promise<{ includeTestnet: boolean; feeRateSatoshisPerKb: { medium: number } }>;
  maxFeeSatoshis(): number;
  deriveAddress(owner: string, network: "main" | "test"): string;
  addressScript(address: string, network: "main" | "test"): string;
  parseTransaction(raw: string, txid?: string): { canonicalTxid: string; inputs: { outpointKey: string }[]; outputs: { vout: number; value: number; scriptHex: string }[] };
}

/** MSFile owns its protected funds ledger and exact funding transaction workflow. */
export function createWorkerFundingRuntime(deps: WorkerFundingDependencies) {
  let msfileBitfsFundingLedger: BitfsFundingLedger | undefined;
  let msfileBitfsFundingLedgerOwnerHex: string | undefined;
  let ledgerEpoch: string | undefined;
/** 返回绑定当前 owner 的唯一 BitFS 专款账本；不在锁定状态打开明文存储。 */
function currentMsfileBitfsFundingLedger(): BitfsFundingLedger {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (deps.session().vaultStatus !== "unlocked" || !owner) throw new Error("Vault 已锁定，BitFS 专款视图不可用");
  const epoch = deps.session().sessionEpoch;
  if (!msfileBitfsFundingLedger || msfileBitfsFundingLedgerOwnerHex !== owner || ledgerEpoch !== epoch) {
    msfileBitfsFundingLedger = createBitfsFundingLedger(deps.journalStore());
    msfileBitfsFundingLedgerOwnerHex = owner;
    ledgerEpoch = epoch;
  }
  return msfileBitfsFundingLedger;
}

/** 普通 P2PKH 只能看见未被 BitFS 专款账本保护的输入；读取失败时拒绝返回快照。 */
async function filterP2pkhSnapshotByBitfsFunds(
  ownerPublicKeyHex: string,
  network: "main" | "test",
  snapshot: P2pkhUtxoSnapshotResult,
): Promise<P2pkhUtxoSnapshotResult> {
  const epoch = deps.session().sessionEpoch;
  if (deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) {
    throw new Error("P2PKH UTXO snapshot owner changed while applying BitFS funding protection");
  }
  if (!snapshot.available) return snapshot;
  const protectedOutpoints = await currentMsfileBitfsFundingLedger().listProtectedOutpoints({ ownerPublicKeyHex, network });
  if (deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()
    || deps.session().sessionEpoch !== epoch) {
    throw new Error("P2PKH UTXO snapshot owner changed while reading BitFS funding protection");
  }
  if (protectedOutpoints.length === 0) return snapshot;
  const protectedKeys = new Set(protectedOutpoints.map((item) => `${item.txid}:${item.vout}`));
  return { ...snapshot, items: snapshot.items.filter((item) => !protectedKeys.has(`${item.txid}:${item.vout}`)) };
}

/** 新鲜 P2PKH 快照确认某笔已观察交易的原输入不再可花后，才解除旧输入保护。 */
async function reconcileMsfileBitfsFundingInputs(
  ownerPublicKeyHex: string,
  network: "main" | "test",
  snapshot: P2pkhUtxoSnapshotResult,
): Promise<void> {
  if (!snapshot.available || snapshot.state !== "fresh") return;
  if (deps.session().vaultStatus !== "unlocked"
    || deps.session().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) return;
  await currentMsfileBitfsFundingLedger().reconcileObservedTransactionInputs({
    ownerPublicKeyHex,
    network,
    unspentOutpoints: snapshot.items
      .filter((item) => !item.isSpentInMempoolTx)
      .map((item) => `${item.txid}:${item.vout}`),
    nowMs: Date.now(),
  });
}

/** 普通 P2PKH 当前 Key 找零输出的网络尘额门槛，单位聪。 */
const BITFS_FUNDING_MIN_OUTPUT_SATOSHIS = 546;

/**
 * 构造只供 BitFS 专款流程使用的 P2PKH 受控签名适配器。
 *
 * 中文说明：Worker 可以请求 Window lane 预签并释放未广播交易；`submit`
 * 永远报错，BitFS exact outbox + broadcaster 是唯一允许的派发路径。
 */
function createMsfileBitfsProtocolSpend(): ProtocolSpendService {
  return {
    async prepare(input) {
      return await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-funding-prepare", input },
      }) as ProtocolSpendPreview;
    },
    async submit() {
      throw new Error("BitFS 专款交易只能由持久化后的 BitFS outbox 广播");
    },
    async releasePrepared(preview) {
      await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-funding-release", preview },
      });
    },
  };
}

/** 按持久化提交编号释放明确未派发的 P2PKH 预签 claim。 */
function releaseMsfileBitfsPreparedSubmission(input: {
  /** 当前 Key。 */
  ownerPublicKeyHex: string;
  /** 交易所属网络。 */
  network: "main" | "test";
  /** canonical txid。 */
  txid: string;
  /** P2PKH 持久化提交编号。 */
  submissionId: string;
}): Promise<void> {
  return deps.executor({
    type: "lane",
    laneId: "msfile",
    operation: { type: "bitfs-funding-release-submission", ...input },
  }).then(() => undefined);
}

async function waitForMsfileFundingSnapshot(input: {
  ownerPublicKeyHex: string;
  seedHashHex: string;
  network: "main" | "test";
  ledger: BitfsFundingLedger;
}): Promise<P2pkhUtxoSnapshotResult> {
  const epoch = deps.session().sessionEpoch;
  const snapshots = deps.snapshots();
  const assertFresh = () => {
    const session = deps.session();
    if (session.sessionEpoch !== epoch || session.vaultStatus !== "unlocked" || session.activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase() || deps.snapshots() !== snapshots) throw new Error("BitFS funding snapshot session changed");
  };
  assertFresh();
  const resources = await deps.ensureResources(input.ownerPublicKeyHex, input.network === "test");
  assertFresh();
  const resource = resources.find((item) => item.network === input.network);
  if (!resource || !snapshots) throw new Error("BitFS FundingTx 的 P2PKH 余额快照尚未就绪");
  const account = await input.ledger.getAccount({ ownerPublicKeyHex: input.ownerPublicKeyHex, seedHashHex: input.seedHashHex, network: input.network, nowMs: Date.now() });
  const expected = account.utxos.filter((utxo) => utxo.state === "available").map((utxo) => `${utxo.txid}:${utxo.vout}`);
  const deadline = Date.now() + 30_000;
  let latest: P2pkhUtxoSnapshotResult = { available: false, state: "unavailable", items: [] };
  while (Date.now() < deadline) {
    assertFresh();
    await snapshots.reconcileConsumed(resource, { thresholdMs: 0 });
    assertFresh();
    latest = await snapshots.refresh(resource);
    assertFresh();
    await reconcileMsfileBitfsFundingInputs(input.ownerPublicKeyHex, input.network, latest);
    const available = new Set(latest.items.filter((item) => !item.isSpentInMempoolTx).map((item) => `${item.txid}:${item.vout}`));
    if (latest.available && latest.state === "fresh" && expected.every((key) => available.has(key))) return latest;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`BitFS FundingTx 新鲜快照未包含专款输出：${latest.items.map((item) => `${item.txid}:${item.vout}`).join(",")}`);
}

/** 为指定 Seed 创建专款拆分准备端口；本函数不提交交易。 */
function createMsfileBitfsFundingSplitDeps(input: {
  /** 当前已解锁 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 专款使用的公链网络。 */
  network: "main" | "test";
  /** 当前买方任务 generation。 */
  generation: number;
  /** 当前 Key + Seed + 网络的账本。 */
  ledger: BitfsFundingLedger;
  /** BitFS exact 交易 outbox。 */
  transactions: BitfsTransactionJournal;
}): BitfsFundingSplitPrepareDeps {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const sessionEpoch = deps.session().sessionEpoch;
  const snapshots = deps.snapshots();
  let snapshotResource: P2pkhUtxoSnapshotResource | undefined;
  const assertContext = (context: { ownerPublicKeyHex: string; network: "main" | "test"; generation: number }): void => {
    if (context.ownerPublicKeyHex.toLowerCase() !== owner
      || context.network !== input.network
      || context.generation !== input.generation
      || deps.session().sessionEpoch !== sessionEpoch
      || deps.session().vaultStatus !== "unlocked"
      || deps.session().activePublicKeyHex?.toLowerCase() !== owner
      || deps.snapshots() !== snapshots) {
      throw new Error("BitFS 专款任务的 Key、网络或会话世代已变化");
    }
  };
  return {
    protocolSpend: createMsfileBitfsProtocolSpend(),
    async getAvailableSnapshot() {
      assertContext({ ownerPublicKeyHex: owner, network: input.network, generation: input.generation });
      const settings = await deps.readP2pkhSettings();
      if (input.network === "test" && !settings.includeTestnet) {
        throw new Error("请先在 P2PKH 设置中启用测试网余额");
      }
      const resources = await deps.ensureResources(owner, settings.includeTestnet);
      snapshotResource = resources.find((resource) => resource.network === input.network);
      if (!snapshotResource || !snapshots) {
        return { available: false, state: "unavailable", items: [] };
      }
      await snapshots.reconcileConsumed(snapshotResource);
      const fresh = await snapshots.refresh(snapshotResource);
      assertContext({ ownerPublicKeyHex: owner, network: input.network, generation: input.generation });
      await reconcileMsfileBitfsFundingInputs(owner, input.network, fresh);
      return filterP2pkhSnapshotByBitfsFunds(owner, input.network, fresh);
    },
    async resolveOwnerAddress() {
      assertContext({ ownerPublicKeyHex: owner, network: input.network, generation: input.generation });
      const address = deps.deriveAddress(owner, input.network);
      return { address, scriptHex: deps.addressScript(address, input.network) };
    },
    reserveP2pkhInputs({ preview, inputOutpoints }) {
      assertContext({ ownerPublicKeyHex: owner, network: input.network, generation: input.generation });
      const resource = snapshotResource;
      const binding = preview.utxoBinding;
      if (!resource || !snapshots || !binding) throw new Error("BitFS 专款拆分缺少可消费的 P2PKH 快照绑定");
      const consumed = snapshots.consume(resource, {
        binding,
        inputOutpointKeys: inputOutpoints,
        txid: preview.txid,
      });
      if (consumed.status !== "consumed") throw new Error(`BitFS 专款输入占用被拒绝：${consumed.status === "rejected" ? consumed.reason : "snapshot-missing"}`);
      return { rollback: () => { snapshots?.rollbackConsume(resource, binding); } };
    },
    parseTransaction(rawTransactionHex, expectedTxid): BitfsFundingTransactionView {
      const parsed = deps.parseTransaction(rawTransactionHex, expectedTxid);
      return {
        canonicalTxid: parsed.canonicalTxid,
        inputs: parsed.inputs.map((item) => item.outpointKey),
        outputs: parsed.outputs.map((item) => ({ vout: item.vout, valueSatoshis: item.value, scriptHex: item.scriptHex })),
      };
    },
    transactions: input.transactions,
    ledger: input.ledger,
    assertCurrentContext: assertContext,
    async releasePrepared(preview) {
      await createMsfileBitfsProtocolSpend().releasePrepared?.(preview);
    },
    nowMs: () => Date.now(),
  };
}

/**
 * 为买方任务准备当前 Key 的普通余额拆分。
 *
 * 中文说明：拆分原文先受账本与 outbox 保护，返回后仍须由专款恢复/广播流程
 * 按 txid 对账；这里绝不直接广播。
 */
async function prepareMsfileBitfsFundingSplit(input: {
  /** 当前已解锁 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 专款使用的公链网络。 */
  network: "main" | "test";
  /** 当前买方任务 generation。 */
  generation: number;
  /** 下一段预计采购金额，十进制聪字符串。 */
  requiredSatoshis: string;
}): Promise<PreparedBitfsFundingSplit> {
  const owner = input.ownerPublicKeyHex.trim().toLowerCase();
  if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex?.toLowerCase() !== owner) {
    throw new Error("BitFS 专款拆分只允许当前已解锁 Key");
  }
  const ledger = currentMsfileBitfsFundingLedger();
  const store = deps.journalStore();
  const transactions = createBitfsTransactionJournal(store);
  const settings = await deps.readP2pkhSettings();
  return prepareBitfsFundingSplit({
    ...input,
    ownerPublicKeyHex: owner,
    feeRateSatoshisPerKb: settings.feeRateSatoshisPerKb.medium,
    maxFeeSatoshis: deps.maxFeeSatoshis(),
    minimumOutputSatoshis: String(BITFS_FUNDING_MIN_OUTPUT_SATOSHIS),
  }, createMsfileBitfsFundingSplitDeps({ ...input, ownerPublicKeyHex: owner, ledger, transactions }));
}

/** 针对当前 Seed 恢复拆分交易，只核对原 txid 与 exact outbox，不重签或广播。 */
async function recoverMsfileBitfsFundingSplit(input: {
  /** 当前已解锁 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 专款所属的公链网络。 */
  network: "main" | "test";
}): Promise<void> {
  const owner = input.ownerPublicKeyHex.trim().toLowerCase();
  if (deps.session().vaultStatus !== "unlocked" || deps.session().activePublicKeyHex?.toLowerCase() !== owner) {
    throw new Error("BitFS 专款恢复只允许当前已解锁 Key");
  }
  const store = deps.journalStore();
  await recoverBitfsFundingSplits(input, {
    ledger: currentMsfileBitfsFundingLedger(),
    transactions: createBitfsTransactionJournal(store),
    releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
    parseTransaction(rawTransactionHex, expectedTxid): BitfsFundingTransactionView {
      const parsed = deps.parseTransaction(rawTransactionHex, expectedTxid);
      return {
        canonicalTxid: parsed.canonicalTxid,
        inputs: parsed.inputs.map((item) => item.outpointKey),
        outputs: parsed.outputs.map((item) => ({ vout: item.vout, valueSatoshis: item.value, scriptHex: item.scriptHex })),
      };
    },
    nowMs: () => Date.now(),
  });
}

/** 广播或只按 txid 对账一笔已持久化的专款拆分交易。 */
async function settleMsfileBitfsFundingSplit(input: {
  /** 当前已解锁 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 本次采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 专款所属公链网络。 */
  network: "main" | "test";
  /** 已持久化拆分交易的 canonical txid。 */
  txid: string;
  /** 当前 Key + Seed 的专款账本。 */
  ledger: BitfsFundingLedger;
  /** 专款交易 exact outbox。 */
  transactions: BitfsTransactionJournal;
  /** Worker 唯一交易广播器。 */
  broadcaster: BitfsTransactionBroadcaster;
  /** 明确未派发时释放 P2PKH 的持久预签 claim。 */
  releasePreparedSubmission(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; submissionId: string }): Promise<void>;
  /** 当前 Worker generation 检查。 */
  assertCurrentContext(): void;
}): Promise<BitfsBroadcastOutcome> {
  input.assertCurrentContext();
  let account = await input.ledger.getAccount({
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    seedHashHex: input.seedHashHex,
    network: input.network,
    nowMs: Date.now(),
  });
  const plan = account.transactions.find((item) => item.txid === input.txid && item.purpose === "split");
  if (!plan) throw new Error("BitFS 专款拆分账本找不到对应交易计划");
  const rawTransaction = await input.transactions.getTransaction(input.txid);
  const record = await input.transactions.getTransactionRecord(input.txid);
  if (!rawTransaction || !record) throw new Error("BitFS 专款拆分交易缺少 exact outbox，输入继续受保护");

  let outcome: BitfsBroadcastOutcome;
  if (record.state === "confirmed") {
    outcome = { status: "confirmed", txid: input.txid, attempts: record.attempts };
  } else if (record.state === "failed") {
    outcome = { status: "failed", txid: input.txid, attempts: record.attempts, reason: record.lastError ?? "not-dispatched" };
  } else if (record.state === "result-unknown") {
    input.assertCurrentContext();
    outcome = await input.broadcaster.reconcile(input.txid);
  } else {
    input.assertCurrentContext();
    outcome = await input.broadcaster.submit(rawTransaction);
  }

  input.assertCurrentContext();
  if (outcome.status === "result-unknown") {
    if (plan.state === "prepared") {
      await input.ledger.markTransactionUnknown({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        seedHashHex: input.seedHashHex,
        network: input.network,
        txid: input.txid,
        nowMs: Date.now(),
      });
    }
    const observationDeadline = Date.now() + 60_000;
    while (outcome.status === "result-unknown" && Date.now() < observationDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      input.assertCurrentContext();
      outcome = await input.broadcaster.reconcile(input.txid);
    }
  }
  if (outcome.status === "result-unknown") return outcome;
  if (outcome.status === "failed") {
    if (plan.state !== "failed" && plan.state !== "observed") {
      if (!plan.p2pkhSubmissionId) throw new Error("拆分交易缺少 P2PKH 提交编号，保留输入占用等待人工恢复");
      await input.releasePreparedSubmission({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        txid: input.txid,
        submissionId: plan.p2pkhSubmissionId,
      });
      await input.ledger.releaseDefinitelyUndispatchedTransaction({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        seedHashHex: input.seedHashHex,
        network: input.network,
        expectedRevision: account.revision,
        txid: input.txid,
        nowMs: Date.now(),
      });
    }
    return outcome;
  }

  const rawTransactionHex = Array.from(rawTransaction, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const parsed = deps.parseTransaction(rawTransactionHex, input.txid);
  const actualInputs = parsed.inputs.map((item) => item.outpointKey).sort();
  const actualOutputs = parsed.outputs.map((item) => ({
    txid: input.txid,
    vout: item.vout,
    valueSatoshis: String(item.value),
    scriptHex: item.scriptHex.toLowerCase(),
  }));
  if (parsed.canonicalTxid !== input.txid
    || actualInputs.length !== plan.inputOutpoints.length
    || actualInputs.some((value, index) => value !== plan.inputOutpoints[index])
    || actualOutputs.length !== plan.expectedOutputs.length
    || actualOutputs.some((value, index) => {
      const expected = plan.expectedOutputs[index];
      return !expected || value.txid !== expected.txid || value.vout !== expected.vout
        || value.valueSatoshis !== expected.valueSatoshis || value.scriptHex !== expected.scriptHex;
    })) {
    throw new Error("BitFS 拆分交易原文与专款账本计划不一致，输入继续受保护");
  }
  await input.ledger.observeSplit({
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    seedHashHex: input.seedHashHex,
    network: input.network,
    txid: input.txid,
    actualOutputs,
    nowMs: Date.now(),
  });
  return outcome;
}

  return {
    currentLedger: currentMsfileBitfsFundingLedger,
    filterSnapshot: filterP2pkhSnapshotByBitfsFunds,
    reconcileInputs: reconcileMsfileBitfsFundingInputs,
    protocolSpend: createMsfileBitfsProtocolSpend,
    releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
    waitForSnapshot: waitForMsfileFundingSnapshot,
    prepareSplit: prepareMsfileBitfsFundingSplit,
    recoverSplit: recoverMsfileBitfsFundingSplit,
    settleSplit: settleMsfileBitfsFundingSplit,
    clear: () => { msfileBitfsFundingLedger = undefined; msfileBitfsFundingLedgerOwnerHex = undefined; ledgerEpoch = undefined; },
  };
}
