// 产品服务目录只在应用装配入口使用；底层 service 缺省为空，测试显式注入。
import type { BsvNetwork, MsFileArbitrationService, MsFileSellerSettings } from "@keymaster/contracts";
import { deriveSupplierPeerId, normalizeSupplierAddress } from "./supplierConfig.js";

const publicKeyHex = "036258d4f23285e868cd91ad0a84c7ec4d798dc6e3965e3f75755d9c0dca4fc4ac";
const peerId = "16Uiu2HAmKGtsKHXsLAdaneryb5r7L6G6Adg8QctE9yKx3GGycbNB";

/** 当前两环境共用身份，网络隔离依靠固定域名；不能只按公钥选择地址。 */
export function productArbitrationServices(network: BsvNetwork, devJson?: string): readonly MsFileArbitrationService[] {
  if (network !== "main" && network !== "test") throw new Error("仲裁配置需要明确的钱包网络");
  if (devJson !== undefined) {
    const values: unknown = JSON.parse(devJson);
    if (!Array.isArray(values)) throw new Error("dev 仲裁目录必须是 JSON 数组");
    const keys = new Set<string>();
    return Object.freeze(values.map((value: unknown) => {
      if (!value || typeof value !== "object" || !("publicKeyHex" in value) || !("address" in value)
        || typeof value.publicKeyHex !== "string" || typeof value.address !== "string") throw new Error("dev 仲裁条目需要 publicKeyHex 和 address");
      const peer = deriveSupplierPeerId(value.publicKeyHex);
      const address = normalizeSupplierAddress(value.address, peer, { allowLoopbackWs: true });
      if (!address.ok) throw new Error(`dev 仲裁地址无效：${address.message}`);
      if (keys.has(value.publicKeyHex)) throw new Error("dev 仲裁目录公钥重复");
      keys.add(value.publicKeyHex);
      const name = "name" in value ? value.name : "dev 仲裁";
      if (typeof name !== "string" || !name.trim()) throw new Error("dev 仲裁名称无效");
      return Object.freeze({ name, publicKeyHex: value.publicKeyHex, address: address.value.normalized });
    }));
  }
  const domain = network === "main" ? "arbitration.bsv8.com" : "arbitration-test.bsv8.com";
  return Object.freeze([Object.freeze({
    name: network === "main" ? "BSV8 主网仲裁" : "BSV8 测试网仲裁",
    publicKeyHex,
    address: `/dns4/${domain}/tcp/443/tls/ws/p2p/${peerId}`,
  })]);
}

/** 内置仲裁方排在前面；用户持久化设置只能增加公钥，不能删除内置身份。 */
export function withRequiredArbitrators(settings: MsFileSellerSettings, services: readonly MsFileArbitrationService[]): MsFileSellerSettings {
  return { ...settings, supportedArbiterPublicKeys: [...new Set([
    ...services.map(service => service.publicKeyHex), ...settings.supportedArbiterPublicKeys,
  ])] };
}
