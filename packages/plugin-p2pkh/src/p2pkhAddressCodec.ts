import type { P2pkhAddressCodec } from "@keymaster/contracts";
import { publicKeyHexToP2pkhAddress } from "./p2pkhSigner.js";
import { parseP2pkhAddress } from "./p2pkhTransactionParser.js";

/** P2PKH 插件提供给平台页面的地址编解码实现。 */
export const p2pkhAddressCodec: P2pkhAddressCodec = {
  /** 由压缩公钥 hex 派生指定网络的 Base58Check P2PKH 地址。 */
  deriveAddress(publicKeyHex, network) {
    return publicKeyHexToP2pkhAddress(publicKeyHex, network);
  },
  /** 解析地址并返回网络与 HASH160；非法地址返回 undefined。 */
  parseAddress(address) {
    return parseP2pkhAddress(address);
  }
};
