import { sha256, hex, unhex, equal, encodePaymentPolicy, decodePaymentPolicy, assertHardwarePaymentPolicy, assertPaymentPolicyContinuation, assertDeviceMigrationBinding, inspectDeviceMigration, type DeviceMigrationRecord } from "@vaultlink/sdk";
import { networkIdentityStorageRoot, WALLET_KEYHOLD_PATH } from "@keymaster/contracts";
import { WALLET_MIGRATION_PATH, WALLET_PAYMENT_POLICY_PATH, StorageRuntimeError, type WalletVaultMigrationStore } from "@keymaster/contracts/storage-internal";

import { parseStoredPaymentPolicy, serializeStoredPaymentPolicy } from "./policy-storage.js";

export interface MigrationJournal {
  format: "keymaster.backend-migration";
  version: 1;
  migrationId: string;
  walletGeneration: string;
  bsvNetwork: "main" | "test";
  publicKeyHex: string;
  source: "software" | "hardware";
  target: "software" | "hardware";
  sourceRevision: number;
  sourceHash: string;
  policyHash: string;
  policyRevision: number;
  phase: "prepared" | "device-committed" | "local-committed" | "complete";
  targetHash: string | null;
}
const fields = ["format", "version", "migrationId", "walletGeneration", "publicKeyHex", "bsvNetwork", "source", "target", "sourceRevision", "sourceHash", "policyHash", "policyRevision", "phase", "targetHash"].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hash = /^[0-9a-f]{64}$/u;
function fail(message: string): never { throw new StorageRuntimeError("storage_wallet_corrupt", message); }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export function parseMigrationJournal(bytes: Uint8Array): MigrationJournal {
  if (bytes.length > 2048) fail("Migration journal exceeds its size limit");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("Migration journal is unreadable"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Migration journal is invalid");
  const j = parsed as MigrationJournal;
  if (Object.keys(j).sort().join() !== fields.join() || j.format !== "keymaster.backend-migration" || j.version !== 1
    || !["main", "test"].includes(j.bsvNetwork) || !uuid.test(j.migrationId) || !uuid.test(j.walletGeneration) || !/^(02|03)[0-9a-f]{64}$/u.test(j.publicKeyHex)
    || !["software", "hardware"].includes(j.source) || !["software", "hardware"].includes(j.target) || j.source === j.target
    || !Number.isSafeInteger(j.policyRevision) || j.policyRevision < 0
    || !Number.isSafeInteger(j.sourceRevision) || j.sourceRevision < 1 || !hash.test(j.sourceHash) || !hash.test(j.policyHash)
    || !["prepared", "device-committed", "local-committed", "complete"].includes(j.phase)
    || (j.targetHash !== null && (typeof j.targetHash !== "string" || !hash.test(j.targetHash)))
    || (["local-committed", "complete"].includes(j.phase) !== (j.targetHash !== null))) fail("Migration journal schema is invalid");
  return j;
}

/** Called only after the encrypted connection has proved the device identity.
 * This checks PUBLIC recovery metadata; it is not proof of a private-key import,
 * physical approval, browser commit or successful erase by itself. */
export function verifyDeviceMigrationJournal(journal: MigrationJournal, device: DeviceMigrationRecord): DeviceMigrationRecord {
  const host=parseMigrationJournal(encode(journal)),state=inspectDeviceMigration(device);
  assertDeviceMigrationBinding(state,{id:host.migrationId,walletGeneration:host.walletGeneration,
    publicKey:unhex(host.publicKeyHex),sourceHash:unhex(host.sourceHash),policyHash:unhex(host.policyHash),
    direction:host.target==="hardware"?"to-hardware":"to-software"});
  if(host.targetHash!==null && state.targetHash!==null && !equal(unhex(host.targetHash),state.targetHash)) throw new StorageRuntimeError("storage_conflict","Device migration target changed");
  const expected=host.phase==="prepared"?["staged","device-committed"]
    :host.phase==="device-committed"?["device-committed"]
    :host.phase==="local-committed"?["device-committed","host-committed","erasing","erased","complete"]
    :host.target==="hardware"?["complete"]:["device-committed","host-committed","erasing","erased","complete"];
  if(!expected.includes(state.phase))throw new StorageRuntimeError("storage_conflict","Device migration phase does not match the browser commit");
  return state;
}

/** The port is only issued to the Coordinator Worker. Journals contain public
 * commitments, never private keys, PINs, passwords or copies of source KeyHold.
 * USB and IndexedDB are separate transactions: a device acknowledgement must be
 * durable before replacing key.json. After that replacement, recovery may only
 * finish the same migration; it cannot reactivate the old backend automatically.
 */
export function createMigrationJournalService(deps: {
  store: WalletVaultMigrationStore;
  inspectKey: (bytes: Uint8Array) => { bsvNetwork: "main" | "test"; publicKeyHex: string; backend: "software" | "hardware"; walletGeneration?: string };
}) {
  const { store, inspectKey } = deps;
  // Preparation lives only in this operation. A terminated Worker leaves the
  // original wallet intact; only the final atomic batch persists a receipt.
  let pending: {journal: MigrationJournal; revision: number} | undefined;
  const policyPath = (identity: {bsvNetwork:"main"|"test";publicKeyHex:string}) => networkIdentityStorageRoot(identity) + WALLET_PAYMENT_POLICY_PATH;
  async function read() {
    if (pending) return pending;
    return undefined;
  }
  async function bound(id: string) {
    const record = await read();
    if (!record || record.journal.migrationId !== id) throw new StorageRuntimeError("storage_conflict", "Migration identity changed");
    const key = await store.get(WALLET_KEYHOLD_PATH);
    if (!key) fail("Migration wallet Key is missing");
    const identity = inspectKey(key.bytes);
    if (identity.bsvNetwork !== record.journal.bsvNetwork || identity.publicKeyHex !== record.journal.publicKeyHex
      || (identity.walletGeneration !== undefined && identity.walletGeneration !== record.journal.walletGeneration)) {
      throw new StorageRuntimeError("storage_conflict", "Migration wallet identity changed");
    }
    const committed = ["local-committed", "complete"].includes(record.journal.phase);
    if (identity.backend !== (committed ? record.journal.target : record.journal.source)
      || (record.journal.phase!=="complete"&&hex(await sha256(key.bytes)) !== (committed ? record.journal.targetHash : record.journal.sourceHash))
      || (!committed && key.revision !== record.journal.sourceRevision)) {
      throw new StorageRuntimeError("storage_conflict", "Migration key record changed");
    }
    const policy = await store.get(policyPath(identity));
    if (!committed && (policy?.revision ?? 0) !== record.journal.policyRevision) throw new StorageRuntimeError("storage_conflict", "Migration payment ledger changed");
    if (record.journal.phase==="local-committed" && (!policy || hex(await sha256(encodePaymentPolicy(parseStoredPaymentPolicy(policy.bytes, identity.publicKeyHex), identity.publicKeyHex))) !== record.journal.policyHash)) {
      throw new StorageRuntimeError("storage_conflict", "Committed migration ledger changed");
    }
    // Completion is a historical receipt. Legitimate label/password changes
    // and subsequent software payments must not be mistaken for a damaged
    // unfinished commit. Identity/generation/backend remain bound; pending
    // migrations still require exact target and ledger bytes above.
    if(record.journal.phase==="complete"&&policy)encodePaymentPolicy(parseStoredPaymentPolicy(policy.bytes,identity.publicKeyHex),identity.publicKeyHex);
    return { ...record, key, policy };
  }
  function conditions(record: Awaited<ReturnType<typeof bound>>) {
    return [{ path: WALLET_KEYHOLD_PATH, ifRevision: record.key.revision }, { path: policyPath(record.journal), ifRevision: record.policy?.revision ?? 0 }];
  }
  return {
    read,
    async sourceBank(publicKeyHex:string){
      const key=await store.get(WALLET_KEYHOLD_PATH);if(!key)fail("Migration key is missing");
      const identity=inspectKey(key.bytes);if(identity.publicKeyHex!==publicKeyHex)fail("Migration identity changed");
      const policy=await store.get(policyPath(identity));
      return encodePaymentPolicy(policy?parseStoredPaymentPolicy(policy.bytes,publicKeyHex):{version:2,key:publicKeyHex,channels:[],sessions:[],pending:[],pools:[]},publicKeyHex);
    },
    async current(){const record=await read();return record?(await bound(record.journal.migrationId)).journal:undefined;},
    async begin(input: { migrationId: string; expectedRevision: number; policyBank: Uint8Array }) {
      const key = await store.get(WALLET_KEYHOLD_PATH), previous = await read();
      if (!key) fail("Migration requires an initialized wallet");
      if (key.revision !== input.expectedRevision || (previous && previous.journal.phase !== "complete")) throw new StorageRuntimeError("storage_conflict", "Migration source changed or another migration is unfinished");
      const identity = inspectKey(key.bytes);
      // Existing hardware record retains its SDK binding. Software binding is
      // deterministically derived from the existing identity, never persisted in meta.
      const digest = hex(await sha256(new TextEncoder().encode(identity.bsvNetwork + "/" + identity.publicKeyHex)));
      const generation = identity.walletGeneration ?? digest.slice(0,8) + "-" + digest.slice(8,12) + "-" + digest.slice(12,16) + "-" + digest.slice(16,20) + "-" + digest.slice(20,32);
      const bank = new Uint8Array(input.policyBank), snapshot = decodePaymentPolicy(bank, identity.publicKeyHex);
      assertHardwarePaymentPolicy(snapshot, identity.publicKeyHex);
      if(snapshot.channels.some(channel=>channel.network!==identity.bsvNetwork))throw new StorageRuntimeError("storage_identity_required","Migration policy network differs from identity");
      if (snapshot.pending.some(payment => payment.state === "reserved")) throw new StorageRuntimeError("storage_conflict", "Active payment reservations must settle before migration");
      const policyHash = hex(await sha256(encodePaymentPolicy(snapshot, identity.publicKeyHex)));
      if (policyHash !== hex(await sha256(bank))) fail("Migration policy bank is not canonical");
      const policy = await store.get(policyPath(identity));
      if (identity.backend === "software") {
        const current = policy ? parseStoredPaymentPolicy(policy.bytes, identity.publicKeyHex) : { version: 2 as const, key: identity.publicKeyHex, channels: [], sessions: [], pending: [], pools: [] };
        if (hex(await sha256(encodePaymentPolicy(current, identity.publicKeyHex))) !== policyHash) throw new StorageRuntimeError("storage_conflict", "Migration bank does not match the source software ledger");
      }
      const journal: MigrationJournal = { format: "keymaster.backend-migration", version: 1, migrationId: input.migrationId,
        walletGeneration: generation, bsvNetwork: identity.bsvNetwork, publicKeyHex: identity.publicKeyHex, source: identity.backend,
        target: identity.backend === "software" ? "hardware" : "software", sourceRevision: key.revision,
        sourceHash: hex(await sha256(key.bytes)), policyHash, policyRevision: policy?.revision ?? 0, phase: "prepared", targetHash: null };
      parseMigrationJournal(encode(journal));
      pending = {journal, revision: previous?.revision ?? 0};
      return journal;
    },
    async deviceCommitted(id: string, policyHash: string) {
      const record = await bound(id);
      if (record.journal.phase !== "prepared" || record.journal.policyHash !== policyHash) throw new StorageRuntimeError("storage_conflict", "Device migration acknowledgement does not match");
      const journal = { ...record.journal, phase: "device-committed" as const };
      pending = {journal, revision: record.revision};
    },
    async commitLocal(id: string, targetBytes: Uint8Array, policyBank: Uint8Array) {
      const record = await bound(id);
      if (record.journal.phase !== "device-committed") throw new StorageRuntimeError("storage_conflict", "Device migration has not been acknowledged");
      // Copy before inspecting/hashing: a caller cannot change the committed bytes
      // while WebCrypto yields. The inspection callback is the real Key repository parser.
      const target = new Uint8Array(targetBytes), identity = inspectKey(target);
      if (identity.bsvNetwork !== record.journal.bsvNetwork || identity.publicKeyHex !== record.journal.publicKeyHex || identity.backend !== record.journal.target
        || (identity.walletGeneration !== undefined && identity.walletGeneration !== record.journal.walletGeneration)) throw new StorageRuntimeError("storage_identity_required", "Migration cannot replace the wallet identity");
      const bank = new Uint8Array(policyBank), snapshot = decodePaymentPolicy(bank, identity.publicKeyHex);
      if (hex(await sha256(bank)) !== record.journal.policyHash || hex(await sha256(encodePaymentPolicy(snapshot, identity.publicKeyHex))) !== record.journal.policyHash) throw new StorageRuntimeError("storage_conflict", "Migration policy bank changed");
      // Software activation is complete once its verified ciphertext and ledger
      // are durable. Optional device disposal must never gate this transaction.
      const journal = { ...record.journal, phase: "complete" as const, targetHash: hex(await sha256(target)) };
      await store.batch({ operations: [{ type: "put", path: WALLET_KEYHOLD_PATH, bytes: target, contentType: "application/json" },
        { type: "put", path: policyPath(identity), bytes: serializeStoredPaymentPolicy(snapshot, identity.publicKeyHex), contentType: "application/json" }], conditions: conditions(record) });
      pending = { journal, revision: record.revision };
    },
    async finish(id: string) {
      const record = await bound(id);
      pending = { journal: { ...record.journal, phase: "complete" }, revision: record.revision };
    },
    async normalizePreviousAttempt() {
      // New migrations keep preparation and completion solely in this operation.
      pending = undefined;
    },
  };
}

/** Reconnect accepts a browser ledger only as the exact public baseline of a
 * completed same-key hardware migration. Device evolution must preserve all
 * consumed/unknown funds and replay tombstones. This is not a key-import API. */
export async function verifyMigratedHardwareLedger(document: import("./hardware-key-record.js").HardwareKeyDocumentV1,
  journalBytes: Uint8Array | undefined, storedPolicy: Uint8Array, deviceBank: Uint8Array): Promise<void> {
  const source = parseStoredPaymentPolicy(storedPolicy, document.publicKeyHex);
  assertHardwarePaymentPolicy(source, document.publicKeyHex);
  const current = decodePaymentPolicy(new Uint8Array(deviceBank), document.publicKeyHex);
  assertPaymentPolicyContinuation(source, current, document.publicKeyHex);
}

/** Private Worker orchestration. Preparation is volatile, the source remains
 * intact, and only a verified target and ledger enter the final atomic batch.
 * The caller holds an exclusive wallet lease during this operation. */
export function createHardwareToSoftwareMigration(deps: {
  service: ReturnType<typeof createMigrationJournalService>;
  device: Pick<import("./hardware-backend.js").VaultLinkHardwareBackend,
    "exportPaymentPolicy"|"migrationStatus"|"exportMigrationKey">;
  assertExclusive(): void;
  createAndVerifyKeyHold(privateKey:Uint8Array,publicKeyHex:string):Promise<Uint8Array>;
}) {
  const {service,device}=deps;
  const check=()=>deps.assertExclusive();
  return {
    /** Before a durable software commit, every retry requests a fresh device
     * hold. Completed software activation never depends on optional erase. */
    async run(input:{migrationId:string;expectedRevision:number}):Promise<MigrationJournal> {
      check();let saved=await service.read();check();
      if(saved&&saved.journal.phase!=="complete"&&saved.journal.migrationId!==input.migrationId)
        throw new StorageRuntimeError("storage_conflict","Another backend migration is unfinished");
      let journal:MigrationJournal,bank:Uint8Array|undefined;
      if(saved?.journal.migrationId===input.migrationId)journal=saved.journal;
      else {
        bank=await device.exportPaymentPolicy();check();
        journal=await service.begin({...input,policyBank:bank});check();
      }
      if(journal.source!=="hardware"||journal.target!=="software")throw new StorageRuntimeError("storage_identity_required","This operation requires a hardware source");
      if(journal.phase==="complete")return journal;
      let state=await device.migrationStatus();check();
      if(state && !(journal.phase==="prepared"&&state.id!==journal.migrationId
        &&(state.phase==="complete"||(state.direction==="to-software"&&state.targetHash===null))))verifyDeviceMigrationJournal(journal,state);
      if(journal.phase==="prepared"||journal.phase==="device-committed") {
        if(!bank)bank=await device.exportPaymentPolicy();check();
        if(hex(await sha256(bank))!==journal.policyHash)throw new StorageRuntimeError("storage_conflict","Device payment ledger changed during migration");
        const binding={id:journal.migrationId,walletGeneration:journal.walletGeneration,publicKey:unhex(journal.publicKeyHex),
          sourceHash:unhex(journal.sourceHash),policyHash:unhex(journal.policyHash),direction:"to-software" as const};
        const exported=await device.exportMigrationKey(binding);
        let target:Uint8Array|undefined;
        try {
          check();state=verifyDeviceMigrationJournal(journal,exported.migration);
          if(journal.phase==="prepared") {
            await service.deviceCommitted(journal.migrationId,journal.policyHash);check();
            journal=(await service.read())!.journal;check();
          }
          target=await deps.createAndVerifyKeyHold(exported.privateKey,journal.publicKeyHex);check();
          await service.commitLocal(journal.migrationId,target,bank);check();
          journal=(await service.read())!.journal;check();
        } finally {exported.privateKey.fill(0);target?.fill(0);}
      }
      if(journal.phase==="local-committed") {
        await service.finish(journal.migrationId);check();
        journal=(await service.read())!.journal;check();
      }
      if(journal.phase!=="complete"||journal.targetHash===null)
        throw new StorageRuntimeError("storage_conflict","Browser migration commit is missing");
      return journal;
    },
  };
}
export {WalletMigrationFence} from './migration-fence.js';
export {requestMigratedDeviceErase} from './software-migration-cleanup.js';
export {ErasedMigrationConnection} from './erased-migration-connection.js';

/** Forward migration keeps the source KeyHold until actual PIN-wrapped device
 * possession and completion are proved. Preparation never survives refresh. */
export function createSoftwareToHardwareMigration(deps:{
 service:ReturnType<typeof createMigrationJournalService>;
 device:import('./provision-migration-connection.js').ProvisionMigrationConnection;
 assertExclusive():void;
 sourceBank():Promise<Uint8Array>;
 unlockSource():Promise<Uint8Array>;
 hardwareDocument(journal:MigrationJournal):Uint8Array;
}){
 return {async run(input:{migrationId:string;expectedRevision:number}):Promise<MigrationJournal>{
  const check=()=>deps.assertExclusive();check();
  // Capture the unlocked session key before changing the device. Preparation is
  // volatile; the only browser write is the final complete transaction.
  const secret=await deps.unlockSource();
  try {
   check();const bank=await deps.sourceBank();check();
   let journal=await deps.service.begin({...input,policyBank:bank});check();
   if(journal.source!=='software'||journal.target!=='hardware')throw Error('migration-conflict');
   await deps.device.stage(journal,bank);check();
   const state=await deps.device.prove(journal,secret);check();
   verifyDeviceMigrationJournal(journal,state);
   if(state.phase!=='device-committed')throw Error('migration-device-save-required');
   await deps.service.deviceCommitted(journal.migrationId,journal.policyHash);check();
   journal=(await deps.service.current())!;check();
   const target=new Uint8Array(deps.hardwareDocument(journal));
   // Finish the device while the browser still owns its source. A disconnect
   // here leaves a normal software wallet plus a device backup, never a
   // half-written browser wallet. Further import to that device is forbidden.
   const committed=await deps.device.commit({...journal,phase:'local-committed',targetHash:hex(await sha256(target))});check();
   if(committed.phase!=='complete')throw Error('migration-device-save-required');
   await deps.service.commitLocal(journal.migrationId,target,bank);check();
   return (await deps.service.current())!;
  } finally {secret.fill(0);}
 }};
}
export {ProvisionMigrationConnection} from './provision-migration-connection.js';
