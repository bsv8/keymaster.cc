import type { BorrowedModuleFileStore, ProtocolSpendService, ProtocolSpendInput, WocService } from "@keymaster/contracts";
import { createBitfsFundingLedger, recoverBitfsFundingSplits, type BitfsFundingLedger, type BitfsFundingTransactionView } from "./funding.js";
import { createBitfsTransactionJournal, type BitfsTransactionJournal, type BitfsChainPort } from "./broadcast.js";
import { createBitfsWocChainPort } from "./wocChain.js";

type FundingResource = { resourceId: string; publicKeyHex: string; network: "main" | "test"; address: string; generation: number };
type FundingPlan = { ownerPublicKeyHex: string; network: "main" | "test"; amountSatoshis: number; feeRateSatoshisPerKb: number; outputs?: Array<{ scriptHex: string; value: string }> };
export interface WorkerFundingDependencies {
  session(): { vaultStatus: string; activePublicKeyHex?: string; sessionEpoch: string };
  journalStore(): BorrowedModuleFileStore;
  protocol(): Promise<{ readonly identity: Readonly<import("@keymaster/contracts").NetworkIdentity>; spend: ProtocolSpendService; planFunding(input: import("@keymaster/contracts").ProtocolFundingPlanRequest): Promise<import("@keymaster/contracts").ProtocolFundingPlan>; releaseFundingPlan(input: {allocationId: string; submissionId: string}): Promise<boolean> }>;
  submitWalletExact(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; rawTxHex: string }): Promise<{ outcome: "accepted" | "already-known" }>;
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
  function protocolSpend(): ProtocolSpendService {
    return {
      async prepare() { throw new Error("BitFS funding requires explicit presign"); },
      async presign(input) {
        const service = await deps.protocol();
        return service.spend.presign({ ...input, deferDispatch: true });
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

  async function releaseFundingPlan(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string; submissionId: string }) {
    const service = await deps.protocol();
    if (service.identity.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase() || service.identity.bsvNetwork !== input.network) throw new Error("BitFS funding cancellation ownership changed");
    return service.releaseFundingPlan({allocationId: input.allocationId, submissionId: input.submissionId});
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
        deps.parseTransaction(input.rawTxHex, input.txid);
        // Trusted business context is retained by the outbox for retries/recovery.
        // Wallet dispatch still requires the current manager allocation.
        if (input.submissionPath === "wallet") return deps.submitWalletExact({ ownerPublicKeyHex: owner, network, ...input });
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
  return { currentLedger, protocolSpend, planFunding, releaseFundingPlan, chain, releasePreparedSubmission, recoverSplit, clear() { ledger = undefined; ledgerOwner = undefined; ledgerEpoch = undefined; } };
}
function hex(bytes: Uint8Array) { return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
