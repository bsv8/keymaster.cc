import { StrictMode, useSyncExternalStore } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultLifecycleSnapshot } from "@keymaster/contracts";
import { createWalletStateSource } from "./walletStateAccess.js";

afterEach(cleanup);

describe("wallet snapshot React subscription", () => {
  it("mounts and updates through cleanup without repeatedly rendering unchanged state", () => {
    let committed: VaultLifecycleSnapshot = { status: "locked", sessionEpoch: "locked", runGeneration: "run", vaultLifecycleRevision: 1 };
    const source = createWalletStateSource(() => committed);
    let renders = 0;
    function LockScreen() {
      // Bound the regression itself: a broken snapshot must fail the test,
      // rather than consuming an unbounded stream of React rerenders.
      if (++renders > 20) throw new Error("Wallet snapshot caused a render loop");
      const snapshot = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
      return <p>{snapshot.lockCleanup?.phase ?? "ready"}</p>;
    }
    const screen = render(<StrictMode><LockScreen /></StrictMode>);
    expect(screen.getByText("ready")).toBeTruthy();
    const initialRenders = renders;
    act(() => { committed = { ...committed }; source.publish(); });
    expect(renders).toBe(initialRenders);
    act(() => {
      committed = { ...committed, lockCleanup: { phase: "pending", attempt: 1 }, vaultLifecycleRevision: 2 };
      source.publish();
    });
    expect(screen.getByText("pending")).toBeTruthy();
    const pendingRenders = renders;
    act(() => { source.publish(); });
    expect(renders).toBe(pendingRenders);
    act(() => {
      committed = { ...committed, lockCleanup: undefined, vaultLifecycleRevision: 3 };
      source.publish();
    });
    expect(screen.getByText("ready")).toBeTruthy();
    expect(renders).toBeLessThanOrEqual(8);
    screen.unmount();
    source.dispose();
  });
});
