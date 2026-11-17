// STAS WOC 查询契约。
import type { BsvNetwork } from "./vault.js";
import type { WocRequestOptions } from "./woc.js";

/** STAS token entry。 */
export interface WocStasTokenEntry {
  symbol: string;
  issuer?: string;
  /** provider-defined unit 下的余额。 */
  balance: number;
}

/** STAS service。 */
export interface WocStasService {
  /** 列出某 BSV 地址持有的 STAS token。 */
  listAddressTokens(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocStasTokenEntry[]>;
}
