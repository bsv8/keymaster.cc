import { describe, expect, it } from "vitest";
import type { CoordinatorBootstrapSnapshot, SessionStateEvent, VaultCoordinatorControl } from "@keymaster/contracts";
import { SessionStateMirror } from "./sessionStateMirror.js";
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";
const KEY = "02" + "ab".repeat(32);
function fixture(crypto: () => Promise<unknown> = async () => ({ ack: { status: "ok" }, result: { address: "address" } })) {
  let push!: (event: SessionStateEvent) => void; let closed = false;
  const bootstrap: CoordinatorBootstrapSnapshot = { authorityInstanceId: "authority", vaultStatus: "unlocked", activePublicKeyHex: KEY, sessionEpoch: "epoch-1", runGeneration: "run-1", walletGeneration: "wallet-1", taskSnapshots: [], scheduleSettings: { taskIntervals: {} } };
  const client = { getBootstrapSnapshot: () => bootstrap, subscribeTopic: (_topic: string, handler: typeof push) => { push = handler; return () => { closed = true; }; }, getIsConnected: () => true, crypto } as unknown as VaultCoordinatorControl;
  const mirror = new SessionStateMirror(client);
  const emit = (changes: Partial<SessionStateEvent>) => push({ topic: "session.state", type: "session.state.changed", cause: "unlock", vaultStatus: "unlocked", activePublicKeyHex: KEY, sessionEpoch: "epoch-1", runGeneration: "run-1", walletGeneration: "wallet-1", sessionRevision: 1, ...changes });
  return { mirror, client, emit, closed: () => closed };
}
describe("committed Vault session projection", () => {
  it("orders reentrant updates, ignores stale revisions and retired runs, and keeps same-key epochs distinct", () => {
    const f = fixture(); const seen: string[] = [];
    f.mirror.subscribe(snapshot => { if (snapshot.sessionEpoch === "epoch-2") f.emit({ sessionEpoch: "epoch-3", sessionRevision: 2 }); });
    f.mirror.subscribe(() => { throw new Error("observer"); });
    f.mirror.subscribe(snapshot => seen.push(snapshot.sessionEpoch));
    f.emit({ sessionEpoch: "epoch-2" });
    f.emit({ sessionEpoch: "old", sessionRevision: 1 });
    f.emit({ sessionEpoch: "restart", runGeneration: "run-2", sessionRevision: 0 });
    f.emit({ sessionEpoch: "retired", runGeneration: "run-1", sessionRevision: 100 });
    expect(seen).toEqual(["epoch-1", "epoch-2", "epoch-3", "restart"]);
    f.mirror.dispose(); expect(f.closed()).toBe(true);
  });
  it("never revives a Window crypto handle when the same key is unlocked again", async () => {
    const f = fixture(); const vault = createVaultServiceCoordinator({ coordinatorClient: f.client, sessionStateMirror: f.mirror });
    const old = await vault.createActiveKeyCrypto(KEY); expect(old.getIdentity().publicKeyHex).toBe(KEY);
    f.emit({ sessionEpoch: "epoch-2" });
    expect(() => old.getIdentity()).toThrow(/revoked/);
    await expect(old.deriveP2pkhAddress({ publicKeyHex: KEY, network: "main" })).rejects.toThrow(/revoked/);
    const fresh = await vault.createActiveKeyCrypto(KEY); expect(fresh.getIdentity().publicKeyHex).toBe(KEY);
    vault.dispose?.(); expect(() => fresh.getIdentity()).toThrow(/revoked/);
  });
  it.each(["epoch", "run", "wallet"])("rejects late Window crypto results after %s changes", async generation => {
    let finish!: (value: unknown) => void;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const vault = createVaultServiceCoordinator({ coordinatorClient: f.client, sessionStateMirror: f.mirror });
    const old = await vault.createActiveKeyCrypto(KEY);
    const pending = old.deriveP2pkhAddress({ publicKeyHex: KEY, network: "main" });
    f.emit(generation === "epoch" ? { sessionEpoch: "epoch-2" } : generation === "run" ? { runGeneration: "run-2" } : { walletGeneration: "wallet-2" });
    finish({ ack: { status: "ok" }, result: { address: "late-address" } });
    await expect(pending).rejects.toThrow(/revoked/); vault.dispose?.();
  });
});

import { createFixtureHost } from "@keymaster/runtime/test-support";
import { VAULT_WALLET_STATE_CAPABILITY, type VaultWalletState } from "@keymaster/contracts";
import { createWalletStateAccess } from "./walletStateAccess.js";
async function publicWindowFixture() {
  const transport = fixture();
  const service = createVaultServiceCoordinator({ coordinatorClient: transport.client, sessionStateMirror: transport.mirror });
  let view!: VaultWalletState;
  const host = createFixtureHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: id => ctx => {
    if (id === "vault") {
      ctx.provide(VAULT_WALLET_STATE_CAPABILITY, createWalletStateAccess({ snapshot: () => service.walletSnapshot(), subscribe: handler => service.subscribeWalletState(handler) }, ctx.scope));
      ctx.scope.onRevoke(() => service.dispose?.());
    } else view = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  } } });
  await host.registerAll([
    { id: "vault", name: "Vault", units: [{ id: "vault.window", runtime: "window-main", scopeKind: "root", provides: [VAULT_WALLET_STATE_CAPABILITY] }] },
    { id: "reader", name: "Reader", units: [{ id: "reader.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "window-main" }] }] },
  ]);
  return { ...transport, host, view };
}
describe("Window 实际服务与公开状态绑定", () => {
  it("a subscription added while notifying receives the committed baseline once", async () => {
    const f = await publicWindowFixture(); const seen: string[] = [];
    try {
      f.view.subscribe(snapshot => { if (snapshot.sessionEpoch === "epoch-2") f.view.subscribe(current => seen.push(current.sessionEpoch)); });
      f.emit({ sessionEpoch: "epoch-2" });
      expect(seen).toEqual(["epoch-2"]);
      f.emit({ sessionEpoch: "epoch-3", sessionRevision: 2 });
      expect(seen).toEqual(["epoch-2", "epoch-3"]);
    } finally { await f.host.dispose(); }
  });
  it("orders reentrant transitions, isolates observers, and stops delivery on provider revocation", async () => {
    const f = await publicWindowFixture(); const seen: string[] = [];
    try {
      f.view.subscribe(snapshot => {
        if (snapshot.sessionEpoch !== "epoch-2") return;
        f.emit({ sessionEpoch: "epoch-3", sessionRevision: 2 });
        f.view.subscribe(current => seen.push(current.sessionEpoch));
      });
      f.view.subscribe(() => { throw new Error("observer"); });
      f.emit({ sessionEpoch: "epoch-2" });
      expect(seen).toEqual(["epoch-2", "epoch-3"]);
      await f.host.revoke("vault", "replace");
      f.emit({ sessionEpoch: "epoch-4", sessionRevision: 3 });
      expect(seen).toEqual(["epoch-2", "epoch-3"]);
      expect(() => f.view.snapshot()).toThrow();
    } finally { await f.host.dispose(); }
  });
});
