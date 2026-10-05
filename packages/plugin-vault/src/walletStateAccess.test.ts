import { describe, expect, it } from "vitest";
import { createLifecycleScope, type PluginConsumer, type LifecycleScope } from "webloom-framework";
import { VAULT_WALLET_STATE_CAPABILITY, type PluginContext, type VaultLifecycleSnapshot, type VaultWalletState } from "@keymaster/contracts";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { createWalletStateAccess, createWalletStateSource } from "./walletStateAccess.js";
const KEY = "02" + "ab".repeat(32);
const initial = (): VaultLifecycleSnapshot => ({ status: "unlocked", activePublicKeyHex: KEY, activeKeyIdentity: { publicKeyHex: KEY, label: "Primary", capabilities: ["p2pkh"], createdAt: "today" }, sessionEpoch: "epoch-1", runGeneration: "run-1", walletGeneration: "wallet-1", vaultLifecycleRevision: 1 });
async function fixture() {
  let committed = initial();
  const source = createWalletStateSource(() => committed);
  let provider!: PluginContext, reader!: PluginContext, stranger!: PluginContext;
  let view!: VaultWalletState;
  const host = createFixtureHost({ runtimeUnitImplementationRegistry: { get: id => id === "vault" ? ctx => { provider = ctx; ctx.provide(VAULT_WALLET_STATE_CAPABILITY, createWalletStateAccess(source, ctx.scope)); } : ctx => { if (id === "reader") { reader = ctx; view = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope); } else stranger = ctx; } } });
  await host.registerAll([
    { id: "vault", name: "Vault", units: [{ id: "vault.window", runtime: "window-main", scopeKind: "root", provides: [VAULT_WALLET_STATE_CAPABILITY] }] },
    { id: "reader", name: "Reader", units: [{ id: "reader.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "window-main" }] }] },
    { id: "stranger", name: "Stranger", units: [{ id: "stranger.window", runtime: "window-main", scopeKind: "root" }] },
  ]);
  return { host, source, provider, get reader() { return reader; }, stranger, view, commit: (changes: Partial<VaultLifecycleSnapshot>) => { committed = { ...committed, ...changes }; source.publish(); } };
}
describe("Vault wallet state capability", () => {
  it("accepts only an issued, declared consumer with its exact Scope", async () => {
    const f = await fixture(); const access = f.provider.capability(VAULT_WALLET_STATE_CAPABILITY);
    expect(() => access.bind({ ...f.reader.consumer } as PluginConsumer, f.reader.scope)).toThrow(/issued/);
    expect(() => access.bind(f.reader.consumer, createLifecycleScope({ kind: "runtime-unit" }))).toThrow(/issued/);
    expect(() => access.bind(f.stranger.consumer, f.stranger.scope)).toThrow();
    expect(Object.keys(f.view).sort()).toEqual(["snapshot", "subscribe"]);
    await f.host.dispose();
  });
  it("delivers a synchronous baseline, deduplicates, and preserves same-key epoch/run/wallet changes", async () => {
    const f = await fixture(); const seen: VaultLifecycleSnapshot[] = [];
    const off = f.view.subscribe(snapshot => seen.push(snapshot)); expect(seen).toHaveLength(1);
    f.source.publish(); expect(seen).toHaveLength(1);
    f.commit({ sessionEpoch: "epoch-2", vaultLifecycleRevision: 2 });
    f.commit({ runGeneration: "run-2", vaultLifecycleRevision: 0 });
    f.commit({ walletGeneration: "wallet-2", vaultLifecycleRevision: 1 });
    expect(seen.map(s => s.sessionEpoch)).toEqual(["epoch-1", "epoch-2", "epoch-2", "epoch-2"]);
    off(); off(); f.commit({ sessionEpoch: "epoch-3" }); expect(seen).toHaveLength(4);
    await f.host.dispose();
  });
  it("strips stale identity on lock and freezes nested metadata without exposing its source", async () => {
    const f = await fixture(); const snapshot = f.view.snapshot();
    expect(() => snapshot.activeKeyIdentity!.capabilities.push("sign")).toThrow();
    expect(() => { (snapshot as VaultLifecycleSnapshot).sessionEpoch = "forged"; }).toThrow();
    expect(f.view.snapshot().activeKeyIdentity!.capabilities).toEqual(["p2pkh"]);
    f.commit({ status: "locked", sessionEpoch: "locked" });
    expect(f.view.snapshot().activePublicKeyHex).toBeUndefined(); expect(f.view.snapshot().activeKeyIdentity).toBeUndefined();
    await f.host.dispose();
  });
  it("fences cached reads and cleans subscriptions on provider revocation; replacements require a new view", async () => {
    const f = await fixture(); let deliveries = 0; const off = f.view.subscribe(() => deliveries++);
    await f.host.revoke("vault", "replace");
    expect(() => f.view.snapshot()).toThrow(); expect(() => f.view.subscribe(() => {})).toThrow();
    off(); off(); f.commit({ sessionEpoch: "epoch-2" }); expect(deliveries).toBe(1);
    await f.host.retry("vault"); await f.host.retry("reader");
    const fresh = f.host.capabilities.get(VAULT_WALLET_STATE_CAPABILITY).bind(f.reader.consumer, f.reader.scope);
    // A revoked consumer cannot impersonate the replacement either.
    expect(fresh).toBeDefined();
    expect(() => f.view.snapshot()).toThrow();
    await f.host.dispose();
  });
  it("cleans subscriptions when a consumer is revoked while the provider remains active", async () => {
    const f = await fixture(); let deliveries = 0; const off = f.view.subscribe(() => deliveries++);
    await f.host.revoke("reader", "done"); f.commit({ sessionEpoch: "epoch-2" });
    expect(deliveries).toBe(1); expect(() => f.view.snapshot()).toThrow(); off(); off(); await f.host.dispose();
  });
  it("isolates throwing observers and orders reentrant committed updates", () => {
    let committed = initial(); const source = createWalletStateSource(() => committed);
    const a: string[] = [], b: string[] = [];
    source.subscribe(snapshot => { a.push(snapshot.sessionEpoch); if (snapshot.sessionEpoch === "epoch-2") { committed = { ...committed, sessionEpoch: "epoch-3" }; source.publish(); } });
    source.subscribe(() => { throw new Error("observer"); });
    source.subscribe(snapshot => b.push(snapshot.sessionEpoch));
    committed = { ...committed, sessionEpoch: "epoch-2" }; source.publish();
    expect(a).toEqual(["epoch-1", "epoch-2", "epoch-3"]); expect(b).toEqual(a);
  });
  it("a subscriber created during reentrant delivery sees its baseline once and never an older commit", () => {
    let committed = initial(); const source = createWalletStateSource(() => committed);
    const seen: string[] = [];
    source.subscribe(snapshot => {
      if (snapshot.sessionEpoch !== "epoch-2") return;
      committed = { ...committed, sessionEpoch: "epoch-3" }; source.publish();
      source.subscribe(current => seen.push(current.sessionEpoch));
    });
    committed = { ...committed, sessionEpoch: "epoch-2" }; source.publish();
    expect(seen).toEqual(["epoch-3"]);
    committed = { ...committed, sessionEpoch: "epoch-4" }; source.publish();
    expect(seen).toEqual(["epoch-3", "epoch-4"]);
  });

});
