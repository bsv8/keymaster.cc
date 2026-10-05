import type { CoordinatorStorageControl, WalletLifecycleService, WalletUnlockResult } from "@keymaster/contracts";
export type WalletMutationControl = Exclude<CoordinatorStorageControl, { type: "status" | "summary" | "cold-start" | "initialize" }>;
export interface WalletControlDependencies {
  lifecycle: WalletLifecycleService;
  beforeRevoke(reason: string): Promise<void>;
  unlocked(result: WalletUnlockResult): void;
  locked(): void;
  passwordChanged(): void;
  reset(): void;
}

/** Vault owns wallet control dispatch; the host commits session and root projections. */
export async function executeWalletControl(control: WalletMutationControl, deps: WalletControlDependencies): Promise<unknown> {
  switch (control.type) {
    case "unlock": {
      const result = await deps.lifecycle.unlock(control.password);
      deps.unlocked(result);
      return result;
    }
    case "lock":
      await deps.beforeRevoke("storage.control.lock");
      await deps.lifecycle.lock();
      deps.locked();
      return undefined;
    case "change-key-password":
      await deps.beforeRevoke("storage.control.change-key-password");
      await deps.lifecycle.changePassword({ oldPassword: control.oldPassword, newPassword: control.newPassword });
      deps.passwordChanged();
      return undefined;
    case "rename-key":
      await deps.lifecycle.rename(control.label);
      return { label: control.label };
    case "export-key-hold":
      return { bytes: await deps.lifecycle.exportKeyHold(), keyHoldFormat: "keyhold" as const };
    case "reset-wallet": {
      const result = await deps.lifecycle.resetWallet({ confirmationLabel: control.confirmationLabel });
      deps.reset();
      return result;
    }
  }
}
