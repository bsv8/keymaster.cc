import type {
  CoordinatorBootstrapSnapshot,
  SessionCoordinatorClient,
  SessionStateEvent,
} from "@keymaster/contracts";

export interface SessionStateSnapshot {
  sessionEpoch: string;
  vaultStatus: CoordinatorBootstrapSnapshot["vaultStatus"];
  activePublicKeyHex?: string;
  selectedPublicKeyHex?: string;
  keyspaceGeneration: number;
  sessionRevision: number;
}

/**
 * The tab-local, immutable projection of Coordinator session.state.
 *
 * This is deliberately the only plugin-vault subscriber to the transport topic:
 * facades derive their narrow APIs from this already-committed snapshot.
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
        selectedPublicKeyHex: event.selectedPublicKeyHex ?? undefined,
        keyspaceGeneration: event.keyspaceGeneration,
        sessionRevision: event.sessionRevision,
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
      selectedPublicKeyHex: snapshot.selectedPublicKeyHex,
      keyspaceGeneration: snapshot.keyspaceGeneration,
      sessionRevision: 0,
    });
  }
}
