// packages/plugin-token-bsv21/src/bsv21Service.ts
// BSV-21 service：plugin-token-bsv21 内部封装，组合 woc.bsv21.service 与
// p2pkh.service（取当前 active key 的 BSV 地址）。
//
// 设计缘由：
//   - 不在 provider 内直接拿 capability，避免 listTokens / getToken 等
//     调用路径重复 dependency 注入；service 负责把"key -> address ->
//     WOC token"这一段流程封装好。
//   - 业务插件禁止直接 fetch WOC：所有外网请求都走 woc.bsv21.service。
//   - plugin-p2pkh 不可用时（plugin-p2pkh 未启用），bsv21Service 立即
//     抛错；上游 plugin-token-bsv21 manifest 依赖 p2pkh.service，host
//     enable 阶段会直接 blocked，不会出现"半可用空页面"。
//   - p2pkh.service 的契约类型在 plugin-p2pkh 内部，跨包 import 会违反
//     scripts/check-boundaries.mjs 的边界规则；本文件以 consumer-side
//     接口形态重新声明本 plugin 实际用到的子集，避免跨 plugin 依赖。
//     接口字段与 plugin-p2pkh 的实现保持松耦合：plugin-p2pkh 内部类型
//     演进不影响本 plugin，runtime 通过 capability 走结构化类型。

import type {
  BsvNetwork,
  KeyspaceService,
  WocBsv21BalanceResponse,
  WocBsv21Service,
  WocBsv21TokenMeta
} from "@keymaster/contracts";

/** p2pkh.service capability key；与 plugin-p2pkh manifest 提供的字符串一致。 */
export const P2PKH_CAPABILITY = "p2pkh.service";

/** 业务侧 sub-resource 标识；与 plugin-p2pkh 内部 assetId 字面量对齐。 */
export type P2pkhAssetIdForBsv21 = "bsv" | "bsvtest";

/** consumer-side P2PKH resource。 */
export interface P2pkhKeyResourceForBsv21 {
  publicKeyHex: string;
  address: string;
  network: BsvNetwork;
}

/** consumer-side P2PKH service：本 BSV-21 插件只用 listResources 与
 * getGlobalSettings。结构化类型，runtime plugin-p2pkh 的实现自动满足。 */
export interface P2pkhServiceForBsv21 {
  listResources(assetId: P2pkhAssetIdForBsv21): Promise<P2pkhKeyResourceForBsv21[]>;
  getGlobalSettings(): { includeTestnet: boolean };
}

const BSV_MAIN_NETWORK: BsvNetwork = "main";
const BSV_TEST_NETWORK: BsvNetwork = "test";

/** BSV-21 service 句柄。 */
export interface Bsv21ServiceHandle {
  /** 列出当前 active key 全部 BSV 地址上的 token 余额（已合并）。 */
  listActiveKeyTokens(): Promise<TokenWithMeta[]>;
  /** 取单个 token 详情。 */
  getToken(tokenId: string): Promise<{ meta: WocBsv21TokenMeta; balance: WocBsv21BalanceResponse } | null>;
}

/** token + meta + 当前余额；origin 即 tokenId。 */
export interface TokenWithMeta {
  meta: WocBsv21TokenMeta;
  balance: WocBsv21BalanceResponse;
  /** 当前 active key 持有此 token 的地址之一（任一）；详情页可继续引用。 */
  address: string;
  network: BsvNetwork;
}

export interface CreateBsv21ServiceOptions {
  keyspace: KeyspaceService;
  p2pkh: P2pkhServiceForBsv21;
  wocBsv21: WocBsv21Service;
  /** 是否纳入 testnet；缺省跟随 p2pkh 全局设置。 */
  includeTestnet?: () => boolean;
}

export function createBsv21Service(options: CreateBsv21ServiceOptions): Bsv21ServiceHandle {
  if (!options || !options.keyspace || !options.p2pkh || !options.wocBsv21) {
    // 防御性：缺关键依赖时立即抛错，避免 listTokens 时再爆。
    throw new Error("createBsv21Service: keyspace / p2pkh / wocBsv21 are required");
  }
  const keyspace = options.keyspace;
  const p2pkh = options.p2pkh;
  const wocBsv21 = options.wocBsv21;

  function shouldIncludeTestnet(): boolean {
    if (options.includeTestnet) return options.includeTestnet();
    try {
      return p2pkh.getGlobalSettings().includeTestnet;
    } catch {
      return false;
    }
  }

  /** 列出当前 active key 持有的全部 BSV P2PKH 资源（main + 可选 test）。 */
  async function activeKeyResources(): Promise<P2pkhKeyResourceForBsv21[]> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) return [];
    const main = await p2pkh.listResources("bsv");
    const list: P2pkhKeyResourceForBsv21[] = main.filter((r) => r.publicKeyHex === state.activePublicKeyHex);
    if (!shouldIncludeTestnet()) return list;
    try {
      const test = await p2pkh.listResources("bsvtest");
      list.push(...test.filter((r: P2pkhKeyResourceForBsv21) => r.publicKeyHex === state.activePublicKeyHex));
    } catch {
      // testnet 资源不可用时不影响 main。
    }
    return list;
  }

  return {
    async listActiveKeyTokens() {
      const resources = await activeKeyResources();
      const out: TokenWithMeta[] = [];
      for (const r of resources) {
        // 不并发：phase 1 资源量小，避免对 WOC 触发突发流量。
        // 真正并发可以让 BSV-21 协议层暴露 batch endpoint 后再做。
        const metas = await wocBsv21.listAddressTokens(r.network, r.address);
        for (const meta of metas) {
          const balance = await wocBsv21.getAddressTokenBalance(r.network, r.address, meta.origin);
          out.push({ meta, balance, address: r.address, network: r.network });
        }
      }
      return out;
    },
    async getToken(tokenId) {
      // tokenId 即 origin；当前 simple 实现按"任一持有此 origin 的地址"返回。
      const all = await this.listActiveKeyTokens();
      const hit = all.find((t) => t.meta.origin === tokenId);
      if (!hit) return null;
      return { meta: hit.meta, balance: hit.balance };
    }
  };
}

/** capability key；plugin-token-bsv21 manifest 依赖。 */
// P2PKH_CAPABILITY 在文件顶部声明。