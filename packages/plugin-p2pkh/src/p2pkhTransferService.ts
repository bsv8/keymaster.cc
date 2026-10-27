// packages/plugin-p2pkh/src/p2pkhTransferService.ts
// P2PKH 转移业务服务：prepare 仅冻结未签名交易；submit 重查 UTXO 后才申请钱包许可。
// 预览内存票据与返回 DTO 精确绑定；页面不能改收款/金额/渠道后沿用旧批准。
// 估费使用 DER/P2PKH 长度上界，预览不会产生可广播签名或占用消费额度。
// 确定未派发的重试继续完整重选输入，未知广播与已签消费不撤销预算。
//
// 硬切换 002 收尾：所有签名 / 选币 / owner 真值走 `publicKeyHex`；

import type { CentralBroadcastService, CoordinatorP2pkhBroadcastResult, CoordinatorValueResult, P2pkhBroadcastSubmission, P2pkhUtxoBinding, VaultService } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type {
  P2pkhAssetId,
  P2pkhKeyResource,
  P2pkhLocalTransaction,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { classifyPaymentScript, p2pkScriptFromPublicKey, publisherMatchesPaymentScript } from "@keymaster/utxo-manager";
import { type P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import {
  buildP2pkhTx,
  calcTxidFromRawTxHex,
  type UnsignedTx,
  rawTxHexByteLength,
  serializeTx, signP2pkhTx
} from "./p2pkhSigner.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";
import { parseP2pkhTransaction, p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhManagerInputEvidence, P2pkhUtxoManager } from "./p2pkhUtxoManager.js";

export interface P2pkhTransferServiceDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto">;
  previousTransactions(network: "main" | "test", inputs: readonly P2pkhUtxo[]): Promise<string[]>;
  /** A transaction-specific spent-output check; unlike snapshot sequence membership it does not require WoC to index local change. */
  assertInputsUnspent?(network: "main" | "test", inputs: readonly Pick<P2pkhUtxo, "txid" | "vout">[]): Promise<void>;
  messageBus: MessageBus;
  /** 资产数据变更通知器：转账成功后立即通知页面重读。 */
  /**
   * 硬切换 002 收尾 + 多 owner 支持：按 `publicKeyHex` 返回该 owner
   * 的 P2PKH namespace K-V。transfer 内部所有读 K-V 的入口（prepare
   * 选币 / submit 取 resource / submission 写入）都传
   * `input.ownerPublicKeyHex` 或 `preview.ownerPublicKeyHex`——
   * 严格按调用方指定的 owner 走 namespace，不再从 active key 推导。
   */
  getStore: (publicKeyHex: string) => Promise<P2pkhStateRepositoryHandle>;
  /**
   * 可花 UTXO 加载入口（由 service 实现）。Manager 路径将 WoC 快照作为外部输入事实；本地输出由 Manager durable state + exact parent bytes 提供，不要求 WoC membership/seq。旧协议路径仍使用快照绑定。
   */
  loadSpendableUtxos: (input: {
    ownerPublicKeyHex: string;
    resource: P2pkhKeyResource;
    /** submit/retry 阶段允许把 consumed 视为“等待新序号”，而不是余额为 0。 */
    purpose?: "prepare" | "submit" | "retry";
    signal?: AbortSignal;
  }) => Promise<P2pkhUtxo[] | { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding }>;
  /** 取得刚刚用于选币的快照绑定；生产实现必须返回序号。 */
  getUtxoBinding?: (input: { ownerPublicKeyHex: string; resource: P2pkhKeyResource }) => Promise<P2pkhUtxoBinding | undefined>;
  /** 页面侧唯一中心广播入口；生产 manifest 注入，旧测试可用下方兼容函数。 */
  centralBroadcastService?: CentralBroadcastService;
  /**
   * Production ordinary transfers use the Coordinator-selected broadcaster.
   *
   * `submission` 必带给页面外的 Worker：页面本地提交是内存态，Worker 读不到，
   * 广播前必须由 Worker 自己先做 write-ahead 审计记录。
   */
  broadcastWithCoordinator?: (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: P2pkhBroadcastSubmission }) => Promise<CoordinatorValueResult<unknown>>;
  /** Durable Worker-owned allocator; production transfers must use this path. */
  utxoManager?: P2pkhUtxoManager;
  /**
   * 当前 active key。p2pkhService.rebindActiveKey 内部用 requireReadyKey
   * 收窄；这里直接拿到的就是 ReadyKeyIdentity（publicKeyHex 必填）。
   */
  getActiveKey: () => ReadyKeyIdentity;
  /**
   * 按 owner public key hex 解析 ReadyKeyIdentity（硬切换 002 收尾）。
   * 解析失败时抛 `Error`，调用方（plugin-protocol）已经校验过 owner
   * key ready 才进入 transfer 流程。
   */
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<ReadyKeyIdentity>;
}

export interface P2pkhTransferService {
  prepare(input: P2pkhTransferInput, context?: { retry?: boolean; signal?: AbortSignal }): Promise<P2pkhTransferPreview>;
  submit(preview: P2pkhTransferPreview, options?: { signal?: AbortSignal }): Promise<P2pkhTransferResult>;
  /**
   * 按预览 ID 提交 Worker 自己记住的那份预览。
   *
   * 中文说明：跨 Runtime 路径（Window → Coordinator → Worker）只传 previewId：
   * 选币、金额、找零与 manager allocation 全部以 Worker 的记录为准，页面无法
   * 改写。预览不存在或已过期即拒绝，不做任何重建。
   */
  submitPrepared(previewId: string, options?: { signal?: AbortSignal }): Promise<P2pkhTransferResult>;
}

function normalizeLoadedUtxos(value: P2pkhUtxo[] | { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding }): { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding } {
  return Array.isArray(value) ? { utxos: value } : value;
}

export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  const prepared = new Map<string, {preview: P2pkhTransferPreview; expires: number; timer?: ReturnType<typeof setTimeout>}>();
  const releaseReservation = (preview: P2pkhTransferPreview): void => {
    if (!preview.managerAllocationId || !deps.utxoManager) return;
    void deps.utxoManager.release({ ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, allocationId: preview.managerAllocationId }).catch(() => undefined);
  };
  const remember = (preview: P2pkhTransferPreview): P2pkhTransferPreview => {
    const now = Date.now();
    for (const [id, value] of prepared) {
      if (value.expires <= now) { if (value.timer) clearTimeout(value.timer); prepared.delete(id); releaseReservation(value.preview); }
    }
    if (prepared.size >= 32) { releaseReservation(preview); throw new Error("Too many pending transfer previews"); }
    const entry = { preview: structuredClone(preview), expires: now + 120000 } as {preview: P2pkhTransferPreview; expires: number; timer?: ReturnType<typeof setTimeout>};
    entry.timer = setTimeout(() => {
      if (prepared.get(preview.previewId) !== entry) return;
      prepared.delete(preview.previewId);
      releaseReservation(entry.preview);
    }, 120000);
    (entry.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    prepared.set(preview.previewId, entry);
    return preview;
  };
  const claim = (preview: P2pkhTransferPreview): P2pkhTransferPreview => {
    const entry = prepared.get(preview.previewId);
    if (!entry || entry.expires <= Date.now()) {
      prepared.delete(preview.previewId);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) releaseReservation(entry.preview);
      throw new Error("Transfer preview expired or already submitted");
    }
    if (JSON.stringify(entry.preview) !== JSON.stringify(preview)) throw new Error("Transfer preview changed");
    if (entry.timer) clearTimeout(entry.timer);
    prepared.delete(preview.previewId);
    return structuredClone(entry.preview);
  };
  /** 取回 Worker 自己记住的预览（跨 Runtime 提交路径）。 */
  const recall = (previewId: string): P2pkhTransferPreview => {
    const entry = prepared.get(previewId);
    if (!entry || entry.expires <= Date.now()) {
      prepared.delete(previewId);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) releaseReservation(entry.preview);
      throw new Error("Transfer preview expired or already submitted");
    }
    return structuredClone(entry.preview);
  };
  return {
    async prepare(input, context) {
      const validated = validateTransferInput(input);
      const paymentContext = input.paymentContext ? Object.freeze({...input.paymentContext}) : undefined;
      const network = assetIdToNetwork(validated.assetId);
      void paymentContext;
      const owner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
      const stateRepository = await deps.getStore(owner.publicKeyHex);
      const activeCrypto = await resolveActiveKeyCrypto(deps.vault, owner.publicKeyHex);
      const resourceId = makeResourceId(network);
      const resource = await stateRepository.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
      }
      if (resource.publicKeyHex !== owner.publicKeyHex) {
        // 防御：namespace K-V 的 resource 与 owner 不一致 → 拒绝。
        throw new Error("P2PKH resource publicKeyHex does not match owner");
      }
      const payment = validated.payment;
      let recipientScriptHex: string | undefined;
      let recipientOwnership: "app-publisher" | "third-party" | "unknown" = "unknown";
      if (payment) {
        if (payment.recipient.type === "p2pkh") {
          validateAddressForNetwork(payment.recipient.address, network);
          recipientScriptHex = p2pkhAddressToScriptHex(payment.recipient.address, network);
        } else {
          recipientScriptHex = p2pkScriptFromPublicKey(payment.recipient.publicKeyHex);
        }
        if (classifyPaymentScript(recipientScriptHex) !== payment.paymentType) {
          throw new Error("Connect payment recipient script does not match the payment type");
        }
        recipientOwnership = publisherMatchesPaymentScript(recipientScriptHex, payment.publisherPublicKeyHex) ? "app-publisher" : "third-party";
      } else {
        validateAddressForNetwork(validated.recipientAddress!, network);
      }

      const loaded = normalizeLoadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: context?.retry ? "retry" : "prepare", signal: context?.signal }));
      const candidates = loaded.utxos;
      if (!deps.utxoManager) throw new Error("Transfer requires the durable UTXO manager");
      const { address: changeAddress } = await activeCrypto.deriveP2pkhAddress();

      if (payment && !deps.utxoManager) throw new Error("Connect payment requires the durable UTXO manager");
      if (deps.utxoManager) {
        const reservation = await deps.utxoManager.reserve({
          ownerPublicKeyHex: owner.publicKeyHex, resource, utxos: candidates,
          feeRateSatoshisPerKb: validated.feeRateSatoshisPerKb,
          ...(payment ? { recipientScriptHex, paymentType: payment.paymentType, paymentId: payment.paymentId } : { recipientAddress: validated.recipientAddress }),
          amountSatoshis: validated.amountSatoshis,
          sendAll: validated.sendAll,
        });
        try {
          const selected = reservation.selectedInputs.map((row) => row.utxo);
          if (selected.length !== reservation.selectedOutpoints.length
            || selected.some((row, index) => `${row.txid.toLowerCase()}:${row.vout}` !== reservation.selectedOutpoints[index]?.toLowerCase())) {
            throw new Error("UTXO manager input evidence does not match its allocation");
          }
          const business = Number(reservation.businessSats);
          const fee = Number(reservation.feeSats);
          const change = Number(reservation.changeSats);
          const total = Number(reservation.totalInSats);
          if (![business, fee, change, total].every(Number.isSafeInteger)) throw new Error("UTXO manager allocation exceeds safe integer bounds");
          const allocation = { requestedSatoshis: business, feeReserveSatoshis: fee, selected, totalInputSatoshis: total, changeSatoshis: change };
          const paymentPreview = payment ? {
            paymentId: payment.paymentId,
            clientRequestId: payment.clientRequestId,
            planDigest: reservation.planDigest ?? "",
            paymentType: payment.paymentType,
            businessKind: payment.businessKind,
            appId: payment.appId,
            appName: payment.appName,
            origin: payment.origin,
            publisherPublicKeyHex: payment.publisherPublicKeyHex,
            recipientOwnership,
            recipientLabel: payment.recipient.type === "p2pkh" ? payment.recipient.address : payment.recipient.publicKeyHex,
            businessScriptHex: reservation.businessScriptHex,
            businessAmountSats: reservation.businessSats,
            changeAmountSats: reservation.changeSats,
            feeSats: reservation.feeSats,
            changeScriptHex: reservation.changeScriptHex,
            outputs: reservation.outputs,
          } satisfies import("@keymaster/contracts").P2pkhConnectPaymentPreview : undefined;
          return remember({
            ...(paymentContext ? { paymentContext: { ...paymentContext } } : {}),
            assetId: validated.assetId, network, ownerPublicKeyHex: owner.publicKeyHex,
            recipientAddress: payment ? (payment.recipient.type === "p2pkh" ? payment.recipient.address : "") : validated.recipientAddress!,
            ...(paymentPreview ? { payment: paymentPreview } : {}),
            amountSatoshis: business,
            feeRateSatoshisPerKb: validated.feeRateSatoshisPerKb, allocation, changeAddress,
            outputs: payment
              ? reservation.outputs.map((row) => ({
                  scriptHex: row.scriptHex, value: Number(row.valueSats), role: row.role,
                  ...(row.role === "change" ? { address: changeAddress } : payment.recipient.type === "p2pkh" ? { address: payment.recipient.address } : {}),
                }))
              : [{ address: validated.recipientAddress!, value: business }, ...(change > 0 ? [{ address: changeAddress, value: change }] : [])],
            estimatedFeeSatoshis: fee,
            serializedSizeBytes: rawTxHexByteLength(reservation.unsignedTxHex) + selected.length * 108,
            txid: "", rawTxHex: reservation.unsignedTxHex, managerAllocationId: reservation.allocationId,
            previewId: crypto.randomUUID(), sendAll: validated.sendAll,
          });
        } catch (error) {
          await deps.utxoManager.release({ ownerPublicKeyHex: owner.publicKeyHex, network, allocationId: reservation.allocationId }).catch(() => undefined);
          throw error;
        }
      }

      throw new Error("UTXO manager reservation is required");
    },

    async submitPrepared(previewId, options) {
      // 事实以 Worker 自己的记录为准：页面只带 previewId。
      return this.submit(recall(previewId), options);
    },

    async submit(preview, options) {
      if (!deps.utxoManager || !preview.managerAllocationId) throw new Error("Transfer submission requires a manager allocation");
      if (options?.signal?.aborted) return { status: "not-dispatched", txid: preview.txid, rawTxHex: preview.rawTxHex, error: "broadcast retry cancelled", submissionId: "", localInputClaimIds: [], attempts: 0, reason: "cancelled" };
      const owner = await resolveOwnerKeyIdentity(deps, preview.ownerPublicKeyHex);
      const stateRepository = await deps.getStore(owner.publicKeyHex);
      const network = preview.network;
      const resourceId = makeResourceId(network);
      const resource = await stateRepository.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
      }
      if (resource.publicKeyHex !== owner.publicKeyHex) {
        throw new Error("P2PKH resource publicKeyHex does not match owner");
      }
      if (assetIdToNetwork(preview.assetId) !== network) {
        throw new Error("Preview asset does not match active network");
      }
      if (preview.amountSatoshis <= 0) {
        throw new Error("Preview amount is invalid");
      }
      if (!deps.centralBroadcastService && !deps.broadcastWithCoordinator) {
        throw new Error("Coordinator broadcast is required for ordinary P2PKH transfers");
      }

      // 提交前再次刷新 `unspent/all`，并确认 preview 中的全部输入仍然存在
      // 且数值未变；刷新失败或输入消失即拒绝广播。
      const submitPrepared = async (currentPreview: P2pkhTransferPreview, submitOnce?: (input: {
        ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; resourceId: string; txid: string; rawTxHex: string; utxoBinding?: P2pkhUtxoBinding; managerAllocationId?: string;
      }) => Promise<CoordinatorP2pkhBroadcastResult>): Promise<{ submissionId: string; result: CoordinatorP2pkhBroadcastResult; localInputClaimIds: string[]; preview: P2pkhTransferPreview }> => {
        const loaded = normalizeLoadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: currentPreview === preview ? "submit" : "retry", signal: options?.signal }));
        const candidates = loaded.utxos;
        const managerInputs = currentPreview.managerAllocationId
          ? await (deps.utxoManager ?? (() => { throw new Error("UTXO manager is unavailable for this preview"); })()).refreshAllocationInputs({
              ownerPublicKeyHex: owner.publicKeyHex, resource, allocationId: currentPreview.managerAllocationId, utxos: candidates,
            })
          : undefined;
        const activeCrypto = await resolveActiveKeyCrypto(deps.vault, owner.publicKeyHex);
        const { address: expectedChangeAddress } = await activeCrypto.deriveP2pkhAddress();
        validateFinalTransferPreview(currentPreview, { candidates, expectedChangeAddress, ...(managerInputs ? { managerInputs } : {}) });
        const frozen = claim(currentPreview);
        if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
        const unsigned: UnsignedTx = frozen.payment
          ? {
              version: 1,
              inputs: frozen.allocation.selected.map((row) => ({
                prevTxid: row.txid, prevVout: row.vout, scriptSig: new Uint8Array(0), sequence: 0xfffffffe,
              })),
              outputs: frozen.payment.outputs.map((row) => ({
                value: Number(row.valueSats), script: hexScriptBytes(row.scriptHex),
              })),
              lockTime: 0,
            }
          : buildP2pkhTx({allocation:frozen.allocation,recipientAddress:frozen.recipientAddress,changeAddress:frozen.changeAddress});
        const unsignedTxHex = Array.from(serializeTx(unsigned), byte => byte.toString(16).padStart(2, "0")).join("");
        void frozen.paymentContext;
        let previous: string[];
        let durableIntent = false;
        try {
          if (frozen.managerAllocationId) {
            if (!deps.utxoManager || unsignedTxHex.toLowerCase() !== frozen.rawTxHex.toLowerCase()) throw new Error("UTXO manager signing template does not match the preview");
            await deps.assertInputsUnspent?.(network, frozen.allocation.selected);
            previous = await loadPreviousTransactions(network, frozen.allocation.selected, managerInputs ?? [], deps.previousTransactions);
            if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
            await deps.utxoManager.prepareSigning({ ownerPublicKeyHex: owner.publicKeyHex, resource, allocationId: frozen.managerAllocationId, unsignedTxHex });
            durableIntent = true;
          } else {
            previous = await deps.previousTransactions(network, frozen.allocation.selected);
          }
        } catch (error) {
          if (frozen.managerAllocationId && !durableIntent) {
            await deps.utxoManager?.release({ ownerPublicKeyHex: owner.publicKeyHex, network, allocationId: frozen.managerAllocationId }).catch(() => undefined);
          }
          throw error;
        }
        if (options?.signal?.aborted) throw new Error("Transfer signing cancelled");
        if (options?.signal?.aborted) throw new Error("Transfer cancelled after signing");
        void previous;
        const rawTxHex = await signP2pkhTx(unsigned, frozen.allocation.selected as import("./p2pkhContracts.js").P2pkhUtxo[], async (digest) => {
          const result = await activeCrypto.signDigest({ digest: new Uint8Array(digest).buffer as ArrayBuffer, format: "der" });
          return new Uint8Array(result.signature);
        }, owner.publicKeyHex);
        const signedSize = rawTxHexByteLength(rawTxHex);
        if (signedSize > frozen.serializedSizeBytes) throw new Error("P2PKH signature exceeded fee size bound");
        currentPreview = {...frozen,rawTxHex,txid:calcTxidFromRawTxHex(rawTxHex),serializedSizeBytes:signedSize};
        const submissionId = crypto.randomUUID();
        const now = new Date().toISOString();
        const localInputClaimIds: string[] = [];
        const localSubmission: P2pkhLocalTransaction = { id: submissionId, resourceId: resource.resourceId, publicKeyHex: owner.publicKeyHex, network, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: currentPreview.allocation.selected.map((input) => `${input.txid}:${input.vout}`), ownOutputs: currentPreview.outputs.flatMap((output, vout) => {
          const scriptHex = output.role === "change" ? output.scriptHex : output.address === currentPreview.changeAddress ? p2pkhAddressToScriptHex(output.address, network) : undefined;
          return scriptHex ? [{ vout, value: output.value, scriptHex }] : [];
        }), createdAt: now, updatedAt: now, attempts: [] };
        // 本地交易只保留审计记录，不再把输入写入 LocalInputClaim。
        // 同一组 UTXO 的并发控制由 Coordinator Worker 的 seq 门禁负责。
        await stateRepository.prepareLocalSubmission({ submission: localSubmission });
        try {
          let result: CoordinatorP2pkhBroadcastResult;
          if (submitOnce) {
            result = await submitOnce({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, resourceId: resource.resourceId, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, ...(currentPreview.utxoBinding === undefined ? {} : { utxoBinding: currentPreview.utxoBinding }), ...(currentPreview.managerAllocationId === undefined ? {} : { managerAllocationId: currentPreview.managerAllocationId }) });
          } else if (deps.broadcastWithCoordinator) {
            const response = await deps.broadcastWithCoordinator({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, submission: { resourceId: resource.resourceId, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, ...(currentPreview.utxoBinding === undefined ? {} : { utxoBinding: currentPreview.utxoBinding }), ...(currentPreview.managerAllocationId === undefined ? {} : { managerAllocationId: currentPreview.managerAllocationId }) } });
            if (response.status === "ok") result = response.value as CoordinatorP2pkhBroadcastResult;
            else if (response.status === "transport-error" && response.dispatchStatus !== "not-dispatched") result = { status: "isolated", txid: currentPreview.txid, reason: response.message };
            else result = { status: "not-dispatched", reason: "coordinator-not-dispatched" };
          } else {
            throw new Error("Coordinator broadcast is required for ordinary P2PKH transfers");
          }
          if (result.status === "not-dispatched") {
            await stateRepository.abortUnattemptedLocalSubmission?.({ submissionId, reason: result.reason });
            return { submissionId, result, localInputClaimIds: [], preview: currentPreview };
          }
          return { submissionId, result, localInputClaimIds, preview: currentPreview };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { submissionId, result: { status: "isolated", txid: currentPreview.txid, reason: message }, localInputClaimIds, preview: currentPreview };
        }
      };

      // One immutable manager allocation, one signature attempt. Unknowns
      // recover by manager exact replay, never by rebuilding or reselecting.
      const firstAttempt = await submitPrepared(preview, deps.centralBroadcastService?.submitOnce.bind(deps.centralBroadcastService));
      return mapTransferResult(firstAttempt.result, firstAttempt.preview, firstAttempt.submissionId, firstAttempt.localInputClaimIds, 1);
    }
  };
}

function mapTransferResult(result: CoordinatorP2pkhBroadcastResult, preview: P2pkhTransferPreview, submissionId: string, localInputClaimIds: string[], attempts: number): P2pkhTransferResult {
  if (result.status === "isolated") return { status: "isolated", txid: result.txid, rawTxHex: preview.rawTxHex, error: result.reason, submissionId, localInputClaimIds, attempts, reason: "isolated" };
  if (result.status === "not-dispatched") return { status: "not-dispatched", txid: preview.txid, rawTxHex: preview.rawTxHex, error: result.reason, submissionId, localInputClaimIds, attempts, reason: result.reason === "cancelled" ? "cancelled" : result.reason === "snapshot-binding-required" || result.reason === "snapshot-input-invalid" ? "snapshot-binding" : undefined };
  return { status: "local-confirmed", delivery: result.status === "already-known" ? "already-known" : "accepted", txid: preview.txid, rawTxHex: preview.rawTxHex, submissionId, localInputClaimIds, attempts };
}

async function loadPreviousTransactions(
  network: "main" | "test",
  selected: readonly P2pkhUtxo[],
  evidence: readonly P2pkhManagerInputEvidence[],
  fetch: P2pkhTransferServiceDeps["previousTransactions"],
): Promise<string[]> {
  const byOutpoint = new Map(evidence.map((row) => [`${row.utxo.txid.toLowerCase()}:${row.utxo.vout}`, row]));
  const missing = selected.filter((row) => !byOutpoint.get(`${row.txid.toLowerCase()}:${row.vout}`)?.previousTransactionHex);
  const fetched = missing.length > 0 ? await fetch(network, missing) : [];
  if (fetched.length !== missing.length) throw new Error("Previous transaction evidence count does not match Manager inputs");
  let fetchedIndex = 0;
  return selected.map((row) => byOutpoint.get(`${row.txid.toLowerCase()}:${row.vout}`)?.previousTransactionHex ?? fetched[fetchedIndex++]!);
}

function hexScriptBytes(scriptHex: string): Uint8Array {
  if (scriptHex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(scriptHex)) throw new Error("Invalid output script hex");
  return Uint8Array.from(scriptHex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function validateFinalTransferPreview(
  preview: P2pkhTransferPreview,
  input: { candidates: P2pkhUtxo[]; expectedChangeAddress: string; managerInputs?: P2pkhManagerInputEvidence[] }
): void {
  const parsed = parseP2pkhTransaction(preview.rawTxHex);
  if (preview.txid !== "" || rawTxHexByteLength(preview.rawTxHex) + parsed.inputs.length * 108 !== preview.serializedSizeBytes) {
    throw new Error("Preview serialized size does not match raw transaction");
  }
  if (preview.changeAddress !== input.expectedChangeAddress) {
    throw new Error("Preview change address does not belong to the transfer owner");
  }
  if (preview.payment) {
    if (parsed.outputs.length !== preview.payment.outputs.length) throw new Error("Preview output count does not match the frozen payment plan");
    for (let index = 0; index < preview.payment.outputs.length; index += 1) {
      const expected = preview.payment.outputs[index]!;
      const actual = parsed.outputs[index]!;
      if (actual.value !== Number(expected.valueSats) || actual.scriptHex !== expected.scriptHex) {
        throw new Error(`Preview output ${index} does not match the frozen payment role`);
      }
    }
  } else {
    if (preview.outputs.length === 0 || preview.outputs.length > 2 || preview.outputs[0]?.address !== preview.recipientAddress) {
      throw new Error("Preview outputs are invalid");
    }
    if (preview.outputs.length === 2 && preview.outputs[1]?.address !== preview.changeAddress) {
      throw new Error("Preview contains an unexpected output");
    }
    if (parsed.outputs.length !== preview.outputs.length) throw new Error("Preview output count does not match raw transaction");
    for (let index = 0; index < preview.outputs.length; index += 1) {
      const expected = preview.outputs[index]!;
      const actual = parsed.outputs[index]!;
      if (actual.value !== expected.value || actual.scriptHex !== p2pkhAddressToScriptHex(expected.address!, preview.network)) {
        throw new Error(`Preview output ${index} does not match raw transaction`);
      }
    }
  }
  if (parsed.inputs.length !== preview.allocation.selected.length) throw new Error("Preview input count does not match raw transaction");
  const candidateByOutpoint = new Map(input.candidates.map((utxo) => [`${utxo.txid.toLowerCase()}:${utxo.vout}`, utxo]));
  const managerByOutpoint = new Map((input.managerInputs ?? []).map((row) => [`${row.utxo.txid.toLowerCase()}:${row.utxo.vout}`, row.utxo]));
  const seen = new Set<string>();
  let totalInputSatoshis = 0;
  for (let index = 0; index < preview.allocation.selected.length; index += 1) {
    const selected = preview.allocation.selected[index]!;
    const key = `${selected.txid.toLowerCase()}:${selected.vout}`;
    if (seen.has(key)) throw new Error("Preview contains a duplicate input");
    seen.add(key);
    const actualInput = parsed.inputs[index]!;
    if (actualInput.outpointKey !== key) throw new Error(`Preview input ${index} does not match raw transaction`);
    const current = preview.managerAllocationId ? managerByOutpoint.get(key) : candidateByOutpoint.get(key);
    if (!current || current.value !== selected.value || current.script !== selected.script) throw new Error(`Preview input is no longer spendable: ${key}`);
    totalInputSatoshis += current.value;
  }
  const requested = preview.payment
    ? preview.payment.outputs.filter((row) => row.role === "business").reduce((sum, row) => sum + Number(row.valueSats), 0)
    : preview.outputs[0]!.value;
  const change = preview.payment
    ? preview.payment.outputs.filter((row) => row.role === "change").reduce((sum, row) => sum + Number(row.valueSats), 0)
    : preview.outputs[1]?.value ?? 0;
  if (preview.payment && (preview.payment.businessAmountSats !== String(requested) || preview.payment.changeAmountSats !== String(change) || preview.payment.feeSats !== String(totalInputSatoshis - requested - change))) {
    throw new Error("Preview payment facts do not match the final transaction");
  }
  const actualFee = totalInputSatoshis - requested - change;
  if (preview.allocation.totalInputSatoshis !== totalInputSatoshis
    || preview.allocation.requestedSatoshis !== requested
    || preview.allocation.changeSatoshis !== change
    || preview.allocation.feeReserveSatoshis !== actualFee
    || preview.estimatedFeeSatoshis !== actualFee
    || actualFee < 0) {
    throw new Error("Preview allocation does not match the final transaction");
  }
}

async function resolveActiveKeyCrypto(vault: Pick<VaultService, "status" | "createActiveKeyCrypto">, publicKeyHex: string) {
  return vault.createActiveKeyCrypto();
}

/**
 * 按 owner public key hex 解析 ReadyKeyIdentity（硬切换 002 收尾）。
 *
 * 解析路径：
 *   1. `ownerPublicKeyHex === active.publicKeyHex` → 走 active key 缓存。
 *   2. 否则走 `deps.getKeyForOwner(publicKeyHex)` 按 hex 解析；不允许
 */
async function resolveOwnerKeyIdentity(
  deps: P2pkhTransferServiceDeps,
  ownerPublicKeyHex: string
): Promise<ReadyKeyIdentity> {
  const active = deps.getActiveKey();
  if (active.publicKeyHex === ownerPublicKeyHex) {
    return active;
  }
  const key = await deps.getKeyForOwner(ownerPublicKeyHex);
  if (!key || !key.publicKeyHex) {
    throw new Error(
      `P2PKH transfer: owner ${ownerPublicKeyHex} is not ready (no publicKeyHex)`
    );
  }
  if (key.publicKeyHex !== ownerPublicKeyHex) {
    throw new Error(
      `P2PKH transfer: resolved key publicKeyHex ${key.publicKeyHex} != requested owner ${ownerPublicKeyHex}`
    );
  }
  return key;
}

function validateTransferInput(input: P2pkhTransferInput): {
  assetId: P2pkhAssetId;
  recipientAddress?: string;
  amountSatoshis: number;
  sendAll: boolean;
  feeRateSatoshisPerKb: number;
  payment?: import("@keymaster/contracts").P2pkhConnectPaymentFacts;
} {
  if (!input.assetId || !(input.assetId in assetIdToNetworkMap)) {
    throw new Error("P2PKH provider requires an assetId");
  }
  const sendAll = input.sendAll === true;
  const payment = input.payment;
  if (payment && sendAll) throw new Error("Connect payment cannot use sendAll");
  const amountSatoshis = sendAll ? 0 : normalizePositiveInteger(input.amountSatoshis, "Amount");
  const feeRateSatoshisPerKb = normalizePositiveInteger(input.feeRateSatoshisPerKb ?? 0, "Fee rate");
  if (feeRateSatoshisPerKb < 1) {
    throw new Error("Fee rate must be at least 1 sats/kB");
  }
  if (payment) {
    if (!payment.paymentId || !payment.clientRequestId || !payment.businessKind) throw new Error("Connect payment identity is incomplete");
    if (payment.paymentType !== payment.recipient.type) throw new Error("Connect payment type does not match recipient material");
    if (!/^(02|03)[0-9a-f]{64}$/i.test(payment.publisherPublicKeyHex)) throw new Error("Connect payment publisher is invalid");
  } else if (!input.recipientAddress) {
    throw new Error("Recipient address is required");
  }
  return {
    assetId: input.assetId,
    ...(input.recipientAddress === undefined ? {} : { recipientAddress: input.recipientAddress }),
    amountSatoshis,
    sendAll,
    feeRateSatoshisPerKb,
    ...(payment ? { payment } : {}),
  };
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/** 校验地址是否匹配目标网络。 */
function validateAddressForNetwork(address: string, network: "main" | "test"): void {
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 25) {
      throw new Error("Invalid P2PKH address length");
    }
    const version = decoded[0];
    if (network === "main" && version !== 0x00) {
      throw new Error("Recipient address is not a mainnet P2PKH address");
    }
    if (network === "test" && version !== 0x6f) {
      throw new Error("Recipient address is not a testnet P2PKH address");
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Invalid recipient address");
  }
}

const assetIdToNetworkMap: Record<P2pkhAssetId, "main" | "test"> = {
  bsv: "main",
  bsvtest: "test"
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58 character");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    let c = carry;
    while (c > 0) {
      bytes.push(c & 0xff);
      c = (c / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}
