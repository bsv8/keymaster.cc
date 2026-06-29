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
}

export interface OrdinalsOutpointHit {
  /** 用户展示用 outpoint（"txid:vout"）。 */
  outpoint: string;
  inscription: Woc1SatOrdinalsInscription;
  address: string;
  network: BsvNetwork;
}

export interface OrdinalsServiceHandle {
  /**
   * 列出当前 active key 持有的 1Sat Ordinals collectibles。
   * - 命中 outpoint（inscription 非 null）：计入结果。
   * - 404 / not-found（inscription = null）：静默跳过。
   * - 其它错误：抛给上游；provider 在 listCollectibles 内部捕获后报告 provider 失败。
   */
  listActiveKeyCollectibles(): Promise<OrdinalsOutpointHit[]>;
  /** 取单个 outpoint 的 inscription。 */
  getOutpoint(outpoint: string): Promise<OrdinalsOutpointHit | null>;
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

  async function activeKeyUtxos(assetId: "bsv" | "bsvtest"): Promise<P2pkhUtxoFor1Sat[]> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) return [];
    return p2pkh.listUtxos({ assetId, ownerPublicKeyHex: state.activePublicKeyHex });
  }

  return {
    async listActiveKeyCollectibles() {
      // phase 1：1Sat Ordinals 只覆盖 BSV 主网；testnet 不进入 collectible 列表。
      const networks: Array<{ assetId: "bsv" | "bsvtest"; network: BsvNetwork }> = [
        { assetId: "bsv", network: "main" }
      ];
      const out: OrdinalsOutpointHit[] = [];
      for (const { assetId, network } of networks) {
        const utxos = await activeKeyUtxos(assetId);
        for (const u of utxos) {
          // 用户可见 collectibleId 用 "txid:vout"（更可读）；
          // 1Sat endpoint 期望的 outpoint 字符串是 "txid_vout"（下划线）。
          const displayOutpoint = `${u.txid}:${u.vout}`;
          const wocOutpoint = toWocOutpoint(u.txid, u.vout);
          // wocOneSat.getOutpointInscription 内部 404 -> null；
          // 其它错误向上抛，provider 内部捕获后报告 provider 失败。
          const inscription = await wocOneSat.getOutpointInscription(network, wocOutpoint);
          if (!inscription) continue;
          out.push({ outpoint: displayOutpoint, inscription, address: u.address, network });
        }
      }
      return out;
    },
    async getOutpoint(outpoint) {
      // outpoint 形参是 "txid:vout"（plugin 内部 collectibleId 格式）；
      // 翻译为 WOC "txid_vout" 字符串再调 1Sat endpoint。
      const [txid, voutStr] = outpoint.split(":");
      if (!txid || !voutStr) return null;
      const vout = Number(voutStr);
      if (!Number.isFinite(vout)) return null;
      const wocOutpoint = toWocOutpoint(txid, vout);
      const network: BsvNetwork = "main";
      const inscription = await wocOneSat.getOutpointInscription(network, wocOutpoint);
      if (!inscription) return null;
      return { outpoint, inscription, address: inscription.owner ?? "", network };
    }
  };
}