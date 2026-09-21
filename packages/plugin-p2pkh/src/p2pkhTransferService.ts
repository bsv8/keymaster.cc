// packages/plugin-p2pkh/src/p2pkhTransferService.ts
// P2PKH 转移业务服务：
//   - prepareTransfer 生成最终已签名交易快照。
//   - submitTransfer 先提交该快照；命中序号门禁且确定未派发时，中心服务
//     才会等待新快照并完整重选输入、重签名、重新提交。
//   - 预览阶段不写本地提交 / 本地输入占用；只有进入应用内广播流程后才写。
// 设计缘由：preview 必须是最终承诺对象，否则用户看到的内容和实际广播的交易
// 可能不是同一笔，后续无法安全复制 rawTxHex 进行外部广播。
//
// 硬切换 002 收尾：所有签名 / 选币 / owner 真值走 `publicKeyHex`；

import type { AssetDataNotifier, CentralBroadcastService, CoordinatorP2pkhBroadcastResult, CoordinatorValueResult, P2pkhBroadcastSubmission, P2pkhUtxoBinding, ProtectedOutpointRegistry, VaultService } from "@keymaster/contracts";
import { CentralBroadcastRetryableError } from "./centralBroadcastService.js";
import type { MessageBus } from "webloom-framework";
import type {
  P2pkhAssetId,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhLocalTransaction,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { localInputClaimIdFor, type P2pkhStateRepositoryHandle } from "./storage/p2pkhStateRepository.js";
import {
  buildP2pkhTx,
  calcTxidFromRawTxHex,
  rawTxHexByteLength,
  signP2pkhTx,
  type UnsignedTx
} from "./p2pkhSigner.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";
import { parseP2pkhTransaction, p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

export interface P2pkhTransferServiceDeps {
  vault: VaultService;
  messageBus: MessageBus;
  /** 资产数据变更通知器：转账成功后立即通知页面重读。 */
  assetDataNotifier?: AssetDataNotifier;
  /**
   * 硬切换 002 收尾 + 多 owner 支持：按 `publicKeyHex` 返回该 owner
   * 的 P2PKH namespace K-V。transfer 内部所有读 K-V 的入口（prepare
   * 选币 / submit 取 resource / claim / submission 写入）都传
   * `input.ownerPublicKeyHex` 或 `preview.ownerPublicKeyHex`——
   * 严格按调用方指定的 owner 走 namespace，不再从 active key 推导。
   */
  getStore: (publicKeyHex: string) => Promise<P2pkhStateRepositoryHandle>;
  /**
   * 可花 UTXO 加载入口（由 service 实现）：
   *   1. 刷新一次 WoC `unspent/all` 内存快照（失败则整次加载失败，
   *      不允许用已知过期的快照签署交易）；
   *   2. 从快照扣除 `isSpentInMempoolTx=true`；
   *   3. 扣除本地 active/isolated input claims 与协议保护 outpoints。
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
  /** Ordinary funding must never consume protocol-protected outpoints. */
  protectedOutpoints?: ProtectedOutpointRegistry;
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
}

function normalizeLoadedUtxos(value: P2pkhUtxo[] | { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding }): { utxos: P2pkhUtxo[]; utxoBinding?: P2pkhUtxoBinding } {
  return Array.isArray(value) ? { utxos: value } : value;
}

export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  return {
    async prepare(input, context) {
      const validated = validateTransferInput(input);
      const network = assetIdToNetwork(validated.assetId);
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
      validateAddressForNetwork(validated.recipientAddress, network);

      const loaded = normalizeLoadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: context?.retry ? "retry" : "prepare", signal: context?.signal }));
      const candidates = loaded.utxos;
      // 中文：绑定必须来自同一次刷新，避免“UTXO 集合”和“序号”来自两次 RPC。
      const utxoBinding = loaded.utxoBinding ?? await deps.getUtxoBinding?.({ ownerPublicKeyHex: owner.publicKeyHex, resource });
      if (candidates.length === 0) {
        throw buildAllocationError({
          available: 0,
          amountSatoshis: validated.amountSatoshis,
          feeSatoshis: 0,
          required: validated.amountSatoshis,
          reason: "no-utxos"
        });
      }

      const sorted = [...candidates].sort((a, b) => a.value - b.value);
      const { address: changeAddress } = await activeCrypto.deriveP2pkhAddress({
        publicKeyHex: owner.publicKeyHex,
        network
      });
      const publicKeyHex = owner.publicKeyHex;
      const signRawTx = async (unsigned: UnsignedTx, selected: P2pkhUtxo[]): Promise<string> =>
        signP2pkhTx(
          unsigned,
          selected,
          async (digest) => {
            const r = await activeCrypto.signDigest({
              publicKeyHex,
              digest: new Uint8Array(digest).buffer,
              format: "der"
            });
            // P0: 校验回包 format 为 der
            if (r.format !== "der") {
              throw new Error(
                `signDigest (p2pkh) format mismatch: requested "der", got "${r.format}"`
              );
            }
            return new Uint8Array(r.signature);
          },
          publicKeyHex
        );

      let bestError: AllocationFailureInfo | undefined;
      const selections = validated.sendAll
        ? [sorted]
        : Array.from({ length: sorted.length }, (_, index) => sorted.slice(0, index + 1));
      for (const selected of selections) {
        const solution = await solveForSelectedInputs({
          assetId: validated.assetId,
          selected,
          amountSatoshis: validated.amountSatoshis,
          sendAll: validated.sendAll,
          feeRateSatoshisPerKb: validated.feeRateSatoshisPerKb,
          recipientAddress: validated.recipientAddress,
          changeAddress,
          signRawTx
        });
        if (solution.ok) {
          // 关键（硬切换 002 收尾）：preview 必须携带 owner 信息，让
          // submit 阶段可校验"同一 owner 才能广播"——避免 caller / widget
          // 在 prepare 与 submit 之间切换 owner 导致"用 keyA 准备、
          // 用 keyB 广播"的错位。
          return {
            ...solution.preview,
            ownerPublicKeyHex: owner.publicKeyHex,
            previewId: crypto.randomUUID(),
            ...(utxoBinding === undefined ? {} : { utxoBinding }),
            sendAll: validated.sendAll,
          };
        }
        bestError = solution.error;
      }

      // 固定金额优先保证“收款额 + fee”。若最终计算发现可用余额不够
      // `金额 + fee`，它与用户选择“全部”是同一笔语义：使用全部可用
      // 输入，最终收款输出 = inputs - actual fee，且不产生找零。这个
      // 分支也覆盖余额低于手填金额本身的情形；仅余额连 fee 都不够时，
      // all-fee 求解会明确失败。
      if (!validated.sendAll) {
        const feeFromAmount = await solveForSelectedInputs({
          assetId: validated.assetId,
          selected: sorted,
          amountSatoshis: validated.amountSatoshis,
          sendAll: true,
          feeRateSatoshisPerKb: validated.feeRateSatoshisPerKb,
          recipientAddress: validated.recipientAddress,
          changeAddress,
          signRawTx
        });
        if (feeFromAmount.ok) {
          return {
            ...feeFromAmount.preview,
            ownerPublicKeyHex: owner.publicKeyHex,
            previewId: crypto.randomUUID(),
            ...(utxoBinding === undefined ? {} : { utxoBinding }),
            sendAll: validated.sendAll,
          };
        }
        bestError = feeFromAmount.error;
      }

      throw buildAllocationError(
        bestError ?? {
          available: candidates.reduce((sum, u) => sum + u.value, 0),
          amountSatoshis: validated.amountSatoshis,
          feeSatoshis: 0,
          required: validated.amountSatoshis,
          reason: "insufficient"
        }
      );
    },

    async submit(preview, options) {
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
        ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; resourceId: string; txid: string; rawTxHex: string; utxoBinding?: P2pkhUtxoBinding;
      }) => Promise<CoordinatorP2pkhBroadcastResult>): Promise<{ submissionId: string; result: CoordinatorP2pkhBroadcastResult; localInputClaimIds: string[]; preview: P2pkhTransferPreview }> => {
        const loaded = normalizeLoadedUtxos(await deps.loadSpendableUtxos({ ownerPublicKeyHex: owner.publicKeyHex, resource, purpose: currentPreview === preview ? "submit" : "retry", signal: options?.signal }));
        const candidates = loaded.utxos;
        const currentBinding = loaded.utxoBinding ?? await deps.getUtxoBinding?.({ ownerPublicKeyHex: owner.publicKeyHex, resource });
        const activeCrypto = await resolveActiveKeyCrypto(deps.vault, owner.publicKeyHex);
        const { address: expectedChangeAddress } = await activeCrypto.deriveP2pkhAddress({ publicKeyHex: owner.publicKeyHex, network });
        if (currentPreview.utxoBinding && (!currentBinding || currentBinding.seq !== currentPreview.utxoBinding.seq || currentBinding.resourceId !== currentPreview.utxoBinding.resourceId)) {
          return { submissionId: "", result: { status: "not-dispatched", reason: "snapshot-stale", currentSeq: currentBinding?.seq }, localInputClaimIds: [], preview: currentPreview };
        }
        validateFinalTransferPreview(currentPreview, { candidates, expectedChangeAddress });
        const submissionId = crypto.randomUUID();
        const now = new Date().toISOString();
        const localInputClaimIds = currentPreview.allocation.selected.map((input) => localInputClaimIdFor(resource.resourceId, input.txid, input.vout));
        const localSubmission: P2pkhLocalTransaction = { id: submissionId, resourceId: resource.resourceId, publicKeyHex: owner.publicKeyHex, network, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: currentPreview.allocation.selected.map((input) => `${input.txid}:${input.vout}`), ownOutputs: currentPreview.outputs.flatMap((output, vout) => output.address === currentPreview.changeAddress ? [{ vout, value: output.value, scriptHex: p2pkhAddressToScriptHex(output.address, network) }] : []), createdAt: now, updatedAt: now, attempts: [] };
        const claims: P2pkhLocalInputClaim[] = currentPreview.allocation.selected.map((input) => ({ id: localInputClaimIdFor(resource.resourceId, input.txid, input.vout), submissionId, resourceId: resource.resourceId, publicKeyHex: owner.publicKeyHex, network, txid: input.txid, vout: input.vout, outpointKey: `${input.txid}:${input.vout}`, value: input.value, state: "active", createdAt: now, updatedAt: now }));
        await stateRepository.prepareLocalSubmission({ submission: localSubmission, claims });
        try {
          let result: CoordinatorP2pkhBroadcastResult;
          if (submitOnce) {
            result = await submitOnce({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, resourceId: resource.resourceId, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, ...(currentPreview.utxoBinding === undefined ? {} : { utxoBinding: currentPreview.utxoBinding }) });
          } else if (deps.broadcastWithCoordinator) {
            const response = await deps.broadcastWithCoordinator({ ownerPublicKeyHex: owner.publicKeyHex, network, submissionId, submission: { resourceId: resource.resourceId, txid: currentPreview.txid, rawTxHex: currentPreview.rawTxHex, ...(currentPreview.utxoBinding === undefined ? {} : { utxoBinding: currentPreview.utxoBinding }) } });
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
          deps.assetDataNotifier?.emit({ providerId: "p2pkh", publicKeyHex: owner.publicKeyHex, revision: Date.now(), kinds: ["utxo", "submission", "claim", "balance"] });
          return { submissionId, result, localInputClaimIds, preview: currentPreview };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { submissionId, result: { status: "isolated", txid: currentPreview.txid, reason: message }, localInputClaimIds, preview: currentPreview };
        }
      };

      if (!deps.centralBroadcastService) {
        const firstAttempt = await submitPrepared(preview);
        return mapTransferResult(firstAttempt.result, firstAttempt.preview, firstAttempt.submissionId, firstAttempt.localInputClaimIds, 1);
      }

      // 首次尝试也必须由中心服务计数和分类。否则首次命中 consumed
      // 时，中心会在没有新序号的情况下直接开始第二次 rebuild。
      let first = true;
      let latestPreview = preview;
      let latestSubmissionId = "";
      let latestLocalInputClaimIds: string[] = [];
      const outcome = await deps.centralBroadcastService.submitWithRetry({
        network,
        boundSeq: preview.utxoBinding?.seq,
        signal: options?.signal,
        attempt: async ({ submitOnce }) => {
          // 中文：sendAll 的金额随余额浮动，任何可重试失败后都不得自动重建，
          // 必须让用户重新确认；首次尝试仍提交用户已确认的 preview。
          if (!first && preview.sendAll) {
            throw new Error("sendAll requires reconfirmation after a retryable failure");
          }
          const currentPreview = first ? preview : await this.prepare({
            assetId: preview.assetId,
            ownerPublicKeyHex: owner.publicKeyHex,
            recipientAddress: preview.recipientAddress,
            amountSatoshis: preview.amountSatoshis,
            feeRateSatoshisPerKb: preview.feeRateSatoshisPerKb,
            sendAll: preview.sendAll,
          }, { retry: true, signal: options?.signal });
          first = false;
          latestPreview = currentPreview;
          const attempt = await submitPrepared(currentPreview, submitOnce);
          latestSubmissionId = attempt.submissionId;
          latestLocalInputClaimIds = attempt.localInputClaimIds;
          if (currentPreview.sendAll && attempt.result.status === "not-dispatched" && (attempt.result.reason === "snapshot-stale" || attempt.result.reason === "snapshot-consumed")) {
            throw new Error("sendAll requires reconfirmation after the UTXO snapshot changed");
          }
          return { submissionId: attempt.submissionId, result: attempt.result };
        },
      });
      return {
        status: outcome.status === "local-confirmed" ? "local-confirmed" : outcome.status === "isolated" ? "isolated" : "not-dispatched",
        txid: outcome.txid ?? latestPreview.txid,
        rawTxHex: latestPreview.rawTxHex,
        error: outcome.error,
        submissionId: latestSubmissionId,
        localInputClaimIds: latestLocalInputClaimIds,
        attempts: outcome.attempts,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    }
  };
}

function mapTransferResult(result: CoordinatorP2pkhBroadcastResult, preview: P2pkhTransferPreview, submissionId: string, localInputClaimIds: string[], attempts: number): P2pkhTransferResult {
  if (result.status === "isolated") return { status: "isolated", txid: result.txid, rawTxHex: preview.rawTxHex, error: result.reason, submissionId, localInputClaimIds, attempts, reason: "isolated" };
  if (result.status === "not-dispatched") return { status: "not-dispatched", txid: preview.txid, rawTxHex: preview.rawTxHex, error: result.reason, submissionId, localInputClaimIds, attempts, reason: result.reason === "snapshot-binding-required" || result.reason === "snapshot-input-invalid" ? "snapshot-binding" : undefined };
  return { status: "local-confirmed", txid: preview.txid, rawTxHex: preview.rawTxHex, submissionId, localInputClaimIds, attempts };
}

function validateFinalTransferPreview(
  preview: P2pkhTransferPreview,
  input: { candidates: P2pkhUtxo[]; expectedChangeAddress: string }
): void {
  const parsed = parseP2pkhTransaction(preview.rawTxHex, preview.txid);
  if (rawTxHexByteLength(preview.rawTxHex) !== preview.serializedSizeBytes) {
    throw new Error("Preview serialized size does not match raw transaction");
  }
  if (preview.changeAddress !== input.expectedChangeAddress) {
    throw new Error("Preview change address does not belong to the transfer owner");
  }
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
    if (actual.value !== expected.value || actual.scriptHex !== p2pkhAddressToScriptHex(expected.address, preview.network)) {
      throw new Error(`Preview output ${index} does not match raw transaction`);
    }
  }
  if (parsed.inputs.length !== preview.allocation.selected.length) throw new Error("Preview input count does not match raw transaction");
  const candidateByOutpoint = new Map(input.candidates.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]));
  const seen = new Set<string>();
  let totalInputSatoshis = 0;
  for (let index = 0; index < preview.allocation.selected.length; index += 1) {
    const selected = preview.allocation.selected[index]!;
    const key = `${selected.txid}:${selected.vout}`;
    if (seen.has(key)) throw new Error("Preview contains a duplicate input");
    seen.add(key);
    const actualInput = parsed.inputs[index]!;
    if (actualInput.outpointKey !== key) throw new Error(`Preview input ${index} does not match raw transaction`);
    const current = candidateByOutpoint.get(key);
    if (!current || current.value !== selected.value) throw new Error(`Preview input is no longer spendable: ${key}`);
    totalInputSatoshis += current.value;
  }
  const requested = preview.outputs[0]!.value;
  const change = preview.outputs[1]?.value ?? 0;
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

async function resolveActiveKeyCrypto(vault: VaultService, publicKeyHex: string) {
  const anyVault = vault as VaultService & {
    createActiveKeyCrypto?: (hex: string) => Promise<{
      deriveP2pkhAddress: (input: { publicKeyHex: string; network: "main" | "test" }) => Promise<{
        publicKeyHex: string;
        address: string;
      }>;
      signDigest: (input: { publicKeyHex: string; digest: ArrayBuffer }) => Promise<{
        publicKeyHex: string;
        signature: ArrayBuffer;
      }>;
    }>;
  };
  if (typeof anyVault.createActiveKeyCrypto === "function") {
    return await anyVault.createActiveKeyCrypto(publicKeyHex);
  }
  throw new Error("Vault does not provide createActiveKeyCrypto");
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

type AllocationFailureInfo = {
  available: number;
  amountSatoshis: number;
  feeSatoshis: number;
  required: number;
  reason: "no-utxos" | "insufficient";
};

type SolveResult = { ok: true; preview: P2pkhTransferPreview } | { ok: false; error: AllocationFailureInfo };

async function solveForSelectedInputs(params: {
  assetId: P2pkhAssetId;
  selected: P2pkhUtxo[];
  amountSatoshis: number;
  sendAll: boolean;
  feeRateSatoshisPerKb: number;
  recipientAddress: string;
  changeAddress: string;
  signRawTx: (unsigned: UnsignedTx, selected: P2pkhUtxo[]) => Promise<string>;
}): Promise<SolveResult> {
  const totalInputSatoshis = params.selected.reduce((sum, u) => sum + u.value, 0);
  let feeSatoshis = 1;

  for (let round = 0; round < 12; round++) {
    // “全部”不是把一个预先填入的数字送出去；它使用全部可用输入，并让
    // 最终收款输出等于 inputs - final fee。因此构建/签名后的实际 fee
    // 始终从收款额扣除，不会因没有额外找零来支付 fee 而失败。
    const recipientSatoshis = params.sendAll
      ? totalInputSatoshis - feeSatoshis
      : params.amountSatoshis;
    const changeSatoshis = params.sendAll ? 0 : totalInputSatoshis - recipientSatoshis - feeSatoshis;
    if (recipientSatoshis <= 0 || changeSatoshis < 0) {
      return {
        ok: false,
        error: {
          available: totalInputSatoshis,
          amountSatoshis: recipientSatoshis,
          feeSatoshis,
          required: params.sendAll ? feeSatoshis + 1 : recipientSatoshis + feeSatoshis,
          reason: "insufficient"
        }
      };
    }
    const allocation = {
      requestedSatoshis: recipientSatoshis,
      feeReserveSatoshis: feeSatoshis,
      selected: params.selected,
      totalInputSatoshis,
      changeSatoshis
    };
    const unsigned = buildP2pkhTx({
      allocation,
      recipientAddress: params.recipientAddress,
      changeAddress: params.changeAddress
    });
    const rawTxHex = await params.signRawTx(unsigned, params.selected);
    const serializedSizeBytes = rawTxHexByteLength(rawTxHex);
    const nextFeeSatoshis = Math.max(1, Math.ceil((serializedSizeBytes * params.feeRateSatoshisPerKb) / 1000));
    // DER 签名长度会随待签名内容变动 1 byte；“全部”在两种金额之间
    // 迭代时可能因此出现相邻 fee 来回跳。只要本轮预留 fee 不低于
    // 重新估算值，就接受这一轮（多出的 1 sat 仍归矿工），避免假性
    // insufficient 错误。
    if (nextFeeSatoshis === feeSatoshis || (params.sendAll && nextFeeSatoshis <= feeSatoshis)) {
      const outputs = [
        { address: params.recipientAddress, value: recipientSatoshis },
        ...(changeSatoshis > 0 ? [{ address: params.changeAddress, value: changeSatoshis }] : [])
      ];
      return {
        ok: true,
        preview: {
          ownerPublicKeyHex: "", // 硬切换 002 收尾：solve 阶段无法直接拿 owner，由 prepare 入口在 spread 时补 ownerPublicKeyHex
          assetId: params.assetId,
          network: assetIdToNetworkMap[params.assetId],
          recipientAddress: params.recipientAddress,
          amountSatoshis: recipientSatoshis,
          feeRateSatoshisPerKb: params.feeRateSatoshisPerKb,
          allocation,
          changeAddress: params.changeAddress,
          outputs,
          estimatedFeeSatoshis: feeSatoshis,
          serializedSizeBytes,
          txid: calcTxidFromRawTxHex(rawTxHex),
          rawTxHex,
          previewId: ""
        }
      };
    }
    feeSatoshis = nextFeeSatoshis;
  }

  const stableRecipientSatoshis = params.sendAll ? totalInputSatoshis - feeSatoshis : params.amountSatoshis;
  const stableChangeSatoshis = params.sendAll ? 0 : totalInputSatoshis - stableRecipientSatoshis - feeSatoshis;
  if (stableRecipientSatoshis <= 0 || stableChangeSatoshis < 0) {
    return {
      ok: false,
      error: {
        available: totalInputSatoshis,
        amountSatoshis: stableRecipientSatoshis,
        feeSatoshis,
        required: params.sendAll ? feeSatoshis + 1 : stableRecipientSatoshis + feeSatoshis,
        reason: "insufficient"
      }
    };
  }
  const stableAllocation = {
    requestedSatoshis: stableRecipientSatoshis,
    feeReserveSatoshis: feeSatoshis,
    selected: params.selected,
    totalInputSatoshis,
    changeSatoshis: stableChangeSatoshis
  };
  const stableUnsigned = buildP2pkhTx({
    allocation: stableAllocation,
    recipientAddress: params.recipientAddress,
    changeAddress: params.changeAddress
  });
  const stableRawTxHex = await params.signRawTx(stableUnsigned, params.selected);
  const serializedSizeBytes = rawTxHexByteLength(stableRawTxHex);
  const estimatedFeeSatoshis = Math.max(1, Math.ceil((serializedSizeBytes * params.feeRateSatoshisPerKb) / 1000));
  if (estimatedFeeSatoshis !== feeSatoshis) {
    return {
      ok: false,
      error: {
        available: totalInputSatoshis,
        amountSatoshis: stableRecipientSatoshis,
        feeSatoshis: estimatedFeeSatoshis,
        required: params.sendAll ? estimatedFeeSatoshis + 1 : stableRecipientSatoshis + estimatedFeeSatoshis,
        reason: "insufficient"
      }
    };
  }
  const outputs = [
    { address: params.recipientAddress, value: stableRecipientSatoshis },
    ...(stableChangeSatoshis > 0 ? [{ address: params.changeAddress, value: stableChangeSatoshis }] : [])
  ];
  return {
    ok: true,
    preview: {
      ownerPublicKeyHex: "", // 硬切换 002 收尾：solve 阶段拿不到 owner，由 prepare 入口补 ownerPublicKeyHex
      assetId: params.assetId,
      network: assetIdToNetworkMap[params.assetId],
      recipientAddress: params.recipientAddress,
      amountSatoshis: stableRecipientSatoshis,
      feeRateSatoshisPerKb: params.feeRateSatoshisPerKb,
      allocation: stableAllocation,
      changeAddress: params.changeAddress,
      outputs,
      estimatedFeeSatoshis,
      serializedSizeBytes,
      txid: calcTxidFromRawTxHex(stableRawTxHex),
      rawTxHex: stableRawTxHex,
      previewId: ""
    }
  };
}

function validateTransferInput(input: P2pkhTransferInput): {
  assetId: P2pkhAssetId;
  recipientAddress: string;
  amountSatoshis: number;
  sendAll: boolean;
  feeRateSatoshisPerKb: number;
} {
  if (!input.assetId || !(input.assetId in assetIdToNetworkMap)) {
    throw new Error("P2PKH provider requires an assetId");
  }
  const sendAll = input.sendAll === true;
  const amountSatoshis = sendAll ? 0 : normalizePositiveInteger(input.amountSatoshis, "Amount");
  const feeRateSatoshisPerKb = normalizePositiveInteger(input.feeRateSatoshisPerKb ?? 0, "Fee rate");
  if (feeRateSatoshisPerKb < 1) {
    throw new Error("Fee rate must be at least 1 sats/kB");
  }
  if (!input.recipientAddress) {
    throw new Error("Recipient address is required");
  }
  return {
    assetId: input.assetId,
    recipientAddress: input.recipientAddress,
    amountSatoshis,
    sendAll,
    feeRateSatoshisPerKb
  };
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function buildAllocationError(input: AllocationFailureInfo): Error {
  return new Error(
    `P2PKH transfer failed: ${input.reason}. Available inputs ${input.available} sats, amount ${input.amountSatoshis} sats, final fee ${input.feeSatoshis} sats, total required ${input.required} sats.`
  );
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
