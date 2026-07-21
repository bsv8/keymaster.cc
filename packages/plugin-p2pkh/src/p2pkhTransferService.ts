// packages/plugin-p2pkh/src/p2pkhTransferService.ts
// P2PKH 转移业务服务：
//   - prepareTransfer 生成最终已签名交易快照。
//   - submitTransfer 只广播 preview.rawTxHex，不再重签、不再重算 fee。
//   - 预览阶段不写本地提交 / 本地输入占用；只有进入应用内广播流程后才写。
// 设计缘由：preview 必须是最终承诺对象，否则用户看到的内容和实际广播的交易
// 可能不是同一笔，后续无法安全复制 rawTxHex 进行外部广播。
//
// 硬切换 002 收尾：所有签名 / 选币 / owner 真值走 `publicKeyHex`；

import type { AssetDataNotifier, MessageBus, PluginLogger, VaultService, WocService } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhLocalInputClaim,
  P2pkhLocalSubmission,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { localInputClaimIdFor, type P2pkhDbHandle } from "./p2pkhDb.js";
import {
  buildP2pkhTx,
  calcTxidFromRawTxHex,
  rawTxHexByteLength,
  signP2pkhTx,
  type UnsignedTx
} from "./p2pkhSigner.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhTransferServiceDeps {
  vault: VaultService;
  woc: WocService;
  messageBus: MessageBus;
  /** 资产数据变更通知器：转账成功后立即通知页面重读。 */
  assetDataNotifier?: AssetDataNotifier;
  /**
   * 硬切换 002 收尾 + 多 owner 支持：按 `publicKeyHex` 返回该 owner
   * 的 P2PKH namespace DB。transfer 内部所有读 DB 的入口（prepare
   * 选币 / submit 取 resource / claim / submission 写入）都传
   * `input.ownerPublicKeyHex` 或 `preview.ownerPublicKeyHex`——
   * 严格按调用方指定的 owner 走 namespace，不再从 active key 推导。
   *
   * 上层 p2pkhService 的硬门禁（`keyspace.openKeyStorage` 要求
   * `active === input.publicKeyHex`）保证 `publicKeyHex` 在调用
   * 时刻等于 active key。
   */
  getDb: (publicKeyHex: string) => Promise<P2pkhDbHandle>;
  /**
   * 当前 active key。p2pkhService.rebindActiveKey 内部用 requireReadyKey
   * 收窄；这里直接拿到的就是 ReadyKeyIdentity（publicKeyHex 必填）。
   *
   * 硬切换 002 收尾：本路径仅作"未传 owner 时的兜底"使用；新代码
   * 一律走 `getKeyForOwner`。
   */
  getActiveKey: () => ReadyKeyIdentity;
  /**
   * 按 owner public key hex 解析 ReadyKeyIdentity（硬切换 002 收尾）。
   * 解析失败时抛 `Error`，调用方（plugin-protocol）已经校验过 owner
   * key ready 才进入 transfer 流程。
   */
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<ReadyKeyIdentity>;
  /** 硬切换 002：业务插件注入的 logger。 */
  logger?: PluginLogger;
}

export interface P2pkhTransferService {
  prepare(input: P2pkhTransferInput): Promise<P2pkhTransferPreview>;
  submit(preview: P2pkhTransferPreview): Promise<P2pkhTransferResult>;
}

export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  return {
    async prepare(input) {
      const validated = validateTransferInput(input);
      const network = assetIdToNetwork(validated.assetId);
      const owner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
      const db = await deps.getDb(owner.publicKeyHex);
      const activeCrypto = await resolveActiveKeyCrypto(deps.vault, owner.publicKeyHex);
      const resourceId = makeResourceId(network);
      const resource = await db.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for owner ${owner.publicKeyHex} (${network})`);
      }
      if (resource.publicKeyHex !== owner.publicKeyHex) {
        // 防御：namespace DB 的 resource 与 owner 不一致 → 拒绝。
        throw new Error("P2PKH resource publicKeyHex does not match owner");
      }
      validateAddressForNetwork(validated.recipientAddress, network);

      const reservations = await db.listLocalInputClaimsByResource(resource.resourceId);
      const reserved = new Set(
        reservations.filter((r) => r.state === "claimed").map((r) => `${r.txid}:${r.vout}`)
      );
      const allUtxos = await db.listUtxos();
      const candidates = allUtxos.filter(
        (u) =>
          u.resourceId === resource.resourceId &&
          u.publicKeyHex === owner.publicKeyHex &&
          !reserved.has(`${u.txid}:${u.vout}`)
      );
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
            ownerPublicKeyHex: owner.publicKeyHex
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
          return { ...feeFromAmount.preview, ownerPublicKeyHex: owner.publicKeyHex };
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

    async submit(preview) {
      const owner = await resolveOwnerKeyIdentity(deps, preview.ownerPublicKeyHex);
      const db = await deps.getDb(owner.publicKeyHex);
      const network = preview.network;
      const resourceId = makeResourceId(network);
      const resource = await db.getResource(resourceId);
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

      const submissionId = crypto.randomUUID();
      const now = new Date().toISOString();
      const submissionBase: P2pkhLocalSubmission = {
        id: submissionId,
        resourceId: resource.resourceId,
        publicKeyHex: owner.publicKeyHex,
        network,
        assetId: preview.assetId,
        canonicalTxid: preview.txid,
        rawTxHex: preview.rawTxHex,
        recipientAddress: preview.recipientAddress,
        amountSatoshis: preview.amountSatoshis,
        status: "submitting",
        txidIntegrity: "missing",
        inputOutpoints: preview.allocation.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        createdAt: now,
        updatedAt: now
      };
      // 硬切换 002 收尾：原子地写 submission + 所有 input claim
      // （tryClaimSubmissionWithInputs 内部走单一 readwrite 事务）。
      // 冲突时整事务 abort，submission / claims 都不写——这是
      // 并发防重的事务层保险。两个并发 submit 撞到同一对
      // (txid, vout) 时，第二个会抛「already claimed」，外层
      // 不进 broadcast。
      const { claimIds: localInputClaimIds } = await db.tryClaimSubmissionWithInputs({
        submission: submissionBase,
        inputs: preview.allocation.selected
      });

      let broadcastRes:
        | {
            accepted: true;
            canonicalTxid: string;
            providerReturnedTxidRaw?: string;
            providerReturnedTxidNormalized?: string;
            txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
          }
        | undefined;
      try {
        broadcastRes = await deps.woc.broadcast(network, preview.rawTxHex, { timeoutMs: 30_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDefinitiveRejection = isDefinitivelyRejectedError(msg);
        if (isDefinitiveRejection) {
          // definitive rejection：value 没在链上花掉，释放本次 claim
          // 让这些 outpoint 重新可被后续分配选到。审计信息保留在
          // failed submission 行里。不引入 `released` 状态——直接
          // delete 行，状态机保持单一。
          await db.releaseLocalInputClaims(localInputClaimIds);
          await db.putLocalSubmission({
            ...submissionBase,
            status: "failed",
            error: msg,
            updatedAt: new Date().toISOString()
          });
          // 通知页面重读：claim 已释放、submission 已写入
          if (deps.assetDataNotifier) {
            deps.assetDataNotifier.emit({
              providerId: "p2pkh",
              publicKeyHex: owner.publicKeyHex,
              revision: Date.now(),
              kinds: ["utxo", "submission", "claim"],
            });
          }
          deps.logger?.warn({
            scope: "p2pkh.transfer",
            event: "transfer.broadcast.rejected",
            message: `P2PKH transfer broadcast rejected: ${preview.txid}`,
            data: { resourceId: resource.resourceId, network, txid: preview.txid, releasedClaimCount: localInputClaimIds.length },
            keyScope: { publicKeyHex: owner.publicKeyHex },
            error: { name: err instanceof Error ? err.name : "Error", message: msg }
          });
          return {
            status: "rejected",
            txid: preview.txid,
            rawTxHex: preview.rawTxHex,
            error: msg,
            submissionId,
            localInputClaimIds: []
          };
        }

        // ambiguous / network error：保留 claim，让 recent-sync 对账。
        // 这与 rejection 不同——UTXO 可能已经花掉，释放会留双花窗口。
        await db.putLocalSubmission({
          ...submissionBase,
          status: "unknown",
          error: msg,
          updatedAt: new Date().toISOString()
        });
        // 通知页面重读：submission 已写入（claim 保留，由 recent-sync 对账）
        if (deps.assetDataNotifier) {
          deps.assetDataNotifier.emit({
            providerId: "p2pkh",
            publicKeyHex: owner.publicKeyHex,
            revision: Date.now(),
            kinds: ["utxo", "submission", "claim"],
          });
        }
        deps.logger?.error({
          scope: "p2pkh.transfer",
          event: "transfer.broadcast.unknown",
          message: `P2PKH transfer broadcast unknown: ${preview.txid}`,
          data: { resourceId: resource.resourceId, network, txid: preview.txid },
          keyScope: { publicKeyHex: owner.publicKeyHex },
          error: { name: err instanceof Error ? err.name : "Error", message: msg }
        });
        deps.messageBus.publish(P2PKH_MSG.TRANSFER_BROADCAST, { resourceId: resource.resourceId, txid: preview.txid });
        return {
          status: "unknown",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          error: msg,
          submissionId,
          localInputClaimIds
        };
      }

      if (!broadcastRes) {
        throw new Error("Broadcast result is missing");
      }

      // 关键不变量（硬切换 003 收尾）：本判断依赖的是 plugin-woc 已归一化
      // 后的 WocBroadcastResult.txidIntegrity（exact / reversed / mismatch /
      // missing）。plugin-p2pkh 不再自行 reverse / normalize provider 原始
      // txid，也不再做"provider 原值与 preview.txid 不一致"这类二次猜测；
      // provider 字节序归一化是 plugin-woc 包的跨包契约职责。
      const nextStatus: P2pkhTransferResult["status"] =
        broadcastRes.txidIntegrity === "mismatch"
          ? "provider-inconsistent"
          : "broadcast";
      await db.putLocalSubmission({
        ...submissionBase,
        status: nextStatus,
        canonicalTxid: broadcastRes.canonicalTxid,
        providerReturnedTxidRaw: broadcastRes.providerReturnedTxidRaw,
        providerReturnedTxidNormalized: broadcastRes.providerReturnedTxidNormalized,
        txidIntegrity: broadcastRes.txidIntegrity,
        updatedAt: new Date().toISOString()
      });
      deps.logger?.info({
        scope: "p2pkh.transfer",
        event: "transfer.broadcast.accepted",
        message: `P2PKH transfer broadcast accepted: ${broadcastRes.canonicalTxid}`,
        data: { resourceId: resource.resourceId, network, txid: broadcastRes.canonicalTxid, txidIntegrity: broadcastRes.txidIntegrity },
        keyScope: { publicKeyHex: owner.publicKeyHex }
      });
      if (broadcastRes.txidIntegrity === "mismatch") {
        deps.logger?.warn({
          scope: "p2pkh.transfer",
          event: "transfer.broadcast.providerInconsistent",
          message: `P2PKH transfer broadcast provider-inconsistent: ${broadcastRes.canonicalTxid}`,
          data: { resourceId: resource.resourceId, network, txid: broadcastRes.canonicalTxid },
          keyScope: { publicKeyHex: owner.publicKeyHex }
        });
      }

      deps.messageBus.publish(P2PKH_MSG.TRANSFER_BROADCAST, { resourceId: resource.resourceId, txid: preview.txid });

      // 立即通知页面重读：UTXO、submission 已变更。
      // 设计缘由：仅靠 TRANSFER_BROADCAST 触发后台任务再发 assetDataNotifier
      // 会导致页面延迟更新；这里在写库后立即通知，订阅 onDataChanged 的页面
      //（如 UTXO 页、历史页）可即时刷新。
      if (deps.assetDataNotifier) {
        deps.assetDataNotifier.emit({
          providerId: "p2pkh",
          publicKeyHex: owner.publicKeyHex,
          revision: Date.now(),
          kinds: ["utxo", "submission", "claim"],
        });
      }

      return {
        status: nextStatus,
        txid: preview.txid,
        rawTxHex: preview.rawTxHex,
        submissionId,
        localInputClaimIds
      };
    }
  };
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
          rawTxHex
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
      rawTxHex: stableRawTxHex
    }
  };
}

async function claimInputs(
  db: P2pkhDbHandle,
  params: {
    submissionId: string;
    resourceId: string;
    publicKeyHex: string;
    network: "main" | "test";
    inputs: P2pkhUtxo[];
  }
): Promise<string[]> {
  const localInputClaimIds: string[] = [];
  const now = new Date().toISOString();
  for (const u of params.inputs) {
    const id = localInputClaimIdFor(params.resourceId, u.txid, u.vout);
    const claim: P2pkhLocalInputClaim = {
      id,
      submissionId: params.submissionId,
      resourceId: params.resourceId,
      publicKeyHex: params.publicKeyHex,
      network: params.network,
      txid: u.txid,
      vout: u.vout,
      state: "claimed",
      createdAt: now,
      updatedAt: now
    };
    await db.putLocalInputClaim(claim);
    localInputClaimIds.push(id);
  }
  return localInputClaimIds;
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

function isDefinitivelyRejectedError(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("network")) {
    return false;
  }
  if (/\b4\d\d\b/.test(lower) && !/\b429\b/.test(lower)) {
    return true;
  }
  if (lower.includes("rejected") || lower.includes("invalid transaction") || lower.includes("bad-txns")) {
    return true;
  }
  return false;
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
