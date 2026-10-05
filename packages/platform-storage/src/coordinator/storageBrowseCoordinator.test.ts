import { describe, expect, it, vi } from "vitest";
import { createIndexedDbWalletStore } from "../local/indexedDbWalletStore.js";
import { createPlatformRootStore } from "../storage-access/platform-root/platformRootStore.js";
import type { StorageBrowseSession } from "../runtime/storageBrowseTypes.js";
import { StorageBrowseCoordinator } from "./storageBrowseCoordinator.js";

const generations = { walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1" };
const open = (peer: string) => ({ kind: "storage.browse.open" as const, expectedSessionEpoch: "epoch-1", clientId: peer, requestId: `open-${peer}` });

describe("Storage browse Worker ownership", () => {
  it("shares one runtime during concurrent page opens and keeps both page handles usable", async () => {
    const store = createIndexedDbWalletStore({ databaseName: `browse-coordinator-${crypto.randomUUID()}` });
    try {
      await store.put("contacts/doc.json", new TextEncoder().encode('{"existing":true}'));
      const root = createPlatformRootStore({ store, generations: () => generations, isCurrent: () => true });
      const opening = vi.spyOn(root, "openBrowseStore");
      const coordinator = new StorageBrowseCoordinator({ root: () => ({ store: root, token: root }), generations: () => generations,
        isUnlocked: () => true, isPeerOpen: () => true, isPeerRevoked: () => false, withReadLease: task => task(),
      });
      const [first, second] = await Promise.all([coordinator.execute(open("first"), "first"), coordinator.execute(open("second"), "second")]);
      expect(opening).toHaveBeenCalledTimes(1);
      for (const [peer, response] of [["first", first], ["second", second]] as const) {
        expect(response.ack.status).toBe("ok");
        const session = response.operationResult as StorageBrowseSession;
        const listed = await coordinator.execute({ kind: "storage.browse.data", expectedSessionEpoch: "epoch-1", clientId: peer,
          requestId: `list-${peer}`, data: { type: "browse.list", browseSessionId: session.browseSessionId, prefix: "" } }, peer);
        expect(listed.ack.status).toBe("ok");
        expect(listed.operationResult).toMatchObject({ entries: [{ path: "contacts/doc.json" }] });
      }
      coordinator.dropBinding();
      expect(coordinator.hasClientAuthorization("first")).toBe(false);
    } finally { store.close(); }
  });

  it("rejects a peer without a committed page session before opening any browse store", async () => {
    const root = vi.fn(() => undefined);
    const coordinator = new StorageBrowseCoordinator({ root, generations: () => generations, isUnlocked: () => true,
      isPeerOpen: () => false, isPeerRevoked: () => false, withReadLease: task => task(),
    });
    expect((await coordinator.execute(open("outsider"), "outsider")).ack).toMatchObject({ status: "error", code: "storage_forbidden" });
    expect(root).not.toHaveBeenCalled();
  });
});
