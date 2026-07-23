// packages/plugin-collectible-1satordinals/src/ordinalsService.ts
// 1Sat Ordinals service：plugin-collectible-1satordinals 内部封装，组合
// p2pkh.service（取当前 active key 的未花费 UTXO 集合）与
// woc.1satordinals.service（按 outpoint 查 inscription）。
//
// 设计缘由（施工单）：
//   - WOC 文档当前没有"按地址列出 1Sat 持仓"的统一入口，因此不能用地址
//     全量拉取；必须走：
//       当前 active key 的 P2PKH 未花费 UTXO 集合
//       -> 对每个 outpoint 调 1Sat 查询
//       -> 404 / not-found 视为"这不是 1Sat collectible"
//       -> 命中的才进入 collectible 列表
//   - 当前未花费 outpoint 才代表"当前仍持有"；这是 phase 1 的正确真值。
//   - 404 / not-found 不应被业务插件记成 provider 错误；woc.1satordinals
//     service 内部已经把 404 翻译成 null，service 直接透传 null。
//   - WOC 1Sat endpoint 期望的 outpoint 字符串格式是 "txid_vout"（下划线），
//     业务侧拿到的 P2PKH UTXO 是 { txid, vout }；本 service 内部用
//     toWocOutpoint() 翻译为 WOC 字符串。
//   - p2pkh.service 契约类型在 plugin-p2pkh 内部，跨包 import 会违反
//     scripts/check-boundaries.mjs 的边界规则；本文件以 consumer-side
//     接口形态重新声明本 plugin 实际用到的子集。

import type {
  BsvNetwork,
  KeyspaceService,
  Woc1SatOrdinalsContent,
  Woc1SatOrdinalsInscription,
  Woc1SatOrdinalsService
} from "@keymaster/contracts";
import { toWocOutpoint } from "@keymaster/contracts";

/** p2pkh.service capability key。 */
export const P2PKH_CAPABILITY = "p2pkh.service";

/** consumer-side P2PKH UTXO；本插件只用 txid/vout/address。 */
export interface P2pkhUtxoFor1Sat {
  txid: string;
  vout: number;
  value: number;
  address: string;
}

/** consumer-side P2PKH filter 形态（只声明本插件实际字段）。 */
export interface P2pkhUtxoFilterFor1Sat {
  assetId?: "bsv" | "bsvtest";
  ownerPublicKeyHex?: string;
}

/** consumer-side P2PKH service。 */
export interface P2pkhServiceFor1Sat {
  listUtxos(filter?: P2pkhUtxoFilterFor1Sat): Promise<P2pkhUtxoFor1Sat[]>;
  listUtxosRaw?(filter?: P2pkhUtxoFilterFor1Sat): Promise<P2pkhUtxoFor1Sat[]>;
  getGlobalSettings?(): { includeTestnet: boolean };
  onDataChanged?(handler: () => void): () => void;
  onGlobalSettingsChange?(handler: (settings: { includeTestnet: boolean }) => void): () => void;
}

export interface OrdinalsOutpointHit {
  /** 用户展示用 outpoint（"txid:vout"）。 */
  outpoint: string;
  inscription: Woc1SatOrdinalsInscription;
  address: string;
  network: BsvNetwork;
  observation?: "unconfirmed" | "confirmed";
  canonicalTxid?: string;
}

export interface OrdinalsServiceHandle {
  /**
   * 列出当前 active key 持有的 1Sat Ordinals collectibles。
   * - 命中 outpoint（inscription 非 null）：计入结果。
   * - 404 / not-found（inscription = null）：静默跳过。
   * - 其它错误：抛给上游；provider 在 listCollectibles 内部捕获后报告 provider 失败。
   */
  listActiveKeyCollectibles(signal?: AbortSignal): Promise<OrdinalsOutpointHit[]>;
  /** 取单个 outpoint 的 inscription。 */
  getOutpoint(outpoint: string, signal?: AbortSignal): Promise<OrdinalsOutpointHit | null>;
  /** 取单个 outpoint 的原始 content。 */
  getOutpointContent(outpoint: string, signal?: AbortSignal): Promise<Woc1SatOrdinalsContent | null>;
  /** 取单个 outpoint 的原始 locking script。 */
  getTransactionOutputScript(outpoint: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** 主动复扫当前 active key 的 1Sat collectibles，并通知订阅者刷新。 */
  sync(signal?: AbortSignal): Promise<void>;
  /** 监听当前 active key / P2PKH 数据变更，供 collectible provider 触发重拉。 */
  onChange(handler: () => void): () => void;
  dispose(): void;
}

export interface CreateOrdinalsServiceOptions {
  keyspace: KeyspaceService;
  p2pkh: P2pkhServiceFor1Sat;
  wocOneSat: Woc1SatOrdinalsService;
}

export function createOrdinalsService(options: CreateOrdinalsServiceOptions): OrdinalsServiceHandle {
  if (!options || !options.keyspace || !options.p2pkh || !options.wocOneSat) {
    throw new Error("createOrdinalsService: keyspace / p2pkh / wocOneSat are required");
  }
  const keyspace = options.keyspace;
  const p2pkh = options.p2pkh;
  const wocOneSat = options.wocOneSat;
  const unsubs: Array<() => void> = [];
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  if (p2pkh.onDataChanged) unsubs.push(p2pkh.onDataChanged(() => notify()));
  if (p2pkh.onGlobalSettingsChange) unsubs.push(p2pkh.onGlobalSettingsChange(() => notify()));

  function includeTestnet(): boolean {
    try {
      return p2pkh.getGlobalSettings?.().includeTestnet ?? false;
    } catch {
      return false;
    }
  }

  async function activeKeyUtxos(assetId: "bsv" | "bsvtest", publicKeyHex: string): Promise<P2pkhUtxoFor1Sat[]> {
    try {
      if (p2pkh.listUtxosRaw) {
        return await p2pkh.listUtxosRaw({ assetId, ownerPublicKeyHex: publicKeyHex });
      }
      return await p2pkh.listUtxos({ assetId, ownerPublicKeyHex: publicKeyHex });
    } catch {
      return [];
    }
  }

  async function listActiveKeyCollectibles(signal?: AbortSignal): Promise<OrdinalsOutpointHit[]> {
    const startedKeyHex = keyspace.active().activePublicKeyHex;
    if (!startedKeyHex) return [];
    const includeTest = includeTestnet();
    const networks: Array<{ assetId: "bsv" | "bsvtest"; network: BsvNetwork }> = includeTest
      ? [
          { assetId: "bsv", network: "main" },
          { assetId: "bsvtest", network: "test" }
        ]
      : [{ assetId: "bsv", network: "main" }];
    const out: OrdinalsOutpointHit[] = [];
    for (const { assetId, network } of networks) {
      if (signal?.aborted) return out;
      const utxos = await activeKeyUtxos(assetId, startedKeyHex);
      for (const u of utxos) {
        if (signal?.aborted) return out;
        // 用户可见 collectibleId 用 "txid:vout"（更可读）；
        // 1Sat endpoint 期望的 outpoint 字符串是 "txid_vout"（下划线）。
        const displayOutpoint = `${u.txid}:${u.vout}`;
        const wocOutpoint = toWocOutpoint(u.txid, u.vout);
        const inscription = await wocOneSat.getOutpointInscription(network, wocOutpoint, { signal });
        if (!inscription) continue;
        out.push({
          outpoint: displayOutpoint,
          inscription,
          address: u.address,
          network,
          observation: inscription.observation,
          canonicalTxid: inscription.canonicalTxid
        });
      }
    }
    return out;
  }

  async function getOutpoint(outpoint: string, signal?: AbortSignal): Promise<OrdinalsOutpointHit | null> {
    const [txid, voutStr] = outpoint.split(":");
    if (!txid || !voutStr) return null;
    const vout = Number(voutStr);
    if (!Number.isFinite(vout)) return null;
    const wocOutpoint = toWocOutpoint(txid, vout);
    const networks = includeTestnet() ? (["main", "test"] as const) : (["main"] as const);
    let lastError: unknown;
    for (const network of networks) {
      let inscription: Woc1SatOrdinalsInscription | null;
      try {
        inscription = await wocOneSat.getOutpointInscription(network, wocOutpoint, { signal });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!inscription) continue;
      return {
        outpoint,
        inscription,
        address: inscription.owner ?? "",
        network,
        observation: inscription.observation,
        canonicalTxid: inscription.canonicalTxid
      };
    }
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return null;
  }

  async function getOutpointContent(outpoint: string, signal?: AbortSignal): Promise<Woc1SatOrdinalsContent | null> {
    const [txid, voutStr] = outpoint.split(":");
    if (!txid || !voutStr) return null;
    const vout = Number(voutStr);
    if (!Number.isFinite(vout)) return null;
    const wocOutpoint = toWocOutpoint(txid, vout);
    const networks = includeTestnet() ? (["main", "test"] as const) : (["main"] as const);
    let lastError: unknown;
    for (const network of networks) {
      try {
        const content = await wocOneSat.getOutpointContent(network, wocOutpoint, { signal });
        if (content) return content;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return null;
  }

  async function getTransactionOutputScript(outpoint: string, signal?: AbortSignal): Promise<Uint8Array> {
    const [txid, voutStr] = outpoint.split(":");
    if (!txid || !voutStr) return Promise.reject(new Error("Ordinal collectible outpoint is invalid"));
    const vout = Number(voutStr);
    if (!Number.isFinite(vout)) return Promise.reject(new Error("Ordinal collectible outpoint is invalid"));
    const networks = includeTestnet() ? (["main", "test"] as const) : (["main"] as const);
    let lastError: unknown;
    for (const network of networks) {
      try {
        return await wocOneSat.getTransactionOutputScript(network, txid, vout, { signal });
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    throw new Error("Ordinal collectible output script is unavailable");
  }

  async function sync(signal?: AbortSignal): Promise<void> {
    const startedKeyHex = keyspace.active().activePublicKeyHex;
    if (!startedKeyHex) return;
    await listActiveKeyCollectibles(signal);
    if (signal?.aborted) return;
    if (keyspace.active().activePublicKeyHex !== startedKeyHex) return;
    notify();
  }

  return {
    listActiveKeyCollectibles,
    getOutpoint,
    getOutpointContent,
    getTransactionOutputScript,
    sync,
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispose() {
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      listeners.clear();
    }
  };
}
