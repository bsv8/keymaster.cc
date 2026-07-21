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
  CoordinatorCommandResult,
  CoordinatorValueResult,
  VaultLifecycleEvent,
  VaultLifecycleSnapshot,
  SessionCoordinatorClient,
} from "@keymaster/contracts";

// ============================================================
// 1. Types
// ============================================================

interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}

/** Vault facade 所需的 Coordinator contract 子集。 */
export type CoordinatorClientLike = Pick<
  SessionCoordinatorClient,
  "getIsConnected" | "getBootstrapSnapshot" | "subscribeTopic" | "unlock" | "lock" | "activateKey" | "vaultOperation" | "crypto"
>;

export interface VaultServiceCoordinatorDeps {
  coordinatorClient: CoordinatorClientLike;
}

function commandResultMessage(result: CoordinatorCommandResult, fallback: string): string {
  if ("message" in result) return result.message;
  if (result.status === "blocked") return typeof result.reason === "string" ? result.reason : result.reason.fallback;
  return `${fallback}: ${result.status}`;
}

function unwrapValueResult<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  throw new Error(commandResultMessage(result, `${operation} failed`));
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
  private lastVaultRevision = -1;
  private lastVaultEpoch: string | null = null;

  private lifecycleChangeHandlers = new Set<(snapshot: VaultLifecycleSnapshot) => void>();
  private lifecycleSnapshot: VaultLifecycleSnapshot = { status: "booting", sessionEpoch: "boot", vaultLifecycleRevision: 0 };
  private noticeChangeHandlers = new Set<(notice: InitialActivationNotice | null) => void>();

  constructor(deps: VaultServiceCoordinatorDeps) {
    this.coordinatorClient = deps.coordinatorClient;

    this.coordinatorClient.subscribeTopic("vault.lifecycle", (event: VaultLifecycleEvent) => {
      if (event.type !== "vault.lifecycle.changed" || typeof event.vaultLifecycleRevision !== "number" || typeof event.sessionEpoch !== "string") return;
      if (event.sessionEpoch === this.lastVaultEpoch && event.vaultLifecycleRevision <= this.lastVaultRevision) return;
      this.lastVaultEpoch = event.sessionEpoch;
      this.lastVaultRevision = event.vaultLifecycleRevision;
      if (this.applyCoordinatorState(event.status, event.activePublicKeyHex, event.sessionEpoch, event.vaultLifecycleRevision)) this.emitLifecycleChanged();
    });
  }

  /** 同步 Coordinator 的 Vault 真值；返回是否有观察者应获知的变化。 */
  private applyCoordinatorState(status: CoordinatorVaultStatus, activePublicKeyHex: string | undefined, sessionEpoch: string, vaultLifecycleRevision: number): boolean {
    const nextStatus = this.mapVaultStatus(status);
    const nextPublicKeyHex = status === "unlocked" ? activePublicKeyHex : undefined;
    const previousPublicKeyHex = this.cachedSessionState?.publicKeyHex;
    const changed = this.cachedStatus !== nextStatus
      || previousPublicKeyHex !== nextPublicKeyHex
      || this.lifecycleSnapshot.sessionEpoch !== sessionEpoch
      || this.lifecycleSnapshot.vaultLifecycleRevision !== vaultLifecycleRevision;

    this.cachedStatus = nextStatus;
    this.cachedSessionState = nextPublicKeyHex
      ? { publicKeyHex: nextPublicKeyHex } as VaultSessionState
      : null;
    this.lifecycleSnapshot = { status: nextStatus, activePublicKeyHex: nextPublicKeyHex, sessionEpoch, vaultLifecycleRevision };
    return changed;
  }

  private async call<T>(operation: string, input?: unknown): Promise<T> {
    if (!this.coordinatorClient.getIsConnected()) throw new Error("Coordinator RPC unavailable");
    return unwrapValueResult<T>(await this.coordinatorClient.vaultOperation(operation, input), operation);
  }

  private async createCoordinatorCrypto(publicKeyHex: string, sessionId = `${publicKeyHex}:${Date.now()}`): Promise<ActiveKeyCrypto> {
    const client = this.coordinatorClient;
    if (!client.getIsConnected()) throw new Error("Coordinator crypto RPC unavailable");
    let revoked = false;
    const guard = () => { if (revoked || this.cachedSessionState?.publicKeyHex !== publicKeyHex) throw new Error("Active key session has been revoked"); };
    return {
      getIdentity: () => { guard(); return { publicKeyHex, label: "", capabilities: [], createdAt: "", sessionId }; },
      async signDigest(input) {
        guard();
        const r = await client.crypto!({
          type: "signDigest",
          digestHex: Array.from(new Uint8Array(input.digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
          format: input.format
        });
        if (r.ack.status !== "ok" || !r.result) {
          throw new Error(commandResultMessage(r.ack, "Sign failed"));
        }
        const result = r.result as { signatureHex: string; format: string };
        // P0: 校验 Coordinator 回包 format 为合法值且与请求一致
        if (result.format !== "der" && result.format !== "compact") {
          throw new Error(`signDigest: unexpected format "${result.format}" from Coordinator`);
        }
        if (result.format !== input.format) {
          throw new Error(
            `signDigest format mismatch: requested "${input.format}", got "${result.format}"`
          );
        }
        return {
          publicKeyHex,
          format: result.format as import("@keymaster/contracts").EcdsaSignatureFormat,
          signature: Uint8Array.from(result.signatureHex.match(/../g)!.map((x) => parseInt(x, 16))).buffer
        };
      },
      async deriveP2pkhAddress(input) { guard(); const r = await client.crypto!({ type: "deriveP2pkhAddress", network: input.network }); if (r.ack.status !== "ok" || !r.result) throw new Error(commandResultMessage(r.ack, "Derive failed")); return { publicKeyHex, address: (r.result as { address: string }).address }; },
      async sealSendInput(sealInput) {
        guard();
        const r = await client.crypto({ type: "sealSendInput", input: sealInput });
        if (r.ack.status !== "ok" || !r.result || r.result.type !== "sealSendInput") return { error: commandResultMessage(r.ack, "Seal failed") };
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
        const backup = await this.call<string>("exportKeyBackup", input);
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

  onLifecycleChange(handler: (snapshot: VaultLifecycleSnapshot) => void): () => void {
    this.lifecycleChangeHandlers.add(handler);
    handler({ ...this.lifecycleSnapshot });
    return () => { this.lifecycleChangeHandlers.delete(handler); };
  }

  getLifecycleSnapshot(): VaultLifecycleSnapshot {
    return { ...this.lifecycleSnapshot };
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
    return await this.call<KeyRef>("createVaultWithInitialKey", input);
  }

  async createVaultWithImportedKey(input: {
    vaultPassword: string;
    key: { label: string; material: VaultKeyMaterial; format: string; capabilities: string[]; source?: string };
  }): Promise<KeyRef> {
    return await this.call<KeyRef>("createVaultWithImportedKey", input);
  }

  async unlock(password: string): Promise<CoordinatorCommandResult> {
    const result = await this.coordinatorClient.unlock(password);
    if (result.status === "accepted" || result.status === "already-unlocked") return result;
    return result;
  }

  async lock(): Promise<CoordinatorCommandResult> {
    const result = await this.coordinatorClient.lock();
    if (result.status !== "accepted" && result.status !== "ok") return result;
    this.initialActivationNotice = null;
    this.notifyNoticeChange();
    return result;
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
    return await this.call<KeyRef[]>("listKeys");
  }

  async getKey(publicKeyHex: string): Promise<KeyRef | undefined> {
    return await this.call<KeyRef | undefined>("getKey", { publicKeyHex });
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
    return await this.call<KeyRef>("importPrivateKey", input);
  }

  async generateKey(input: {
    password: string;
    label: string;
    capabilities?: string[];
  }): Promise<KeyRef> {
    return await this.call<KeyRef>("generateKey", input);
  }

  async deleteKeyMaterial(publicKeyHex: string): Promise<void> {
    await this.call("deleteKeyMaterial", { publicKeyHex });
  }

  async removeKey(publicKeyHex: string): Promise<void> {
    void publicKeyHex;
    throw new Error("Use keyspace.deleteKey instead");
  }

  async exportKeyBackup(publicKeyHex: string): Promise<string> {
    return await this.call<string>("exportKeyBackup", { publicKeyHex });
  }

  async importKeyBackup?(input: {
    backup: string;
    sourcePassword: string;
    targetPassword: string;
  }): Promise<KeyRef> {
    return await this.call<KeyRef>("importKeyBackup", input);
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

  async activateKey(input: { publicKeyHex: string; password: string }): Promise<CoordinatorCommandResult> {
    return this.coordinatorClient.activateKey(input.password, input.publicKeyHex);
  }

  dispose?(): void {
    this.disposeAllAppViewSessions("vault service disposed");
    this.lifecycleChangeHandlers.clear();
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

  private emitLifecycleChanged(): void {
    for (const handler of this.lifecycleChangeHandlers) {
      try { handler({ ...this.lifecycleSnapshot }); } catch { /* noop */ }
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
