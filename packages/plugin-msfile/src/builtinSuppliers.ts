// 平台内置的 MSFile 供应商。
//
// 这些供应商是系统缺省能力，不来自用户 K-V，也不能被删除或改写。
// Service 层负责把它们合并进设置快照和数据面供应商快照，并拒绝针对
// 同一公钥的 upsert/delete；页面只显示固定的“系统内置”身份。

import type { MsFileSupplierConfig } from "@keymaster/contracts";

/** BSV8 官方 msfiles 服务公钥；地址中的 PeerId 必须与该公钥派生结果一致。 */
export const BSV8_OFFICIAL_MSFILES_SUPPLIER_PUBLIC_KEY_HEX =
  "039da34bc7ccccff68bb7b4295094f4d9180020302909bb75e4b4610d865619c26";

/** BSV8 官方 msfiles 服务的 WSS multiaddr（443 + 受信 TLS）。 */
export const BSV8_OFFICIAL_MSFILES_SUPPLIER_ADDRESS =
  "/dns4/msfiles.bsv8.com/tcp/443/tls/ws/p2p/16Uiu2HAmPGLn8pLWrSTqidMuq5P1rQBo9UhRwdAUjNVyjSwurtvH";

/** 只读系统供应商列表；调用方通过 merge 函数取得副本后再使用。 */
export const MSFILE_BUILTIN_SUPPLIERS: readonly MsFileSupplierConfig[] = [
  {
    name: "BSV8 Official MSFiles",
    supplierPublicKeyHex: BSV8_OFFICIAL_MSFILES_SUPPLIER_PUBLIC_KEY_HEX,
    addresses: [BSV8_OFFICIAL_MSFILES_SUPPLIER_ADDRESS],
    enabled: true,
    builtin: true,
  },
];

/** 公钥是否是内置供应商；内置供应商不允许删除或改写。 */
export function isBuiltinMsFileSupplier(
  supplierPublicKeyHex: string,
  builtins: readonly MsFileSupplierConfig[] = MSFILE_BUILTIN_SUPPLIERS,
): boolean {
  const key = supplierPublicKeyHex.toLowerCase();
  return builtins.some((supplier) => supplier.supplierPublicKeyHex.toLowerCase() === key);
}

/**
 * 把内置供应商合并到持久化列表前面。
 *
 * 持久化记录即使带有同一公钥也不会胜出，避免旧数据或手工写入绕过
 * 系统缺省身份；返回的每个内置记录都是新的副本，调用方不能改到常量。
 */
export function mergeBuiltinMsFileSuppliers(
  persisted: readonly MsFileSupplierConfig[],
  builtins: readonly MsFileSupplierConfig[] = MSFILE_BUILTIN_SUPPLIERS,
): MsFileSupplierConfig[] {
  const builtinKeys = new Set(builtins.map((supplier) => supplier.supplierPublicKeyHex.toLowerCase()));
  const merged = builtins.map((supplier) => ({
    ...supplier,
    addresses: [...supplier.addresses],
  }));
  return [...merged, ...persisted.filter((entry) => !builtinKeys.has(entry.supplierPublicKeyHex.toLowerCase()))];
}
