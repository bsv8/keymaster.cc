// packages/contracts/src/vaultSession.ts
// Vault / session 生命周期契约。

import type { ActiveKeySessionId } from "./activeKeyCrypto.js";

export type VaultSessionKind = "keymaster" | "appView";

export interface VaultSessionState {
  sessionId: ActiveKeySessionId;
  kind: VaultSessionKind;
  publicKeyHex?: string;
  revoked: boolean;
}

export interface VaultSessionBootstrap {
  sessionId: ActiveKeySessionId;
  kind: VaultSessionKind;
  publicKeyHex?: string;
}

export interface VaultSessionRevokeEvent {
  sessionId: ActiveKeySessionId;
  publicKeyHex?: string;
  reason: "lock" | "logout" | "window-close" | "worker-error" | "password-change";
}
