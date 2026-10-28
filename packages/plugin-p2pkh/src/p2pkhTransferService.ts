// Ordinary transfers use the manager's allocation and unsigned exact directly.
// Internal DTOs are trusted; spendability, single-use previews, durable intent,
// cancellation, fee size and unknown broadcast responsibility remain business state.
import type { CentralBroadcastService, CoordinatorP2pkhBroadcastResult, CoordinatorValueResult, P2pkhBroadcastSubmission, P2pkhUtxoBinding, VaultService } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type { P2pkhKeyResource, P2pkhLocalTransaction, P2pkhTransferInput, P2pkhTransferPreview, P2pkhTransferResult, P2pkhUtxo, ReadyKeyIdentity } from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { parseTx, p2pkScriptFromPublicKey, publisherMatchesPaymentScript } from "@keymaster/utxo-manager";
import type { P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import { calcTxidFromRawTxHex, type UnsignedTx, rawTxHexByteLength, signP2pkhTx } from "./p2pkhSigner.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhManagerInputEvidence, P2pkhUtxoManager } from "./p2pkhUtxoManager.js";

export interface P2pkhTransferServiceDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto">;
  previousTransactions(network: "main" | "test", inputs: readonly P2pkhUtxo[]): Promise<string[]>;
  /** Chain observation, not a repeated check of an internal preview. */
  assertInputsUnspent?(network: "main" | "test", inputs: readonly Pick<P2pkhUtxo, "txid" | "vout">[]): Promise<void>;
  messageBus: MessageBus;
  getStore: (publicKeyHex: string) => Promise<P2pkhStateRepositoryHandle>;
  loadSpendableUtxos: (input: {
    ownerPublicKeyHex: string; resource: P2pkhKeyResource; purpose?: "prepare" | "submit" | "retry"; signal?: AbortSignal;
  }) => Promise<P2pkhUtxo[] | { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding }>;
  centralBroadcastService?: CentralBroadcastService;
  broadcastWithCoordinator?: (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: P2pkhBroadcastSubmission }) => Promise<CoordinatorValueResult<unknown>>;
  utxoManager?: P2pkhUtxoManager;
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
function loadedUtxos(value: P2pkhUtxo[] | { utxos: P2pkhUtxo[] }): P2pkhUtxo[] {
  return Array.isArray(value) ? value : value.utxos;
}

export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  const prepared = new Map<string, { preview: P2pkhTransferPreview; expires: number; timer?: ReturnType<typeof setTimeout> }>();
  const releaseReservation = (preview: P2pkhTransferPreview): void => {
    if (!preview.managerAllocationId || !deps.utxoManager) return;
    void deps.utxoManager.release({ ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, allocationId: preview.managerAllocationId }).catch(() => undefined);
  };
  function remember(preview: P2pkhTransferPreview): P2pkhTransferPreview {
    const now = Date.now();
    for (const [id, entry] of prepared) {
      if (entry.expires > now) continue;
      if (entry.timer) clearTimeout(entry.timer);
      prepared.delete(id); releaseReservation(entry.preview);
    }
    if (prepared.size >= 32) { releaseReservation(preview); throw new Error("Too many pending transfer previews"); }
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
      if (!manager) throw new Error("Transfer requires the durable UTXO manager");
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
      const candidates = loadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: context?.retry ? "retry" : "prepare", signal: context?.signal }));
      const { address: changeAddress } = await activeCrypto.deriveP2pkhAddress();
      const reservation = await manager.reserve({
        ownerPublicKeyHex: owner.publicKeyHex, resource, utxos: candidates,
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb!,
        ...(payment ? { recipientScriptHex, paymentType: payment.paymentType, paymentId: payment.paymentId } : { recipientAddress: input.recipientAddress }),
        amountSatoshis: sendAll ? 0 : input.amountSatoshis, sendAll,
      });
      try {
        const selected = reservation.selectedInputs.map(row => row.utxo);
        const business = Number(reservation.businessSats), fee = Number(reservation.feeSats), change = Number(reservation.changeSats);
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
        await manager.release({ ownerPublicKeyHex: owner.publicKeyHex, network, allocationId: reservation.allocationId }).catch(() => undefined);
        throw error;
      }
    },
    async submitPrepared(previewId, options) { return this.submit(recall(previewId), options); },
    async submit(preview, options) {
      // Recall before any async work. Caller display metadata is not a second
      // transaction source and never replaces the manager's frozen bytes.
      const remembered = recall(preview.previewId);
      const manager = deps.utxoManager;
      if (!manager || !remembered.managerAllocationId) throw new Error("Transfer submission requires a manager allocation");
      if (options?.signal?.aborted) return { status: "not-dispatched", txid: remembered.txid, rawTxHex: remembered.rawTxHex, error: "broadcast retry cancelled", submissionId: "", localInputClaimIds: [], attempts: 0, reason: "cancelled" };
      const owner = await resolveOwnerKeyIdentity(deps, remembered.ownerPublicKeyHex);
      const stateRepository = await deps.getStore(owner.publicKeyHex);
      const network = remembered.network;
      const resource = await stateRepository.getResource(makeResourceId(network));
      if (!resource) throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
      if (!deps.centralBroadcastService && !deps.broadcastWithCoordinator) throw new Error("Coordinator broadcast is required for ordinary P2PKH transfers");
      const candidates = loadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: "submit", signal: options?.signal }));
      const managerInputs = await manager.refreshAllocationInputs({ ownerPublicKeyHex: owner.publicKeyHex, resource, allocationId: remembered.managerAllocationId, utxos: candidates });
      const activeCrypto = await deps.vault.createActiveKeyCrypto();
      const { address: currentChangeAddress } = await activeCrypto.deriveP2pkhAddress();
      // This checks a real asynchronous wallet replacement, not an internal
      // DTO's shape. A late task must not sign with a newly active wallet.
      if (currentChangeAddress !== remembered.changeAddress) throw new Error("Transfer owner session changed");
      const frozen = recall(remembered.previewId, true);
      const selected = managerInputs.map(row => row.utxo);
      let durableIntent = false;
      try {
        await deps.assertInputsUnspent?.(network, selected);
        await loadPreviousTransactions(network, selected, managerInputs, deps.previousTransactions);
        if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
        await manager.prepareSigning({ ownerPublicKeyHex: owner.publicKeyHex, resource, allocationId: frozen.managerAllocationId!, unsignedTxHex: frozen.rawTxHex });
        durableIntent = true;
      } catch (error) {
        if (!durableIntent) await manager.release({ ownerPublicKeyHex: owner.publicKeyHex, network, allocationId: frozen.managerAllocationId! }).catch(() => undefined);
        throw error;
      }
      if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
      const rawTxHex = await signP2pkhTx(unsignedFromExact(frozen.rawTxHex), selected, async digest => {
        const result = await activeCrypto.signDigest({ digest: new Uint8Array(digest).buffer as ArrayBuffer, format: "der" });
        return new Uint8Array(result.signature);
      }, owner.publicKeyHex);
      const signedSize = rawTxHexByteLength(rawTxHex);
      if (signedSize > frozen.serializedSizeBytes) throw new Error("P2PKH signature exceeded fee size bound");
      const signed = { ...frozen, rawTxHex, txid: calcTxidFromRawTxHex(rawTxHex), serializedSizeBytes: signedSize };
      const submissionId = crypto.randomUUID(), now = new Date().toISOString();
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
        if (deps.centralBroadcastService) {
          result = await deps.centralBroadcastService.submitOnce({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, ...submission });
        } else {
          const response = await deps.broadcastWithCoordinator!({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, submission });
          if (response.status === "ok") result = response.value as CoordinatorP2pkhBroadcastResult;
          else if (response.status === "transport-error" && response.dispatchStatus !== "not-dispatched") result = { status: "isolated", txid: signed.txid, reason: response.message };
          else result = { status: "not-dispatched", reason: "coordinator-not-dispatched" };
        }
        if (result.status === "not-dispatched") await stateRepository.abortUnattemptedLocalSubmission?.({ submissionId, reason: result.reason });
      } catch (error) {
        result = { status: "isolated", txid: signed.txid, reason: error instanceof Error ? error.message : String(error) };
      }
      return mapTransferResult(result, signed, submissionId);
    },
  };
}
function mapTransferResult(result: CoordinatorP2pkhBroadcastResult, preview: P2pkhTransferPreview, submissionId: string): P2pkhTransferResult {
  const common = { rawTxHex: preview.rawTxHex, submissionId, localInputClaimIds: [], attempts: 1 };
  if (result.status === "isolated") return { ...common, status: "isolated", txid: result.txid, error: result.reason, reason: "isolated" };
  if (result.status === "not-dispatched") return { ...common, status: "not-dispatched", txid: preview.txid, error: result.reason,
    reason: result.reason === "cancelled" ? "cancelled" : result.reason === "snapshot-binding-required" || result.reason === "snapshot-input-invalid" ? "snapshot-binding" : undefined };
  return { ...common, status: "local-confirmed", delivery: result.status === "already-known" ? "already-known" : "accepted", txid: preview.txid };
}
/** Decode the manager exact for the existing signer; do not rebuild business outputs. */
function unsignedFromExact(rawTxHex: string): UnsignedTx {
  const parsed = parseTx(rawTxHex);
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
  return {
    version: parsed.version, lockTime: parsed.locktime,
    inputs: parsed.inputs.map(row => ({ prevTxid: row.txid, prevVout: row.vout, scriptSig: bytes(row.scriptSigHex), sequence: row.sequence })),
    outputs: parsed.outputs.map(row => ({ value: Number(row.value), script: bytes(row.scriptHex) })),
  };
}
async function loadPreviousTransactions(network: "main" | "test", selected: readonly P2pkhUtxo[], evidence: readonly P2pkhManagerInputEvidence[], fetch: P2pkhTransferServiceDeps["previousTransactions"]): Promise<string[]> {
  const byOutpoint = new Map(evidence.map(row => [`${row.utxo.txid.toLowerCase()}:${row.utxo.vout}`, row]));
  const missing = selected.filter(row => !byOutpoint.get(`${row.txid.toLowerCase()}:${row.vout}`)?.previousTransactionHex);
  const fetched = missing.length > 0 ? await fetch(network, missing) : [];
  if (fetched.length !== missing.length) throw new Error("Previous transaction evidence count does not match Manager inputs");
  let fetchedIndex = 0;
  return selected.map(row => byOutpoint.get(`${row.txid.toLowerCase()}:${row.vout}`)?.previousTransactionHex ?? fetched[fetchedIndex++]!);
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
