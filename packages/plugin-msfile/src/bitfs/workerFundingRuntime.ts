import { requireWocNetwork } from "@keymaster/contracts";
import type { BorrowedModuleFileStore, ProtocolSpendService, ProtocolSpendInput, WocService } from "@keymaster/contracts";
import { createBitfsFundingLedger, recoverBitfsFundingSplits, type BitfsFundingLedger, type BitfsFundingTransactionView } from "./funding.js";
import { createBitfsTransactionJournal, type BitfsTransactionJournal, type BitfsChainPort } from "./broadcast.js";
import { createBitfsWocChainPort } from "./wocChain.js";

type FundingResource = { resourceId: string; publicKeyHex: string; network: "main" | "test"; address: string; generation: number };
type FundingPlan = { ownerPublicKeyHex: string; network: "main" | "test"; amountSatoshis: number; feeRateSatoshisPerKb: number; outputs?: Array<{ scriptHex: string; value: string }> };
export interface WorkerFundingDependencies {
  session(): { vaultStatus: string; activePublicKeyHex?: string; sessionEpoch: string };
  journalStore(): BorrowedModuleFileStore;
  walletView(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<import("@keymaster/contracts").P2pkhUtxoSnapshotResult>;
  protocol(): Promise<{ readonly identity: Readonly<import("@keymaster/contracts").NetworkIdentity>; spend: ProtocolSpendService; planFunding(input: import("@keymaster/contracts").ProtocolFundingPlanRequest): Promise<{ selected: ProtocolSpendInput[]; totalInputSatoshis: number }> }>;
  submitWalletExact(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; rawTxHex: string }): Promise<{ outcome: "accepted" | "already-known" }>;
  ownsWalletExact(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; rawTxHex: string }): Promise<boolean>;
  previousTransaction(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string }): Promise<string | null>;
  observeBusinessReceipt(input: { ownerPublicKeyHex: string; network: "main" | "test"; rawTxHex: string }): Promise<void>;
  ensureResources(owner: string, bsvNetwork: "main" | "test"): Promise<FundingResource[]>;
  walletIdentity(): Readonly<import("@keymaster/contracts").NetworkIdentity>;
  effectiveFeeRate(): number;
  maxFeeSatoshis(): number;
  deriveAddress(owner: string, network: "main" | "test"): string;
  addressScript(address: string, network: "main" | "test"): string;
  parseTransaction(raw: string, txid?: string): { canonicalTxid: string; inputs: { outpointKey: string }[]; outputs: { vout: number; value: number; scriptHex: string }[] };
}

/** BitFS owns pool business evidence, never a parallel wallet allocator. */
export function createWorkerFundingRuntime(deps: WorkerFundingDependencies) {
  let ledger: BitfsFundingLedger | undefined;
  let ledgerOwner: string | undefined;
  let ledgerEpoch: string | undefined;
  function currentLedger(): BitfsFundingLedger {
    const session = deps.session(), owner = session.activePublicKeyHex?.toLowerCase();
    if (session.vaultStatus !== "unlocked" || !owner) throw new Error("Vault 已锁定，BitFS 资金视图不可用");
    if (!ledger || ledgerOwner !== owner || ledgerEpoch !== session.sessionEpoch) {
      ledger = createBitfsFundingLedger(deps.journalStore()); ledgerOwner = owner; ledgerEpoch = session.sessionEpoch;
    }
    return ledger;
  }
  function protocolSpend(transactions?: BitfsTransactionJournal): ProtocolSpendService {
    return {
      async prepare() { throw new Error("BitFS funding requires explicit presign"); },
      async presign(input) {
        const service = await deps.protocol();
        const inputs = await Promise.all(input.inputs.map(async item => {
          const raw = await transactions?.getTransaction(item.txid);
          return raw ? { ...item, previousTransactionHex: hex(raw) } : item;
        }));
        return service.spend.presign({ ...input, inputs, deferDispatch: true });
      },
      async submit() { throw new Error("BitFS funding dispatch requires verified Kind 3 and durable business evidence"); },
      async releasePrepared(preview) { await (await deps.protocol()).spend.releasePrepared!(preview); },
      async releasePreparedSubmission(input) { await (await deps.protocol()).spend.releasePreparedSubmission!(input); },
    };
  }
  async function releasePreparedSubmission(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; submissionId: string }) {
    const service = await deps.protocol();
    const currentSession = deps.session();
    if (currentSession.vaultStatus !== "unlocked" || currentSession.activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()
      || service.identity.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase() || service.identity.bsvNetwork !== input.network) throw new Error("BitFS submission ownership changed");
    await service.spend.releasePreparedSubmission!({ txid: input.txid, submissionId: input.submissionId });
  }
  async function planFunding(input: FundingPlan) {
    const service = await deps.protocol();
    if (service.identity.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase() || service.identity.bsvNetwork !== input.network) throw new Error("BitFS funding ownership changed");
    const { ownerPublicKeyHex: _owner, network: _network, ...plan } = input;
    return service.planFunding(plan);
  }

  /** Wallet-input transactions dispatch only through the manager. Pool-only
   * transactions stay in BitFS and do not incur another wallet approval. */
  function chain(woc: WocService & import("@keymaster/contracts").WocWorkerBroadcastService, network: "main" | "test", transactions: BitfsTransactionJournal): BitfsChainPort {
    const session = deps.session(), owner = session.activePublicKeyHex;
    if (!owner || session.vaultStatus !== "unlocked") throw new Error("BitFS chain requires unlocked owner");
    const check = () => { const now = deps.session(); if (now.vaultStatus !== "unlocked" || now.activePublicKeyHex !== owner || now.sessionEpoch !== session.sessionEpoch) throw new Error("BitFS chain session revoked"); };
    const businessChain = createBitfsWocChainPort(woc, network);
    return {
      async broadcast(input) {
        check();
        const parsed = deps.parseTransaction(input.rawTxHex, input.txid);
        const owned = await deps.ownsWalletExact({ ownerPublicKeyHex: owner, network, ...input });
        check();
        if (owned) return deps.submitWalletExact({ ownerPublicKeyHex: owner, network, ...input });
        const walletScript = deps.addressScript(deps.deriveAddress(owner, network), network).toLowerCase();
        let walletInput = false;
        for (const row of parsed.inputs) {
          const [txid, vout] = row.outpointKey.split(":");
          const managerParent = await deps.previousTransaction({ ownerPublicKeyHex: owner, network, txid: txid! });
          check();
          const retained = managerParent ? undefined : await transactions.getTransaction(txid!);
          if (!managerParent && !retained && !woc.getRawTransaction) throw new Error("BitFS previous transaction reader unavailable");
          const raw = managerParent ?? (retained ? hex(retained) : await requireWocNetwork(woc, network).getRawTransaction!(txid!));
          check();
          const previous = deps.parseTransaction(raw, txid);
          const output = previous.outputs.find(item => item.vout === Number(vout));
          if (!output) throw new Error("BitFS input has no trusted prevout");
          walletInput ||= output.scriptHex.toLowerCase() === walletScript;
        }
        check();
        if (walletInput) return deps.submitWalletExact({ ownerPublicKeyHex: owner, network, ...input });
        const result = await businessChain.broadcast(input);
        check();
        // Pool business is already authorized. Feed the verified receipt back
        // to manager so returned wallet outputs are usable without WoC polling.
        await deps.observeBusinessReceipt({ ownerPublicKeyHex: owner, network, rawTxHex: input.rawTxHex });
        return result;
      },
      async lookupTransaction(txid) {
        check();
        const result = await businessChain.lookupTransaction(txid);
        check();
        if (result === "confirmed" || result === "mempool") {
          const raw = await transactions.getTransaction(txid);
          if (!raw) throw new Error("Observed BitFS transaction has no retained exact bytes");
          deps.parseTransaction(hex(raw), txid);
          await deps.observeBusinessReceipt({ ownerPublicKeyHex: owner, network, rawTxHex: hex(raw) });
          check();
        }
        return result;
      },
    };
  }
  async function recoverSplit(input: { ownerPublicKeyHex: string; seedHashHex: string; network: "main" | "test" }) {
    const session = deps.session();
    if (session.vaultStatus !== "unlocked" || session.activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("BitFS 专款恢复只允许当前已解锁 Key");
    await recoverBitfsFundingSplits(input, {
      ledger: currentLedger(), transactions: createBitfsTransactionJournal(deps.journalStore()), releasePreparedSubmission,
      parseTransaction(raw, txid): BitfsFundingTransactionView { const parsed = deps.parseTransaction(raw, txid); return { canonicalTxid: parsed.canonicalTxid, inputs: parsed.inputs.map(row => row.outpointKey), outputs: parsed.outputs.map(row => ({ vout: row.vout, valueSatoshis: row.value, scriptHex: row.scriptHex })) }; },
      nowMs: () => Date.now(),
    });
  }
  return { currentLedger, protocolSpend, planFunding, chain, walletView: deps.walletView, releasePreparedSubmission, recoverSplit, clear() { ledger = undefined; ledgerOwner = undefined; ledgerEpoch = undefined; } };
}
function hex(bytes: Uint8Array) { return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
