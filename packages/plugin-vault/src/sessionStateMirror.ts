// packages/plugin-vault/src/sessionStateMirror.ts
import type {
  CoordinatorBootstrapSnapshot,
  SessionCoordinatorClient,
  SessionStateEvent,
} from "@keymaster/contracts";
import {
  AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  normalizeAutoLockTimeoutMs,
} from "@keymaster/contracts";

export interface SessionStateSnapshot {
  activeKeyIdentity?: import("@keymaster/contracts").KeyIdentity;
  sessionEpoch: string;
  vaultStatus: CoordinatorBootstrapSnapshot["vaultStatus"];
  /** 唯一钱包 Key；未初始化或锁定时省略。 */
  activePublicKeyHex?: string;
  /** Worker 运行世代；Worker 重启后变化，使旧授权失效。 */
  runGeneration: string;
  /** 当前钱包身份世代；重置后变化，即使重新导入同一私钥也不同。 */
  walletGeneration?: string;
  sessionRevision: number;
  autoLockTimeoutMs: number;
}

/**
 * The tab-local, immutable projection of Coordinator session.state.
 *
 * This is deliberately the only plugin-vault subscriber to the transport topic:
 * facades derive their narrow APIs from this already-committed snapshot. Two
 * generations ride along because they are the only handle bindings that matter
 * in a purely local wallet:
 *   - runGeneration: this Worker run. A restart invalidates every old grant.
 *   - walletGeneration: reset/re-initialize. An async result from before a
 *     reset must not write into the recreated wallet, even for the same key.
 */
export class SessionStateMirror {
  private snapshot: Readonly<SessionStateSnapshot>;
  private readonly listeners = new Set<(snapshot: Readonly<SessionStateSnapshot>) => void>();

  private transportOff: () => void = () => {};
  private readonly retiredRuns = new Set<string>();
  private readonly pending: SessionStateEvent[] = [];
  private delivering = false;

  constructor(client: Pick<SessionCoordinatorClient, "getBootstrapSnapshot" | "subscribeTopic">) {
    const initial = client.getBootstrapSnapshot();
    this.snapshot = this.toSnapshot(initial);
    this.transportOff = client.subscribeTopic("session.state", (event: SessionStateEvent) => {
      this.pending.push(event);
      if (this.delivering) return;
      this.delivering = true;
      try { while (this.pending.length) this.commit(this.pending.shift()!); } finally { this.delivering = false; }
    });
  }

  private commit(event: SessionStateEvent): void {
      if (event.type !== "session.state.changed") return;
      if (this.retiredRuns.has(event.runGeneration)) return;
      if (event.runGeneration === this.snapshot.runGeneration && event.sessionRevision <= this.snapshot.sessionRevision) return;
      if (event.runGeneration !== this.snapshot.runGeneration) this.retiredRuns.add(this.snapshot.runGeneration);
      this.snapshot = Object.freeze({
        ...(event.vaultStatus === "unlocked" && event.activeKeyIdentity ? { activeKeyIdentity: Object.freeze({ ...event.activeKeyIdentity, capabilities: Object.freeze([...event.activeKeyIdentity.capabilities]) as unknown as string[] }) } : {}),
        sessionEpoch: event.sessionEpoch,
        vaultStatus: event.vaultStatus,
        activePublicKeyHex: event.vaultStatus === "unlocked" ? event.activePublicKeyHex ?? undefined : undefined,
        runGeneration: event.runGeneration,
        ...(event.walletGeneration === undefined ? {} : { walletGeneration: event.walletGeneration }),
        sessionRevision: event.sessionRevision,
        autoLockTimeoutMs: normalizeAutoLockTimeoutMs(event.autoLockTimeoutMs),
      });
      for (const listener of [...this.listeners]) { try { listener(this.snapshot); } catch { /* isolate observers */ } }
  }

  dispose(): void { this.transportOff(); this.transportOff = () => {}; this.listeners.clear(); this.pending.length = 0; }

  getSnapshot(): Readonly<SessionStateSnapshot> {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: Readonly<SessionStateSnapshot>) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.snapshot); } catch { /* isolate observers */ }
    return () => this.listeners.delete(listener);
  }

  private toSnapshot(snapshot: CoordinatorBootstrapSnapshot) {
    return Object.freeze({
      sessionEpoch: snapshot.sessionEpoch,
      vaultStatus: snapshot.vaultStatus,
      activePublicKeyHex: snapshot.vaultStatus === "unlocked" ? snapshot.activePublicKeyHex : undefined,
      ...(snapshot.vaultStatus === "unlocked" && snapshot.activeKeyIdentity ? { activeKeyIdentity: Object.freeze({ ...snapshot.activeKeyIdentity, capabilities: Object.freeze([...snapshot.activeKeyIdentity.capabilities]) as unknown as string[] }) } : {}),
      runGeneration: snapshot.runGeneration,
      ...(snapshot.walletGeneration === undefined ? {} : { walletGeneration: snapshot.walletGeneration }),
      sessionRevision: 0,
      autoLockTimeoutMs: normalizeAutoLockTimeoutMs(snapshot.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS),
    });
  }
}
