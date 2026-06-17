// packages/plugin-p2pkh/src/p2pkhTransferService.ts
// P2PKH 转移业务服务（硬切换 007 / 008 收尾）：
//   - 不再接收 keyId；签名所需的 keyId 由 service 通过 getActiveKey 内部获取。
//   - DB 操作通过传入的 db 句柄完成（p2pkhService 在 ensureDb 后传入）。
//   - 写 pending / reservation 时把 publicKeyHash 一并写入，便于跨 key 排错。
// 设计缘由：所有 P2PKH 转移业务逻辑放在这里；Widget 只调用服务。
// 签名仍走 vault.withPrivateKey；广播走 woc.service（强制 broadcast 优先级）。
// 硬切换 008 收尾 + 硬切换 003 收尾：getActiveKey 返回 ReadyKeyIdentity
// （publicKeyHash / publicKeyHex 必填）。p2pkhService.rebindActiveKey 内部
// 用 requireReadyKey 收窄；本文件不直接调用 requireReadyKey。短公钥不再
// 作为字段持有，UI 需要时由 `formatShortPublicKey(publicKeyHex)` 现算。

import type { MessageBus, VaultService, WocService } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhPendingTransfer,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxoReservation,
  ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { assetIdToNetwork, makeResourceId } from "./p2pkhContracts.js";
import { reservationIdFor, type P2pkhDbHandle } from "./p2pkhDb.js";
import { allocateUtxos, P2pkhAllocationError } from "./utxoAllocator.js";
import { buildP2pkhTx, deriveP2pkhAddress, signP2pkhTx } from "./p2pkhSigner.js";
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
  submit(preview: P2pkhTransferPreview, input: P2pkhTransferInput): Promise<P2pkhTransferResult>;
}

export function createP2pkhTransferService(deps: P2pkhTransferServiceDeps): P2pkhTransferService {
  return {
    async prepare(input) {
      const network = assetIdToNetwork(input.assetId);
      const db = await deps.getDb();
      const active = deps.getActiveKey();
      const resourceId = makeResourceId(active.keyId, network);
      const resource = await db.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for active key (${network})`);
      }
      validateAddressForNetwork(input.recipientAddress, network);
      const reservations = await db.listReservationsByResource(resource.resourceId);
      const reservationOutpoints = new Set(
        reservations.filter((r) => r.state === "reserved").map((r) => `${r.txid}:${r.vout}`)
      );
      const allUtxos = await db.listUtxos();
      const candidates = allUtxos.filter(
        (u) => u.resourceId === resource.resourceId && !reservationOutpoints.has(`${u.txid}:${u.vout}`)
      );
      const result = allocateUtxos(candidates, {
        amountSatoshis: input.amountSatoshis,
        feeReserveSatoshis: input.feeRateSatoshisPerKb != null ? Math.max(500, Math.ceil((input.feeRateSatoshisPerKb / 1000) * 250)) : 500,
        assetId: input.assetId,
        keyId: active.keyId
      });
      if (!result.ok) {
        throw new P2pkhAllocationError(result.error);
      }
      const { address: changeAddress } = await deps.vault.withPrivateKey(active.keyId, async (m) => deriveP2pkhAddress(m.hex, network));
      const outputs: Array<{ address: string; value: number }> = [
        { address: input.recipientAddress, value: result.allocation.requestedSatoshis }
      ];
      if (result.allocation.changeSatoshis > 0) {
        outputs.push({ address: changeAddress, value: result.allocation.changeSatoshis });
      }
      return {
        allocation: result.allocation,
        changeAddress,
        outputs,
        estimatedFeeSatoshis: result.allocation.feeReserveSatoshis
      };
    },

    async submit(preview, input) {
      const network = assetIdToNetwork(input.assetId);
      const db = await deps.getDb();
      const active = deps.getActiveKey();
      const resourceId = makeResourceId(active.keyId, network);
      const resource = await db.getResource(resourceId);
      if (!resource) {
        throw new Error(`P2PKH resource not found for active key (${network})`);
      }
      const pendingId = crypto.randomUUID();
      const now = new Date().toISOString();

      // 1. 签名（vault.withPrivateKey 内执行）。
      let rawTxHex: string;
      try {
        const { publicKeyHex, address: changeAddress } = await deps.vault.withPrivateKey(active.keyId, async (m) => deriveP2pkhAddress(m.hex, network));
        const unsigned = buildP2pkhTx({
          allocation: preview.allocation,
          recipientAddress: input.recipientAddress,
          changeAddress
        });
        rawTxHex = await deps.vault.withPrivateKey(active.keyId, async (m) => signP2pkhTx(unsigned, preview.allocation.selected, m, publicKeyHex));
      } catch (err) {
        await writeFailedPending(db, {
          id: pendingId,
          resourceId: resource.resourceId,
          keyId: active.keyId,
          publicKeyHash: active.publicKeyHash,
          network,
          assetId: input.assetId,
          recipientAddress: input.recipientAddress,
          amountSatoshis: input.amountSatoshis,
          inputOutpoints: preview.allocation.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
          createdAt: now,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }

      // 2. 写 pending transfer。
      const pending: P2pkhPendingTransfer = {
        id: pendingId,
        resourceId: resource.resourceId,
        keyId: active.keyId,
        publicKeyHash: active.publicKeyHash,
        network,
        assetId: input.assetId,
        recipientAddress: input.recipientAddress,
        amountSatoshis: input.amountSatoshis,
        status: "pending",
        inputOutpoints: preview.allocation.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        createdAt: now,
        updatedAt: now
      };
      await db.putPendingTransfer(pending);

      // 3. 广播（broadcast 优先级由 service 内部强制）。
      let broadcastRes;
      try {
        broadcastRes = await deps.woc.broadcast(network, rawTxHex, { timeoutMs: 30_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDefinitiveRejection = isDefinitivelyRejectedError(msg);
        if (isDefinitiveRejection) {
          await db.putPendingTransfer({
            ...pending,
            status: "failed",
            error: msg,
            updatedAt: new Date().toISOString()
          });
          return {
            status: "rejected",
            rawTxHex,
            error: msg,
            pendingTransferId: pendingId,
            reservationIds: []
          };
        }
        await db.putPendingTransfer({
          ...pending,
          status: "unknown",
          error: msg,
          updatedAt: new Date().toISOString()
        });
        const unknownReservationIds: string[] = [];
        for (const u of preview.allocation.selected) {
          const id = reservationIdFor(resource.resourceId, u.txid, u.vout);
          const reservation: P2pkhUtxoReservation = {
            id,
            resourceId: resource.resourceId,
            keyId: active.keyId,
            publicKeyHash: active.publicKeyHash,
            network,
            txid: u.txid,
            vout: u.vout,
            spendingTxid: pendingId,
            state: "reserved",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await db.putReservation(reservation);
          unknownReservationIds.push(id);
        }
        return {
          status: "unknown",
          rawTxHex,
          error: msg,
          pendingTransferId: pendingId,
          reservationIds: unknownReservationIds
        };
      }

      const txid = broadcastRes.txid;

      // 4. 写 reservation。
      const reservationIds: string[] = [];
      for (const u of preview.allocation.selected) {
        const id = reservationIdFor(resource.resourceId, u.txid, u.vout);
        const reservation: P2pkhUtxoReservation = {
          id,
          resourceId: resource.resourceId,
          keyId: active.keyId,
          publicKeyHash: active.publicKeyHash,
          network,
          txid: u.txid,
          vout: u.vout,
          spendingTxid: txid,
          state: "reserved",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await db.putReservation(reservation);
        reservationIds.push(id);
      }

      // 5. 更新 pending 状态为 broadcast。
      await db.putPendingTransfer({
        ...pending,
        status: "broadcast",
        txid,
        updatedAt: new Date().toISOString()
      });

      // 6. 触发一次高优先级 recent-sync。
      deps.messageBus.publish(P2PKH_MSG.TRANSFER_BROADCAST, { resourceId: resource.resourceId, txid });

      return {
        status: "broadcast",
        txid,
        rawTxHex,
        pendingTransferId: pendingId,
        reservationIds
      };
    }
  };
}

async function writeFailedPending(
  db: P2pkhDbHandle,
  input: {
    id: string;
    resourceId: string;
    keyId: string;
    publicKeyHash: string;
    network: "main" | "test";
    assetId: P2pkhAssetId;
    recipientAddress: string;
    amountSatoshis: number;
    inputOutpoints: Array<{ txid: string; vout: number; value: number }>;
    createdAt: string;
    error: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db.putPendingTransfer({
    id: input.id,
    resourceId: input.resourceId,
    keyId: input.keyId,
    publicKeyHash: input.publicKeyHash,
    network: input.network,
    assetId: input.assetId,
    recipientAddress: input.recipientAddress,
    amountSatoshis: input.amountSatoshis,
    status: "failed",
    inputOutpoints: input.inputOutpoints,
    createdAt: input.createdAt,
    updatedAt: now,
    error: input.error
  });
}

/**
 * 判断广播错误是否是 WOC 明确拒绝（非网络/超时/5xx）。
 * 只有 WOC 端确认不会接受该交易时返回 true；其他错误一律视为未知结果。
 */
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
