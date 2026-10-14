import { commitment } from "./crypto.js";
import { secpIdentityVerifier } from "./bsv.js";
import { equal, fail, fixed } from "./bytes.js";
import { decode, encode, object } from "./cbor.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const fields = ["version", "id", "walletGeneration", "publicKey", "sourceHash", "policyHash", "direction", "phase", "targetHash"];
export function inspectDeviceMigration(value) {
    const r = object(value, fields);
    if (r.version !== 1 || typeof r.id !== "string" || !uuid.test(r.id)
        || typeof r.walletGeneration !== "string" || !uuid.test(r.walletGeneration)
        || (r.direction !== "to-hardware" && r.direction !== "to-software")
        || typeof r.phase !== "string" || !["staged", "device-committed", "host-committed", "erasing", "erased", "complete"].includes(r.phase))
        fail("corrupt-migration");
    const pub = fixed(r.publicKey, 33);
    if (pub[0] !== 2 && pub[0] !== 3)
        fail("corrupt-migration");
    const hasTarget = !["staged", "device-committed"].includes(r.phase);
    if (hasTarget !== (r.targetHash !== null)
        || (r.direction === "to-hardware" && ["erasing", "erased"].includes(r.phase)))
        fail("corrupt-migration");
    return { version: 1, id: r.id, walletGeneration: r.walletGeneration,
        publicKey: new Uint8Array(pub), sourceHash: new Uint8Array(fixed(r.sourceHash, 32)),
        policyHash: new Uint8Array(fixed(r.policyHash, 32)), direction: r.direction,
        phase: r.phase,
        targetHash: r.targetHash === null ? null : new Uint8Array(fixed(r.targetHash, 32)) };
}
export function encodeDeviceMigration(value) {
    return encode(inspectDeviceMigration(value), 1024);
}
export function decodeDeviceMigration(bytes) {
    return inspectDeviceMigration(decode(bytes, 1024));
}
/** The host must bind a public status reply to its durable journal before using
 * the phase. Receiving "complete" for another migration cannot activate a key. */
export function assertDeviceMigrationBinding(record, expected) {
    const r = inspectDeviceMigration(record);
    if (r.id !== expected.id || r.walletGeneration !== expected.walletGeneration || r.direction !== expected.direction
        || !equal(r.publicKey, expected.publicKey) || !equal(r.sourceHash, expected.sourceHash) || !equal(r.policyHash, expected.policyHash))
        fail("migration-conflict");
}
/** Semantic import proof: the freshly PIN-wrapped business key signs an exact
 * source identity/ledger/challenge tuple. A temporary USB key cannot substitute
 * its handshake signature, and a public phase alone is not proof of import. */
export async function migrationImportProofCommitment(record, challenge) {
    const r = inspectDeviceMigration(record);
    if (r.direction !== "to-hardware")
        fail("migration-conflict");
    return commitment("key-import-proof", 1, { id: r.id, publicKey: r.publicKey, sourceHash: r.sourceHash, policyHash: r.policyHash, challenge: fixed(challenge, 32) });
}
export async function verifyMigrationImportProof(record, challenge, signature) {
    const r = inspectDeviceMigration(record);
    if (!["device-committed", "host-committed", "complete"].includes(r.phase)
        || !secpIdentityVerifier.verify(await migrationImportProofCommitment(r, challenge), signature, r.publicKey))
        fail("migration-key-proof-invalid");
}
