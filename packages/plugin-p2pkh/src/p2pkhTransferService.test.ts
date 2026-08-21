import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhLocalInputClaim, type P2pkhLocalOutpoint, type P2pkhLocalTransaction, type P2pkhUtxo } from "./p2pkhContracts.js";

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

function makeDb(utxos: P2pkhUtxo[], resource: P2pkhKeyResource) {
  const claims = new Map<string, P2pkhLocalInputClaim>();
  const locals = new Map<string, P2pkhLocalTransaction>();
  const outputs = new Map<string, P2pkhLocalOutpoint>();
  return {
    claims, locals, outputs,
    async getResource(id: string) { return id === resource.resourceId ? resource : undefined; },
    async listUtxos() { return utxos; },
    async listLocalInputClaimsByResource(id: string) { return [...claims.values()].filter((row) => row.resourceId === id); },
    async listLocalTransactions(id?: string) { return [...locals.values()].filter((row) => !id || row.resourceId === id); },
    async listLocalOutpoints(id?: string) { return [...outputs.values()].filter((row) => !id || row.resourceId === id); },
    async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims: P2pkhLocalInputClaim[]; localOutpoints: P2pkhLocalOutpoint[] }) {
      for (const claim of input.claims) {
        const existing = claims.get(claim.id);
        if (existing && existing.submissionId !== claim.submissionId && !["released", "confirmed"].includes(existing.state)) throw new Error("P2PKH input already claimed");
      }
      locals.set(input.submission.id, { ...input.submission, localState: "submitting", chainResolution: "unresolved" });
      for (const claim of input.claims) claims.set(claim.id, { ...claim, state: "active" });
      for (const output of input.localOutpoints) outputs.set(output.id, { ...output, state: "unavailable" });
    },
    async finishLocalSubmission(input: { submissionId: string; localState: "local-confirmed" | "isolated"; reason?: string }) {
      const row = locals.get(input.submissionId)!;
      locals.set(row.id, { ...row, localState: input.localState, isolationReason: input.reason, updatedAt: new Date().toISOString() });
      for (const claim of claims.values()) if (claim.submissionId === input.submissionId) claims.set(claim.id, { ...claim, state: input.localState === "local-confirmed" ? "active" : "isolated" });
      for (const output of outputs.values()) if (output.submissionId === input.submissionId) outputs.set(output.id, { ...output, state: input.localState === "local-confirmed" ? "available" : "isolated" });
    },
    async abortUnattemptedLocalSubmission(input: { submissionId: string }) {
      const row = locals.get(input.submissionId);
      if (!row || row.attempts.length) return;
      locals.delete(input.submissionId);
      for (const [id, claim] of claims) if (claim.submissionId === input.submissionId) claims.delete(id);
      for (const [id, output] of outputs) if (output.submissionId === input.submissionId) outputs.delete(id);
    }
  };
}

function makeResource(): P2pkhKeyResource {
  return { resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, label: "active", address: OWNER.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0 };
}

function makeService(outcome: "accepted" | "already-known" | "isolated" | "not-dispatched" = "accepted", broadcastError?: Error, options?: { utxos?: P2pkhUtxo[]; protectedOutpoints?: { isProtected(input: { txid: string; vout: number; network: "main" | "test"; publicKeyHex?: string }): boolean } }) {
  const db = makeDb(options?.utxos ?? [makeUtxo()], makeResource());
  const broadcast = vi.fn(async ({ submissionId }: { submissionId: string }) => {
    if (broadcastError) throw broadcastError;
    if (outcome === "not-dispatched") return { status: "ok" as const, value: { status: "not-dispatched", reason: "coordinator-not-connected" }, sessionEpoch: "test-epoch" };
    await db.finishLocalSubmission({ submissionId, localState: outcome === "isolated" ? "isolated" : "local-confirmed" });
    return { status: "ok" as const, value: { status: outcome }, sessionEpoch: "test-epoch" };
  });
  const service = createP2pkhTransferService({
    vault: makeVault(),
    messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never,
    getDb: async () => db as never,
    protectedOutpoints: options?.protectedOutpoints as never,
    broadcastPreflight: async () => ({ generation: 7 }),
    broadcastWithCoordinator: broadcast,
    getActiveKey: () => ({ publicKeyHex: OWNER.publicKeyHex, label: "active", capabilities: ["p2pkh"], createdAt: "now" }),
    getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: ["p2pkh"], createdAt: "now" })
  });
  return { service, db, broadcast };
}

async function prepare(service: ReturnType<typeof makeService>["service"]) {
  return service.prepare({ ownerPublicKeyHex: OWNER.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
}

describe("ordinary P2PKH Coordinator transfer", () => {
  it("prepares a final transaction without any broadcast", async () => {
    const { service, broadcast } = makeService();
    const preview = await prepare(service);
    expect(preview.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["accepted", "already-known"] as const)("promotes %s to local-confirmed", async (outcome) => {
    const { service, db, broadcast } = makeService(outcome);
    const preview = await prepare(service);
    const result = await service.submit(preview);
    expect(result.status).toBe("local-confirmed");
    expect(result.localInputClaimIds).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ expectedProviderGeneration: 7 }));
      expect([...db.locals.values()][0]?.localState).toBe("local-confirmed");
    expect([...db.claims.values()][0]?.state).toBe("active");
    expect([...db.outputs.values()][0]?.state).toBe("available");
  });

  it("isolates provider failure and never releases the input claim", async () => {
    const { service, db } = makeService("isolated");
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("isolated");
    expect([...db.claims.values()][0]?.state).toBe("isolated");
    expect([...db.locals.values()][0]?.localState).toBe("isolated");
  });

  it("does not write a terminal state when the Coordinator RPC response is lost", async () => {
    const { service, db } = makeService("accepted", new Error("Coordinator port closed"));
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("isolated");
    expect(result.error).toBe("Coordinator port closed");
    expect([...db.locals.values()][0]?.localState).toBe("submitting");
    expect([...db.locals.values()][0]?.isolationReason).toBeUndefined();
    expect([...db.claims.values()][0]?.state).toBe("active");
  });

  it("revokes a submission when the Coordinator explicitly reports no dispatch", async () => {
    const { service, db } = makeService("not-dispatched");
    const result = await service.submit(await prepare(service));
    expect(result.status).toBe("not-dispatched");
    expect(db.locals.size).toBe(0);
    expect(db.claims.size).toBe(0);
    expect(db.outputs.size).toBe(0);
  });

  it("does not select an isolated input for a new preview", async () => {
    const { service, db } = makeService();
    db.claims.set("isolated", { id: "isolated", submissionId: "old", resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, network: "main", txid: FUNDING_TXID, vout: 0, value: 3_000, outpointKey: `${FUNDING_TXID}:0`, state: "isolated", createdAt: "now", updatedAt: "now" });
    await expect(prepare(service)).rejects.toThrow(/No P2PKH UTXOs|no-utxos|insufficient/i);
  });

  it("revalidates the raw inputs and preview allocation before writing claims", async () => {
    const { service, db, broadcast } = makeService();
    const preview = await prepare(service);
    const tampered = {
      ...preview,
      allocation: {
        ...preview.allocation,
        selected: [{ ...preview.allocation.selected[0]!, txid: "cc".repeat(32) }]
      }
    };
    await expect(service.submit(tampered)).rejects.toThrow(/input/i);
    expect(db.locals.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("does not select a protocol-protected funding outpoint", async () => {
    const protectedTxid = "aa".repeat(32);
    const ordinaryTxid = "bb".repeat(32);
    const protectedOutpoints = { isProtected: vi.fn(({ txid }: { txid: string }) => txid === protectedTxid) };
    const { service } = makeService("accepted", undefined, { utxos: [makeUtxo(3_000, protectedTxid), makeUtxo(3_000, ordinaryTxid)], protectedOutpoints });
    const preview = await prepare(service);
    expect(preview.allocation.selected.map((input) => input.txid)).toEqual([ordinaryTxid]);
    expect(protectedOutpoints.isProtected).toHaveBeenCalledWith(expect.objectContaining({ txid: protectedTxid, network: "main", publicKeyHex: OWNER.publicKeyHex }));
  });

  it("deduplicates duplicate local logical outputs before public prepare", async () => {
    const { service, db } = makeService("accepted", undefined, { utxos: [] });
    const resourceId = makeResourceId("main");
    const txid = "ab".repeat(32);
    const now = "2024-01-01T00:00:00.000Z";
    const makeLocal = (id: string): P2pkhLocalTransaction => ({ id, resourceId, publicKeyHex: OWNER.publicKeyHex, network: "main", txid, rawTxHex: "", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 3_000, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] });
    db.locals.set("local-a", makeLocal("local-a"));
    db.locals.set("local-b", makeLocal("local-b"));
    const makeOutput = (id: string, submissionId: string): P2pkhLocalOutpoint => ({ id, resourceId, txid, vout: 0, value: 3_000, scriptHex: "", submissionId, state: "available", createdAt: now, updatedAt: now });
    db.outputs.set("output-a", makeOutput("output-a", "local-a"));
    db.outputs.set("output-b", makeOutput("output-b", "local-b"));
    const preview = await prepare(service);
    expect(preview.allocation.selected).toHaveLength(1);
    expect(preview.allocation.selected[0]).toMatchObject({ txid, vout: 0, value: 3_000 });
    expect(preview.allocation.totalInputSatoshis).toBe(3_000);
  });

  it("uses the confirmed candidate when transfer sees a stale local overlay", async () => {
    const txid = "ac".repeat(32);
    const { service, db } = makeService("accepted", undefined, { utxos: [makeUtxo(3_000, txid)] });
    const now = "2024-01-01T00:00:00.000Z";
    db.locals.set("stale-local", { id: "stale-local", resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, network: "main", txid, rawTxHex: "", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 9_000, scriptHex: "local-script" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] });
    db.outputs.set("stale-output", { id: "stale-output", resourceId: makeResourceId("main"), txid, vout: 0, value: 9_000, scriptHex: "local-script", submissionId: "stale-local", state: "available", createdAt: now, updatedAt: now });
    const preview = await service.prepare({ ownerPublicKeyHex: OWNER.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
    expect(preview.allocation.selected).toHaveLength(1);
    expect(preview.allocation.selected[0]).toMatchObject({ txid, value: 3_000, status: "confirmed" });
  });

  it("rejects before writing when the Coordinator preflight is unavailable", async () => {
    const { service, db } = makeService();
    const preview = await prepare(service);
    const gated = createP2pkhTransferService({
      vault: makeVault(), messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never,
      getDb: async () => db as never,
      getActiveKey: () => ({ publicKeyHex: OWNER.publicKeyHex, label: "active", capabilities: [], createdAt: "now" }),
      getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" })
    });
    await expect(gated.submit(preview)).rejects.toThrow(/Coordinator broadcast/);
    expect(db.locals.size).toBe(0);
    expect(db.claims.size).toBe(0);
  });
});
