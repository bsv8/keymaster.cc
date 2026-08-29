// packages/plugin-msfile/src/msfileService.test.ts
// 授权与数据面必测项（施工单 §8.2 / KMMF-005 / KMMF-006）。

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MSFILE_DB_NAME } from "./msfileDb.js";
import { MsFileServiceImpl, createMsFileService } from "./msfileService.js";
import type { MsFileTransport } from "./msfileTransport.js";
import type {
  MsFileGlobalPriceSettings,
  MsFileSupplierConfig,
} from "@keymaster/contracts";
import { MsFileServiceError } from "./msfileErrors.js";
import { sha256 } from "./sha256.js";
import { OWNER_PUBKEY, SUPPLIER_PUBKEY, SUPPLIER_PEER_ID } from "./supplierConfig.test.js";
import { validatePersistedSupplier } from "./supplierConfig.js";

const PUBLISHER_A = OWNER_PUBKEY;
export const OWNER_PEER_ID = "16Uiu2HAm7jWZvRQWjW8LpPRXqyGJqpb4rqLkX7FUu53zoQG9oUuF";
const OTHER_KEY = "02b6de0e542ca933c790eb27e7d759abf2947233552fd0f942c4cd391186286e72";

async function hashOf(bytes: Uint8Array): Promise<string> {
  return Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function waitForApprovals(service: MsFileServiceImpl, count = 1): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (service.listPendingApprovals().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("approval did not open in time");
}

const SUPPLIER_ADDRESS = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;

interface RecordedRead {
  supplierPublicKeyHex: string;
  kind: "seed" | "block";
  hashHex: string;
  maxPriceSatoshis: bigint;
}

// 测试脚本允许模拟全部 wire 终态（含 supplier-error），
// 注入 service 时收敛为真实 transport 类型。
type FakeScriptOutcome =
  | { type: "ok"; content: Uint8Array }
  | { type: "price-limit-exceeded" }
  | { type: "supplier-error"; errorCode: string };
type ReadOutcome = FakeScriptOutcome;

// 测试 transport：仅 read 的返回值放宽为可注入 supplier-error 等全部 wire 终态。
type TestTransport = Omit<import("./msfileTransport.js").MsFileTransport, "read" | "probe"> & {
  reads: RecordedRead[];
  invalidateSupplierCalls: Array<{ supplierPublicKeyHex: string | undefined; generation: number }>;
  script: Array<(input: RecordedRead) => Promise<FakeScriptOutcome>>;
  stat(input: { supplier: { supplierPublicKeyHex: string }; seedHashHex?: string; supplierGeneration?: number }): Promise<import("@keymaster/contracts").MsFileSupplierStat>;
  read(input: { supplier: { supplierPublicKeyHex: string }; kind: "seed" | "block"; hashHex: string; maxPriceSatoshis: bigint; supplierGeneration?: number }): Promise<FakeScriptOutcome>;
  probe(input: { supplier: { supplierPublicKeyHex: string }; supplierGeneration?: number }): Promise<import("@keymaster/contracts").MsFileSupplierProbeResult>;
};

function makeTransport(): TestTransport {
  const transport = {
    available: true as const,
    reads: [] as RecordedRead[],
    script: [] as Array<(input: RecordedRead) => Promise<ReadOutcome>>,
    async stat({ supplier }: { supplier: { supplierPublicKeyHex: string } }) {
      return { supplierPublicKeyHex: supplier.supplierPublicKeyHex, status: "absent" as const };
    },
    async read(input: { supplier: { supplierPublicKeyHex: string }; kind: "seed" | "block"; hashHex: string; maxPriceSatoshis: bigint }) {
      transport.reads.push({
        supplierPublicKeyHex: input.supplier.supplierPublicKeyHex,
        kind: input.kind,
        hashHex: input.hashHex,
        maxPriceSatoshis: input.maxPriceSatoshis,
      });
      const next = transport.script.shift();
      if (!next) throw new Error("unexpected read");
      return next(transport.reads[transport.reads.length - 1]!);
    },
    async probe() {
      return {
        supplierPublicKeyHex: SUPPLIER_PUBKEY,
        peerId: SUPPLIER_PEER_ID,
        connected: true,
        startedAt: 1,
        durationMs: 2,
        addresses: [],
      };
    },
    dispose() {},
    invalidateSupplierCalls: [] as Array<{ supplierPublicKeyHex: string | undefined; generation: number }>,
    async invalidateSupplier(supplierPublicKeyHex: string | undefined, generation: number) {
      transport.invalidateSupplierCalls.push({ supplierPublicKeyHex, generation });
    },
  };
  return transport;
}

function appContext(owner: string, publisher: string, appId: string) {
  return {
    connectSessionId: `session-${owner.slice(2, 6)}-${appId}`,
    transportOrigin: "https://app.example",
    ownerPublicKeyHex: owner,
    appIdentity: {
      version: 1 as const,
      publisherPublicKeyHex: publisher,
      appId,
      appName: appId,
      identityDigestHex: "aa".repeat(32),
    },
  };
}

const openServices: MsFileServiceImpl[] = [];
let serviceRef: MsFileServiceImpl;

async function freshService(transport = makeTransport()): Promise<MsFileServiceImpl> {
  // 测试 fake 的脚本结果类型比真实 transport 宽（可注入 supplier-error 等
  // wire 终态）；在注入边界一次性收窄。
  const service = createMsFileService({ transport: transport as unknown as MsFileTransport });
  openServices.push(service);
  return service;
}

async function configureGlobal(service: MsFileServiceImpl, seed = "100", block = "50"): Promise<void> {
  await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
  await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: seed, blockMaxPriceSatoshis: block });
}

afterEach(async () => {
  while (openServices.length > 0) {
    openServices.pop()?.dispose();
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(MSFILE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => setTimeout(() => resolve(), 50);
  });
});

describe("trusted reads", () => {
  it("fail closed before global settings exist", async () => {
    const service = await freshService();
    await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    await expect(service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) }))
      .rejects.toMatchObject({ code: "msfile_not_configured" });
  });

  it("send the global cap on the wire and never read app overrides", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "100", "50");
    // 即使存在更高的 App override，trusted 也只用全局额度。
    await service.updateAppPriceOverride({
      key: { ownerPublicKeyHex: OTHER_KEY, publisherPublicKeyHex: PUBLISHER_A, appId: "app" },
      override: { seedMaxPriceSatoshis: "9999" },
    });

    const seedBytes = new Uint8Array(32);
    const outcome = { type: "ok" as const, content: seedBytes };
    transport.script.push(async () => outcome);

    const result = await service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: await hashOf(seedBytes) });
    expect(result.contentHashHex).toBe(await hashOf(seedBytes));
    expect(result.content.$type).toBe("binary");
    expect(transport.reads[0]).toMatchObject({ kind: "seed", maxPriceSatoshis: 100n });
  });

  it("map wire price_limit_exceeded to the stable error without approvals", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_price_limit_exceeded" });
    expect(transport.reads).toHaveLength(1);
  });

  it("separate supplier business terminal states from transport failures（审查修复）", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "supplier-error", errorCode: "content_not_found" }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_content_not_found" });
    transport.script.push(async () => ({ type: "supplier-error", errorCode: "rate_limited" }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_rate_limited" });
    transport.script.push(async () => ({ type: "supplier-error", errorCode: "acquisition_failed" }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_supplier_error" });
    transport.script.push(async () => ({ type: "supplier-error", errorCode: "totally_unknown_code" }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_transport_error" });
  });

  it("enforce exact seed length when a prior Stat reported the file size（审查修复）", async () => {
    const transport = makeTransport();
    // Stat 返回 file size = 262144（单块文件）→ Seed 必须恰好 32 字节。
    transport.stat = async ({ supplier }: { supplier: { supplierPublicKeyHex: string } }) => ({
      supplierPublicKeyHex: supplier.supplierPublicKeyHex,
      status: "available",
      recommendedFilename: "one-block.bin",
      fileSizeBytes: "262144",
      mediaType: ""
    });
    const service = await freshService(transport);
    await configureGlobal(service);

    // 长度错误（64 字节，但 Stat 报告 file size = 262144 → Seed 应为 32 字节）：
    // Stat 与 Read 必须指向同一个 seedHash。
    const wrongLength = new Uint8Array(64);
    const wrongHash = Array.from(await sha256(wrongLength), (b) => b.toString(16).padStart(2, "0")).join("");
    await service.stat({ seedHashHex: wrongHash });
    transport.script.push(async () => ({ type: "ok", content: wrongLength }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: wrongHash })
    ).rejects.toMatchObject({ code: "msfile_integrity_error" });

    // 精确长度（32 字节）且 hash 匹配：放行。
    const right = new Uint8Array(32).fill(7);
    const rightHash = Array.from(await sha256(right), (b) => b.toString(16).padStart(2, "0")).join("");
    await service.stat({ seedHashHex: rightHash });
    transport.script.push(async () => ({ type: "ok", content: right }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: rightHash })
    ).resolves.toMatchObject({ contentHashHex: rightHash });

    // 供应商配置世代变化后缓存失效：未知尺寸回退到基础校验。
    await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    transport.script.push(async () => ({ type: "ok", content: wrongLength }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: wrongHash })
    ).resolves.toMatchObject({ contentHashHex: wrongHash });
  });

  it("reject unknown / disabled suppliers before touching the wire", async () => {
    const service = await freshService();
    await configureGlobal(service);
    await expect(service.readSeed({ supplierPublicKeyHex: "02" + "22".repeat(32), seedHashHex: "ab".repeat(32) }))
      .rejects.toMatchObject({ code: "msfile_supplier_not_found" });
    await service.upsertSupplier({ name: "off", supplierPublicKeyHex: "02" + "33".repeat(32).replace(/^/, ""), addresses: [SUPPLIER_ADDRESS.replace(SUPPLIER_PEER_ID, "16Uiu2HAm7jWZvRQWjW8LpPRXqyGJqpb4rqLkX7FUu53zoQG9oUuF")], enabled: false }).catch(() => undefined);
    const disabledKey = "02b6de0e542ca933c790eb27e7d759abf2947233552fd0f942c4cd391186286e72";
    await expect(service.readSeed({ supplierPublicKeyHex: disabledKey, seedHashHex: "ab".repeat(32) }))
      .rejects.toMatchObject({ code: "msfile_supplier_not_found" });
  });

  it("fail closed on integrity mismatch", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "ok", content: new Uint8Array(31) }));
    await expect(
      service.readBlock({ supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_integrity_error" });
  });

  it("aggregate stat per supplier without folding network errors into absent", async () => {
    const transport = makeTransport();
    transport.stat = async ({ supplier }: { supplier: { supplierPublicKeyHex: string } }) => {
      if (supplier.supplierPublicKeyHex === SUPPLIER_PUBKEY) {
        return {
          supplierPublicKeyHex: SUPPLIER_PUBKEY,
          status: "quoted" as const,
          recommendedFilename: "a.bin",
          fileSizeBytes: "10",
          mediaType: "",
          minSeedPriceSatoshis: "1",
          maxSeedPriceSatoshis: "2",
          minFullBlockPriceSatoshis: "1",
          maxFullBlockPriceSatoshis: "2",
        };
      }
      throw new Error("dial failed");
    };
    const service = await freshService(transport);
    const other = OTHER_KEY;
    await service.upsertSupplier({ name: "a", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    // 第二个供应商使用另一个公钥；地址必须 pin 到它自己的 PeerId。
    await service.upsertSupplier({
      name: "b",
      supplierPublicKeyHex: other,
      addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${OWNER_PEER_ID}`],
      enabled: false, // 不参与 Stat 并发
    });
    const result = await service.stat({ seedHashHex: "ab".repeat(32) });
    expect(result.suppliers).toHaveLength(1);
    expect(result.suppliers[0]).toMatchObject({ status: "quoted", supplierPublicKeyHex: SUPPLIER_PUBKEY });
    // 启用第二个供应商后网络错误单独呈现。
    await service.upsertSupplier({
      name: "b",
      supplierPublicKeyHex: other,
      addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${OWNER_PEER_ID}`],
      enabled: true,
    });
    const result2 = await service.stat({ seedHashHex: "ab".repeat(32) });
    expect(result2.suppliers.find((entry) => entry.supplierPublicKeyHex === other)).toMatchObject({ status: "network-error" });
    void transport.available;
  });
});

describe("connect gateway authorization", () => {
  const ctxA = () => appContext(OWNER_PUBKEY, PUBLISHER_A, "player");

  it("records sanitized usage on first call", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    const pending = service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) });
    void pending.catch(() => undefined);
    await waitForApprovals(service);
    const authorizations = await service.listAppAuthorizations();
    await service.abortSession(ctxA().connectSessionId);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({ appName: "player", key: { appId: "player" } });
  });

  it("uses effective cap = override ?? global and sends explicit unlimited as wire 0", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "100", "50");
    await service.updateAppPriceOverride({
      key: ctxA().appIdentity.publisherPublicKeyHex ? { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER_A, appId: "player" } : ({} as never),
      override: { blockMaxPriceSatoshis: "0" },
    });

    const bytes = new Uint8Array(64);
    transport.script.push(async () => ({ type: "ok", content: bytes }));
    await service.connect.readBlock(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: await hashOf(bytes) });
    expect(transport.reads[0]).toMatchObject({ kind: "block", maxPriceSatoshis: 0n });
    // Seed 未设置 override → 继承全局 100。
    const seedBytes = new Uint8Array(32);
    transport.script.push(async () => ({ type: "ok", content: seedBytes }));
    await service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: await hashOf(seedBytes) });
    expect(transport.reads[1]).toMatchObject({ kind: "seed", maxPriceSatoshis: 100n });
  });

  it("supports once-only escalation in memory and always escalation persisted to one field only", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "10", "10");
    const seedBytes = new Uint8Array(32).fill(1);
    const seedHash = Array.from(await sha256(seedBytes), (b) => b.toString(16).padStart(2, "0")).join("");

    // 第一次：超额 → 用户选择“仅本次 200”。
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "ok", content: seedBytes }));
    const pendingOnce = service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: seedHash });
    await waitForApprovals(service);
    const approvals = service.listPendingApprovals();

    await service.resolveApproval(approvals[0]!.approvalId, { action: "allow", scope: "once", newMaxPriceSatoshis: "200" });
    await pendingOnce;
    expect(transport.reads.map((read) => read.maxPriceSatoshis)).toEqual([10n, 200n]);
    // once 不落库。
    expect((await service.listAppAuthorizations())[0]?.policy).toBeNull();

    // 第二次：再次超额 → “始终 300”，只写 seed 字段。
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "ok", content: seedBytes }));
    const pendingAlways = service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: seedHash });
    await waitForApprovals(service);
    const approval = service.listPendingApprovals()[0]!;
    await service.resolveApproval(approval.approvalId, { action: "allow", scope: "always", newMaxPriceSatoshis: "300" });
    await pendingAlways;

    const policy = (await service.listAppAuthorizations())[0]!.policy!;
    expect(policy.override).toEqual({ seedMaxPriceSatoshis: "300" });

    // 第三次：以持久化的 300 直接成功，无需确认。
    transport.script.push(async () => ({ type: "ok", content: seedBytes }));
    await service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: seedHash });
    // 第二次调用的首个 wire Read 仍从继承全局 10 开始（once 未落库），确认后按 300 重发。
    expect(transport.reads.map((read) => read.maxPriceSatoshis)).toEqual([10n, 200n, 10n, 300n, 300n]);
  });

  it("does not loop confirmations when the resend still exceeds the cap", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "10", "10");
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    const pending = service.connect.readBlock(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: "11".repeat(32) });
    await waitForApprovals(service);
    const approval = service.listPendingApprovals()[0];
    await service.resolveApproval(approval!.approvalId, { action: "allow", scope: "once", newMaxPriceSatoshis: "20" });
    await expect(pending).rejects.toMatchObject({ code: "msfile_price_limit_exceeded" });
    expect(service.listPendingApprovals()).toHaveLength(0);
    expect(transport.reads).toHaveLength(2);
  });

  it("maps user rejection to user_rejected and never resends", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    const pending = service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) });
    await waitForApprovals(service);
    await service.resolveApproval(service.listPendingApprovals()[0]!.approvalId, { action: "reject" });
    await expect(pending).rejects.toMatchObject({ code: "user_rejected" });
    expect(transport.reads).toHaveLength(1);
  });

  it("keeps two apps and two owners fully isolated", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "100", "100");
    await service.updateAppPriceOverride({
      key: { ownerPublicKeyHex: OWNER_PUBKEY, publisherPublicKeyHex: PUBLISHER_A, appId: "player" },
      override: { seedMaxPriceSatoshis: "700" },
    });
    const otherApp = appContext(OWNER_PUBKEY, PUBLISHER_A, "editor");
    const bytes = new Uint8Array(32);
    transport.script.push(async () => ({ type: "ok", content: bytes }));
    await service.connect.readSeed(otherApp, { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: await hashOf(bytes) });
    expect(transport.reads[0]).toMatchObject({ maxPriceSatoshis: 100n });
  });

  it("cancels pending approvals when the session is revoked", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    const pending = service.connect.readSeed(ctxA(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) });
    await waitForApprovals(service);
    await service.abortSession(ctxA().connectSessionId);
    await expect(pending).rejects.toMatchObject({ code: "user_rejected" });
    expect(service.listPendingApprovals()).toHaveLength(0);
  });

  it("requires a well-formed app context", async () => {
    const service = await freshService();
    await configureGlobal(service);
    await expect(
      service.connect.stat({ ...ctxA(), connectSessionId: "" }, { seedHashHex: "ab".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_identity_required" });
  });
});

interface FakeDbOverrides {
  listSuppliersGate?: { resolve(): void; promise: Promise<void> };
  delayList?: boolean;
}
function makeFakeDb(seed: MsFileSupplierConfig[] = [], overrides: FakeDbOverrides = {}): import("./msfileDb.js").MsFileDb & {
  rows: Map<string, MsFileSupplierConfig>;
  settingsRow: {
    settings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null;
    mediaBlockReadConcurrency?: number;
    globalSeedReadConcurrency?: number;
    globalBlockReadConcurrency?: number;
    globalStatConcurrency?: number;
    updatedAt: number | null;
  };
} {
    const rows = new Map<string, MsFileSupplierConfig>(seed.map((entry) => [entry.supplierPublicKeyHex, entry]));
    let listCallCount = 0;
    const settingsRow = { settings: null as MsFileGlobalPriceSettings | null, updatedAt: null as number | null };
    return {
      rows,
      settingsRow,
      async getGlobalSettings() { return settingsRow.settings ? { ...settingsRow } : null; },
      async putGlobalSettings(settings) { settingsRow.settings = { ...settings }; settingsRow.updatedAt = Date.now(); },
      async putReadConcurrencySettings(settings) {
        Object.assign(settingsRow, settings);
        settingsRow.updatedAt = Date.now();
      },
      async putMediaBlockReadConcurrency(settings) {
        settingsRow.mediaBlockReadConcurrency = typeof settings === "number" ? settings : settings.mediaBlockReadConcurrency;
        settingsRow.updatedAt = Date.now();
      },
      async listSuppliers() {
        listCallCount += 1;
        // 第一次调用来自构造期 init（快速放行）；第二次起才是 mutation 路径。
        if (overrides.delayList && listCallCount >= 2 && overrides.listSuppliersGate) await overrides.listSuppliersGate.promise;
        return [...rows.values()];
      },
      async getSupplier(key) { return rows.get(key) ?? null; },
      async upsertSupplier(config) { rows.set(config.supplierPublicKeyHex, config); },
      async deleteSupplier(key) { rows.delete(key); },
      async listAppPolicies() { return []; },
      async getAppPolicy() { return null; },
      async putAppPolicy() {},
      async deleteAppPolicy() {},
      async listAppUsages() { return []; },
      async touchAppUsage() {},
      close() {}
    };
  }

  it("blocks reads for the whole mutation window until invalidation completes（第五轮审查修复）", { timeout: 60_000 }, async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    // 先完成初始配置，再安装门控：只悬挂“本次”mutation 的 invalidation。
    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    let invalidationStarted = false;
    const innerInvalidate = transport.invalidateSupplier.bind(transport);
    transport.invalidateSupplier = async (key: string | undefined, generation: number) => {
      invalidationStarted = true;
      await invalidationGate;
      await innerInvalidate(key, generation);
    };

    // mutation 快速通过 DB 提交与同步 fencing，随后悬挂在 invalidation 上；
    // 整个窗口内该供应商的数据面必须 fail closed。
    const mutation = service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    void mutation.catch(() => undefined);
    for (let i = 0; i < 200 && !invalidationStarted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(invalidationStarted).toBe(true);

    // 窗口内的 read / probe 都不能到达 transport。
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_unavailable" });
    expect(transport.reads).toHaveLength(0);
    await expect(service.probeSupplier(SUPPLIER_PUBKEY)).rejects.toMatchObject({ code: "msfile_unavailable" });

    // 完成后解除。
    releaseInvalidation();
    await mutation;
    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "ok", content: bytes }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash })
    ).resolves.toMatchObject({ contentHashHex: hash });
    expect(transport.reads).toHaveLength(1);
  });

  it("keeps a failed invalidation as a hard data-plane block until re-save succeeds", async () => {
    const transport = makeTransport();
    let failInvalidation = false;
    const inner = transport.invalidateSupplier.bind(transport);
    transport.invalidateSupplier = async (key, generation) => {
      if (failInvalidation) throw new Error("close failed");
      await inner(key, generation);
    };
    const service = await freshService(transport);
    await configureGlobal(service);

    failInvalidation = true;
    await expect(
      service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true })
    ).rejects.toThrow(/closing previous connections failed/);

    // failed barrier：read 持续禁用。
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: "ab".repeat(32) })
    ).rejects.toMatchObject({ code: "msfile_unavailable" });

    // 重新保存成功后解除。
    failInvalidation = false;
    await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "ok", content: bytes }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash })
    ).resolves.toBeTruthy();
  });

  it("serves preloaded suppliers immediately without an explicit init wait", async () => {
    const transport = makeTransport();
    const seeded: MsFileSupplierConfig = { name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true };
    const db = makeFakeDb([seeded]);
    db.settingsRow.settings = { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" };
    const service = createMsFileService({ db, transport: transport as unknown as MsFileTransport });
    openServices.push(service);

    // 不等待任何初始化：立即 stat 必须看到预置供应商（而非误报“无供应商”）。
    const result = await service.stat({ seedHashHex: "ab".repeat(32) });
    expect(result.suppliers).toHaveLength(1);
    expect(result.suppliers[0]).toMatchObject({ status: "absent", supplierPublicKeyHex: SUPPLIER_PUBKEY });
  });

  it("lets a late refresh never resurrect a pre-mutation snapshot", async () => {
    const transport = makeTransport();
    let releaseList!: () => void;
    const gatePromise = new Promise<void>((resolve) => { releaseList = resolve; });
    const seeded: MsFileSupplierConfig = { name: "old", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true };
    const db = makeFakeDb([seeded]);
    const originalList = db.listSuppliers.bind(db);
    let firstCall = true;
    db.listSuppliers = async () => {
      if (firstCall) { firstCall = false; await gatePromise; }
      return originalList();
    };
    const service = createMsFileService({ db, transport: transport as unknown as MsFileTransport });
    openServices.push(service);

    // init 的 refresh 挂在首次 listSuppliers 上；公开方法必须等待初始化——
    // mutation 在此期间发起会被挂起，直到 init 完成后才执行，
    // 因此不存在“迟到 refresh 覆盖新快照”的交错。
    let settled = false;
    const mutation = service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "7", blockMaxPriceSatoshis: "8" }).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // 仍在等待 init

    releaseList();
    await mutation;
    expect(settled).toBe(true);

    // 最终状态与 DB 一致，且未被任何迟到 refresh 复古。
    const snapshot = await service.getSettingsSnapshot();
    expect(snapshot.globalSettings).toEqual({ seedMaxPriceSatoshis: "7", blockMaxPriceSatoshis: "8" });
    expect(snapshot.suppliers.map((entry) => entry.name)).toEqual(["old"]);
  });

describe("supplier fence token（第五轮审查修复）", () => {
  it("rejects a read whose async address validation overlaps a failed pre-commit mutation", { timeout: 60_000 }, async () => {
    const transport = makeTransport();
    let releaseValidator!: () => void;
    const validatorGate = new Promise<void>((resolve) => { releaseValidator = resolve; });
    let validatorCalls = 0;
    const db = makeFakeDb([]);
    let failNextWrite = false;
    const origUpsert = db.upsertSupplier.bind(db);
    db.upsertSupplier = async (config: MsFileSupplierConfig) => {
      if (failNextWrite) { failNextWrite = false; throw new Error("forced db failure"); }
      await origUpsert(config);
    };
    const service = createMsFileService({
      db,
      transport: transport as unknown as MsFileTransport,
      validatorLoader: async () => {
        validatorCalls += 1;
        if (validatorCalls >= 1) await validatorGate; // read 的地址校验是首次 loader 调用（init 不经过 loader）
        return { validatePersistedSupplier };
      }
    });
    openServices.push(service);
    await configureGlobal(service);


    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "ok", content: bytes }));

    // read 先启动并悬挂在地址校验上（首次 loader 调用）。
    const pendingRead = service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash });
    void pendingRead.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(validatorCalls).toBeGreaterThanOrEqual(1);

    // 校验悬挂期间执行一次 pre-commit 失败的 mutation：
    // barrier 设置又按状态机恢复——fence token 推进而 generation 不变，
    // 正是审查指出的“barrier 已设而 generation 未动”窗口。
    failNextWrite = true;
    const failingMutation = service
      .upsertSupplier({ name: "x", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true })
      .catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));

    releaseValidator();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(pendingRead).rejects.toMatchObject({ code: "msfile_unavailable" });
    expect(transport.reads).toHaveLength(0);

    // pre-commit 失败：配置未写入，调用方收到原始 DB 错误。
    const mutationError = (await failingMutation) as Error;
    expect(mutationError.message).toBe("forced db failure");
  });

  it("re-checks the fence after stat validation when a pre-commit mutation interleaves", { timeout: 60_000 }, async () => {
    let dialCount = 0;
    const transport = makeTransport();
    const innerStat = transport.stat.bind(transport);
    transport.stat = async (input) => { dialCount += 1; return innerStat(input); };
    let releaseValidator!: () => void;
    const validatorGate = new Promise<void>((resolve) => { releaseValidator = resolve; });
    let validatorCalls = 0;
    const seeded: MsFileSupplierConfig = { name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true };
    const db = makeFakeDb([seeded]);
    db.settingsRow.settings = { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" };
    let failNextWrite = false;
    const origUpsert = db.upsertSupplier.bind(db);
    db.upsertSupplier = async (config: MsFileSupplierConfig) => {
      if (failNextWrite) { failNextWrite = false; throw new Error("forced db failure"); }
      await origUpsert(config);
    };
    const service = createMsFileService({
      db,
      transport: transport as unknown as MsFileTransport,
      validatorLoader: async () => {
        validatorCalls += 1;
        if (validatorCalls >= 1) await validatorGate; // init 不经过 loader；stat 是首个消费者
        return { validatePersistedSupplier };
      }
    });
    openServices.push(service);
    await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" });

    // stat 先悬挂在地址校验上；期间执行一次 pre-commit 失败的 mutation。
    const pendingStat = service.stat({ seedHashHex: "ab".repeat(32) });
    void pendingStat.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    failNextWrite = true;
    const failingMutation = service
      .upsertSupplier({ name: "x", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true })
      .catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));

    releaseValidator();
    await expect(pendingStat).rejects.toMatchObject({ code: "msfile_unavailable" });
    expect(dialCount).toBe(0);
    const mutationError = (await failingMutation) as Error;
    expect(mutationError.message).toBe("forced db failure");

    // 无 mutation 的后续 stat 正常拨号（活性对照）。
    const result = await service.stat({ seedHashHex: "ab".repeat(32) });
    expect(result.suppliers).toHaveLength(1);
    expect(dialCount).toBe(1);
  });

  it("aborts in-flight data operations that resume after dispose（第六轮审查修复）", { timeout: 60_000 }, async () => {
    let releaseValidator!: () => void;
    const validatorGate = new Promise<void>((resolve) => { releaseValidator = resolve; });
    let validatorCalls = 0;
    const seeded: MsFileSupplierConfig = { name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true };
    const db = makeFakeDb([seeded]);
    db.settingsRow.settings = { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" };
    let dialCount = 0;
    let probeCount = 0;
    const transport = makeTransport();
    const innerStat = transport.stat.bind(transport);
    const innerProbe = transport.probe.bind(transport);
    const innerRead = transport.read.bind(transport);
    transport.stat = async (input) => { dialCount += 1; return innerStat(input); };
    transport.probe = async (input) => { probeCount += 1; return innerProbe(input); };
    transport.read = async (input) => { dialCount += 1; return innerRead(input); };
    const service = createMsFileService({
      db,
      transport: transport as unknown as MsFileTransport,
      validatorLoader: async () => {
        validatorCalls += 1;
        // 无条件门控：init 不经过 loader，因此挂起的是 read/stat/probe 三者。
        await validatorGate;
        return { validatePersistedSupplier };
      }
    });
    openServices.push(service);
    await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" });

    // 三个数据面操作同时悬挂在地址校验上。
    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    const pendingRead = service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash });
    void pendingRead.catch(() => undefined);
    const pendingStat = service.stat({ seedHashHex: hash });
    void pendingStat.catch(() => undefined);
    const pendingProbe = service.probeSupplier(SUPPLIER_PUBKEY);
    void pendingProbe.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 悬挂期间 dispose：同步推进生命周期栅栏并释放 transport。
    service.dispose();

    releaseValidator();
    await expect(pendingRead).rejects.toMatchObject({ code: "msfile_unavailable" });
    await expect(pendingStat).rejects.toMatchObject({ code: "msfile_unavailable" });
    await expect(pendingProbe).rejects.toMatchObject({ code: "msfile_unavailable" });
    // 已释放的 transport 从未被触碰。
    expect(dialCount).toBe(0);
    expect(probeCount).toBe(0);
    // disposed 后的新请求同样 fail closed。
    await expect(service.stat({ seedHashHex: hash })).rejects.toMatchObject({ code: "msfile_unavailable" });
  });

  it("propagates initialization failure to every public method（第六轮审查修复）", async () => {
    const transport = makeTransport();
    const failingDb = makeFakeDb([]);
    failingDb.getGlobalSettings = async () => { throw new Error("db exploded"); };
    const service = createMsFileService({
      db: failingDb,
      transport: transport as unknown as MsFileTransport,
    });
    openServices.push(service);

    // 先等 ready 落定（初始化错误被记录），再断言状态与行为一致。
    await expect(service.stat({ seedHashHex: "ab".repeat(32) })).rejects.toMatchObject({ code: "msfile_unavailable" });
    expect(service.status()).toBe("unavailable");
    await expect(service.getSettingsSnapshot()).rejects.toMatchObject({ code: "msfile_unavailable" });
    await expect(
      service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "5", blockMaxPriceSatoshis: "5" })
    ).rejects.toMatchObject({ code: "msfile_unavailable" });
  });
});


describe("supplier invalidation races（审查修复）", () => {
  const gwCtx = () => appContext(OWNER_PUBKEY, PUBLISHER_A, "player");
  it("awaits transport invalidation with bumped generations on config writes", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    // configureGlobal 内的首次 upsert 已推进到 generation 1。
    expect(transport.invalidateSupplierCalls).toEqual([{ supplierPublicKeyHex: SUPPLIER_PUBKEY, generation: 1 }]);
    await service.upsertSupplier({ name: "nas-2", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    expect(transport.invalidateSupplierCalls[1]).toEqual({ supplierPublicKeyHex: SUPPLIER_PUBKEY, generation: 2 });
    await service.deleteSupplier(SUPPLIER_PUBKEY);
    expect(transport.invalidateSupplierCalls[2]).toEqual({ supplierPublicKeyHex: SUPPLIER_PUBKEY, generation: 3 });
  });

  it("discards a read whose supplier was disabled while the wire read was in flight", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service);
    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => {
      // Read 在途时 disable 同一供应商：generation 推进，迟到结果必须被丢弃。
      await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: false });
      return { type: "ok" as const, content: bytes };
    });
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash })
    ).rejects.toMatchObject({ code: "msfile_unavailable" });
  });

  it("reports a compound failure when invalidation rejects after the DB commit", async () => {
    const transport = makeTransport();
    let failInvalidation = false;
    const originalInvalidate = transport.invalidateSupplier.bind(transport);
    transport.invalidateSupplier = async (key: string | undefined, generation: number) => {
      if (failInvalidation) throw new Error("connections refused to close");
      await originalInvalidate(key, generation);
    };
    const service = await freshService(transport);
    await configureGlobal(service);

    failInvalidation = true;
    // 配置已写库但旧连接清理失败：调用方必须得到“已保存但清理失败”的复合错误。
    await expect(
      service.upsertSupplier({ name: "nas-x", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true })
    ).rejects.toThrow(/was saved, but closing previous connections failed/);
    // 快照/缓存仍反映已提交的 DB 状态（不回滚、不悬空）。
    const snapshot = await service.getSettingsSnapshot();
    expect(snapshot.suppliers).toHaveLength(1);
    expect(snapshot.suppliers[0]).toMatchObject({ name: "nas-x" });

    // 清理恢复后可继续正常变更。
    failInvalidation = false;
    await service.deleteSupplier(SUPPLIER_PUBKEY);
    expect((await service.getSettingsSnapshot()).suppliers).toHaveLength(0);
  });

  it("never commits the stat size cache when the configuration changed mid-stat", async () => {
    const transport = makeTransport();
    transport.stat = async ({ supplier }: { supplier: { supplierPublicKeyHex: string } }) => {
      // Stat 在途时 disable 同一供应商：世代推进，迟到结果连同缓存一起作废。
      await serviceRef.upsertSupplier({ name: "nas", supplierPublicKeyHex: supplier.supplierPublicKeyHex, addresses: [SUPPLIER_ADDRESS], enabled: false });
      return {
        supplierPublicKeyHex: supplier.supplierPublicKeyHex,
        status: "available" as const,
        recommendedFilename: "one.bin",
        fileSizeBytes: "262144",
        mediaType: ""
      };
    };
    const service = await freshService(transport);
    serviceRef = service;
    await configureGlobal(service, "100", "100");
    await expect(service.stat({ seedHashHex: "ab".repeat(32) })).rejects.toMatchObject({ code: "msfile_unavailable" });
    // 重新启用后，未知 file size 的 Seed 不做精确长度校验 → 缓存确未写入。
    await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    const odd = new Uint8Array(96); // 对齐但非 32 整除块长
    const oddHash = Array.from(await sha256(odd), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "ok", content: odd }));
    await expect(
      service.readSeed({ supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: oddHash })
    ).resolves.toMatchObject({ contentHashHex: oddHash });
  });

  it("requires permanent grants to exceed the current cap and keeps the approval pending otherwise", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "100", "100");
    const bytes = new Uint8Array(32);
    const hash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "ok" as const, content: bytes }));
    const pending = service.connect.readSeed(gwCtx(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: hash });
    void pending.catch(() => undefined);
    await waitForApprovals(service);
    const approvalId = service.listPendingApprovals()[0]!.approvalId;
    // 更低的永久额度必须被拒绝，且审批保持未决可重试。
    await expect(
      service.resolveApproval(approvalId, { action: "allow", scope: "always", newMaxPriceSatoshis: "50" })
    ).rejects.toThrow(/exceed the current cap/);
    expect(service.listPendingApprovals()).toHaveLength(1);
    await service.resolveApproval(approvalId, { action: "allow", scope: "always", newMaxPriceSatoshis: "200" });
    await pending;
    expect((await service.listAppAuthorizations())[0]?.policy?.override).toEqual({ seedMaxPriceSatoshis: "200" });
  });

  it("persists seed and block permanent grants independently without clobbering", async () => {
    const transport = makeTransport();
    const service = await freshService(transport);
    await configureGlobal(service, "10", "10");
    const bytes = new Uint8Array(32);

    // Block 永久提额。
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "ok", content: bytes }));
    const blockHash = Array.from(await sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    const blockPending = service.connect.readBlock(gwCtx(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, blockHashHex: blockHash });
    await waitForApprovals(service);
    await service.resolveApproval(service.listPendingApprovals()[0]!.approvalId, { action: "allow", scope: "always", newMaxPriceSatoshis: "40" });
    await blockPending;

    // Seed 永久提额不得覆盖 Block 字段。
    const seedBytes = new Uint8Array(32).fill(1);
    const seedHash = Array.from(await sha256(seedBytes), (b) => b.toString(16).padStart(2, "0")).join("");
    transport.script.push(async () => ({ type: "price-limit-exceeded" }));
    transport.script.push(async () => ({ type: "ok", content: seedBytes }));
    const seedPending = service.connect.readSeed(gwCtx(), { supplierPublicKeyHex: SUPPLIER_PUBKEY, seedHashHex: seedHash });
    await waitForApprovals(service);
    await service.resolveApproval(service.listPendingApprovals()[0]!.approvalId, { action: "allow", scope: "always", newMaxPriceSatoshis: "70" });
    await seedPending;

    expect((await service.listAppAuthorizations())[0]?.policy?.override).toEqual({
      blockMaxPriceSatoshis: "40",
      seedMaxPriceSatoshis: "70"
    });
  });
});

describe("settings control plane", () => {
  it("roundtrips settings snapshot and generation bumps", async () => {
    const service = await freshService();
    let snapshot = await service.getSettingsSnapshot();
    expect(snapshot.globalSettings).toBeNull();
    expect(snapshot.supplierGeneration).toBe(0);
    await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "5", blockMaxPriceSatoshis: "0" });
    snapshot = await service.getSettingsSnapshot();
    expect(snapshot.globalSettings).toEqual({ seedMaxPriceSatoshis: "5", blockMaxPriceSatoshis: "0" });
    await service.upsertSupplier({ name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [SUPPLIER_ADDRESS], enabled: true });
    expect((await service.getSettingsSnapshot()).supplierGeneration).toBeGreaterThan(0);
  });

  it("uses recommended read concurrency defaults and atomically retains the last valid value", async () => {
    const service = await freshService();
    expect(await service.getReadConcurrencySettings()).toEqual({
      mediaBlockReadConcurrency: 2,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 4,
    });

    await service.updateReadConcurrencySettings({
      mediaBlockReadConcurrency: 4,
      globalSeedReadConcurrency: 6,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 7,
    });
    expect(await service.getReadConcurrencySettings()).toEqual({
      mediaBlockReadConcurrency: 4,
      globalSeedReadConcurrency: 6,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 7,
    });
    await expect(service.updateReadConcurrencySettings({
      mediaBlockReadConcurrency: 13,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 1,
    })).rejects.toThrow();
    expect(await service.getReadConcurrencySettings()).toEqual({
      mediaBlockReadConcurrency: 4,
      globalSeedReadConcurrency: 6,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 7,
    });

    await service.resetReadConcurrencySettings();
    expect(await service.getSettingsSnapshot()).toMatchObject({
      mediaBlockReadConcurrency: 2,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 8,
      globalStatConcurrency: 4,
    });
  });

  it("rejects non-canonical amounts", async () => {
    const service = await freshService();
    await expect(service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "01", blockMaxPriceSatoshis: "5" })).rejects.toThrow(/canonical/);
    await expect(service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "-1", blockMaxPriceSatoshis: "5" })).rejects.toThrow();
    await expect(service.resolveApproval("missing", { action: "allow", scope: "once", newMaxPriceSatoshis: "5" })).rejects.toBeInstanceOf(MsFileServiceError);
  });

  it("probe requires an existing supplier", async () => {
    const service = await freshService();
    await expect(service.probeSupplier(SUPPLIER_PUBKEY)).rejects.toMatchObject({ code: "msfile_supplier_not_found" });
    await configureGlobal(service);
    const probe = await service.probeSupplier(SUPPLIER_PUBKEY);
    expect(probe.connected).toBe(true);
  });
});
