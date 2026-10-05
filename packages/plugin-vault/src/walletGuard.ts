import type { VaultStatus } from "@keymaster/contracts";
import type { WalletGuard } from "./VaultWalletGuard.js";
type ShellGuardState = WalletGuard;
export function areShellGuardStatesEqual(a: ShellGuardState, b: ShellGuardState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "diagnostic" && b.kind === "diagnostic") return a.error === b.error;
  if (a.kind !== "needs-repair" || b.kind !== "needs-repair") return true;
  return a.publicKeyHex === b.publicKeyHex;
}

export async function evaluateShellGuard(args: {
  vaultStatus: VaultStatus;
  getCurrentKey: () => Promise<{ publicKeyHex: string } | undefined>;
  /** 身份投影里的公钥；仅用于 needs-repair 的诊断展示。 */
  projectedPublicKeyHex?: string;
}): Promise<ShellGuardState> {
  if (args.vaultStatus !== "unlocked") return { kind: "normal" };
  try {
    const key = await args.getCurrentKey();
    if (key) return { kind: "normal" };
    return { kind: "needs-repair", publicKeyHex: args.projectedPublicKeyHex };
  } catch (err) {
    return { kind: "diagnostic", error: err instanceof Error ? err.message : String(err) };
  }
}

