import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { P2pkhLocalInputClaim, P2pkhProtocolSubmission } from "./p2pkhContracts.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";

const encoder = new TextEncoder();
const path = (id: string) => `protocol/${bytesToHex(sha256(encoder.encode(id)))}.json`;
type Evidence = { format: "keymaster.p2pkh.protocol"; version: 1; submission: P2pkhProtocolSubmission; claims: P2pkhLocalInputClaim[] };
const statuses = new Set(["prepared", "broadcast-pending-woc", "woc-observed-unconfirmed", "woc-confirmed", "woc-dropped", "rejected", "unknown", "provider-inconsistent"]);
const txid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function decode(bytes: Uint8Array, filename: string): Evidence {
  if (bytes.length > 1024 * 1024) throw new Error("Protocol evidence too large");
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Evidence;
  const row = value?.submission;
  if (value.format !== "keymaster.p2pkh.protocol" || value.version !== 1 || !row || typeof row.id !== "string" || path(row.id) !== filename
    || !txid(row.canonicalTxid) || !/^(02|03)[a-f0-9]{64}$/u.test(row.publicKeyHex) || !["main", "test"].includes(row.network)
    || !statuses.has(row.status) || !Array.isArray(row.inputs) || !row.inputs.length || !Array.isArray(row.localInputClaimIds) || !Array.isArray(value.claims)
    || !row.inputs.every(input => txid(input.txid) && Number.isSafeInteger(input.vout) && input.vout >= 0)
    || !value.claims.every(claim => typeof claim.id === "string" && claim.submissionId === row.id && claim.publicKeyHex === row.publicKeyHex
      && claim.network === row.network && txid(claim.txid) && Number.isSafeInteger(claim.vout) && claim.vout >= 0 && ["active", "isolated", "released", "confirmed"].includes(claim.state))) throw new Error("Corrupt protocol evidence; spending blocked");
  return value;
}

/** Wallet protocol WAL only; ordinary UTXO and chain data remain in their existing owners. */
export function createWorkerProtocolEvidence(files: BorrowedModuleFileStore) {
  const state = async () => createP2pkhStateRepository(await openP2pkhStateRepository(files));
  async function listEvidence() {
    const output: Evidence[] = [];
    let cursor: string | undefined;
    do {
      const page = await files.list({ prefix: "protocol/", ...(cursor ? { cursor } : {}) });
      for (const file of page.files) {
        const object = await files.get(file.path);
        if (!object) throw new Error("Protocol evidence disappeared during read");
        output.push(decode(object.bytes, file.path));
      }
      cursor = page.nextCursor;
    } while (cursor);
    return output;
  }
  async function hydrate() {
    const repository = await state();
    const bundle = await openP2pkhStateRepository(files);
    for (const evidence of await listEvidence()) {
      await repository.putProtocolSubmission(evidence.submission);
      for (const claim of evidence.claims) {
        const current = bundle.memory.localClaims.get(claim.id);
        if (current && current.submissionId !== claim.submissionId && current.state === "active") continue;
        bundle.memory.localClaims.set(claim.id, structuredClone(claim));
      }
    }
    return repository;
  }
  return {
    async getProtocolSubmission(id: string) {
      const object = await files.get(path(id));
      if (!object) return undefined;
      const value = decode(object.bytes, path(id));
      if (value.submission.id !== id) throw new Error("Protocol evidence id mismatch");
      return value.submission;
    },
    async listProtocolSubmissions() { return (await listEvidence()).map(value => value.submission); },
    async listLocalInputClaims() { return (await listEvidence()).flatMap(value => value.claims); },
    async tryClaimInputs(input: Parameters<Awaited<ReturnType<typeof state>>["tryClaimInputs"]>[0]) { return (await hydrate()).tryClaimInputs(input); },
    async putProtocolSubmission(row: P2pkhProtocolSubmission) {
      const repository = await state();
      const claims = (await repository.listLocalInputClaims()).filter(claim => claim.submissionId === row.id);
      const previous = await files.get(path(row.id));
      const old = previous ? decode(previous.bytes, path(row.id)) : undefined;
      if (old && (old.submission.canonicalTxid !== row.canonicalTxid || old.submission.publicKeyHex !== row.publicKeyHex || old.submission.network !== row.network)) throw new Error("Protocol evidence identity changed");
      const evidence: Evidence = { format: "keymaster.p2pkh.protocol", version: 1, submission: row, claims: claims.length ? claims : old?.claims ?? [] };
      await files.put(path(row.id), encoder.encode(JSON.stringify(evidence)), previous ? { ifRevision: previous.revision } : { ifNoneMatch: true });
      await repository.putProtocolSubmission(row);
    },
    async releaseLocalInputClaims(ids: string[]) {
      const repository = await hydrate();
      await repository.releaseLocalInputClaims(ids);
      for (const evidence of await listEvidence()) {
        if (!evidence.claims.some(claim => ids.includes(claim.id))) continue;
        const object = await files.get(path(evidence.submission.id));
        if (!object) throw new Error("Protocol evidence disappeared during release");
        const next = decode(object.bytes, path(evidence.submission.id));
        next.claims = next.claims.map(claim => ids.includes(claim.id) ? { ...claim, state: "released", updatedAt: new Date().toISOString() } : claim);
        await files.put(path(next.submission.id), encoder.encode(JSON.stringify(next)), { ifRevision: object.revision });
      }
    },
  };
}
