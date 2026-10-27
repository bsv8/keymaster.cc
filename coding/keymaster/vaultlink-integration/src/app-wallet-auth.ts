import type {VaultService, VaultWalletState} from "@keymaster/contracts";

/** App 的业务许可在 Keymaster；此处只核对本次已解锁的钱包执行后端。
 * 硬件绝不调用 verifyPassword，更不把页面密码作为设备 PIN。
 * 公钥派生 RPC 在 Root 中核对已验证的设备所有者及当前绑定，不产生签名。
 */
export async function authenticateAppWallet(
  vault: Pick<VaultService, "verifyPassword" | "getCurrentKey" | "createActiveKeyCrypto">,
  publicKeyHex: string,
  password: string,
  walletState: Pick<VaultWalletState, "snapshot">,
): Promise<void> {
  const issued = walletState.snapshot();
  const backend = issued.activeKeyIdentity?.backend ?? "software";
  const assertLive = () => {
    const current = walletState.snapshot();
    if (issued.status !== "unlocked" || issued.activePublicKeyHex !== publicKeyHex
      || current.status !== issued.status || current.activePublicKeyHex !== issued.activePublicKeyHex
      || current.sessionEpoch !== issued.sessionEpoch || current.runGeneration !== issued.runGeneration
      || current.walletGeneration !== issued.walletGeneration
      || current.activeKeyIdentity?.bsvNetwork !== issued.activeKeyIdentity?.bsvNetwork
      || (current.activeKeyIdentity?.backend ?? "software") !== backend) {
      throw new Error("Active wallet key session has been revoked");
    }
  };
  assertLive();
  if (backend === "software") {
    await vault.verifyPassword(password);
    assertLive();
    return;
  }
  if (password !== "") throw new Error("Hardware PIN must be entered on the device");
  const key = await vault.getCurrentKey();
  assertLive();
  if (key?.format !== "keymaster.hardware-key" || key.publicKeyHex !== publicKeyHex) throw new Error("Hardware wallet identity mismatch");
  const crypto = await vault.createActiveKeyCrypto();
  try {
    assertLive();
    const derived = await crypto.deriveP2pkhAddress();
    assertLive();
    if (derived.publicKeyHex !== publicKeyHex || !derived.address) throw new Error("Hardware wallet identity mismatch");
  } finally { crypto.dispose?.("App wallet authentication completed"); }
}
