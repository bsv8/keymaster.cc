// packages/plugin-p2pkh/src/p2pkhTransferService.ts
// P2PKH 转移业务服务：
//   - prepareTransfer 生成最终已签名交易快照。
//   - submitTransfer 只广播 preview.rawTxHex，不再重签、不再重算 fee。
//   - 预览阶段不写 pending / reservation；只有进入应用内广播流程后才写。
// 设计缘由：preview 必须是最终承诺对象，否则用户看到的内容和实际广播的交易
// 可能不是同一笔，后续无法安全复制 rawTxHex 进行外部广播。

import type { MessageBus, VaultService, WocService } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhPendingTransfer,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  P2pkhUtxoReservation,
  ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { reservationIdFor, type P2pkhDbHandle } from "./p2pkhDb.js";
import {
  buildP2pkhTx,
  calcTxidFromRawTxHex,
  deriveP2pkhAddress,
  rawTxHexByteLength,
  signP2pkhTx,
  type UnsignedTx
} from "./p2pkhSigner.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export interface P2pkhTransferServiceDeps {
  vault: VaultService;
  woc: WocService;
  messageBus: MessageBus;
  /** 每次需要操作时由 p2pkhService 提供的当前 namespace db。 */
  getDb: () => Promise<P2pkhDbHandle>;
  /**
   * 当前 active key。p2pkhService.rebindActiveKey 内部用 requireReadyKey
   * 收窄；这里直接拿到的就是 ReadyKeyIdentity（publicKeyHash 必填）。
   */
  getActiveKey: () => ReadyKeyIdentity;
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
      const db = await deps.getDb();
      const active = deps.getActiveKey();
      const resourceId = makeResourceId(active.keyId, network);
      const resource = await db.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for active key (${network})`);
      }
      validateAddressForNetwork(validated.recipientAddress, network);

      const reservations = await db.listReservationsByResource(resource.resourceId);
      const reserved = new Set(
        reservations.filter((r) => r.state === "reserved").map((r) => `${r.txid}:${r.vout}`)
      );
      const allUtxos = await db.listUtxos();
      const candidates = allUtxos.filter(
        (u) => u.resourceId === resource.resourceId && !reserved.has(`${u.txid}:${u.vout}`)
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
      const { address: changeAddress, publicKeyHex } = await deps.vault.withPrivateKey(
        active.keyId,
        async (material) => deriveP2pkhAddress(material.hex, network)
      );
      const signRawTx = async (unsigned: UnsignedTx, selected: P2pkhUtxo[]): Promise<string> =>
        deps.vault.withPrivateKey(active.keyId, async (material) => signP2pkhTx(unsigned, selected, material, publicKeyHex));

      let bestError: AllocationFailureInfo | undefined;
      for (let count = 1; count <= sorted.length; count++) {
        const selected = sorted.slice(0, count);
        const solution = await solveForSelectedInputs({
          assetId: validated.assetId,
          selected,
          amountSatoshis: validated.amountSatoshis,
          feeRateSatoshisPerKb: validated.feeRateSatoshisPerKb,
          recipientAddress: validated.recipientAddress,
          changeAddress,
          signRawTx
        });
        if (solution.ok) {
          return solution.preview;
        }
        bestError = solution.error;
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
      const db = await deps.getDb();
      const active = deps.getActiveKey();
      const network = preview.network;
      const resourceId = makeResourceId(active.keyId, network);
      const resource = await db.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for active key (${network})`);
      }
      if (resource.publicKeyHash !== active.publicKeyHash) {
        throw new Error("Active key changed before broadcast");
      }
      if (assetIdToNetwork(preview.assetId) !== network) {
        throw new Error("Preview asset does not match active network");
      }
      if (preview.amountSatoshis <= 0) {
        throw new Error("Preview amount is invalid");
      }

      const pendingId = crypto.randomUUID();
      const now = new Date().toISOString();
      const pendingBase: P2pkhPendingTransfer = {
        id: pendingId,
        resourceId: resource.resourceId,
        keyId: active.keyId,
        publicKeyHash: active.publicKeyHash,
        network,
        assetId: preview.assetId,
        txid: preview.txid,
        recipientAddress: preview.recipientAddress,
        amountSatoshis: preview.amountSatoshis,
        status: "pending",
        inputOutpoints: preview.allocation.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        createdAt: now,
        updatedAt: now
      };
      await db.putPendingTransfer(pendingBase);

      let broadcastRes: { txid: string };
      try {
        broadcastRes = await deps.woc.broadcast(network, preview.rawTxHex, { timeoutMs: 30_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDefinitiveRejection = isDefinitivelyRejectedError(msg);
        if (isDefinitiveRejection) {
          await db.putPendingTransfer({
            ...pendingBase,
            status: "failed",
            error: msg,
            updatedAt: new Date().toISOString()
          });
          return {
            status: "rejected",
            txid: preview.txid,
            rawTxHex: preview.rawTxHex,
            error: msg,
            pendingTransferId: pendingId,
            reservationIds: []
          };
        }

        const reservationIds = await reserveInputs(db, {
          resourceId: resource.resourceId,
          keyId: active.keyId,
          publicKeyHash: active.publicKeyHash,
          network,
          spendingTxid: preview.txid,
          inputs: preview.allocation.selected
        });
        await db.putPendingTransfer({
          ...pendingBase,
          status: "unknown",
          error: msg,
          updatedAt: new Date().toISOString()
        });
        return {
          status: "unknown",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          error: msg,
          pendingTransferId: pendingId,
          reservationIds
        };
      }

      if (broadcastRes.txid !== preview.txid) {
        const msg = "Broadcast txid does not match preview txid";
        await db.putPendingTransfer({
          ...pendingBase,
          status: "failed",
          error: msg,
          updatedAt: new Date().toISOString()
        });
        throw new Error(msg);
      }

      const reservationIds = await reserveInputs(db, {
        resourceId: resource.resourceId,
        keyId: active.keyId,
        publicKeyHash: active.publicKeyHash,
        network,
        spendingTxid: preview.txid,
        inputs: preview.allocation.selected
      });
      await db.putPendingTransfer({
        ...pendingBase,
        status: "broadcast",
        txid: preview.txid,
        updatedAt: new Date().toISOString()
      });

      deps.messageBus.publish(P2PKH_MSG.TRANSFER_BROADCAST, { resourceId: resource.resourceId, txid: preview.txid });

      return {
        status: "broadcast",
        txid: preview.txid,
        rawTxHex: preview.rawTxHex,
        pendingTransferId: pendingId,
        reservationIds
      };
    }
  };
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
  feeRateSatoshisPerKb: number;
  recipientAddress: string;
  changeAddress: string;
  signRawTx: (unsigned: UnsignedTx, selected: P2pkhUtxo[]) => Promise<string>;
}): Promise<SolveResult> {
  const totalInputSatoshis = params.selected.reduce((sum, u) => sum + u.value, 0);
  let feeSatoshis = 1;

  for (let round = 0; round < 12; round++) {
    const changeSatoshis = totalInputSatoshis - params.amountSatoshis - feeSatoshis;
    if (changeSatoshis < 0) {
      return {
        ok: false,
        error: {
          available: totalInputSatoshis,
          amountSatoshis: params.amountSatoshis,
          feeSatoshis,
          required: params.amountSatoshis + feeSatoshis,
          reason: "insufficient"
        }
      };
    }
    const allocation = {
      requestedSatoshis: params.amountSatoshis,
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
    if (nextFeeSatoshis === feeSatoshis) {
      const outputs = [
        { address: params.recipientAddress, value: params.amountSatoshis },
        ...(changeSatoshis > 0 ? [{ address: params.changeAddress, value: changeSatoshis }] : [])
      ];
      return {
        ok: true,
        preview: {
          assetId: params.assetId,
          network: assetIdToNetworkMap[params.assetId],
          recipientAddress: params.recipientAddress,
          amountSatoshis: params.amountSatoshis,
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

  const stableChangeSatoshis = totalInputSatoshis - params.amountSatoshis - feeSatoshis;
  if (stableChangeSatoshis < 0) {
    return {
      ok: false,
      error: {
        available: totalInputSatoshis,
        amountSatoshis: params.amountSatoshis,
        feeSatoshis,
        required: params.amountSatoshis + feeSatoshis,
        reason: "insufficient"
      }
    };
  }
  const stableAllocation = {
    requestedSatoshis: params.amountSatoshis,
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
        amountSatoshis: params.amountSatoshis,
        feeSatoshis: estimatedFeeSatoshis,
        required: params.amountSatoshis + estimatedFeeSatoshis,
        reason: "insufficient"
      }
    };
  }
  const outputs = [
    { address: params.recipientAddress, value: params.amountSatoshis },
    ...(stableChangeSatoshis > 0 ? [{ address: params.changeAddress, value: stableChangeSatoshis }] : [])
  ];
  return {
    ok: true,
    preview: {
      assetId: params.assetId,
      network: assetIdToNetworkMap[params.assetId],
      recipientAddress: params.recipientAddress,
      amountSatoshis: params.amountSatoshis,
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

async function reserveInputs(
  db: P2pkhDbHandle,
  params: {
    resourceId: string;
    keyId: string;
    publicKeyHash: string;
    network: "main" | "test";
    spendingTxid: string;
    inputs: P2pkhUtxo[];
  }
): Promise<string[]> {
  const reservationIds: string[] = [];
  const now = new Date().toISOString();
  for (const u of params.inputs) {
    const id = reservationIdFor(params.resourceId, u.txid, u.vout);
    const reservation: P2pkhUtxoReservation = {
      id,
      resourceId: params.resourceId,
      keyId: params.keyId,
      publicKeyHash: params.publicKeyHash,
      network: params.network,
      txid: u.txid,
      vout: u.vout,
      spendingTxid: params.spendingTxid,
      state: "reserved",
      createdAt: now,
      updatedAt: now
    };
    await db.putReservation(reservation);
    reservationIds.push(id);
  }
  return reservationIds;
}

function validateTransferInput(input: P2pkhTransferInput): {
  assetId: P2pkhAssetId;
  recipientAddress: string;
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
} {
  if (!input.assetId || !(input.assetId in assetIdToNetworkMap)) {
    throw new Error("P2PKH provider requires an assetId");
  }
  const amountSatoshis = normalizePositiveInteger(input.amountSatoshis, "Amount");
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
