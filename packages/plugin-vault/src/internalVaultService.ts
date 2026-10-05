import type { VaultService, WalletInitializePlan, WalletKeySummary } from "@keymaster/contracts";
/** 仅由 Vault 装配和内部 UI 持有，禁止发布为 capability。 */
export interface InternalVaultService extends VaultService {
  walletSnapshot(): import("@keymaster/contracts").VaultLifecycleSnapshot;
  subscribeWalletState(handler: (snapshot: import("@keymaster/contracts").VaultLifecycleSnapshot) => void): () => void;
  initialize(plan: WalletInitializePlan): Promise<WalletKeySummary>;
  changePassword(input: { oldPassword: string; newPassword: string }): Promise<void>;
  renameKey(label: string): Promise<void>;
  exportKeyHold(): Promise<Uint8Array>;
  resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }>;
}
