// Ordinary transfers own their original plan; the manager owns input allocation.
// Internal DTOs are trusted. Manager owns spendability; single-use previews,
// original exact, cancellation and broadcast responsibility belong to this caller.
import type { CentralBroadcastService, CoordinatorP2pkhBroadcastResult, CoordinatorValueResult, P2pkhBroadcastSubmission, VaultService } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type { P2pkhLocalTransaction, P2pkhTransferInput, P2pkhTransferPreview, P2pkhTransferResult, ReadyKeyIdentity } from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { buildUnsigned, estimateFeeSats, estimateSignedSize } from "keymaster-utxo-manager";
import { buildPaymentTemplate, p2pkScriptFromPublicKey, publisherMatchesPaymentScript } from "./p2pkhPaymentTemplate.js";
import type { P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import { calcTxidFromRawTxHex, rawTxHexByteLength, signP2pkhTx } from "./p2pkhSigner.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import { unsignedFromExact, type P2pkhSubmissionRuntime } from "./p2pkhSubmissionRuntime.js";

export interface P2pkhTransferServiceDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto">;
  messageBus: MessageBus;
  getStore: (publicKeyHex: string) => Promise<P2pkhStateRepositoryHandle>;
  centralBroadcastService?: CentralBroadcastService;
  broadcastWithCoordinator?: (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: P2pkhBroadcastSubmission }) => Promise<CoordinatorValueResult<unknown>>;
  utxoManager?: P2pkhUtxoManager;
  submissions?: P2pkhSubmissionRuntime;
  /** These host accessors reject revoked/unready wallet sessions. */
  getActiveKey: () => ReadyKeyIdentity;
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<ReadyKeyIdentity>;
}
export interface P2pkhTransferService {
  prepare(input: P2pkhTransferInput, context?: { retry?: boolean; signal?: AbortSignal }): Promise<P2pkhTransferPreview>;
  submit(preview: P2pkhTransferPreview, options?: { signal?: AbortSignal }): Promise<P2pkhTransferResult>;
  /** Submit the Worker's remembered allocation; never rebuild from caller metadata. */
  submitPrepared(previewId: string, options?: { signal?: AbortSignal }): Promise<P2pkhTransferResult>;
}
export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  const prepared = new Map<string, { preview: P2pkhTransferPreview; expires: number; timer?: ReturnType<typeof setTimeout> }>();
  const releaseReservation = (preview: P2pkhTransferPreview): void => {
    if (!preview.managerAllocationId || !deps.utxoManager || !deps.submissions) return;
    const scope = {ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network};
    try {
      const plan = deps.submissions.preparedForAllocation({...scope, allocationId: preview.managerAllocationId});
      if (deps.submissions.cancelUnsigned({...scope, submissionId: plan.submissionId})) void deps.utxoManager.release({...scope, allocationId: preview.managerAllocationId}).catch(() => undefined);
    } catch { /* Already signing, consumed or revoked: never release by expiry. */ }
  };
  function remember(preview: P2pkhTransferPreview): P2pkhTransferPreview {
    const now = Date.now();
    for (const [id, entry] of prepared) {
      if (entry.expires > now) continue;
      if (entry.timer) clearTimeout(entry.timer);
      prepared.delete(id); releaseReservation(entry.preview);
    }
    if (prepared.size >= 32) throw new Error("Too many pending transfer previews");
    const entry: { preview: P2pkhTransferPreview; expires: number; timer?: ReturnType<typeof setTimeout> } = { preview: structuredClone(preview), expires: now + 120000 };
    entry.timer = setTimeout(() => {
      if (prepared.get(preview.previewId) !== entry) return;
      prepared.delete(preview.previewId); releaseReservation(entry.preview);
    }, 120000);
    (entry.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    prepared.set(preview.previewId, entry);
    return preview;
  }
  function recall(previewId: string, consume = false): P2pkhTransferPreview {
    const entry = prepared.get(previewId);
    if (!entry || entry.expires <= Date.now()) {
      prepared.delete(previewId);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) releaseReservation(entry.preview);
      throw new Error("Transfer preview expired or already submitted");
    }
    if (consume) { if (entry.timer) clearTimeout(entry.timer); prepared.delete(previewId); }
    return structuredClone(entry.preview);
  }
  return {
    async prepare(input, context) {
      const manager = deps.utxoManager;
      if (!manager || !deps.submissions) throw new Error("Transfer requires the allocation pool and transaction runtime");
      const network = assetIdToNetwork(input.assetId);
      const owner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
      const stateRepository = await deps.getStore(owner.publicKeyHex);
      const activeCrypto = await deps.vault.createActiveKeyCrypto();
      const resource = await stateRepository.getResource(makeResourceId(network));
      if (!resource) throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
      const payment = input.payment;
      const sendAll = input.sendAll === true;
      if (payment && sendAll) throw new Error("Connect payment cannot use sendAll");
      const recipientScriptHex = payment
        ? payment.recipient.type === "p2pkh" ? p2pkhAddressToScriptHex(payment.recipient.address, network) : p2pkScriptFromPublicKey(payment.recipient.publicKeyHex)
        : undefined;
      const recipientOwnership = payment && recipientScriptHex
        ? publisherMatchesPaymentScript(recipientScriptHex, payment.publisherPublicKeyHex) ? "app-publisher" as const : "third-party" as const
        : "unknown" as const;
      const { address: changeAddress } = await activeCrypto.deriveP2pkhAddress();
      const businessScriptHex = recipientScriptHex ?? p2pkhAddressToScriptHex(input.recipientAddress!, network);
      const submissionId = crypto.randomUUID();
      const requested = sendAll
        ? {kind: "all", allocation: await manager.requestAll({ownerPublicKeyHex: owner.publicKeyHex, resource})} as const
        : {kind: "amount", allocation: await manager.request({ownerPublicKeyHex: owner.publicKeyHex, resource,
          amountSats: String(input.amountSatoshis), feeRateSatPerKb: String(input.feeRateSatoshisPerKb!),
          outputScriptLengths: [businessScriptHex.length / 2]})} as const;
      const funding = requested.allocation;
      // Every error after freezing, including fee calculation and construction,
      // must release this request's ID while the transaction is still unsigned.
      try {
        const selected = funding.selectedInputs.map(row => row.utxo);
        const feeSats = requested.kind === "all"
          ? estimateFeeSats(BigInt(input.feeRateSatoshisPerKb!), estimateSignedSize(selected.length, [businessScriptHex.length / 2]))
          : BigInt(requested.allocation.feeSats);
        const businessSats = requested.kind === "all" ? BigInt(funding.totalInSats) - feeSats : BigInt(requested.allocation.businessSats);
        if (requested.kind === "all" && businessSats <= 0n) throw new Error("Insufficient balance");
        const changeSats = requested.kind === "all" ? 0n : BigInt(requested.allocation.changeSats);
        const changeScriptHex = changeSats > 0n ? p2pkhAddressToScriptHex(changeAddress, network) : null;
        const outputs = buildPaymentTemplate({paymentType: payment?.paymentType ?? "p2pkh", businessAmountSats: String(businessSats),
          businessScriptHex, changeAmountSats: String(changeSats), changeScriptHex});
        const unsignedTxHex = buildUnsigned({inputs: selected.map(row => ({txid: row.txid, vout: row.vout})),
          outputs: outputs.map(row => ({scriptHex: row.scriptHex, value: row.valueSats}))});
        const reservation = {...funding, businessSats: String(businessSats), feeSats: String(feeSats), changeSats: String(changeSats),
          unsignedTxHex, outputs, businessScriptHex, changeScriptHex, planDigest: JSON.stringify(outputs)};
        const business = Number(businessSats), fee = Number(feeSats), change = Number(changeSats);
        deps.submissions.prepare({ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, allocationId: reservation.allocationId,
          paymentId: payment?.paymentId, unsignedTxHex, inputs: selected, outputs: [{value: business, scriptHex: businessScriptHex}],
          feeSatoshis: fee, feeRateSatoshisPerKb: input.feeRateSatoshisPerKb!, changeSatoshis: change, ...(change > 0 ? {changeAddress} : {})});
        const allocation = { requestedSatoshis: business, feeReserveSatoshis: fee, selected, totalInputSatoshis: Number(reservation.totalInSats), changeSatoshis: change };
        const paymentPreview = payment ? {
          paymentId: payment.paymentId, clientRequestId: payment.clientRequestId, planDigest: reservation.planDigest!,
          paymentType: payment.paymentType, businessKind: payment.businessKind, appId: payment.appId, appName: payment.appName,
          origin: payment.origin, publisherPublicKeyHex: payment.publisherPublicKeyHex, recipientOwnership,
          recipientLabel: payment.recipient.type === "p2pkh" ? payment.recipient.address : payment.recipient.publicKeyHex,
          businessScriptHex: reservation.businessScriptHex, businessAmountSats: reservation.businessSats, changeAmountSats: reservation.changeSats,
          feeSats: reservation.feeSats, changeScriptHex: reservation.changeScriptHex, outputs: reservation.outputs,
        } satisfies import("@keymaster/contracts").P2pkhConnectPaymentPreview : undefined;
        return remember({
          ...(input.paymentContext ? { paymentContext: { ...input.paymentContext } } : {}),
          assetId: input.assetId, network, ownerPublicKeyHex: owner.publicKeyHex,
          recipientAddress: payment ? payment.recipient.type === "p2pkh" ? payment.recipient.address : "" : input.recipientAddress!,
          ...(paymentPreview ? { payment: paymentPreview } : {}), amountSatoshis: business, feeRateSatoshisPerKb: input.feeRateSatoshisPerKb!,
          allocation, changeAddress,
          outputs: payment ? reservation.outputs.map(row => ({ scriptHex: row.scriptHex, value: Number(row.valueSats), role: row.role,
            ...(row.role === "change" ? { address: changeAddress } : payment.recipient.type === "p2pkh" ? { address: payment.recipient.address } : {}),
          })) : [{ address: input.recipientAddress!, value: business }, ...(change > 0 ? [{ address: changeAddress, value: change }] : [])],
          estimatedFeeSatoshis: fee, serializedSizeBytes: rawTxHexByteLength(reservation.unsignedTxHex) + selected.length * 108,
          txid: "", rawTxHex: reservation.unsignedTxHex, managerAllocationId: reservation.allocationId, previewId: crypto.randomUUID(), sendAll,
        });
      } catch (error) {
        const scope = {ownerPublicKeyHex: owner.publicKeyHex, network, submissionId};
        if (deps.submissions.find(scope)) deps.submissions.cancelUnsigned(scope);
        await manager.release({...scope, allocationId: funding.allocationId});
        throw error;
      }
    },
    async submitPrepared(previewId, options) { return this.submit(recall(previewId), options); },
    async submit(preview, options) {
      // Recall before any async work. Caller display metadata is not a second
      // transaction source and never replaces the original business plan.
      const remembered = recall(preview.previewId);
      const manager = deps.utxoManager;
      if (!manager || !remembered.managerAllocationId) throw new Error("Transfer submission requires a manager allocation");
      const transactions = deps.submissions;
      if (!transactions) throw new Error("Transaction runtime unavailable");
      const scope = {ownerPublicKeyHex: remembered.ownerPublicKeyHex, network: remembered.network};
      const plan = transactions.preparedForAllocation({...scope, allocationId: remembered.managerAllocationId});
      let dispatchAttempted = false;
      try {
        if (options?.signal?.aborted) {
          recall(remembered.previewId, true);
          transactions.cancelUndispatched({...scope, submissionId: plan.submissionId});
          await manager.release({...scope, allocationId: remembered.managerAllocationId});
          return { status: "not-dispatched", txid: remembered.txid, rawTxHex: remembered.rawTxHex, error: "broadcast retry cancelled", submissionId: "", localInputClaimIds: [], attempts: 0, reason: "cancelled" };
        }
        const owner = await resolveOwnerKeyIdentity(deps, remembered.ownerPublicKeyHex);
        const stateRepository = await deps.getStore(owner.publicKeyHex);
        const network = remembered.network;
        const resource = await stateRepository.getResource(makeResourceId(network));
        if (!resource) throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
        if (!deps.centralBroadcastService && !deps.broadcastWithCoordinator) throw new Error("Coordinator broadcast is required for ordinary P2PKH transfers");
        await manager.assertAllocationUsable({...scope, allocationId: remembered.managerAllocationId});
        const activeCrypto = await deps.vault.createActiveKeyCrypto();
        const { address: currentChangeAddress } = await activeCrypto.deriveP2pkhAddress();
        // This checks a real asynchronous wallet replacement, not an internal
        // DTO's shape. A late task must not sign with a newly active wallet.
        if (currentChangeAddress !== remembered.changeAddress) throw new Error("Transfer owner session changed");
        const frozen = recall(remembered.previewId, true);
        const selected = plan.inputs;
        // Manager already supplies trusted prevout parameters; signing needs no parent bytes.
        if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
        transactions.beginSigning({...scope, submissionId: plan.submissionId});
        const rawTxHex = await signP2pkhTx(unsignedFromExact(plan.unsignedTxHex), selected, async digest => {
          const result = await activeCrypto.signDigest({ digest: new Uint8Array(digest).buffer as ArrayBuffer, format: "der" });
          return new Uint8Array(result.signature);
        }, owner.publicKeyHex);
        transactions.signed({...scope, submissionId: plan.submissionId, rawTxHex});
        const signedSize = rawTxHexByteLength(rawTxHex);
        if (signedSize > frozen.serializedSizeBytes) throw new Error("P2PKH signature exceeded fee size bound");
        const signed = { ...frozen, rawTxHex, txid: calcTxidFromRawTxHex(rawTxHex), serializedSizeBytes: signedSize };
        const submissionId = plan.submissionId, now = new Date().toISOString();
        const localSubmission: P2pkhLocalTransaction = {
          id: submissionId, resourceId: resource.resourceId, publicKeyHex: owner.publicKeyHex, network, txid: signed.txid,
          rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: selected.map(row => `${row.txid}:${row.vout}`),
          ownOutputs: signed.outputs.flatMap((output, vout) => {
            const scriptHex = output.role === "change" ? output.scriptHex : output.address === signed.changeAddress ? p2pkhAddressToScriptHex(output.address, network) : undefined;
            return scriptHex ? [{ vout, value: output.value, scriptHex }] : [];
          }), createdAt: now, updatedAt: now, attempts: [],
        };
        // Audit only: no independent input claims, selection or timeout unlock.
        await stateRepository.prepareLocalSubmission({ submission: localSubmission });
        let result: CoordinatorP2pkhBroadcastResult;
        try {
          const submission = { resourceId: resource.resourceId, txid: signed.txid, rawTxHex, managerAllocationId: frozen.managerAllocationId,
            ...(frozen.utxoBinding === undefined ? {} : { utxoBinding: frozen.utxoBinding }),
          };
          dispatchAttempted = true;
          if (deps.centralBroadcastService) {
            result = await deps.centralBroadcastService.submitOnce({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, ...submission });
          } else {
            const response = await deps.broadcastWithCoordinator!({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, submission });
            if (response.status === "ok") result = response.value as CoordinatorP2pkhBroadcastResult;
            else if (response.status === "transport-error" && response.dispatchStatus !== "not-dispatched") result = { status: "isolated", txid: signed.txid, reason: response.message };
            else result = { status: "not-dispatched", reason: "coordinator-not-dispatched" };
          }
          if (result.status === "not-dispatched") {
            try {await stateRepository.abortUnattemptedLocalSubmission?.({ submissionId, reason: result.reason });}
            catch (error) {console.warn("Undispatched transfer audit failed", error);}
          }
        } catch (error) {
          result = { status: "isolated", txid: signed.txid, reason: error instanceof Error ? error.message : String(error) };
        }
        const state = transactions.read({...scope, submissionId}).state;
        if (state !== "accepted" && state !== "already-known" && state !== "rejected") {
          const rejected = result.status === "not-dispatched" || (result.status === "isolated" && result.providerCode === "woc-tx-rejected");
          transactions.outcome({...scope, submissionId, state: rejected ? "rejected" : result.status === "isolated" ? "unknown" : result.status === "already-known" ? "already-known" : "accepted"});
        }
        // The central path may already have recorded rejection. Release is
        // idempotent; do not skip cleanup merely because the outcome is recorded.
        if (transactions.read({...scope, submissionId}).state === "rejected") {
          await manager.release({...scope, allocationId: frozen.managerAllocationId!});
        }
        return mapTransferResult(result, signed, submissionId);
      } catch (error) {
        try {
          const state = transactions.read({...scope, submissionId: plan.submissionId}).state;
          if (state === "prepared" || (!dispatchAttempted && (state === "signing" || state === "signed")) || state === "cancelled" || state === "rejected") {
            // Seal first so late signer results cannot be dispatched. Only an
            // uncertain broadcast keeps its allocation frozen.
            transactions.cancelUndispatched({...scope, submissionId: plan.submissionId});
            const entry = prepared.get(remembered.previewId);
            if (entry?.timer) clearTimeout(entry.timer);
            prepared.delete(remembered.previewId);
            await manager.release({...scope, allocationId: remembered.managerAllocationId});
          }
        } catch (cleanupError) { console.warn("Transfer cancellation cleanup failed", cleanupError); }
        throw error;
      }
    },
  };
}
function mapTransferResult(result: CoordinatorP2pkhBroadcastResult, preview: P2pkhTransferPreview, submissionId: string): P2pkhTransferResult {
  const common = { rawTxHex: preview.rawTxHex, submissionId, localInputClaimIds: [], attempts: 1 };
  if (result.status === "isolated") return { ...common, status: "isolated", txid: result.txid, error: result.reason, reason: result.providerCode === "woc-tx-rejected" ? "transaction-rejected" : "isolated" };
  if (result.status === "not-dispatched") return { ...common, status: "not-dispatched", txid: preview.txid, error: result.reason,
    reason: result.reason === "cancelled" ? "cancelled" : result.reason === "snapshot-binding-required" || result.reason === "snapshot-input-invalid" ? "snapshot-binding" : undefined };
  return { ...common, status: "local-confirmed", delivery: result.status === "already-known" ? "already-known" : "accepted", txid: preview.txid };
}
/** Preserve the original task's wallet ownership, never switch an old task to a new key. */
async function resolveOwnerKeyIdentity(deps: P2pkhTransferServiceDeps, ownerPublicKeyHex: string): Promise<ReadyKeyIdentity> {
  const active = deps.getActiveKey();
  if (active.publicKeyHex === ownerPublicKeyHex) return active;
  const key = await deps.getKeyForOwner(ownerPublicKeyHex);
  if (!key || !key.publicKeyHex) throw new Error(`P2PKH transfer: owner ${ownerPublicKeyHex} is not ready (no publicKeyHex)`);
  if (key.publicKeyHex !== ownerPublicKeyHex) throw new Error(`P2PKH transfer: resolved key publicKeyHex ${key.publicKeyHex} != requested owner ${ownerPublicKeyHex}`);
  return key;
}
