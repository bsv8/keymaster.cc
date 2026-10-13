import { expect, it } from "vitest";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { watchWindowCleanupFailures } from "./windowCleanupFailures.js";

it("reports a native Scope cleanup failure before a later disposer finishes", async () => {
  let unblock!: () => void;
  const pending = new Promise<void>(resolve => { unblock = resolve; });
  const identity = { vaultStatus: "unlocked" as const, ownerPublicKeyHex: "owner", sessionEpoch: "session", runGeneration: "run", walletGeneration: "wallet" };
  const host = createFixtureHost({ runtime: "window-main", initialRuntimeIdentity: identity,
    runtimeUnitImplementationRegistry: { get: () => context => {
      // Native Scope executes disposers in reverse registration order.
      context.onDispose(() => pending);
      context.onDispose(() => { throw new Error("first-native-cleanup-failure"); });
    } },
  });
  const failures: string[] = [];
  let gotFailure!: () => void;
  const failure = new Promise<void>(resolve => { gotFailure = resolve; });
  const off = watchWindowCleanupFailures(host, () => "lock:1", details => { failures.push(details); gotFailure(); });
  await host.register({ id: "failing-plugin", name: "Failing plugin", units: [{ id: "failing-plugin.window", runtime: "window-main", scopeKind: "owner-session" }] });
  let settled = false;
  const transition = host.transitionRuntimeIdentity({ ...identity, vaultStatus: "locked", ownerPublicKeyHex: undefined, sessionEpoch: "locked" });
  const finished = transition.then(() => { settled = true; }, () => { settled = true; });
  try {
    await failure;
    expect(settled).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("first-native-cleanup-failure");
    expect(failures[0]).toContain("resourceId");
  } finally {
    unblock(); await finished;
    off(); await host.dispose("test");
  }
});
