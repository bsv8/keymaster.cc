import { expect, test } from "vitest";
import { createIndexedDbWalletStore, createPlatformRootStore } from "../../../../packages/platform-storage/src/coordinator/index.js";
import { createVaultBootstrapStorage } from "../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js";
import { createKeyHoldDocument, serializeKeyHoldDocument } from "../../../../packages/plugin-vault/src/keyholdDocument.js";
import { createWalletKeyRepository, inspectWalletKeyBytes } from "../../../../packages/plugin-vault/src/walletKeyRepository.js";
import { CENTRAL_STORAGE_DECLARATIONS, WALLET_META_PATH, WALLET_META_FORMAT, WALLET_CURRENT_SCHEMA_VERSION } from "@keymaster/contracts";
import { WALLET_MIGRATION_PATH, WALLET_PAYMENT_POLICY_PATH } from "@keymaster/contracts/storage-internal";
import { sha256, hex, unhex, encodePaymentPolicy } from "@vaultlink/sdk";
import { createMigrationJournalService, parseMigrationJournal, verifyMigratedHardwareLedger, verifyDeviceMigrationJournal } from "../src/migration-journal.js";
import { validateHardwareKeyDocument } from "../src/hardware-key-record.js";
import { WalletPayments, type PaymentChannelDTO } from "../src/wallet-payments.js";
import { parseStoredPaymentPolicy } from "../src/policy-storage.js";
const POLICY_PATH="main/0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798/"+WALLET_PAYMENT_POLICY_PATH;
const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));

async function prepare(databaseName: string) {
  const store = createIndexedDbWalletStore({ databaseName });
  const key = new Uint8Array(32); key[31] = 1;
  const repo = createWalletKeyRepository(createVaultBootstrapStorage(store).keys);
  const source = await repo.create({bsvNetwork: "main" as const,  label: "保持身份", privateKeyBytes: key, password: "original-password" }); key.fill(0);
  const walletGeneration = crypto.randomUUID();
  const meta = { format: WALLET_META_FORMAT, version: 1, schemaVersion: WALLET_CURRENT_SCHEMA_VERSION, initialized: true, walletGeneration, createdAt: new Date().toISOString() };
  await store.put(WALLET_META_PATH, encode(meta));
  const business = encode({ contacts: [source.document.publicKeyHex], usedSatoshis: "250" });
  await store.put("contacts/existing", business);
  const root = createPlatformRootStore({identity: {bsvNetwork:"main",publicKeyHex:"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"},  store, generations: () => ({ walletGeneration, sessionEpoch: "migration-test", runGeneration: "migration-test" }) });
  const files = await root.openPlatformFileStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.vaultPayments });
  const core = await WalletPayments.open(files, source.document.publicKeyHex, () => {}, async () => { throw new Error("This test must not sign transactions"); }, "main");
  await core.handle({ action: "register", id: "app.main", owner: "app.example", kind: "app", network: "main", paymentType: "p2pkh" });
  const channels = await core.handle({ action: "list" }) as PaymentChannelDTO[];
  await core.handle({ action: "configure", channel: { ...channels[0]!, revision: channels[0]!.revision + 1, singleLimit: "18446744073709551615", defaultSessionLimit: "1000" } });
  await core.handle({ action: "session-open", id: "app.connection.1", owner: "app.example" });
  await core.handle({ action: "session-close", id: "app.connection.1" });
  const storedPolicy = (await store.get(POLICY_PATH))!;
  const bank = encodePaymentPolicy(parseStoredPaymentPolicy(storedPolicy.bytes, source.document.publicKeyHex), source.document.publicKeyHex);
  const policyHash = hex(await sha256(bank));
  files.close();
  const migrationId = crypto.randomUUID();
  const service = createMigrationJournalService({ store: createVaultBootstrapStorage(store).migration, inspectKey: inspectWalletKeyBytes });
  const target = encode({bsvNetwork: "main" as const,  format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2, label: source.document.label, publicKeyHex: source.document.publicKeyHex, walletGeneration, backendGeneration: 1 });
  return { store, repo, source, meta, business, policyHash, bank, storedPolicy, migrationId, service, target };
}

test("真实 IndexedDB：刷新丢弃准备数据，设备确认之前不能提交，Key 与完成记录原子替换", async () => {
  const databaseName = "migration-journal-" + crypto.randomUUID();
  const p = await prepare(databaseName);
  await p.service.begin({ migrationId: p.migrationId, expectedRevision: p.source.revision, policyBank: p.bank });
  await expect(p.service.commitLocal(p.migrationId, p.target, p.bank)).rejects.toMatchObject({ code: "storage_conflict" });
  expect((await p.repo.read())?.bytes).toEqual(p.source.bytes);
  p.store.close();
  const reopened = createIndexedDbWalletStore({ databaseName });
  const service = createMigrationJournalService({ store: createVaultBootstrapStorage(reopened).migration, inspectKey: inspectWalletKeyBytes });
  try {
    expect(await service.read()).toBeUndefined();
    expect(await reopened.get(WALLET_MIGRATION_PATH)).toBeUndefined();
    await service.begin({migrationId:p.migrationId,expectedRevision:p.source.revision,policyBank:p.bank});
    await expect(service.deviceCommitted(p.migrationId, "00".repeat(32))).rejects.toMatchObject({ code: "storage_conflict" });
    await service.deviceCommitted(p.migrationId, p.policyHash);
    const foreign = JSON.parse(new TextDecoder().decode(p.target)); foreign.walletGeneration = crypto.randomUUID();
    await expect(service.commitLocal(p.migrationId, encode(foreign), p.bank)).rejects.toMatchObject({ code: "storage_identity_required" });
    const peer = createMigrationJournalService({ store: createVaultBootstrapStorage(reopened).migration, inspectKey: inspectWalletKeyBytes });
    await peer.begin({migrationId:p.migrationId,expectedRevision:p.source.revision,policyBank:p.bank});
    await peer.deviceCommitted(p.migrationId,p.policyHash);
    const results = await Promise.allSettled([service.commitLocal(p.migrationId, p.target, p.bank), peer.commitLocal(p.migrationId, p.target, p.bank)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((await service.read())?.journal).toMatchObject({ phase: "complete", targetHash: hex(await sha256(p.target)) });
    expect((await createWalletKeyRepository(reopened).read())?.backend).toBe("hardware");
    expect((await reopened.get("contacts/existing"))?.bytes).toEqual(p.business);
    expect((await reopened.get(POLICY_PATH))?.bytes).toEqual(p.storedPolicy.bytes);
    expect((await reopened.get(WALLET_META_PATH))?.bytes).toEqual(encode(p.meta));

    expect((await service.read())?.journal.phase).toBe("complete");
    const hardwareDocument = validateHardwareKeyDocument(JSON.parse(new TextDecoder().decode(p.target)));
    const completedJournal = (await reopened.get(WALLET_MIGRATION_PATH))!.bytes;
    await verifyMigratedHardwareLedger(hardwareDocument, completedJournal, p.storedPolicy.bytes, p.bank);
    await expect(verifyMigratedHardwareLedger(hardwareDocument, undefined, p.storedPolicy.bytes, p.bank)).rejects.toMatchObject({ code: "storage_identity_required" });
    const emptyBank = encodePaymentPolicy({ version: 2, key: hardwareDocument.publicKeyHex, channels: [], sessions: [], pending: [], pools: [] }, hardwareDocument.publicKeyHex);
    await expect(verifyMigratedHardwareLedger(hardwareDocument, completedJournal, p.storedPolicy.bytes, emptyBank)).rejects.toThrow("policy-rollback");

    const stored = JSON.parse(new TextDecoder().decode((await reopened.get(WALLET_MIGRATION_PATH))!.bytes));
    expect(Object.keys(stored)).not.toContain("password"); expect(Object.keys(stored)).not.toContain("privateKey");
    const next = await service.begin({ migrationId: crypto.randomUUID(), expectedRevision: (await createWalletKeyRepository(reopened).read())!.revision, policyBank: p.bank });
    expect(next).toMatchObject({ source: "hardware", target: "software", phase: "prepared" });
    await service.deviceCommitted(next.migrationId, p.policyHash);
    // Storage/cryptography only: the fixture key is not evidence of a hardware
    // export. The actual device PIN/export/erase flow has a separate gate.
    const privateKey = new Uint8Array(32); privateKey[31] = 1;
    try {
      const keyHold = await createKeyHoldDocument({bsvNetwork: "main" as const,  label: "保持身份", privateKey }, "new-software-password");
      await service.commitLocal(next.migrationId, new TextEncoder().encode(serializeKeyHoldDocument(keyHold)), p.bank);
      expect((await service.current())?.phase).toBe("complete");
      const repository = createWalletKeyRepository(reopened);
      await expect(repository.unlock("original-password")).rejects.toBeDefined();
      const unlocked = await repository.unlock("new-software-password");
      expect(unlocked.privateKeyBytes).toEqual(privateKey); unlocked.privateKeyBytes.fill(0);
      expect((await reopened.get(POLICY_PATH))?.bytes).toEqual(p.storedPolicy.bytes);
      expect((await reopened.get("contacts/existing"))?.bytes).toEqual(p.business);
    } finally { privateKey.fill(0); }
  } finally { reopened.close(); }
});

test("迁移端口仅允许固定记录、显式 CAS，源记录改变或重置使恢复提交失败", async () => {
  const p = await prepare("migration-cas-" + crypto.randomUUID());
  try {
    const port = createVaultBootstrapStorage(p.store).migration;
    expect(() => port.get("contacts/existing")).toThrow();
    expect(() => port.batch({ operations: [{ type: "put", path: "key.json", bytes: p.target }] })).toThrow();
    expect(() => port.batch({ operations: [{ type: "put", path: WALLET_MIGRATION_PATH, bytes: encode({}) }], conditions: [{ path: "key.json", ifRevision: p.source.revision }] })).toThrow();
    await p.service.begin({ migrationId: p.migrationId, expectedRevision: p.source.revision, policyBank: p.bank });
    await p.repo.rename("并发改名");
    await expect(p.service.deviceCommitted(p.migrationId, p.policyHash)).rejects.toMatchObject({ code: "storage_conflict" });
    await p.store.resetWallet();
    await expect(p.service.commitLocal(p.migrationId, p.target, p.bank)).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    expect(await p.repo.read()).toBeUndefined();
  } finally { p.store.close(); }
});

test("公开迁移记录严格拒绝私钥字段、无效阶段及前后提交标记不一致", async () => {
  const p = await prepare("migration-schema-" + crypto.randomUUID());
  try {
    const journal = await p.service.begin({ migrationId: p.migrationId, expectedRevision: p.source.revision, policyBank: p.bank });
    for (const patch of [{ privateKey: "secret" }, { version: 2 }, { sourceRevision: 0 }, { target: "software" }, { phase: "other" }, { phase: "complete", targetHash: null }, { targetHash: "00".repeat(32) }]) {
      expect(() => parseMigrationJournal(encode({ ...journal, ...patch }))).toThrow();
    }
    expect(parseMigrationJournal(encode(journal))).toEqual(journal);
  } finally { p.store.close(); }
});


test("公开设备进度必须绑定实际浏览器迁移 journal，阶段和目标提交不能串钱包；迁回完成独立于擦除",async()=>{
  const p=await prepare(`migration-device-binding-${crypto.randomUUID()}`);
  try {
    const host=await p.service.begin({migrationId:p.migrationId,expectedRevision:p.source.revision,policyBank:p.bank});
    const device={version:1 as const,id:host.migrationId,walletGeneration:host.walletGeneration,
      publicKey:unhex(host.publicKeyHex),sourceHash:unhex(host.sourceHash),policyHash:unhex(host.policyHash),
      direction:"to-hardware" as const,phase:"device-committed" as const,targetHash:null};
    expect(verifyDeviceMigrationJournal(host,device)).toEqual(device);
    expect(()=>verifyDeviceMigrationJournal(host,{...device,id:crypto.randomUUID()})).toThrow();
    expect(()=>verifyDeviceMigrationJournal(host,{...device,sourceHash:new Uint8Array(32)})).toThrow();
    expect(()=>verifyDeviceMigrationJournal(host,{...device,policyHash:new Uint8Array(32)})).toThrow();
    expect(()=>verifyDeviceMigrationJournal(host,{...device,walletGeneration:crypto.randomUUID()})).toThrow();
    await p.service.deviceCommitted(p.migrationId,p.policyHash);
    await p.service.commitLocal(p.migrationId,p.target,p.bank);
    const local=(await p.service.read())!.journal,targetHash=unhex(local.targetHash!);
    expect(()=>verifyDeviceMigrationJournal(local,device)).toThrow();
    expect(()=>verifyDeviceMigrationJournal(local,{...device,phase:"host-committed",targetHash})).toThrow();
    expect(()=>verifyDeviceMigrationJournal(local,{...device,phase:"host-committed",targetHash:new Uint8Array(32)})).toThrow();
    const complete=(await p.service.read())!.journal;
    expect(()=>verifyDeviceMigrationJournal(complete,device)).toThrow();
    expect(verifyDeviceMigrationJournal(complete,{...device,phase:"complete",targetHash}).phase).toBe("complete");
    const returning={...complete,source:"hardware" as const,target:"software" as const};
    expect(verifyDeviceMigrationJournal(returning,{...device,direction:"to-software",phase:"host-committed",targetHash}).phase).toBe("host-committed");
    expect(verifyDeviceMigrationJournal(returning,{...device,direction:"to-software",phase:"erased",targetHash}).phase).toBe("erased");
  }finally{p.store.close();}
});
