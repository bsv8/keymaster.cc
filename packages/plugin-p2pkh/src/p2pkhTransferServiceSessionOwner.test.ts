import { describe, expect, it, vi } from "vitest";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhUtxo } from "./p2pkhContracts.js";

const OWNER_A = deriveP2pkhAddress("00000000000000000000000000000000000000000000000000000000000000a1", "main");
const OWNER_B = deriveP2pkhAddress("00000000000000000000000000000000000000000000000000000000000000b1", "main");
const RECIPIENT = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");

function makeRepository(owner: typeof OWNER_A) {
  const resource: P2pkhKeyResource = { resourceId: makeResourceId("main"), publicKeyHex: owner.publicKeyHex, label: "owner", address: owner.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0 };
  const utxo: P2pkhUtxo = { id: "funding", resourceId: resource.resourceId, publicKeyHex: owner.publicKeyHex, network: "main", address: owner.address, txid: "09".repeat(32), vout: 0, value: 3_000, status: "confirmed", isSpentInMempoolTx: false, syncedAt: resource.createdAt };
  return {
    resource, utxo,
    async getResource(id: string) { return id === resource.resourceId ? resource : undefined; },
    async prepareLocalSubmission() {},
    async abortUnattemptedLocalSubmission() {},
  };
}

function makeVault() {
  return { status: () => "unlocked", createActiveKeyCrypto: async (publicKeyHex: string) => ({ deriveP2pkhAddress: async (input: { network: "main" | "test" }) => ({ ...deriveP2pkhAddress(publicKeyHex === OWNER_A.publicKeyHex ? "00000000000000000000000000000000000000000000000000000000000000a1" : "00000000000000000000000000000000000000000000000000000000000000b1", input.network) }), signDigest: async () => ({ publicKeyHex, format: "der" as const, signature: new Uint8Array(64).buffer }) }) } as never;
}

describe("ordinary P2PKH transfer owner binding", () => {
  it("opens the namespace selected by the preview owner and refreshes its UTXOs", async () => {
    const openedOwners: string[] = [];
    const loadedOwners: string[] = [];
    const stores = new Map<string, ReturnType<typeof makeRepository>>();
    const service = createP2pkhTransferService({
      vault: makeVault(),
      messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never,
      getStore: async (publicKeyHex) => { openedOwners.push(publicKeyHex); if (!stores.has(publicKeyHex)) stores.set(publicKeyHex, makeRepository(publicKeyHex === OWNER_A.publicKeyHex ? OWNER_A : OWNER_B)); return stores.get(publicKeyHex) as never; },
      loadSpendableUtxos: async ({ ownerPublicKeyHex, resource }: { ownerPublicKeyHex: string; resource: P2pkhKeyResource }) => {
        loadedOwners.push(ownerPublicKeyHex);
        const store = stores.get(ownerPublicKeyHex);
        return store ? [store.utxo] : [{ id: "x", resourceId: resource.resourceId, publicKeyHex: ownerPublicKeyHex, network: "main" as const, address: resource.address, txid: "09".repeat(32), vout: 0, value: 3_000, status: "confirmed" as const, isSpentInMempoolTx: false, syncedAt: resource.createdAt }];
      },
      broadcastWithCoordinator: async () => ({ status: "ok" as const, value: { status: "accepted" }, sessionEpoch: "test-epoch" }),
      getActiveKey: () => ({ publicKeyHex: OWNER_A.publicKeyHex, label: "a", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "b", capabilities: [], createdAt: "now" }),
    });
    await service.prepare({ ownerPublicKeyHex: OWNER_B.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
    expect(openedOwners).toContain(OWNER_B.publicKeyHex);
    expect(loadedOwners).toContain(OWNER_B.publicKeyHex);
  });
});
