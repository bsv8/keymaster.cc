// packages/plugin-sat-subscription/src/defaults.ts
// SatSubscription 缺省供应商。
//
// 设计缘由：
//   - 开发（`npm run dev`）使用 testnet 网关，正式构建
//     （`npm run build` / `npm run build:production`）使用 mainnet 网关；
//   - 缺省供应商是「出口」：当前 owner 新消息默认从它发布；
//   - 入口不做单一化——所有被选为接收方的供应商都会侦听；
//   - 用户清空供应商列表后，下次启动重新回到缺省供应商，
//     因此产品永远有一个可用出口。

import type { SatSupplierConfigV1 } from "@keymaster/contracts";
import type { SatSubscriptionStateSnapshot } from "./satState.js";

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

/** 构造指定网络的缺省供应商配置。 */
export function createDefaultSatSupplierConfig(network: SatDefaultNetwork): SatSupplierConfigV1 {
  return {
    supplierId: SAT_DEFAULT_SUPPLIER_ID,
    name: SAT_DEFAULT_SUPPLIER_NAME,
    supplierPublicKeyHex: SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
    multiaddrs: [...SAT_DEFAULT_SUPPLIER_MULTIADDRS[network]],
    enabled: true
  };
}

/**
 * 把缺省供应商应用到 owner 快照。
 *
 * 规则：
 *   - 已有供应商：保持用户配置，只补齐缺失的 ownerSettings；
 *   - 供应商为空：写入缺省供应商，并把它设为默认发布（出口）与接收方
 *     （入口）；入口本身允许用户继续追加更多接收供应商；
 *   - owner 公钥缺失时不落任何配置（调用方应先绑定 owner）。
 *
 * 结果只作为运行时初始快照；真正持久化仍发生在用户修改设置时。
 */
export function applyDefaultSatSupplier(
  snapshot: SatSubscriptionStateSnapshot,
  network: SatDefaultNetwork
): SatSubscriptionStateSnapshot {
  if (!snapshot.ownerPublicKeyHex) return snapshot;
  if (snapshot.suppliers.length > 0) {
    return {
      ...snapshot,
      ownerSettings: snapshot.ownerSettings ?? {
        ownerPublicKeyHex: snapshot.ownerPublicKeyHex,
        defaultPublishSupplierId: null,
        receiveSupplierIds: []
      }
    };
  }
  const supplier = createDefaultSatSupplierConfig(network);
  return {
    ...snapshot,
    suppliers: [supplier],
    ownerSettings: {
      ownerPublicKeyHex: snapshot.ownerPublicKeyHex,
      defaultPublishSupplierId: supplier.supplierId,
      receiveSupplierIds: [supplier.supplierId]
    }
  };
}
