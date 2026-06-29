// packages/plugin-token-stas/src/stasService.ts
// STAS service：plugin-token-stas 内部封装，组合 woc.stas.service 与
// p2pkh.service（取当前 active key 的 BSV 地址）。
//
// 设计缘由：
//   - phase 1 只支持主网 STAS：service 强制走 main network；testnet
//     不进入统一持仓页。
//   - STAS 单条 entry 自带 balance；service 直接透传。
//   - 业务插件禁止直接 fetch WOC：所有外网请求都走 woc.stas.service。
//   - p2pkh.service 契约类型在 plugin-p2pkh 内部，跨包 import 会违反
//     scripts/check-boundaries.mjs 的边界规则；本文件以 consumer-side
//     接口形态重新声明本 plugin 实际用到的子集。

import type {
  BsvNetwork,
  KeyspaceService,
  WocStasService,
  WocStasTokenEntry
} from "@keymaster/contracts";

/** p2pkh.service capability key。 */
export const P2PKH_CAPABILITY = "p2pkh.service";

/** consumer-side P2PKH resource；plugin-token-stas 只用 publicKeyHex / address / network。 */
export interface P2pkhKeyResourceForStas {
  publicKeyHex: string;
  address: string;
  network: BsvNetwork;
}

/** consumer-side P2PKH service。 */
export interface P2pkhServiceForStas {
  listResources(assetId: "bsv" | "bsvtest"): Promise<P2pkhKeyResourceForStas[]>;
}

const STAS_NETWORK: BsvNetwork = "main";

export interface StasTokenWithEntry {
  entry: WocStasTokenEntry;
  address: string;
  network: BsvNetwork;
}

export interface StasServiceHandle {
  listActiveKeyTokens(): Promise<StasTokenWithEntry[]>;
}

export interface CreateStasServiceOptions {
  keyspace: KeyspaceService;
  p2pkh: P2pkhServiceForStas;
  wocStas: WocStasService;
}

export function createStasService(options: CreateStasServiceOptions): StasServiceHandle {
  if (!options || !options.keyspace || !options.p2pkh || !options.wocStas) {
    throw new Error("createStasService: keyspace / p2pkh / wocStas are required");
  }
  const keyspace = options.keyspace;
  const p2pkh = options.p2pkh;
  const wocStas = options.wocStas;

  async function activeKeyMainAddresses(): Promise<string[]> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) return [];
    const list = await p2pkh.listResources("bsv");
    return list
      .filter((r) => r.publicKeyHex === state.activePublicKeyHex && r.network === STAS_NETWORK)
      .map((r) => r.address);
  }

  return {
    async listActiveKeyTokens() {
      const addresses = await activeKeyMainAddresses();
      const out: StasTokenWithEntry[] = [];
      for (const address of addresses) {
        const entries = await wocStas.listAddressTokens(STAS_NETWORK, address);
        for (const entry of entries) {
          out.push({ entry, address, network: STAS_NETWORK });
        }
      }
      return out;
    }
  };
}