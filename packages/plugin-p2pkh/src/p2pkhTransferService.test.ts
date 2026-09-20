import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhLocalInputClaim, type P2pkhLocalTransaction, type P2pkhUtxo } from "./p2pkhContracts.js";

const PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = deriveP2pkhAddress(PRIVATE_KEY, "main");
const RECIPIENT = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");
const FUNDING_TXID = "09".repeat(32);
function hexToBytes(value: string): Uint8Array { return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)); }

function makeUtxo(value = 3_000, txid = FUNDING_TXID, vout = 0): P2pkhUtxo {
  return { id: `coin-${txid}-${vout}`, resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, network: "main", address: OWNER.address, txid, vout, value, height: 1, status: "confirmed", isSpentInMempoolTx: false, syncedAt: "2024-01-01T00:00:00.000Z" };
}

function makeVault() {
  return {
    status: () => "unlocked",
    createActiveKeyCrypto: async () => ({
      async deriveP2pkhAddress(input: { network: "main" | "test" }) {
        const derived = deriveP2pkhAddress(PRIVATE_KEY, input.network);
        return { publicKeyHex: derived.publicKeyHex, address: derived.address };
      },
      async signDigest(input: { digest: ArrayBuffer; format: "der" | "compact" }) {
        const signature = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(PRIVATE_KEY), { lowS: true, prehash: false, format: input.format });
        return { publicKeyHex: OWNER.publicKeyHex, format: input.format, signature: signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) };
      }
    })
  } as never;
}

function makeRepository(resource: P2pkhKeyResource) {
  const claims = new Map<string, P2pkhLocalInputClaim>();
  const locals = new Map<string, P2pkhLocalTransaction>();
  return {
    claims, locals,
    async getResource(id: string) { return id === resource.resourceId ? resource : undefined; },
    async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims: P2pkhLocalInputClaim[] }) {
      for (const claim of input.claims) {
        const existing = claims.get(claim.id);
        if (existing && existing.submissionId !== claim.submissionId && !["released", "confirmed"].includes(existing.state)) throw new Error("P2PKH input already claimed");
      }
      locals.set(input.submission.id, { ...input.submission, localState: "submitting", chainResolution: "unresolved" });
      for (const claim of input.claims) claims.set(claim.id, { ...claim, state: "active" });
    },
    async abortUnattemptedLocalSubmission(input: { submissionId: string }) {
      const row = locals.get(input.submissionId);
      if (!row || row.attempts.length) return;
      locals.delete(input.submissionId);
      for (const [id, claim] of claims) if (claim.submissionId === input.submissionId) claims.delete(id);
    }
  };
}

function makeResource(): P2pkhKeyResource {
  return { resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, label: "active", address: OWNER.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0 };
}

function makeService(outcome: "accepted" | "already-known" | "isolated" | "not-dispatched" = "accepted", broadcastError?: Error, options?: { utxos?: P2pkhUtxo[] }) {
  const resource = makeResource();
  const stateRepository = makeRepository(resource);
  const utxos = options?.utxos ?? [makeUtxo()];
  const loadSpendableUtxos = vi.fn(async () => [...utxos]);
  const broadcast = vi.fn(async ({ submissionId }: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string }) => {
    if (broadcastError) throw broadcastError;
    if (outcome === "not-dispatched") {
      await stateRepository.abortUnattemptedLocalSubmission({ submissionId });
      return { status: "ok" as const, value: { status: "not-dispatched", reason: "coordinator-not-connected" }, sessionEpoch: "test-epoch" };
    }
    return { status: "ok" as const, value: { status: outcome }, sessionEpoch: "test-epoch" };
  });
  const service = createP2pkhTransferService({
    vault: makeVault(),
    messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never,
    getStore: async () => stateRepository as never,
    loadSpendableUtxos: loadSpendableUtxos as never,
    broadcastWithCoordinator: broadcast as never,
    getActiveKey: () => ({ publicKeyHex: OWNER.publicKeyHex, label: "active", capabilities: ["p2pkh"], createdAt: "now" }),
    getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: ["p2pkh"], createdAt: "now" })
  });
  return { service, stateRepository, broadcast, loadSpendableUtxos };
}

async function prepare(service: ReturnType<typeof makeService>["service"]) {
  return service.prepare({ ownerPublicKeyHex: OWNER.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
}

describe("ordinary P2PKH Coordinator transfer", () => {
  it("refreshes spendable UTXOs before prepare without any broadcast", async () => {
    const { service, broadcast, loadSpendableUtxos } = makeService();
    const preview = await prepare(service);
    expect(preview.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(loadSpendableUtxos).toHaveBeenCalledTimes(1);
    expect(loadSpendableUtxos).toHaveBeenCalledWith(expect.objectContaining({ ownerPublicKeyHex: OWNER.publicKeyHex }));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["accepted", "already-known"] as const)("promotes %s to local-confirmed", async (outcome) => {
    const { service, stateRepository, broadcast, loadSpendableUtxos } = makeService(outcome);
    const preview = await prepare(service);
    const result = await service.submit(preview);
    expect(result.status).toBe("local-confirmed");
    expect(result.localInputClaimIds).toHaveLength(1);
    // 提交前再次刷新快照并校验输入仍然可花。
    expect(loadSpendableUtxos).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ ownerPublicKeyHex: OWNER.publicKeyHex, network: "main" }));
    expect([...stateRepository.locals.values()][0]?.localState).toBe("submitting");
    expect([...stateRepository.claims.values()][0]?.state).toBe("active");
  });

  it("isolates provider failure and keeps the input claim for reconciliation", async () => {
    const { service, stateRepository } = makeService("isolated");
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("isolated");
    expect([...stateRepository.locals.values()][0]?.localState).toBe("submitting");
    expect([...stateRepository.claims.values()][0]?.state).toBe("active");
  });

  it("does not write a terminal state when the Coordinator RPC response is lost", async () => {
    const { service, stateRepository } = makeService("accepted", new Error("Coordinator port closed"));
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("isolated");
    expect(result.error).toBe("Coordinator port closed");
    expect([...stateRepository.locals.values()][0]?.localState).toBe("submitting");
    expect([...stateRepository.locals.values()][0]?.isolationReason).toBeUndefined();
    expect([...stateRepository.claims.values()][0]?.state).toBe("active");
  });

  it("revokes a submission when the Coordinator explicitly reports no dispatch", async () => {
    const { service, stateRepository } = makeService("not-dispatched");
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("not-dispatched");
    expect(result.localInputClaimIds).toEqual([]);
    expect(stateRepository.locals.size).toBe(0);
    expect(stateRepository.claims.size).toBe(0);
  });

  it("rejects isolated inputs that the loader already excluded", async () => {
    const { service, stateRepository } = makeService("accepted", undefined, { utxos: [] });
    stateRepository.claims.set("isolated", { id: "isolated", submissionId: "old", resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, network: "main", txid: FUNDING_TXID, vout: 0, value: 3_000, outpointKey: `${FUNDING_TXID}:0`, state: "isolated", createdAt: "now", updatedAt: "now" });
    await expect(prepare(service)).rejects.toThrow(/no-utxos|insufficient|Available inputs/i);
  });

  it("revalidates the preview inputs against the refreshed snapshot before writing claims", async () => {
    const { service, stateRepository, broadcast } = makeService();
    const preview = await prepare(service);
    const tampered = {
      ...preview,
      allocation: {
        ...preview.allocation,
        selected: [{ ...preview.allocation.selected[0]!, txid: "cc".repeat(32) }]
      }
    };
    await expect(service.submit(tampered)).rejects.toThrow(/input/i);
    expect(stateRepository.locals.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("uses exactly the loader-provided spendable set for selection", async () => {
    const ordinaryTxid = "bb".repeat(32);
    const { service } = makeService("accepted", undefined, { utxos: [makeUtxo(3_000, ordinaryTxid)] });
    const preview = await prepare(service);
    expect(preview.allocation.selected.map((input) => input.txid)).toEqual([ordinaryTxid]);
  });

  it("rejects before writing when the Coordinator broadcast is unavailable", async () => {
    const { service, stateRepository } = makeService();
    const preview = await prepare(service);
    const gated = createP2pkhTransferService({
      vault: makeVault(), messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never,
      getStore: async () => stateRepository as never,
      loadSpendableUtxos: async () => [makeUtxo()],
      getActiveKey: () => ({ publicKeyHex: OWNER.publicKeyHex, label: "active", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" })
    });
    await expect(gated.submit(preview)).rejects.toThrow(/Coordinator broadcast/);
    expect(stateRepository.locals.size).toBe(0);
    expect(stateRepository.claims.size).toBe(0);
  });
});
