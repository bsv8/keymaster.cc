// packages/plugin-vault/src/vaultServiceCoordinator.ts
// VaultService Coordinator Facade
//
// 设计缘由（施工单 002）：
//   - 所有变更操作走 RPC，收到 event 后更新只读 cache/listener
//   - 不拥有独立状态真值、私钥、任务队列、timer 或网络执行权

import type {
  VaultService,
  VaultStatus,
  VaultSessionState,
  KeyRef,
  ActiveKeyCrypto,
  InitialActivationNotice,
  CoordinatorVaultStatus,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
} from "@keymaster/contracts";

// ============================================================
// 1. Types
// ============================================================

interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}

/** Coordinator client 最小接口（避免跨包导入）。 */
interface CoordinatorClientLike {
  getIsConnected(): boolean;
  getState(): { vaultStatus: CoordinatorVaultStatus; activePublicKeyHex?: string };
  onStateChange(handler: (state: { vaultStatus: CoordinatorVaultStatus; activePublicKeyHex?: string }) => void): () => void;
  onEvent(eventType: string, handler: (event: { type: string; status?: CoordinatorVaultStatus; activePublicKeyHex?: string }) => void): () => void;
  unlock(password: string, publicKeyHex?: string): Promise<{ status: string; message?: string }>;
  lock(): Promise<{ status: string; message?: string }>;
  activateKey(password: string, publicKeyHex: string): Promise<{ status: string; message?: string }>;
  vaultOperation(operation: string, input?: unknown): Promise<unknown>;
  crypto(operation: CoordinatorCryptoOperation): Promise<{ ack: { status: string; message?: string; reason?: string }; result?: CoordinatorCryptoResult }>;
}

export interface VaultServiceCoordinatorDeps {
  coordinatorClient: CoordinatorClientLike;
}

// ============================================================
// 2. VaultService Coordinator Facade
// ============================================================

export class VaultServiceCoordinator implements VaultService {
  private coordinatorClient: CoordinatorClientLike;

  private cachedStatus: VaultStatus = "booting";
  private cachedSessionState: VaultSessionState | null = null;
  private cachedKeys: KeyRef[] = [];
  private appViewRevocations = new Map<string, () => void>();
  private initialActivationNotice: InitialActivationNotice | null = null;

  private statusChangeHandlers = new Set<(status: VaultStatus) => void>();
  private noticeChangeHandlers = new Set<(notice: InitialActivationNotice | null) => void>();

  constructor(deps: VaultServiceCoordinatorDeps) {
    this.coordinatorClient = deps.coordinatorClient;

    this.coordinatorClient.onStateChange((state: { vaultStatus: CoordinatorVaultStatus; activePublicKeyHex?: string }) => {
      this.cachedStatus = this.mapVaultStatus(state.vaultStatus);
      if (state.vaultStatus === "unlocked" && state.activePublicKeyHex) {
        this.cachedSessionState = { publicKeyHex: state.activePublicKeyHex } as VaultSessionState;
      } else {
        this.cachedSessionState = null;
      }
      this.notifyStatusChange();
    });

    this.coordinatorClient.onEvent("vault.status-changed", (event: { type: string; status?: CoordinatorVaultStatus; activePublicKeyHex?: string }) => {
      if (event.type === "vault.status-changed" && event.status) {
        this.cachedStatus = this.mapVaultStatus(event.status);
        this.notifyStatusChange();
      }
    });
  }

  private async call(operation: string, input?: unknown): Promise<unknown> {
    if (!this.coordinatorClient.getIsConnected()) throw new Error("Coordinator RPC unavailable");
    return this.coordinatorClient.vaultOperation(operation, input);
  }

  private async createCoordinatorCrypto(publicKeyHex: string, sessionId = `${publicKeyHex}:${Date.now()}`): Promise<ActiveKeyCrypto> {
    const client = this.coordinatorClient;
    if (!client.getIsConnected()) throw new Error("Coordinator crypto RPC unavailable");
    let revoked = false;
    const guard = () => { if (revoked || this.cachedSessionState?.publicKeyHex !== publicKeyHex) throw new Error("Active key session has been revoked"); };
    return {
      getIdentity: () => { guard(); return { publicKeyHex, label: "", capabilities: [], createdAt: "", sessionId }; },
      async signDigest(input) { guard(); const r = await client.crypto!({ type: "signDigest", digestHex: Array.from(new Uint8Array(input.digest)).map((b) => b.toString(16).padStart(2, "0")).join("") }); if (r.ack.status !== "ok" || !r.result) throw new Error(r.ack.message ?? r.ack.reason ?? "Sign failed"); return { publicKeyHex, signature: Uint8Array.from((r.result as { signatureHex: string }).signatureHex.match(/../g)!.map((x) => parseInt(x, 16))).buffer }; },
      async deriveP2pkhAddress(input) { guard(); const r = await client.crypto!({ type: "deriveP2pkhAddress", network: input.network }); if (r.ack.status !== "ok" || !r.result) throw new Error(r.ack.message ?? "Derive failed"); return { publicKeyHex, address: (r.result as { address: string }).address }; },
      async sealSendInput(sealInput) {
        guard();
        const r = await client.crypto({ type: "sealSendInput", input: sealInput });
        if (r.ack.status !== "ok" || !r.result || r.result.type !== "sealSendInput") return { error: r.ack.message ?? r.ack.reason ?? "Seal failed" };
        return { record: { messageId: "", senderPublicKeyHex: sealInput.sender.senderPublicKeyHex, senderEndpointId: sealInput.sender.senderOrigin ?? sealInput.sender.senderAppId ?? "", senderEndpointKind: sealInput.sender.senderOrigin ? "origin" : "plugin", recipientPublicKeyHex: sealInput.recipient.recipientPublicKeyHex, recipientEndpointId: sealInput.recipient.recipientOrigin ?? sealInput.recipient.recipientAppId ?? "", recipientEndpointKind: sealInput.recipient.recipientOrigin ? "origin" : "plugin", clientMessageId: sealInput.clientMessageId, createdAtMs: sealInput.createdAtMs, insertedAtMs: Date.now(), envelope: { envelopeBytes: r.result.envelope, signatureBytes: r.result.signature } } } as unknown as import("@keymaster/contracts").ActiveKeyCryptoSealSendInputResult;
      },
      async openSealed(rec) {
        guard();
        try {
          const r = await client.crypto({ type: "openSealed", record: rec });
          if (r.ack.status !== "ok" || !r.result || r.result.type !== "openSealed") return null;
          return JSON.parse(new TextDecoder().decode(r.result.plaintext)) as import("@keymaster/contracts").AppMsgMessage;
        } catch { return null; }
      },
      exportEncryptedKeyBackup: async (input) => {
        if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
        const backup = await this.call("exportKeyBackup", input) as string;
        return { publicKeyHex, backup: new TextEncoder().encode(backup).buffer };
      },
      dispose: () => {
        if (revoked) return;
        revoked = true;
        if (this.appViewRevocations.get(sessionId)) this.appViewRevocations.delete(sessionId);
      }
    };
  }

  // ============================================================
  // 3. State Access
  // ============================================================

  status(): VaultStatus {
    return this.cachedStatus;
  }

  onStatusChange(handler: (status: VaultStatus) => void): () => void {
    this.statusChangeHandlers.add(handler);
    handler(this.cachedStatus);
    return () => { this.statusChangeHandlers.delete(handler); };
  }

  getSessionState(): VaultSessionState | null {
    return this.cachedSessionState;
  }

  getInitialActivationNotice(): InitialActivationNotice | null {
    return this.initialActivationNotice;
  }

  clearInitialActivationNotice(): void {
    this.initialActivationNotice = null;
    this.notifyNoticeChange();
  }

  onInitialActivationNoticeChange(
    handler: (notice: InitialActivationNotice | null) => void
  ): () => void {
    this.noticeChangeHandlers.add(handler);
    handler(this.initialActivationNotice);
    return () => { this.noticeChangeHandlers.delete(handler); };
  }

  // ============================================================
  // 4. Vault Operations
  // ============================================================

  async hasVault(): Promise<boolean> {
    return this.cachedStatus !== "uninitialized" && this.cachedStatus !== "booting";
  }

  async createVault(password: string): Promise<void> {
    await this.call("createVault", { password });
  }

  async createVaultWithInitialKey(input: {
    password: string;
    label?: string;
    capabilities?: string[];
  }): Promise<KeyRef> {
    return await this.call("createVaultWithInitialKey", input) as KeyRef;
  }

  async createVaultWithImportedKey(input: {
    vaultPassword: string;
    key: { label: string; material: VaultKeyMaterial; format: string; capabilities: string[]; source?: string };
  }): Promise<KeyRef> {
    return await this.call("createVaultWithImportedKey", input) as KeyRef;
  }

  async unlock(password: string): Promise<void> {
    const ack = await this.coordinatorClient.unlock(password);
    if (ack.status === "already-unlocked") return;
    if (ack.status !== "accepted") {
      throw new Error(`Unlock failed: ${ack.status}${"message" in ack ? ` - ${ack.message}` : ""}`);
    }
  }

  async lock(): Promise<void> {
    const ack = await this.coordinatorClient.lock();
    if (ack.status !== "accepted") {
      throw new Error(`Lock failed: ${ack.status}${"message" in ack ? ` - ${ack.message}` : ""}`);
    }
    this.initialActivationNotice = null;
    this.notifyNoticeChange();
  }

  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<void> {
    await this.call("changePassword", input);
  }

  async verifyPassword(password: string): Promise<void> {
    await this.call("verifyPassword", { password });
  }

  async finalizeEmptyVaultAfterLastKeyDeletion(): Promise<void> {
    await this.call("finalizeEmptyVaultAfterLastKeyDeletion");
  }

  async recoverEmptyVaultToUninitialized(): Promise<void> {
    await this.call("recoverEmptyVaultToUninitialized");
  }

  // ============================================================
  // 5. Key Operations
  // ============================================================

  async listKeys(): Promise<KeyRef[]> {
    return await this.call("listKeys") as KeyRef[];
  }

  async getKey(publicKeyHex: string): Promise<KeyRef | undefined> {
    return await this.call("getKey", { publicKeyHex }) as KeyRef | undefined;
  }

  async findByAddress(address: string): Promise<KeyRef | undefined> {
    return (await this.listKeys()).find((k) => k.address === address);
  }

  async importPrivateKey(input: {
    password: string;
    label: string;
    material: VaultKeyMaterial;
    format: string;
    capabilities: string[];
    source?: string;
  }): Promise<KeyRef> {
    return await this.call("importPrivateKey", input) as KeyRef;
  }

  async generateKey(input: {
    password: string;
    label: string;
    capabilities?: string[];
  }): Promise<KeyRef> {
    return await this.call("generateKey", input) as KeyRef;
  }

  async deleteKeyMaterial(publicKeyHex: string): Promise<void> {
    await this.call("deleteKeyMaterial", { publicKeyHex });
  }

  async removeKey(publicKeyHex: string): Promise<void> {
    await this.call("removeKey", { publicKeyHex });
  }

  async exportKeyBackup(publicKeyHex: string): Promise<string> {
    return await this.call("exportKeyBackup", { publicKeyHex }) as string;
  }

  async importKeyBackup?(input: {
    backup: string;
    sourcePassword: string;
    targetPassword: string;
  }): Promise<KeyRef> {
    return await this.call("importKeyBackup", input) as KeyRef;
  }

  // ============================================================
  // 6. Crypto Operations
  // ============================================================

  async createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto> {
    return this.createCoordinatorCrypto(publicKeyHex);
  }

  async createAppViewSession(input: {
    sessionId: string;
    publicKeyHex: string;
    password: string;
  }): Promise<ActiveKeyCrypto> {
    if (this.cachedSessionState?.publicKeyHex !== input.publicKeyHex) throw new Error("AppView crypto requires the global active key");
    await this.call("verifyPassword", { password: input.password });
    this.disposeAppViewSession(input.sessionId, "appView session replaced");
    const crypto = await this.createCoordinatorCrypto(input.publicKeyHex, input.sessionId);
    this.appViewRevocations.set(input.sessionId, () => crypto.dispose?.("appView session disposed"));
    return crypto;
  }

  disposeAppViewSession(sessionId: string, reason?: string): void {
    void reason;
    const revoke = this.appViewRevocations.get(sessionId);
    if (revoke) revoke();
    this.appViewRevocations.delete(sessionId);
  }

  disposeAllAppViewSessions(reason?: string): void {
    void reason;
    for (const revoke of this.appViewRevocations.values()) revoke();
    this.appViewRevocations.clear();
  }

  async activateKey(input: { publicKeyHex: string; password: string }): Promise<void> {
    const ack = await this.coordinatorClient.activateKey(input.password, input.publicKeyHex);
    if (ack.status !== "accepted") {
      throw new Error(`Activate key failed: ${ack.status}${"message" in ack ? ` - ${ack.message}` : ""}`);
    }
  }

  dispose?(): void {
    this.disposeAllAppViewSessions("vault service disposed");
    this.statusChangeHandlers.clear();
    this.noticeChangeHandlers.clear();
  }

  // ============================================================
  // 7. State Management
  // ============================================================

  private mapVaultStatus(coordinatorStatus: CoordinatorVaultStatus): VaultStatus {
    switch (coordinatorStatus) {
      case "booting": return "booting";
      case "uninitialized": return "uninitialized";
      case "locked": return "locked";
      case "unlocked": return "unlocked";
      case "fatal": return "locked";
      default: return "locked";
    }
  }

  private notifyStatusChange(): void {
    for (const handler of this.statusChangeHandlers) {
      try { handler(this.cachedStatus); } catch { /* noop */ }
    }
  }

  private notifyNoticeChange(): void {
    for (const handler of this.noticeChangeHandlers) {
      try { handler(this.initialActivationNotice); } catch { /* noop */ }
    }
  }
}

// ============================================================
// 8. Factory Function
// ============================================================

export function createVaultServiceCoordinator(deps: VaultServiceCoordinatorDeps): VaultService {
  return new VaultServiceCoordinator(deps);
}
