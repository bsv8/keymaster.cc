import type { BorrowedModuleFileStore, ProtocolSpendPreview, ProtocolSpendService, P2pkhUtxoSnapshotResult, P2pkhUtxoBinding } from "@keymaster/contracts";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { createBitfsFundingLedger, recoverBitfsFundingSplits, type BitfsFundingLedger, type BitfsFundingTransactionView } from "./funding.js";
import { createBitfsTransactionJournal, type BitfsTransactionJournal } from "./broadcast.js";

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
  ensureResources(owner: string, bsvNetwork: "main" | "test"): Promise<FundingSnapshotResource[]>;
  snapshots(): FundingSnapshots | undefined;
  readP2pkhSettings(): Promise<{ bsvNetwork: "main" | "test"; feeRateSatoshisPerKb: number }>;
  maxFeeSatoshis(): number;
  deriveAddress(owner: string, network: "main" | "test"): string;
  addressScript(address: string, network: "main" | "test"): string;
  parseTransaction(raw: string, txid?: string): { canonicalTxid: string; inputs: { outpointKey: string }[]; outputs: { vout: number; value: number; scriptHex: string }[] };
}

/** MSFile owns pool evidence and exact funding transactions; wallet outputs remain ordinary balance. */
export function createWorkerFundingRuntime(deps: WorkerFundingDependencies) {
  let msfileBitfsFundingLedger: BitfsFundingLedger | undefined;
  let msfileBitfsFundingLedgerOwnerHex: string | undefined;
  let ledgerEpoch: string | undefined;
/** 返回绑定当前 owner 的唯一 BitFS 资金账本；不在锁定状态打开明文存储。 */
function currentMsfileBitfsFundingLedger(): BitfsFundingLedger {
  const owner = deps.session().activePublicKeyHex?.trim().toLowerCase();
  if (deps.session().vaultStatus !== "unlocked" || !owner) throw new Error("Vault 已锁定，BitFS 资金视图不可用");
  const epoch = deps.session().sessionEpoch;
  if (!msfileBitfsFundingLedger || msfileBitfsFundingLedgerOwnerHex !== owner || ledgerEpoch !== epoch) {
    msfileBitfsFundingLedger = createBitfsFundingLedger(deps.journalStore());
    msfileBitfsFundingLedgerOwnerHex = owner;
    ledgerEpoch = epoch;
  }
  return msfileBitfsFundingLedger;
}

/** 只协调正在执行的交易输入；钱包输出不因 BitFS 历史或文件归属受保护。 */
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

/**
 * 构造只供 BitFS 资金流程使用的 P2PKH 受控签名适配器。
 *
 * 中文说明：Worker 可以请求 Window lane 预签并释放未广播交易；`submit`
 * 永远报错，BitFS exact outbox + broadcaster 是唯一允许的派发路径。
 */
function createMsfileBitfsProtocolSpend(transactions?: BitfsTransactionJournal): ProtocolSpendService {
  return {
    async prepare(){throw Error("BitFS funding requires explicit presign");},
    async presign(input) {
      const inputs = await Promise.all(input.inputs.map(async item => {
        const raw = await transactions?.getTransaction(item.txid);
        return raw ? { ...item, previousTransactionHex: Array.from(raw, byte => byte.toString(16).padStart(2, "0")).join("") } : item;
      }));
      return await deps.executor({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-funding-prepare", input: { ...input, inputs } },
      }) as ProtocolSpendPreview;
    },
    async submit() {
      throw new Error("BitFS 资金交易只能由持久化后的 BitFS outbox 广播");
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
  const resources = await deps.ensureResources(input.ownerPublicKeyHex, input.network);
  assertFresh();
  const resource = resources.find((item) => item.network === input.network);
  if (!resource || !snapshots) throw new Error("BitFS FundingTx 的 P2PKH 余额快照尚未就绪");
  const deadline = Date.now() + 30_000;
  let latest: P2pkhUtxoSnapshotResult = { available: false, state: "unavailable", items: [] };
  while (Date.now() < deadline) {
    assertFresh();
    await snapshots.reconcileConsumed(resource, { thresholdMs: 0 });
    assertFresh();
    latest = await snapshots.refresh(resource);
    assertFresh();
    await reconcileMsfileBitfsFundingInputs(input.ownerPublicKeyHex, input.network, latest);
    if (latest.available && latest.state === "fresh") return filterP2pkhSnapshotByBitfsFunds(input.ownerPublicKeyHex, input.network, latest);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`BitFS FundingTx 无法取得新鲜钱包快照：${latest.items.map((item) => `${item.txid}:${item.vout}`).join(",")}`);
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

  return {
    currentLedger: currentMsfileBitfsFundingLedger,
    filterSnapshot: filterP2pkhSnapshotByBitfsFunds,
    reconcileInputs: reconcileMsfileBitfsFundingInputs,
    protocolSpend: createMsfileBitfsProtocolSpend,
    releasePreparedSubmission: releaseMsfileBitfsPreparedSubmission,
    waitForSnapshot: waitForMsfileFundingSnapshot,
    recoverSplit: recoverMsfileBitfsFundingSplit,
    clear: () => { msfileBitfsFundingLedger = undefined; msfileBitfsFundingLedgerOwnerHex = undefined; ledgerEpoch = undefined; },
  };
}
