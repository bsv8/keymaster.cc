import { describe, expect, it } from "vitest";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";

describe("createKeyspaceServiceCoordinator", () => {
  it("initializes from the Coordinator bootstrap snapshot", () => {
    const coordinatorClient = {
      getBootstrapSnapshot: () => ({
        sessionEpoch: "test",
        vaultStatus: "unlocked" as const,
        activePublicKeyHex: "02".padEnd(66, "a"),
        keyspaceGeneration: 7,
        taskSnapshots: [],
        scheduleSettings: { assetHoldingsIntervalMs: 900_000 }
      }),
      subscribeTopic: () => () => undefined,
      backgroundCancelByKey: async () => ({ status: "accepted" as const }),
      vaultOperation: async () => ({ status: "ok" as const, value: undefined, sessionEpoch: "test" })
    };

    const keyspace = createKeyspaceServiceCoordinator(coordinatorClient);

    expect(keyspace.active()).toEqual({ activePublicKeyHex: "02".padEnd(66, "a") });
    expect(keyspace.requireActiveKey().publicKeyHex).toBe("02".padEnd(66, "a"));
  });
});
