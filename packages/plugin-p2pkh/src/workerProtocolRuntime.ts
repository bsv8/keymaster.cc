import type { ActiveKeyCrypto, BorrowedModuleFileStore, CentralBroadcastService, ProtectedOutpoint, ProtocolSubmissionObservation } from "@keymaster/contracts";
import { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createWalletProtectedOutpoints } from "./registries/walletProtectedOutpoints.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { buildUnsigned, codeOf, type Funds } from "keymaster-utxo-manager";
import { deriveP2pkhAddress, traceDev } from "@keymaster/contracts";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import type { P2pkhSubmissionRuntime } from "./p2pkhSubmissionRuntime.js";

export interface WorkerProtocolDependencies {
  assertActive(): void;
  owner: string;
  network: "main" | "test";
  storage: BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  central: CentralBroadcastService;
  manager: P2pkhUtxoManager;
  submissions: P2pkhSubmissionRuntime;
  refreshFundingInputs(): Promise<Funds>;
}

/** Claims protection for UTXO manager; retired forum responsibility excluded (decision B). */
export async function readWorkerProtocolProtection(storage: BorrowedModuleFileStore, owner: string, network: "main" | "test"): Promise<ProtectedOutpoint[]> {
  const state = createWorkerProtocolEvidence(storage);
  const submissions = await state.listProtocolSubmissions();
  // 已退役论坛提交不再形成占用：protectedClaimIds 含 `:forum` 后缀的直接排除。
  // 文件级删除由 purgeRetiredForumProtocolData 落实；此处过滤保证删除前/残留同样不恢复占用。
  const live = submissions.filter((row) => !(Array.isArray(row.protectedClaimIds) && row.protectedClaimIds.some((id) => typeof id === "string" && id.endsWith(":forum"))));
  const ids = new Set(live.filter(row => row.publicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network).map(row => row.id));
  const claims = await state.listLocalInputClaims();
  const claimed = claims.filter(row => ids.has(row.submissionId) && row.publicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network && (row.state === "active" || row.state === "isolated"))
    .map(row => ({
      txid: row.txid, vout: row.vout, network: row.network, publicKeyHex: row.publicKeyHex,
      ownerPluginId: "p2pkh", kind: "protocol-claim",
      source: `occupation:${row.submissionId}`, submissionId: row.submissionId,
    }));
  return claimed;
}


export async function createWorkerProtocolRuntime(deps: WorkerProtocolDependencies) {
  const registry = createProtectedOutpointRegistry();
  const check = () => { deps.assertActive(); };
  const protectionView = createWalletProtectedOutpoints(registry, { identity: { publicKeyHex: deps.owner, bsvNetwork: deps.network }, assertActive: () => check() });
  const state = async () => { check(); const store = createWorkerProtocolEvidence(deps.storage); check(); return store; };
  const observeProtocolSubmission = async (input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; submissionId: string }): Promise<ProtocolSubmissionObservation> => {
    check();
    const row = await (await state()).getProtocolSubmission(input.submissionId);
    check();
    if (!row || row.publicKeyHex.toLowerCase() !== deps.owner.toLowerCase() || row.network !== input.network || row.canonicalTxid !== input.txid) return "unknown";
    switch (row.status) {
      case "prepared": return "not-dispatched";
      case "broadcast-pending-woc": case "woc-observed-unconfirmed": return "observed-unconfirmed";
      case "woc-confirmed": return "observed-confirmed";
      case "woc-dropped": return "dropped";
      case "rejected": return row.droppedReason === "prepared-spend-released" ? "not-dispatched" : "rejected";
      default: return "unknown";
    }
  };
  const executor = createP2pkhProtocolSpendService({
    vault: { status: () => { check(); return "unlocked"; }, createActiveKeyCrypto: async () => { check(); const crypto = await deps.crypto(deps.owner); check(); return crypto; } },
    centralBroadcastService: deps.central,
    getKeyForOwner: async () => { check(); return { publicKeyHex: deps.owner }; },
    claimStore: {
      async tryClaimInputs(input) { check(); const result = await (await state()).tryClaimInputs(input); check(); return result; },
      async releaseLocalInputClaims(input) { check(); await (await state()).releaseLocalInputClaims(input.claimIds); check(); },
    },
    submissionStore: {
      async getProtocolSubmission(input) { check(); return (await state()).getProtocolSubmission(input.id); },
      async putProtocolSubmission(record) { check(); await (await state()).putProtocolSubmission(record); check(); },
    },
    protectedOutpoints: registry,
    protocolManager: deps.manager,
    submissions: deps.submissions,
  });
  const scoped = <T extends object>(input: T) => {
    check();
    return { ...structuredClone(input), ownerPublicKeyHex: deps.owner, network: deps.network };
  };
  const spend: import("@keymaster/contracts").ProtocolSpendService = {
    async prepare(input) { const value = await executor.prepare(scoped(input)); check(); return value; },
    async presign(input) { const value = await executor.presign(scoped(input)); check(); return value; },
    async submit(input) { check(); const result = await executor.submit(input); check(); return result; },
    async releasePrepared(input) { check(); await executor.releasePrepared!(input); check(); },
    async releasePreparedSubmission(input) { await executor.releasePreparedSubmission(scoped(input)); check(); },
  };
  const planFunding = async (input: import("@keymaster/contracts").ProtocolFundingPlanRequest & { ownerPublicKeyHex: string; network: "main" | "test" }) => {
    check();
    const address = deriveP2pkhAddress(input.ownerPublicKeyHex, input.network);
    const walletScriptHex = p2pkhAddressToScriptHex(address, input.network);
    const outputs = input.outputs ?? [{scriptHex: walletScriptHex, value: String(input.amountSatoshis)}];
    if (outputs.reduce((sum, row) => sum + BigInt(row.value), 0n) !== BigInt(input.amountSatoshis)) throw new Error("Funding amount differs from declared business outputs");
    const submissionId = crypto.randomUUID();
    const request = {ownerPublicKeyHex: input.ownerPublicKeyHex,
      resource: {resourceId: `p2pkh:${input.network}`, network: input.network, address}, amountSats: String(input.amountSatoshis),
      feeRateSatPerKb: String(input.feeRateSatoshisPerKb), outputScriptLengths: outputs.map(row => row.scriptHex.length / 2)};
    const log = (event: string, details: () => object = () => ({})) => traceDev("keymaster.p2pkh.funding", event, () => ({
      submissionId, network: input.network, address, ...details(),
    }));
    const select = async (attempt: number) => {
      log("selection.start", () => ({ attempt, amountSats: request.amountSats, feeRateSatPerKb: request.feeRateSatPerKb, outputScriptLengths: request.outputScriptLengths }));
      try {
        const allocation = await deps.manager.request(request);
        log("selection.success", () => ({ attempt, allocationId: allocation.allocationId, inputCount: allocation.selectedInputs.length,
          totalInSats: allocation.totalInSats, feeSats: allocation.feeSats, changeSats: allocation.changeSats }));
        return allocation;
      } catch (error) {
        log("selection.failed", () => ({ attempt, code: codeOf(error), error }));
        throw error;
      }
    };
    const allocation = await select(1).catch(async error => {
      const code = codeOf(error);
      if (code !== "no-utxos" && code !== "insufficient") throw error;
      check();
      log("refresh.start", () => ({ selectionCode: code }));
      try {
        const funds = await deps.refreshFundingInputs();
        log("refresh.success", () => ({ funds }));
      } catch (refreshError) {
        log("refresh.failed", () => ({ error: refreshError }));
        throw new Error("Could not refresh wallet funding inputs", { cause: refreshError });
      }
      check();
      return select(2);
    });
    try {
      check();
      const selected = allocation.selectedInputs.map(row => ({txid: row.utxo.txid, vout: row.utxo.vout, value: row.utxo.value, address: row.utxo.address}));
      const txOutputs = [...outputs, ...(BigInt(allocation.changeSats) > 0n ? [{scriptHex: walletScriptHex, value: allocation.changeSats}] : [])];
      // Final input sequences make locktime inert. Vary the bytes of a new
      // opening so it cannot reuse the outpoint of a cancelled opening plan.
      const unsignedTxHex = input.distinctTransaction
        ? buildUnsigned({ inputs: selected.map(input => ({ ...input, sequence: 0xffffffff })),
          outputs: txOutputs, locktime: Number.parseInt(submissionId.slice(0, 8), 16) })
        : buildUnsigned({ inputs: selected, outputs: txOutputs });
      deps.submissions.prepare({...input, submissionId, allocationId: allocation.allocationId, unsignedTxHex, inputs: selected,
        outputs: outputs.map(row => ({scriptHex: row.scriptHex, value: Number(row.value)})), feeSatoshis: Number(allocation.feeSats),
        changeSatoshis: Number(allocation.changeSats), ...(BigInt(allocation.changeSats) > 0n ? {changeAddress: address} : {})});
      log("plan.prepared", () => ({ allocationId: allocation.allocationId, inputCount: selected.length }));
      return {allocationId: allocation.allocationId, submissionId, selected, totalInputSatoshis: Number(allocation.totalInSats),
        businessSats: allocation.businessSats, feeSats: allocation.feeSats, changeSats: allocation.changeSats, unsignedTxHex};
    } catch (error) {
      log("plan.failed", () => ({ allocationId: allocation.allocationId, error }));
      await deps.manager.release({...input, allocationId: allocation.allocationId});
      throw error;
    }
  };
  // Cancel the original funding intention, never reconstruct wallet occupancy
  // from BitFS history. Pre-broadcast signing errors cancel and release;
  // dispatch uncertainty never authorizes release.
  const releaseFundingPlan = async (input: {allocationId: string; submissionId: string}): Promise<boolean> => {
    check();
    const scope = {ownerPublicKeyHex: deps.owner, network: deps.network, submissionId: input.submissionId};
    const current = deps.submissions.read(scope);
    if (current.plan.allocationId !== input.allocationId) throw new Error("Funding cancellation does not match its original allocation");
    if (current.state === "signed" || (current.state === "rejected" && current.txid)) {
      if (!current.txid) throw new Error("Signed funding intention has no exact txid");
      await executor.releasePreparedSubmission({...scope, txid: current.txid});
      return true;
    }
    if (!["prepared", "signing", "cancelled", "rejected"].includes(current.state)) return false;
    deps.submissions.cancelUndispatched(scope);
    await deps.manager.release({...scope, allocationId: input.allocationId});
    return true;
  };
  check();
  return Object.freeze({ identity: Object.freeze({ publicKeyHex: deps.owner, bsvNetwork: deps.network }), spend, executor, releaseFundingPlan,
    planFundingCommand: planFunding,
    planFunding: (input: import("@keymaster/contracts").ProtocolFundingPlanRequest) => planFunding(scoped(input)), observer: { observeProtocolSubmission: (input: { txid: string; submissionId: string }) => observeProtocolSubmission(scoped(input)) }, protectedOutpoints: registry, protectionView,
    dispose() { for (const id of registry._ids()) registry.unregister(id); },
  });
}
