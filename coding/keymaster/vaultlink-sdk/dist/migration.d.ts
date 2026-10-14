/** Public device recovery record. It is a commitment to progress, not a key
 * backup or authorization. Only the device's private migration controller may
 * advance it after the corresponding physical/storage action succeeds. */
export interface DeviceMigrationRecord {
    version: 1;
    id: string;
    walletGeneration: string;
    publicKey: Uint8Array;
    sourceHash: Uint8Array;
    policyHash: Uint8Array;
    direction: "to-hardware" | "to-software";
    phase: "staged" | "device-committed" | "host-committed" | "erasing" | "erased" | "complete";
    targetHash: Uint8Array | null;
}
export declare function inspectDeviceMigration(value: unknown): DeviceMigrationRecord;
export declare function encodeDeviceMigration(value: DeviceMigrationRecord): Uint8Array;
export declare function decodeDeviceMigration(bytes: Uint8Array): DeviceMigrationRecord;
/** The host must bind a public status reply to its durable journal before using
 * the phase. Receiving "complete" for another migration cannot activate a key. */
export declare function assertDeviceMigrationBinding(record: DeviceMigrationRecord, expected: Pick<DeviceMigrationRecord, "id" | "walletGeneration" | "publicKey" | "sourceHash" | "policyHash" | "direction">): void;
/** Semantic import proof: the freshly PIN-wrapped business key signs an exact
 * source identity/ledger/challenge tuple. A temporary USB key cannot substitute
 * its handshake signature, and a public phase alone is not proof of import. */
export declare function migrationImportProofCommitment(record: DeviceMigrationRecord, challenge: Uint8Array): Promise<Uint8Array>;
export declare function verifyMigrationImportProof(record: DeviceMigrationRecord, challenge: Uint8Array, signature: Uint8Array): Promise<void>;
