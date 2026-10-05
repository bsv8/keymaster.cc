import { expect, it } from "vitest";
import { createWorkerKeySession } from "./workerKeySession.js";
import { createWorkerActiveKeyCryptoFactory } from "./workerActiveKeyCrypto.js";
import { createWorkerIdentityProjection } from "./workerIdentityProjection.js";
const publicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
it("refuses cached operations after the same key enters a new session and after disposal", async () => {
  let sessionEpoch = "first";
  const keySession = createWorkerKeySession(() => ({ unlocked: true, publicKeyHex, sessionEpoch }));
  keySession.replace(new Uint8Array(32).fill(0).map((value, index) => index === 31 ? 1 : value));
  const factory = createWorkerActiveKeyCryptoFactory({
    keySession, sessionEpoch: () => sessionEpoch,
    summary: () => ({ publicKeyHex, capabilities: ["p2pkh"], createdAt: "today", label: "Key" }),
    withIoLease: (_operation, execute) => execute(),
  });
  const old = await factory(publicKeyHex);
  expect((await old.deriveP2pkhAddress({ publicKeyHex, network: "main" })).address).toBe("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
  sessionEpoch = "second";
  await expect(old.signDigest({ publicKeyHex, digest: new Uint8Array(32).buffer, format: "compact" })).rejects.toThrow(/changed/);
  expect(() => old.getIdentity()).toThrow(/changed/);
  const current = await factory(publicKeyHex);
  current.dispose();
  await expect(current.deriveP2pkhAddress({ publicKeyHex, network: "main" })).rejects.toThrow("disposed");
});
it("protects private public identity metadata arrays", () => {
  const projection = createWorkerIdentityProjection();
  projection.setSummary({ publicKeyHex, capabilities: ["p2pkh"], createdAt: "today", label: "Key" });
  projection.summary()!.capabilities.length = 0;
  expect(projection.summary()!.capabilities).toEqual(["p2pkh"]);
});

it("revokes a cached child handle with its provider even when the wallet session stays unchanged", async () => {
  const { createLifecycleScope } = await import("webloom-framework");
  const scope = createLifecycleScope({ kind: "runtime-unit", metadata: { pluginId: "vault" } });
  const keySession = createWorkerKeySession(() => ({ unlocked: true, publicKeyHex, sessionEpoch: "same" }));
  keySession.replace(Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0));
  let leases = 0;
  const factory = createWorkerActiveKeyCryptoFactory({ keySession, sessionEpoch: () => "same",
    summary: () => ({ publicKeyHex, capabilities: ["p2pkh"], createdAt: "today", label: "Key" }),
    withIoLease: (_operation, execute) => { leases++; return execute(); },
  });
  const cached = await factory(publicKeyHex, scope);
  await cached.signDigest({ publicKeyHex, digest: new Uint8Array(32).buffer, format: "compact" });
  scope.revoke("provider removed without locking session");
  const before = leases;
  expect(() => cached.getIdentity()).toThrow();
  await expect(cached.signDigest({ publicKeyHex, digest: new Uint8Array(32).buffer, format: "compact" })).rejects.toThrow();
  await expect(cached.deriveP2pkhAddress({ publicKeyHex, network: "main" })).rejects.toThrow();
  expect(leases).toBe(before);
  await expect(factory(publicKeyHex, scope)).rejects.toThrow();
  const replacement = createLifecycleScope({ kind: "runtime-unit", metadata: { pluginId: "vault" } });
  const next = await factory(publicKeyHex, replacement);
  expect((await next.deriveP2pkhAddress({ publicKeyHex, network: "main" })).address).toBe("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
  expect(() => cached.getIdentity()).toThrow();
  await scope.dispose(); await replacement.dispose();
});

it.each(["sign", "derive-address"] as const)("discards late %s results after provider revoke, beyond the I/O lease", async operation => {
  const { createLifecycleScope } = await import("webloom-framework");
  const scope = createLifecycleScope({ kind: "runtime-unit", metadata: { pluginId: "vault" } });
  const keySession = createWorkerKeySession(() => ({ unlocked: true, publicKeyHex, sessionEpoch: "same" }));
  keySession.replace(Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0));
  let finish!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const factory = createWorkerActiveKeyCryptoFactory({ keySession, sessionEpoch: () => "same",
    summary: () => ({ publicKeyHex, capabilities: ["p2pkh"], createdAt: "today", label: "Key" }),
    async withIoLease(_operation, execute) { const result = await execute(); entered(); await waiting; return result; },
  });
  const cached = await factory(publicKeyHex, scope);
  const pending = operation === "sign" ? cached.signDigest({ publicKeyHex, digest: new Uint8Array(32).buffer, format: "compact" }) : cached.deriveP2pkhAddress({ publicKeyHex, network: "main" });
  await started; scope.revoke("provider removed"); finish();
  await expect(pending).rejects.toThrow();
  await scope.dispose();
});
