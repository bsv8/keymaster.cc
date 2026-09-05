import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService } from "./p2pkhTransferService.js";
import { makeResourceId, type P2pkhKeyResource, type P2pkhLocalInputClaim, type P2pkhLocalOutpoint, type P2pkhLocalTransaction, type P2pkhUtxo } from "./p2pkhContracts.js";
import type { AssetDataNotifier } from "@keymaster/contracts";

const PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = deriveP2pkhAddress(PRIVATE_KEY, "main");
const RECIPIENT = deriveP2pkhAddress("0000000000000000000000000000000000000000000000000000000000000002", "main");
const TXID = "09".repeat(32);
function hexToBytes(value: string): Uint8Array { return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)); }

function makeVault() { return { status: () => "unlocked", createActiveKeyCrypto: async () => ({ deriveP2pkhAddress: async (input: { network: "main" | "test" }) => ({ ...deriveP2pkhAddress(PRIVATE_KEY, input.network) }), signDigest: async (input: { digest: ArrayBuffer; format: "der" | "compact" }) => { const signature = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(PRIVATE_KEY), { lowS: true, prehash: false, format: input.format }); return { publicKeyHex: OWNER.publicKeyHex, format: input.format, signature: signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) }; } }) } as never; }

function makeRepository() {
  const resource: P2pkhKeyResource = { resourceId: makeResourceId("main"), publicKeyHex: OWNER.publicKeyHex, label: "active", address: OWNER.address, network: "main", createdAt: "2024-01-01T00:00:00.000Z", generation: 0 };
  const utxo: P2pkhUtxo = { id: "coin", resourceId: resource.resourceId, publicKeyHex: OWNER.publicKeyHex, network: "main", address: OWNER.address, txid: TXID, vout: 0, value: 3_000, height: 1, status: "confirmed", isSpentInMempoolTx: false, syncedAt: resource.createdAt };
  const claims = new Map<string, P2pkhLocalInputClaim>(); const locals = new Map<string, P2pkhLocalTransaction>(); const outputs = new Map<string, P2pkhLocalOutpoint>();
  return { resource, claims, locals, outputs, async getResource(id: string) { return id === resource.resourceId ? resource : undefined; }, async listUtxos() { return [utxo]; }, async listLocalInputClaimsByResource() { return [...claims.values()]; }, async listLocalTransactions() { return [...locals.values()]; }, async listLocalOutpoints() { return [...outputs.values()]; }, async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims: P2pkhLocalInputClaim[]; localOutpoints: P2pkhLocalOutpoint[] }) { locals.set(input.submission.id, input.submission); for (const claim of input.claims) claims.set(claim.id, claim); for (const output of input.localOutpoints) outputs.set(output.id, output); }, async finishLocalSubmission(input: { submissionId: string; localState: "local-confirmed" | "isolated" }) { const row = locals.get(input.submissionId)!; locals.set(row.id, { ...row, localState: input.localState }); for (const claim of claims.values()) if (claim.submissionId === input.submissionId) claims.set(claim.id, { ...claim, state: input.localState === "local-confirmed" ? "active" : "isolated" }); for (const output of outputs.values()) if (output.submissionId === input.submissionId) outputs.set(output.id, { ...output, state: input.localState === "local-confirmed" ? "available" : "isolated" }); }, async abortUnattemptedLocalSubmission() {} };
}

function createFixture(outcome: "accepted" | "isolated") {
  const stateRepository = makeRepository(); const emit = vi.fn();
  const service = createP2pkhTransferService({ vault: makeVault(), messageBus: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) } as never, assetDataNotifier: { emit, subscribe: vi.fn() } as unknown as AssetDataNotifier, getStore: async () => stateRepository as never, broadcastPreflight: async () => ({ generation: 1 }), broadcastWithCoordinator: async ({ submissionId }: { submissionId: string }) => { await stateRepository.finishLocalSubmission({ submissionId, localState: outcome === "isolated" ? "isolated" : "local-confirmed" }); return { status: "ok" as const, value: { status: outcome }, sessionEpoch: "test-epoch" }; }, getActiveKey: () => ({ publicKeyHex: OWNER.publicKeyHex, label: "active", capabilities: [], createdAt: "now" }), getKeyForOwner: async (publicKeyHex) => ({ publicKeyHex, label: "active", capabilities: [], createdAt: "now" }) });
  return { service, stateRepository, emit };
}

describe("p2pkh transfer data notifications", () => {
  it("emits after local confirmation", async () => {
    const { service, emit } = createFixture("accepted");
    const preview = await service.prepare({ ownerPublicKeyHex: OWNER.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
    expect((await service.submit(preview)).status).toBe("local-confirmed");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ providerId: "p2pkh", publicKeyHex: OWNER.publicKeyHex }));
  });

  it("emits after isolation and keeps the local failure visible", async () => {
    const { service, stateRepository, emit } = createFixture("isolated");
    const preview = await service.prepare({ ownerPublicKeyHex: OWNER.publicKeyHex, assetId: "bsv", recipientAddress: RECIPIENT.address, amountSatoshis: 1_000, feeRateSatoshisPerKb: 1 });
    expect((await service.submit(preview)).status).toBe("isolated");
    expect([...stateRepository.claims.values()][0]?.state).toBe("isolated");
    expect(emit).toHaveBeenCalled();
  });
});
