/**
 * key.json 的硬件公开记录。它只是持久身份绑定，不是设备持有权证明。
 * 恢复连接仍必须用 VLP 挑战验签；不得用 USB 编号或本记录代替认证。
 * 不存软件密文副本、PIN、私钥或可自动回退的软件解锁材料。
 */
export interface HardwareKeyDocumentV1 {
  format: "keymaster.hardware-key";
  version: 1;
  backend: "vaultlink";
  wireVersion: 2;
  label: string;
  publicKeyHex: string;
  walletGeneration: string;
  backendGeneration: number;
}

export function validateHardwareKeyDocument(value: unknown): HardwareKeyDocumentV1 {
  const fail = (): never => { throw new TypeError("Invalid hardware Key record"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const fields = ["format", "version", "backend", "wireVersion", "label", "publicKeyHex", "walletGeneration", "backendGeneration"];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))) return fail();
  if (record.format !== "keymaster.hardware-key" || record.version !== 1 || record.backend !== "vaultlink" || record.wireVersion !== 2) return fail();
  if (typeof record.label !== "string" || !record.label.length || new TextEncoder().encode(record.label).length > 1024) return fail();
  // 曲线点有效性由钱包仓储使用实际 secp256k1 库检查。
  if (typeof record.publicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(record.publicKeyHex)) return fail();
  if (typeof record.walletGeneration !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.walletGeneration)) return fail();
  if (typeof record.backendGeneration !== "number" || !Number.isSafeInteger(record.backendGeneration) || record.backendGeneration < 1 || record.backendGeneration > 0xffffffff) return fail();
  return {
    format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2,
    label: record.label, publicKeyHex: record.publicKeyHex,
    walletGeneration: record.walletGeneration, backendGeneration: record.backendGeneration,
  };
}
