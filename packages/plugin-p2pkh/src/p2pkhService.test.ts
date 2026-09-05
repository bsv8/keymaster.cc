import { afterEach, describe, expect, it } from "vitest";
import type { KeyspaceService, OwnerAppStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { createP2pkhService } from "./p2pkhService.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import { sha256 } from "@noble/hashes/sha256";
import type { P2pkhKeyResource, P2pkhLocalOutpoint, P2pkhLocalTransaction } from "./p2pkhContracts.js";

const OWNER = "02" + "11".repeat(32);
const resource: P2pkhKeyResource = { resourceId: "p2pkh:main", publicKeyHex: OWNER, label: "test", address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", network: "main", createdAt: new Date(0).toISOString(), generation: 0 };

function bytes(raw: string): Uint8Array { return Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16))); }
function txid(raw: string): string { return Array.from(sha256(sha256(bytes(raw))).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function makeTx(scriptHex: string, value: number): string {
  const valueHex = value.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  return `0100000001${"00".repeat(32)}0000000000ffffffff01${valueHex}${(scriptHex.length / 2).toString(16).padStart(2, "0")}${scriptHex}00000000`;
}
function keyspace(): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex: OWNER }),
    getKey: async () => ({ publicKeyHex: OWNER, label: "test", capabilities: ["p2pkh"], createdAt: new Date(0).toISOString() }),
    onActiveKeyChanged: () => () => undefined
  } as unknown as KeyspaceService;
}

function ownerStore(): OwnerAppStore {
  return createInMemoryKeyValueStore({
    scope: "key",
    ownerPublicKeyHex: OWNER,
    applicationStorageId: "UTXOS",
    schemaVersion: 1,
    bucketId: "test",
    bucketGeneration: 1
  }) as OwnerAppStore;
}

const vault = {
  status: () => "unlocked",
  createActiveKeyCrypto: async () => ({ deriveP2pkhAddress: async () => ({ publicKeyHex: OWNER, address: resource.address }) })
} as never;
const messageBus = { publish: () => undefined, subscribe: () => () => undefined } as never;

afterEach(() => {
  disposeP2pkhStateRepository();
});

describe("P2PKH service canonical allocation", () => {
  it("uses the confirmed chain candidate when public allocate sees the same local outpoint", async () => {
    const ownerKeyspace = keyspace();
    const storage = ownerStore();
    const stateRepository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
    await stateRepository.putAddress(resource);
    const rawTxHex = makeTx(p2pkhAddressToScriptHex(resource.address, "main"), 1_000);
    const confirmedTxid = txid(rawTxHex);
    await stateRepository.ingestConfirmedTransaction({ resource, tx: { txid: confirmedTxid, rawTxHex, blockHeight: 100 } });
    const local: P2pkhLocalTransaction = { id: "stale-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: confirmedTxid, rawTxHex, localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 9_000, scriptHex: p2pkhAddressToScriptHex(resource.address, "main") }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] };
    const output: P2pkhLocalOutpoint = { id: "stale-output", resourceId: resource.resourceId, txid: confirmedTxid, vout: 0, value: 9_000, scriptHex: local.ownOutputs[0]!.scriptHex, submissionId: local.id, state: "available", createdAt: local.createdAt, updatedAt: local.updatedAt };
    await stateRepository.prepareLocalSubmission({ submission: local, claims: [], localOutpoints: [output] });
    await stateRepository.finishLocalSubmission({ submissionId: local.id, localState: "local-confirmed" });
    const service = createP2pkhService({ vault, keyspace: ownerKeyspace, messageBus, storage });
    await service.rehydrate();
    const allocation = await service.allocateUtxos({ assetId: "bsv", amountSatoshis: 100 });
    expect(allocation.selected).toHaveLength(1);
    expect(allocation.selected[0]).toMatchObject({ txid: confirmedTxid, value: 1_000, status: "confirmed" });
    service.dispose?.();
  });
});
