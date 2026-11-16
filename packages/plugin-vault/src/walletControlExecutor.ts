import type { CoordinatorStorageControl, WalletLifecycleService } from "@keymaster/contracts";
export type WalletMutationControl = Exclude<CoordinatorStorageControl, { type: "status" | "summary" | "cold-start" | "initialize" }>;
export interface WalletControlDependencies {
  lifecycle: WalletLifecycleService;
  reset(): void;
}

/** Vault owns wallet control dispatch; the host commits session and root projections. */
export async function executeWalletControl(control: WalletMutationControl, deps: WalletControlDependencies): Promise<unknown> {
  switch (control.type) {
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
