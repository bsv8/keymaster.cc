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

  constructor(client: Pick<SessionCoordinatorClient, "getBootstrapSnapshot" | "subscribeTopic">) {
    const initial = client.getBootstrapSnapshot();
    this.snapshot = this.toSnapshot(initial);
    client.subscribeTopic("session.state", (event: SessionStateEvent) => {
      if (event.type !== "session.state.changed") return;
      this.snapshot = Object.freeze({
        sessionEpoch: event.sessionEpoch,
        vaultStatus: event.vaultStatus,
        activePublicKeyHex: event.activePublicKeyHex ?? undefined,
        runGeneration: event.runGeneration,
        ...(event.walletGeneration === undefined ? {} : { walletGeneration: event.walletGeneration }),
        sessionRevision: event.sessionRevision,
        autoLockTimeoutMs: normalizeAutoLockTimeoutMs(event.autoLockTimeoutMs),
      });
      for (const listener of this.listeners) listener(this.snapshot);
    });
  }

  getSnapshot(): Readonly<SessionStateSnapshot> {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: Readonly<SessionStateSnapshot>) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private toSnapshot(snapshot: CoordinatorBootstrapSnapshot) {
    return Object.freeze({
      sessionEpoch: snapshot.sessionEpoch,
      vaultStatus: snapshot.vaultStatus,
      activePublicKeyHex: snapshot.activePublicKeyHex,
      runGeneration: snapshot.runGeneration,
      ...(snapshot.walletGeneration === undefined ? {} : { walletGeneration: snapshot.walletGeneration }),
      sessionRevision: 0,
      autoLockTimeoutMs: normalizeAutoLockTimeoutMs(snapshot.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS),
    });
  }
}
