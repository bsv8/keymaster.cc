import type { VaultLifecycleSnapshot, VaultWalletState, VaultWalletStateAccess, KeyIdentity } from "@keymaster/contracts";
/** Explicit state fixture; security tests use the production provider instead. */
export function walletStateFixtureSnapshot(state: Partial<VaultLifecycleSnapshot>, identity?: () => KeyIdentity): VaultLifecycleSnapshot {
  return { status: state.activePublicKeyHex ? "unlocked" : "locked", sessionEpoch: "fixture-epoch", runGeneration: "fixture-run", walletGeneration: "fixture-wallet", vaultLifecycleRevision: 0, ...state,
    ...(state.activePublicKeyHex && identity ? { activeKeyIdentity: identity() } : {}) };
}
export function walletStateFixtureAccess(source: VaultWalletState): VaultWalletStateAccess {
  return { bind: () => source };
}
