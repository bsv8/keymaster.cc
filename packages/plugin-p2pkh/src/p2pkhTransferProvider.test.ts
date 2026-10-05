import { walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
import { describe, expect, it } from "vitest";
import type { BalanceBroadcaster, GlobalBalanceSnapshot, VaultWalletState } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import type { P2pkhService } from "./p2pkhContracts.js";
import { createP2pkhTransferProvider } from "./p2pkhTransferProvider.js";

const OWNER = "02" + "11".repeat(32);

function createDeps() {
  let snapshot: GlobalBalanceSnapshot = {
    publicKeyHex: OWNER,
    includeTestnet: false,
    balances: { mainnet: { total: 1000, available: true } },
    revision: 1,
  };
  const service = {
    balanceBroadcaster: {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } satisfies BalanceBroadcaster,
    getGlobalSettings: () => ({ includeTestnet: false }),
    syncStatus: () => "idle" as const,
    onSyncStatusChange: () => () => undefined,
    onGlobalSettingsChange: () => () => undefined,
  } as unknown as P2pkhService;
  const walletState = {
    isInitializing: () => false,
    snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: OWNER }))()),
    subscribe: () => () => undefined,
    onInitializationChange: () => () => undefined,
  } as unknown as VaultWalletState;
  const messageBus = { subscribe: () => () => undefined } as unknown as MessageBus;
  return {
    service,
    walletState,
    messageBus,
    setBalance(total: number) {
      snapshot = { ...snapshot, balances: { mainnet: { total, available: true } }, revision: snapshot.revision + 1 };
    },
  };
}

describe("p2pkhTransferProvider", () => {
  it("T05：offer 读取余额广播的最新主网值，未知不伪装成 0", async () => {
    const deps = createDeps();
    const provider = createP2pkhTransferProvider(deps);

    expect((await provider.listOffers())[0]?.balance).toMatchObject({ amount: 1000, available: true });
    deps.setBalance(400);
    expect((await provider.listOffers())[0]?.balance).toMatchObject({ amount: 400, available: true });

    provider.dispose();
  });
});
