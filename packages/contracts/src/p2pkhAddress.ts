import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/**
 * /transfer 页面当前使用的收款方状态。
 *
 * 地址是签名与广播使用的最终支付真值；identity 只用于派生地址、联系人
 * 反查与页面核对，不得在地址与身份冲突时静默合并。
 */
export interface TransferRecipient {
  /** 收款人身份：压缩公钥 hex；来自联系人、手工输入或地址反查命中。 */
  identity?: {
    /** 压缩公钥 hex（小写）。 */
    publicKeyHex: string;
    /** 身份来源：联系人、手工公钥或地址反查命中。 */
    source: "contact" | "manual" | "resolved";
  };
  /** 网络：主网 main 或测试网 test。 */
  network: BsvNetwork;
  /** 收款地址：签名与广播使用的最终支付真值。 */
  address: string;
  /** 地址来源：由公钥派生或手工输入。 */
  addressSource: "derived" | "manual";
  /** 命中的联系人昵称；未命中时省略。 */
  contactName?: string;
}

/**
 * P2PKH 地址编解码能力。
 *
 * 平台页面只通过 capability 消费该能力；具体的 HASH160、Base58Check 与
 * 网络 version 处理由 plugin-p2pkh 提供，避免平台重复实现地址算法。
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
