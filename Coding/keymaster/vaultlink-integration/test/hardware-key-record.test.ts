import { afterEach, describe, expect, it } from "vitest";
import { Point } from "@noble/secp256k1";
import { createIndexedDbWalletStore } from "../../../../packages/platform-storage/src/coordinator/index.js";
import { createWalletKeyRepository } from "../../../../packages/plugin-vault/src/walletKeyRepository.js";
import { WALLET_CURRENT_SCHEMA_VERSION, WALLET_META_FORMAT, parseCoordinatorResponseFor } from "@keymaster/contracts";
import { validateHardwareKeyDocument, type HardwareKeyDocumentV1 } from "../src/hardware-key-record.js";
import {
  __testBootstrapWalletStorage, __testColdStart, __testGetActivePublicKeyHex,
  __testGetVaultStatus, __testResetWalletStore, __testResetState,
  __testSeedWalletLocalRecords, __testUnlock,
} from "../../../../apps/web/src/keymasterSessionCoordinator.worker.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const keyHex = Point.fromPrivateKey("1".padStart(64, "0")).toHex(true);
function document(): HardwareKeyDocumentV1 {
  return { format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2,
    label: "RocKey 硬件", publicKeyHex: keyHex, walletGeneration: crypto.randomUUID(), backendGeneration: 1 };
}

describe("硬件公开 Key 记录：生产仓储与 Coordinator 冷启动", () => {
  afterEach(async () => { await __testResetWalletStore(); });

  it("读取、改名、重开数据库不产生软件解锁或 KeyHold 导出路径", async () => {
    // IndexedDB 宿主由测试环境提供；使用正式存储适配器、条件写和生产仓储。
    const databaseName = "hardware-key-record-" + crypto.randomUUID();
    const store = createIndexedDbWalletStore({ databaseName });
    const record = document();
    try {
      await store.put("key.json", bytes(record), { ifNoneMatch: true, contentType: "application/json" });
      const keys = createWalletKeyRepository(store);
      expect(await keys.read()).toMatchObject({ backend: "hardware", document: record });
      await expect(keys.unlock("anything")).rejects.toMatchObject({ code: "storage_wallet_unsupported" });
      await expect(keys.changePassword({ oldPassword: "anything", newPassword: "password" })).rejects.toMatchObject({ code: "storage_wallet_unsupported" });
      await expect(keys.export()).rejects.toMatchObject({ code: "storage_wallet_unsupported" });
      const renamed = await keys.rename("改名后的硬件");
      expect(renamed.backend).toBe("hardware");
      expect(renamed.document).toEqual({ ...record, label: "改名后的硬件" });
      await expect(keys.rename("")).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    } finally { store.close(); }
    const reopened = createIndexedDbWalletStore({ databaseName });
    try {
      expect((await createWalletKeyRepository(reopened).read())?.document).toEqual({ ...record, label: "改名后的硬件" });
      expect((await reopened.list()).objects.map(value => value.path)).toEqual(["key.json"]);
    } finally { reopened.close(); }
  });

  it("不能通过原 KeyHold 导入入口伪造硬件绑定", async () => {
    const store = createIndexedDbWalletStore({ databaseName: "hardware-import-" + crypto.randomUUID() });
    try {
      const keys = createWalletKeyRepository(store);
      await expect(keys.import(bytes(document()))).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
      expect(await keys.read()).toBeUndefined();
    } finally { store.close(); }
  });

  it("同 Key 条件替换后端保留其它记录、拒绝换身份/陈旧提交，迁回使用新软件密码", async () => {
    // 这里只验证迁移提交存储边界；不冒充设备导入/导出或 journal 联调。
    const databaseName="backend-migration-"+crypto.randomUUID();
    const store=createIndexedDbWalletStore({databaseName});
    const other=createIndexedDbWalletStore({databaseName});
    const repo=createWalletKeyRepository(store), peer=createWalletKeyRepository(other);
    const secret=new Uint8Array(32); secret[31]=1;
    try {
      const original=await repo.create({label:"迁移 Key",privateKeyBytes:secret,password:"original-password"});
      const business=new TextEncoder().encode("existing contacts and settings");
      await store.put("contacts/state",business,{ifNoneMatch:true});
      const target={...document(),label:"迁移 Key"};
      await expect(repo.commitHardwareMigration({expectedRevision:original.revision,document:{...target,publicKeyHex:Point.fromPrivateKey("2".padStart(64,"0")).toHex(true)}})).rejects.toMatchObject({code:"storage_identity_required"});
      const outcomes=await Promise.allSettled([repo.commitHardwareMigration({expectedRevision:original.revision,document:target}),peer.commitHardwareMigration({expectedRevision:original.revision,document:target})]);
      expect(outcomes.filter(value=>value.status==="fulfilled")).toHaveLength(1);
      expect(outcomes.find(value=>value.status==="rejected")).toMatchObject({status:"rejected",reason:{code:"storage_conflict"}});
      const hardware=await repo.read();expect(hardware?.backend).toBe("hardware");
      expect(Object.keys(JSON.parse(new TextDecoder().decode(hardware!.bytes))).sort()).toEqual(Object.keys(target).sort());
      expect((await store.get("contacts/state"))?.bytes).toEqual(business);
      const wrong=new Uint8Array(32);wrong[31]=2;
      await expect(repo.commitSoftwareMigration({expectedRevision:hardware!.revision,privateKeyBytes:wrong,password:"new-password"})).rejects.toMatchObject({code:"storage_identity_required"});wrong.fill(0);
      const migrated=await repo.commitSoftwareMigration({expectedRevision:hardware!.revision,privateKeyBytes:secret,password:"new-password"});
      expect(migrated.backend).toBe("software");expect(migrated.document.publicKeyHex).toBe(target.publicKeyHex);
      expect((await store.get("contacts/state"))?.bytes).toEqual(business);
      await expect(repo.unlock("original-password")).rejects.toBeDefined();
      const unlocked=await repo.unlock("new-password");expect(unlocked.privateKeyBytes).toEqual(secret);unlocked.privateKeyBytes.fill(0);
      await expect(repo.commitSoftwareMigration({expectedRevision:hardware!.revision,privateKeyBytes:secret,password:"another-password"})).rejects.toMatchObject({code:"storage_conflict"});
    } finally { secret.fill(0); store.close(); other.close(); }
  });

  it("已有硬件记录拒绝软件创建，两个真实存储连接并发改名只提交一次", async () => {
    const databaseName = "hardware-single-key-" + crypto.randomUUID();
    const first = createIndexedDbWalletStore({ databaseName });
    const second = createIndexedDbWalletStore({ databaseName });
    const record = document();
    try {
      await first.put("key.json", bytes(record), { ifNoneMatch: true });
      const a = createWalletKeyRepository(first), b = createWalletKeyRepository(second);
      const privateKeyBytes = new Uint8Array(32); privateKeyBytes[31] = 2;
      try {
        await expect(a.create({ label: "另一把 Key", privateKeyBytes, password: "software-password" }))
          .rejects.toMatchObject({ code: "storage_conflict" });
      } finally { privateKeyBytes.fill(0); }
      const results = await Promise.allSettled([a.rename("甲"), b.rename("乙")]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const failed = results.find(result => result.status === "rejected");
      expect(failed).toMatchObject({ status: "rejected", reason: { code: "storage_conflict" } });
      expect((await a.read())?.document.publicKeyHex).toBe(record.publicKeyHex);
      expect((await first.list()).objects.map(value => value.path)).toEqual(["key.json"]);
    } finally { first.close(); second.close(); }
  });

  it("Worker RPC 保留后端类型并拒绝未知类型，旧软件快照仍可读取", () => {
    const request = { kind: "storage.control", control: { type: "cold-start" } } as const;
    const key = { publicKeyHex: keyHex, label: "硬件", backend: "hardware" };
    const response = { sessionEpoch: "locked", ack: { status: "ok" }, operationResult: { state: "ready", key } };
    expect(parseCoordinatorResponseFor(request, response).operationResult).toEqual({ state: "ready", key });
    expect(() => parseCoordinatorResponseFor(request, { ...response, operationResult: { state: "ready", key: { ...key, backend: "unknown" } } })).toThrow();
    const oldKey = { publicKeyHex: keyHex, label: "软件" };
    expect(parseCoordinatorResponseFor(request, { ...response, operationResult: { state: "ready", key: oldKey } }).operationResult).toEqual({ state: "ready", key: oldKey });
  });

  it("严格拒绝混入软件密文、错误版本、零世代及无效曲线点", async () => {
    const record = document();
    for (const patch of [{ cipher: {} }, { version: 2 }, { wireVersion: 1 }, { backendGeneration: 0 }, { backendGeneration: 0x100000000 }, { backendGeneration: 1.5 }, { walletGeneration: "foreign" }]) {
      expect(() => validateHardwareKeyDocument({ ...record, ...patch })).toThrow();
    }
    const store = createIndexedDbWalletStore({ databaseName: "hardware-curve-" + crypto.randomUUID() });
    try {
      await store.put("key.json", bytes({ ...record, publicKeyHex: "02" + "ff".repeat(32) }));
      await expect(createWalletKeyRepository(store).read()).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    } finally { store.close(); }
  });

  async function seed(record: HardwareKeyDocumentV1, walletGeneration = record.walletGeneration) {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
    await __testSeedWalletLocalRecords({ keyHold: JSON.stringify(record), meta: JSON.stringify({
      format: WALLET_META_FORMAT, version: 1, schemaVersion: WALLET_CURRENT_SCHEMA_VERSION,
      initialized: true, walletGeneration, createdAt: new Date().toISOString(),
    }) });
    __testResetState();
    await __testBootstrapWalletStorage();
  }

  it("正式 Worker 冷启动保留硬件身份但不授予解锁状态", async () => {
    const record = document();
    await seed(record);
    expect(await __testColdStart()).toMatchObject({ state: "ready", key: {
      publicKeyHex: record.publicKeyHex, label: record.label, backend: "hardware",
    } });
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    const result = await __testUnlock("not-a-hardware-pin");
    expect(result.ack).toMatchObject({ status: "error", code: "storage_wallet_unsupported" });
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
  });

  it("真实 Worker 冷启动遇到未完成迁移不会恢复原后端或接受普通解锁", async () => {
    const record = document();
    await seed(record);
    const store = createIndexedDbWalletStore();
    const { WALLET_MIGRATION_PATH } = await import("@keymaster/contracts/storage-internal");
    const { sha256, hex } = await import("@vaultlink/sdk");
    try {
      const source = (await store.get("key.json"))!;
      const journal = { format: "keymaster.backend-migration", version: 1, migrationId: crypto.randomUUID(),
        walletGeneration: record.walletGeneration, publicKeyHex: record.publicKeyHex, source: "hardware", target: "software",
        sourceRevision: source.revision, sourceHash: hex(await sha256(source.bytes)), policyHash: hex(await sha256(new Uint8Array())),
        policyRevision: 0, phase: "device-committed", targetHash: null };
      await store.put(WALLET_MIGRATION_PATH, bytes(journal));
      __testResetState();
      await expect(__testBootstrapWalletStorage()).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
      expect(await __testColdStart()).toMatchObject({ state: "corrupt", reason: expect.stringContaining("unfinished") });
      expect(__testGetActivePublicKeyHex()).toBeUndefined();
      expect(__testGetVaultStatus()).not.toBe("unlocked");
      expect((await __testUnlock("password")).ack.status).not.toBe("ok");
      expect((await store.get("key.json"))?.bytes).toEqual(source.bytes);
    } finally { store.close(); }
  });

  it("跨钱包世代的记录不会被当作可解锁身份", async () => {
    await expect(seed(document(), crypto.randomUUID())).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    expect((await __testColdStart()).state).toBe("corrupt");
    expect(__testGetVaultStatus()).not.toBe("unlocked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
  });
});
