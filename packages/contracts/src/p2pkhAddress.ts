import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
export { deriveP2pkhAddress } from "./p2pkhPublicKeyAddress.js";

/**
 * /transfer 页面当前使用的收款方状态。
 *
 * 地址是签名与广播使用的最终支付真值；identity 只用于派生地址
 * 与页面核对，不得在地址与身份冲突时静默合并。
 */
export interface TransferRecipient {
  /** 收款人身份：压缩公钥 hex；来自手工输入。 */
  identity?: {
    /** 压缩公钥 hex（小写）。 */
    publicKeyHex: string;
    /** 身份来源：手工公钥。 */
    source: "manual";
  };
  /** 网络：主网 main 或测试网 test。 */
  network: BsvNetwork;
  /** 收款地址：签名与广播使用的最终支付真值。 */
  address: string;
  /** 地址来源：由公钥派生或手工输入。 */
  addressSource: "derived" | "manual";
}

/**
 * P2PKH 地址编解码能力。
 *
 * 平台页面通过 capability 消费该能力。公钥派生复用共享纯算法；
 * plugin-p2pkh 提供编解码门面，平台不复制 HASH160/Base58Check 实现。
 */
export interface P2pkhAddressCodec {
  /** 由压缩公钥与网络派生 P2PKH 地址。 */
  deriveAddress(publicKeyHex: string, network: BsvNetwork): string;
  /** 解析地址；非 P2PKH、长度错误或校验和错误时返回 undefined。 */
  parseAddress(address: string): { network: BsvNetwork; hash160Hex: string } | undefined;
}

/** P2PKH 地址编解码能力的唯一 capability 身份。 */
export const P2PKH_ADDRESS_CODEC_CAPABILITY = defineCapability<P2pkhAddressCodec>({
  kind: "local",
  id: "p2pkh.address-codec",
  version: "1",
});
