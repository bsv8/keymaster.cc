// packages/plugin-sat-subscription/src/defaults.ts
// SatSubscription 缺省供应商。
//
// 设计缘由：
//   - main/test 由已解锁钱包身份决定，不由构建模式决定；
//   - dev 可显式注入临时网关；不改变钱包链网络，不持久化临时默认值；
//   - 缺省供应商是「出口」：当前 owner 新消息默认从它发布；
//   - 入口不做单一化——所有被选为接收方的供应商都会侦听；
//   - 用户清空供应商列表后，下次启动重新回到缺省供应商，
//     因此产品永远有一个可用出口。

import type { SatSupplierConfigV1 } from "@keymaster/contracts";
import type { SatSubscriptionStateSnapshot } from "./satState.js";
import { multiaddr } from "@multiformats/multiaddr";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";

/** 缺省供应商对应的网络选择。 */
export type SatDefaultNetwork = "mainnet" | "testnet";

/** 缺省供应商本地编号。 */
export const SAT_DEFAULT_SUPPLIER_ID = "bsv8";
/** 缺省供应商显示名称。 */
export const SAT_DEFAULT_SUPPLIER_NAME = "bsv8";
/** 缺省供应商身份公钥；testnet / mainnet 共用同一把网关公钥。 */
export const SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX =
  "031e6690e2c12ef4f7b96204d6c96652625f7f300606f01f17f7b089c076425918";

/** 缺省供应商可拨号地址；按网络区分。 */
export const SAT_DEFAULT_SUPPLIER_MULTIADDRS: Readonly<Record<SatDefaultNetwork, readonly string[]>> =
  Object.freeze({
    mainnet: Object.freeze([
      "/dns/us-gateway.bsv8.com/tcp/443/tls/ws/p2p/16Uiu2HAmEhfHraPUP1YrYQFy6M8TTbtCZq6A7BGcXi77ZwCS5jxj"
    ]),
    testnet: Object.freeze([
      "/dns/ustest-gateway.bsv8.com/tcp/443/tls/ws/p2p/16Uiu2HAmEhfHraPUP1YrYQFy6M8TTbtCZq6A7BGcXi77ZwCS5jxj"
    ])
  });

/** 判断设置输入是否试图伪装、覆盖或禁用编译内置 Supplier。 */
export function isBuiltInDefaultSupplierConfig(config: SatSupplierConfigV1): boolean {
  const addresses = new Set([
    ...SAT_DEFAULT_SUPPLIER_MULTIADDRS.mainnet,
    ...SAT_DEFAULT_SUPPLIER_MULTIADDRS.testnet,
  ]);
  return config.supplierId === SAT_DEFAULT_SUPPLIER_ID
    || config.supplierPublicKeyHex === SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX
    || config.multiaddrs.some((address) => addresses.has(address));
}

/** 构造指定网络的缺省供应商配置。 */
export function createDefaultSatSupplierConfig(network: SatDefaultNetwork, devJson?: string): SatSupplierConfigV1 {
  if (network !== "mainnet" && network !== "testnet") throw new Error("SatSubscription 缺省需要明确的钱包网络");
  if (devJson !== undefined) {
    const value: unknown = JSON.parse(devJson);
    if (!value || typeof value !== "object" || !("publicKeyHex" in value) || !("multiaddrs" in value)
      || typeof value.publicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(value.publicKeyHex)
      || !Array.isArray(value.multiaddrs) || value.multiaddrs.length === 0) throw new Error("dev 网关需要 publicKeyHex 和非空 multiaddrs");
    const peer = peerIdFromPublicKeyBytes(hexToBytes(value.publicKeyHex)).toString();
    const addresses = value.multiaddrs.map((address: unknown) => {
      if (typeof address !== "string") throw new Error("dev 网关地址必须是字符串");
      const parsed = multiaddr(address);
      const components = parsed.getComponents();
      const last = components[components.length - 1];
      if (last?.name !== "p2p" || last.value !== peer) throw new Error("dev 网关地址与公钥身份不一致");
      return parsed.toString();
    });
    const name = "name" in value ? value.name : "dev 网关";
    if (typeof name !== "string" || !name.trim()) throw new Error("dev 网关名称无效");
    return { supplierId: SAT_DEFAULT_SUPPLIER_ID, name, supplierPublicKeyHex: value.publicKeyHex, multiaddrs: addresses, enabled: true };
  }
  return {
    supplierId: SAT_DEFAULT_SUPPLIER_ID,
    name: SAT_DEFAULT_SUPPLIER_NAME,
    supplierPublicKeyHex: SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
    multiaddrs: [...SAT_DEFAULT_SUPPLIER_MULTIADDRS[network]],
    enabled: true
  };
}

/**
 * 把缺省供应商注入运行时快照。
 *
 * 规则：
 *   - bsv8 是编译内置能力，永远只在内存中出现，不由 setting.json 配置；
 *   - setting.json 只提供用户新增 Supplier 和新增 Supplier 的当前选择；
 *   - 缺少默认发布选择时使用 bsv8，接收入口总是包含 bsv8，再追加用户选择的
 *     已启用 Supplier；
 *   - owner 公钥缺失时不注入任何配置（调用方应先绑定 owner）。
 *
 * 结果只作为运行时初始快照；Repository 保存时会再次过滤 bsv8 和默认值。
 */
export function applyDefaultSatSupplier(
  snapshot: SatSubscriptionStateSnapshot,
  network: SatDefaultNetwork,
  devJson?: string,
): SatSubscriptionStateSnapshot {
  if (!snapshot.ownerPublicKeyHex) return snapshot;
  const supplier = createDefaultSatSupplierConfig(network, devJson);
  const customSuppliers = snapshot.suppliers.filter((item) => item.supplierId !== SAT_DEFAULT_SUPPLIER_ID);
  const customById = new Map(customSuppliers.map((item) => [item.supplierId, item]));
  const previousSettings = snapshot.ownerSettings;
  const customDefault = previousSettings?.defaultPublishSupplierId
    && previousSettings.defaultPublishSupplierId !== SAT_DEFAULT_SUPPLIER_ID
    && customById.get(previousSettings.defaultPublishSupplierId)?.enabled === true
    ? previousSettings.defaultPublishSupplierId
    : null;
  const customReceive = (previousSettings?.receiveSupplierIds ?? [])
    .filter((supplierId) => supplierId !== SAT_DEFAULT_SUPPLIER_ID)
    .filter((supplierId) => customById.get(supplierId)?.enabled === true);
  return {
    ...snapshot,
    suppliers: [supplier, ...customSuppliers],
    ownerSettings: {
      ownerPublicKeyHex: snapshot.ownerPublicKeyHex,
      defaultPublishSupplierId: customDefault ?? supplier.supplierId,
      receiveSupplierIds: [supplier.supplierId, ...new Set(customReceive)]
    }
  };
}
