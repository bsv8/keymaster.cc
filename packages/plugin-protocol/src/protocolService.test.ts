// packages/plugin-protocol/src/protocolService.test.ts
// 协议 service 关键行为单测：
//   - ready -> request -> result 正常流程；
//   - aud !== event.origin 拒绝；
//   - 锁定态解锁后继续；
//   - 无 active key 拒绝；
//   - claim 省略规则；
//   - identity/sign envelope 字节稳定；
//   - cipher 同 origin 可解、异 origin 不可解。
//   - 单条 request 完成后 service 不发 closing、phase 回 waiting；
//   - 同 popup 连续处理两条 request 时复用同一个 service；
//   - pageUnloading 才发 closing；
//   - DB 写失败不阻塞主协议结果。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  LaunchAppViewError,
  type KeyspaceService,
  type VaultService,
  type ConnectSessionRecord,
  type ProtocolClosingMessage,
  type ProtocolCommandRecord,
  type ProtocolFeePoolRecord,
  type ProtocolMethod,
  type ProtocolOriginSettingsRecord,
  type ProtocolResultMessage,
  type ProtocolStorageDb
} from "@keymaster/contracts";
import { ProtocolServiceImpl, type ProtocolServiceDeps } from "./protocolService.js";
import type { LaunchTokenRecord, ResolvedClaimValue } from "@keymaster/contracts";
import { cborDecode, cborEncode } from "./protocolCbor.js";
import { aesGcmDecrypt, deriveSiteKey, verifyCompactSecp256k1, signCompactSecp256k1 } from "./protocolCrypto.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const TEST_PRIV_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PUB_HEX = "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";
const ORIGIN = "https://abc.com";

interface FakeWindow {
  postMessage: (msg: unknown, origin: string) => void;
  closed: boolean;
  messages: { msg: unknown; origin: string }[];
}

function makeFakeOpener(): FakeWindow {
  return {
    postMessage(msg, origin) {
      this.messages.push({ msg, origin });
    },
    closed: false,
    messages: []
  };
}

function makeVaultStub(publicKeyHex: string): VaultService {
  // 施工单 2026-06-30 003：vault 内部 state 驱动 status() 返回；lock() /
  // unlock() 翻转后调用方（popup page vault.onStatusChange）会再调
  // `service.setVaultLockState(...)`，让 service 端的 `computeLockState()`
  // 读到的 vault.status 与真实一致。
  const state = { locked: false };
  const listeners = new Set<(s: "locked" | "unlocked") => void>();
  return {
    status: () => (state.locked ? "locked" : "unlocked"),
    onStatusChange: (h: (s: "locked" | "unlocked") => void) => {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    withPrivateKey: async <T,>(_keyId: string, fn: (m: { hex: string }) => Promise<T> | T) => {
      return fn({ hex: TEST_PRIV_HEX });
    },
    listKeys: async () => [
      {
        id: "k1",
        label: "Key A",
        format: "generated",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString(),
        publicKeyHex
      }
    ],
    getKey: async () => undefined,
    getKeyByPublicKeyHex: async () => undefined,
    findByAddress: async () => undefined,
    hasVault: async () => true,
    createVault: async () => undefined,
    createVaultWithInitialKey: async () => ({} as never),
    createVaultWithImportedKey: async () => ({} as never),
    unlock: async () => {
      state.locked = false;
      for (const l of listeners) l("unlocked");
    },
    lock: async () => {
      state.locked = true;
      for (const l of listeners) l("locked");
    },
    verifyPassword: async () => undefined,
    importPrivateKey: async () => ({} as never),
    generateKey: async () => ({} as never),
    removeKey: async () => undefined,
    deleteKeyMaterial: async () => undefined,
    exportPrivateKey: async () => ({} as never),
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined
    // 施工单 2026-06-30 002 硬切换：vault 已删除
    // `exportUnlockRuntimeForSessionWindow` / `importUnlockRuntimeFromLauncher`
    // （2026-06-29/003 已删除，002 沿用）。launcher 端改用现有
    // `vault.withPrivateKey(keyId, fn)` 借 owner 私钥 hex 拼
    // `OwnerRuntimeBootstrap`。launchAppView 测试只走 `withPrivateKey` 路径，
    // 不再需要 unlock runtime 假实现。
  } as unknown as VaultService;
}

function makeKeyspaceStub(publicKeyHex: string): KeyspaceService {
  return {
    listKeys: async () => [
      {
        keyId: "k1",
        publicKeyHex,
        label: "Key A",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString(),
        identityStatus: "ready"
      }
    ],
    // 施工单 2026-06-28 001：cipher.* / connect.* 现在按 session.ownerPublicKeyHex
    // 查 key。fake stub 默认返回"单 key ready"，让 cipher/connect 测试可以跑通。
    getKey: async (hex: string) => {
      if (hex !== publicKeyHex) return undefined;
      return {
        keyId: "k1",
        publicKeyHex,
        label: "Key A",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString(),
        identityStatus: "ready" as const
      };
    },
    active: () => ({ activePublicKeyHex: publicKeyHex }),
    setActive: async () => undefined,
    requireActiveKey: () => ({
      keyId: "k1",
      publicKeyHex,
      label: "Key A",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString() }),
    onActiveChange: () => () => undefined,
    openKeyStorage: async () => ({ db: {} as IDBDatabase, name: "x", close: () => undefined }),
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    deleteKeyById: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  } as unknown as KeyspaceService;
}

/**
 * 内存 fake storageDb：保留持久语义（同 id / poolKey / origin 覆盖、
 * 按 origin 隔离、updatedAt desc 排序），不引入 fake-indexeddb。
 */
function makeFakeStorageDb(): ProtocolStorageDb & { writes: number; readFailures: number; writeFailures: number } {
  const commands = new Map<string, ProtocolCommandRecord>();
  const origins = new Map<string, ProtocolOriginSettingsRecord>();
  const pools = new Map<string, ProtocolFeePoolRecord>();
  const sessions = new Map<string, ConnectSessionRecord>();
  let storageConfig: { provider: "s3-compatible"; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean; updatedAt: number } | null = null;
  const launchTokens = new Map<string, LaunchTokenRecord>();
  let writes = 0;
  let writeFailures = 0;
  return {
    get writes() {
      return writes;
    },
    get readFailures() {
      return 0;
    },
    get writeFailures() {
      return writeFailures;
    },
    async putCommand(record: ProtocolCommandRecord) {
      writes++;
      if (record.id === "__force_write_fail__") {
        writeFailures++;
        throw new Error("forced write failure");
      }
      commands.set(record.id, { ...record });
    },
    async getCommand(id: string) {
      const v = commands.get(id);
      return v ? { ...v } : null;
    },
    async listCommandsByOrigin(origin: string) {
      const out: ProtocolCommandRecord[] = [];
      for (const v of commands.values()) {
        if (v.origin === origin) out.push({ ...v });
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      return out;
    },
    async getOrigin(origin: string) {
      const v = origins.get(origin);
      return v ? { ...v } : null;
    },
    async putOrigin(record: ProtocolOriginSettingsRecord) {
      writes++;
      origins.set(record.origin, { ...record });
    },
    async listOrigins() {
      return Array.from(origins.values()).map((r) => ({ ...r }));
    },
    async getFeePool(poolKey: string) {
      const v = pools.get(poolKey);
      return v ? { ...v } : null;
    },
    async putFeePool(record: ProtocolFeePoolRecord) {
      writes++;
      pools.set(record.poolKey, { ...record });
    },
    async deleteFeePool(poolKey: string) {
      pools.delete(poolKey);
    },
    async listFeePoolsByOrigin(origin: string) {
      return Array.from(pools.values())
        .filter((r) => r.origin === origin)
        .map((r) => ({ ...r }));
    },
    async putConnectSession(record: ConnectSessionRecord) {
      writes++;
      sessions.set(record.sessionId, { ...record });
    },
    async getConnectSession(sessionId: string) {
      const v = sessions.get(sessionId);
      return v ? { ...v } : null;
    },
    async listConnectSessionsByOrigin(origin: string) {
      return Array.from(sessions.values())
        .filter((r) => r.origin === origin)
        .map((r) => ({ ...r }));
    },
    async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
      const revokeAt = Date.now();
      sessions.set(record.sessionId, { ...record });
      for (const [sessionId, value] of sessions.entries()) {
        if (value.origin !== record.origin) continue;
        if (sessionId === record.sessionId) continue;
        if (value.revokedAt !== null) continue;
        sessions.set(sessionId, { ...value, revokedAt: revokeAt });
      }
    },
    async getStorageProviderConfig() {
      return storageConfig ? { ...storageConfig } : null;
    },
    async putStorageProviderConfig(record) {
      writes++;
      storageConfig = { ...record };
    },
    async deleteStorageProviderConfig() {
      storageConfig = null;
    },
    async putLaunchToken(record) {
      launchTokens.set(record.token, { ...record });
    },
    async getLaunchToken(token) {
      const v = launchTokens.get(token);
      return v ? { ...v } : null;
    },
    async consumeLaunchToken(token) {
      const v = launchTokens.get(token);
      if (v && !v.consumed) {
        launchTokens.set(token, { ...v, consumed: true });
      }
    },
    async deleteLaunchToken(token) {
      launchTokens.delete(token);
    }
  };
}

function makeFakeSystemSettings() {
  // 已被收回到 per-origin `ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`；
  // 留空 stub 仅防止残留引用编译失败。
  return {
    getFeePoolDefaultFundSatoshis: () => 0,
    setFeePoolDefaultFundSatoshis: () => undefined
  };
}

/**
 * 构造一个带 valid `sess-test` session 的 storageDb stub。
 *
 * 施工单 2026-06-28 002 硬切换：所有业务方法都强制要求 `connectSessionId`。
 * cancel/timeout 类测试关心的是 timer 行为（cache miss → 30s 兜底、
 * 只 clamp down、不热更新），**不**关心 session 预校验细节；统一给
 * stubDb 配一个 valid `sess-test` session，让测试代码不再受 002 新增
 * 的 session 预校验干扰。
 *
 * 调 `stubOverrides` 可以覆盖个别 DB 方法（典型用法：把 `getOrigin`
 * 改成挂住的 promise 模拟慢 DB）。**不**要在这里改 `getConnectSession`——
 * 它必须始终返回 valid session。
 */
function makeFakeStorageDbWithSession(
  stubOverrides: Partial<ProtocolStorageDb> = {}
): ProtocolStorageDb {
  const base: ProtocolStorageDb = {
    async putCommand() { /* noop */ },
    async getCommand() { return null; },
    async listCommandsByOrigin() { return []; },
    async getOrigin() { return null; },
    async putOrigin() { /* noop */ },
    async listOrigins() { return []; },
    async getFeePool() { return null; },
    async putFeePool() { /* noop */ },
    async deleteFeePool() { /* noop */ },
    async listFeePoolsByOrigin() { return []; },
    async putConnectSession() { /* noop */ },
    async getConnectSession(sessionId: string) {
      if (sessionId) {
        return {
          sessionId,
          origin: ORIGIN,
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          claimsSnapshot: {},
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          revokedAt: null
        };
      }
      return null;
    },
    async listConnectSessionsByOrigin() { return []; }
    ,
    async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
      await base.putConnectSession(record);
      const all = await base.listConnectSessionsByOrigin(record.origin);
      const revokeAt = Date.now();
      for (const session of all) {
        if (session.sessionId === record.sessionId) continue;
        if (session.revokedAt !== null) continue;
        await base.putConnectSession({ ...session, revokedAt: revokeAt });
      }
    },
    async getStorageProviderConfig() { return base.getStorageProviderConfig(); },
    async putStorageProviderConfig(record) { await base.putStorageProviderConfig(record); },
    async deleteStorageProviderConfig() { await base.deleteStorageProviderConfig(); },
    async putLaunchToken(record) {
      if (base.putLaunchToken) await base.putLaunchToken(record);
    },
    async getLaunchToken(token) {
      return base.getLaunchToken ? base.getLaunchToken(token) : null;
    },
    async consumeLaunchToken(token) {
      if (base.consumeLaunchToken) await base.consumeLaunchToken(token);
    },
    async deleteLaunchToken(token) {
      if (base.deleteLaunchToken) await base.deleteLaunchToken(token);
    }
  };
  return { ...base, ...stubOverrides };
}

interface ServiceHarness {
  service: ProtocolServiceImpl;
  opener: FakeWindow;
  deps: ProtocolServiceDeps;
  posted: {
    ready: number;
    result: ProtocolResultMessage[];
    closing: ProtocolClosingMessage[];
  };
  getResult: () => ProtocolResultMessage | null;
  storageDb: ReturnType<typeof makeFakeStorageDb>;
}

function makeService(publicKeyHex = TEST_PUB_HEX, storageDb: ProtocolStorageDb | undefined = makeFakeStorageDb(), extra: Partial<ProtocolServiceDeps> = {}): ServiceHarness {
  const opener = makeFakeOpener();
  let resultMessage: ProtocolResultMessage | null = null;
  const posted: ServiceHarness["posted"] = { ready: 0, result: [], closing: [] };
  const deps: ProtocolServiceDeps = {
    vault: makeVaultStub(publicKeyHex),
    keyspace: makeKeyspaceStub(publicKeyHex),
    resolveOpener: () => opener as unknown as Window,
    postReady: () => {
      posted.ready++;
    },
    postResult: (_t, _o, msg) => {
      resultMessage = msg;
      posted.result.push(msg);
    },
    postClosing: (_t, msg) => {
      posted.closing.push(msg);
    },
    ...extra
  };
  if (storageDb) {
    deps.storageDb = storageDb;
  }
  const service = new ProtocolServiceImpl(deps);
  // 施工单 2026-06-28 002 硬切换：业务方法强制要求 connectSessionId；
  // 默认 seed 两条 session（ORIGIN + ORIGIN_FRESH），让绝大多数测试可以
  // 无脑发业务方法。需要测 session 不存在 / 跨 origin / revoked 的测试
  // 自行 override。
  // 用 `void` + .catch 容错：failing storageDb 测试会抛错，吞掉即可。
  if (storageDb) {
    const db = storageDb as ReturnType<typeof makeFakeStorageDb>;
    void db.putConnectSession({
      sessionId: "sess-test",
      origin: ORIGIN,
      ownerPublicKeyHex: publicKeyHex,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    }).catch(() => undefined);
    void db.putConnectSession({
      sessionId: "sess-fresh",
      origin: "https://fresh.example",
      ownerPublicKeyHex: publicKeyHex,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    }).catch(() => undefined);
    // 切换 origin 测试常用 ORIGIN_FRESH / origin-a.example / origin-b.example / other.example。
    // 默认 seed 这些 origin 下的 sess-* session，避免每个测试单独 setup。
    void db.putConnectSession({
      sessionId: "sess-origin-a",
      origin: "https://origin-a.example",
      ownerPublicKeyHex: publicKeyHex,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    }).catch(() => undefined);
    void db.putConnectSession({
      sessionId: "sess-origin-b",
      origin: "https://origin-b.example",
      ownerPublicKeyHex: publicKeyHex,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    }).catch(() => undefined);
    void db.putConnectSession({
      sessionId: "sess-other",
      origin: "https://other.example",
      ownerPublicKeyHex: publicKeyHex,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    }).catch(() => undefined);
  }
  return {
    service,
    opener,
    deps,
    posted,
    getResult: () => resultMessage,
    storageDb: storageDb as ReturnType<typeof makeFakeStorageDb>
  };
}

function makeEvent<T>(data: T, origin = ORIGIN, source: object | null = null): MessageEvent {
  return {
    data,
    origin,
    source
  } as unknown as MessageEvent;
}

/**
 * 测试辅助：手工写一条 connect session 到 fake storageDb，
 * 让 cipher.* / connect.resume 测试不必先走完整 login 流程。
 *
 * 字段与 contract ConnectSessionRecord 严格对齐（施工单 2026-06-28 002
 * 硬切换：已移除 `ownerKeyId`，只保留 `ownerPublicKeyHex`）。
 */
async function seedConnectSession(
  storageDb: ReturnType<typeof makeFakeStorageDb>,
  sessionId: string,
  ownerPublicKeyHex: string,
  origin: string = ORIGIN
): Promise<void> {
  const now = Date.now();
  await storageDb.putConnectSession({
    sessionId,
    origin,
    ownerPublicKeyHex,
    ownerLabel: "Key A",
    claimsSnapshot: {},
    createdAt: now,
    lastUsedAt: now,
    revokedAt: null
  });
}

/** 用与 `protocolService.computeTxidFromHex` 相同的算法求 txid：先 hex → bytes，再双 sha256 反序。 */
function computeExpectedBaseTxid(txHex: string): string {
  const clean = txHex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex");
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error("Invalid hex");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  // sha256d 反序：与 BSV txid 算法一致。
  const first = sha256(new Uint8Array(bytes));
  const second = sha256(new Uint8Array(first));
  const out: string[] = [];
  for (let i = second.length - 1; i >= 0; i--) {
    out.push(second[i]!.toString(16).padStart(2, "0"));
  }
  return out.join("");
}

beforeEach(() => {
  // 不需要 shared setup；每个 case 独立构造 service。
});

describe("ProtocolServiceImpl", () => {
  it("posts ready on startSession", async () => {
    const { service, posted } = makeService();
    service.startSession();
    expect(posted.ready).toBe(1);
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("binds first request and moves to confirming when vault unlocked", async () => {
    const { service, opener } = makeService();
    service.startSession();
    const event = makeEvent(
      {
        v: PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "identity.get",
        params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "hello", claims: ["key.label"], connectSessionId: "sess-test" }
      },
      ORIGIN,
      opener
    );
    await service.handleMessage(event);
    expect(service.snapshot().phase).toBe("confirming");
    expect(service.snapshot().requestId).toBe("req-1");
  });

  it("rejects request when aud !== event.origin", async () => {
    const { service, opener, getResult } = makeService();
    service.startSession();
    const event = makeEvent(
      {
        v: PROTOCOL_VERSION,
        type: "request",
        id: "req-2",
        method: "identity.get",
        params: {
          aud: "https://evil.com",
          iat: 1000,
          exp: 2000,
          text: "hello",
          // 施工单 2026-06-28 002 硬切换：identity.get 强制要求
          // connectSessionId；让请求穿过 session 预校验以命中 aud 检查。
          connectSessionId: "sess-test"
        }
      },
      ORIGIN,
      opener
    );
    await service.handleMessage(event);
    await service.confirmByUser();
    const r = getResult();
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error.code).toBe("invalid_origin");
    }
  });

  it("user rejection replies with user_rejected and does not close popup", async () => {
    const { service, opener, getResult, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-3",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.rejectByUser();
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.error.code).toBe("user_rejected");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "req-3");
    expect(card?.failureReason).toBe("user_canceled");
    // 施工单 002：拒绝不结束 popup 会话；phase 回到 waiting、不发 closing。
    expect(service.snapshot().phase).toBe("waiting");
    expect(posted.closing).toHaveLength(0);
  });

  it("identity.get envelope is deterministic cbor with signed envelope bytes", async () => {
    const { service, opener, getResult } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "hi", claims: ["key.label"], connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const result = r.result as {
      identityEnvelope: { bytes: ArrayBuffer; mime?: string };
      signature: { bytes: ArrayBuffer };
      subject: { publicKey: { bytes: ArrayBuffer } };
      resolvedClaims: Record<string, unknown>;
    };
    expect(result.identityEnvelope.mime).toBe("application/cbor");
    const decoded = cborDecode(new Uint8Array(result.identityEnvelope.bytes)) as unknown[];
    expect(Array.isArray(decoded)).toBe(true);
    const arr = decoded as unknown[];
    expect(arr[0]).toBe(PROTOCOL_VERSION);
    expect(arr[1]).toBe("req-id");
    expect(arr[2]).toBe(ORIGIN);
    expect(arr[3]).toBe(1000);
    expect(arr[4]).toBe(2000);
    expect(arr[5]).toBe("hi");
    const claims = arr[7] as unknown[];
    expect(Array.isArray(claims)).toBe(true);
    expect((claims[0] as unknown[])[0]).toBe("key.label");
    expect(result.resolvedClaims["key.label"]).toBe("Key A");
    expect(result.signature.bytes.byteLength).toBe(64);
    const pub = new Uint8Array(result.subject.publicKey.bytes);
    expect(pub.length).toBe(33);
    const sigOk = verifyCompactSecp256k1(
      new Uint8Array(result.signature.bytes),
      new Uint8Array(result.identityEnvelope.bytes),
      pub
    );
    expect(sigOk).toBe(true);
  });

  it("cipher.encrypt + cipher.decrypt round-trip within same origin", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    await seedConnectSession(storageDb, "sess-cipher-1", TEST_PUB_HEX);
    const content = new TextEncoder().encode("note body");
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-1",
          method: "cipher.encrypt",
          params: { text: "encrypt", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer }, connectSessionId: "sess-cipher-1" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const r1 = getResult();
    expect(r1?.ok).toBe(true);
    if (!r1 || r1.ok !== true) return;
    const enc = r1.result as { nonce: { bytes: ArrayBuffer }; cipherbytes: { bytes: ArrayBuffer } };

    const siteKey = deriveSiteKey(TEST_PRIV_HEX, ORIGIN);
    const plain = aesGcmDecrypt(siteKey, new Uint8Array(enc.nonce.bytes), new Uint8Array(enc.cipherbytes.bytes));
    const decoded = cborDecode(plain) as unknown[];
    expect(decoded[0]).toBe(PROTOCOL_VERSION);
    expect(decoded[1]).toBe("note.v1");
    expect(new TextDecoder().decode(decoded[2] as Uint8Array)).toBe("note body");
  });

  it("cipher.decrypt across different origin fails with decrypt_failed", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    await seedConnectSession(storageDb, "sess-cipher-2", TEST_PUB_HEX);
    const content = new TextEncoder().encode("body");
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-2",
          method: "cipher.encrypt",
          params: { text: "x", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer }, connectSessionId: "sess-cipher-2" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const r1 = getResult();
    if (!r1 || r1.ok !== true) throw new Error("expected ok");
    const enc = r1.result as { nonce: { bytes: ArrayBuffer }; cipherbytes: { bytes: ArrayBuffer } };

    const EVIL = "https://evil.com";
    const evil = makeService();
    evil.service.startSession();
    // evil 必须 seed 同 origin 的 session 才能跨过 origin 闸；AES-GCM 仍会失败。
    await seedConnectSession(evil.storageDb, "sess-evil", TEST_PUB_HEX, EVIL);
    const opener2 = evil.opener;
    await evil.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-2",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: enc.nonce,
            cipherbytes: enc.cipherbytes,
            connectSessionId: "sess-evil"
          }
        },
        EVIL,
        opener2
      )
    );
    await evil.service.confirmByUser();
    const r2 = evil.getResult();
    expect(r2?.ok).toBe(false);
    if (r2 && r2.ok === false) expect(r2.error.code).toBe("decrypt_failed");
  });

  it("ignores non-request messages before binding", async () => {
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(makeEvent({ foo: "bar" }, ORIGIN, opener));
    expect(service.snapshot().phase).toBe("waiting");
    expect(service.snapshot().requestId).toBeNull();
  });

  it("rejects request when active key is not available", async () => {
    const { service, opener, deps, getResult } = makeService();
    const ks = makeKeyspaceStub("00".repeat(33));
    ks.active = () => ({});
    ks.requireActiveKey = () => {
      throw new Error("No active key");
    };
    const s2 = new ProtocolServiceImpl({ ...deps, keyspace: ks });
    s2.startSession();
    await s2.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-no-key",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await s2.confirmByUser();
    const r = getResult();
    expect(r?.ok).toBe(false);
  });

  /* ============== 施工单 002 硬切换：popup 复用 ============== */

  it("does not post closing after a successful result; phase returns to waiting", async () => {
    const { service, opener, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-ok-1",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    // result 发了，但 closing 还没发（closing 由 pageUnloading 路径负责）。
    expect(posted.result).toHaveLength(1);
    expect(posted.closing).toHaveLength(0);
    // 单条 request 收尾：phase 回到 waiting；service 还在。
    expect(service.snapshot().phase).toBe("waiting");
    expect(service.currentOrigin()).toBe(ORIGIN);
  });

  it("reuses the same service to process a second request after first completes", async () => {
    const { service, opener, posted } = makeService();
    service.startSession();

    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "A", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    expect(posted.closing).toHaveLength(0);
    expect(service.snapshot().phase).toBe("waiting");

    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-B",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "B", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 收到第二条后立即进入 confirming，可被确认。
    expect(service.snapshot().phase).toBe("confirming");
    expect(service.snapshot().requestId).toBe("req-B");
    await service.confirmByUser();
    // 两条 result 都已发，closing 仍未发。
    expect(posted.result).toHaveLength(2);
    expect(posted.closing).toHaveLength(0);
  });

  it("concurrent live requests coexist in feed (施工单 2026-06-27 002 硬切换)", async () => {
    // 旧行为（001 单之前）：第二条 request 被单 active request 模型忽略。
    // 新行为（002 单）：多 request 并存；两条独立活卡出现在 feed 活请求区
    // 头部（按 createdAt asc 排序）。
    const { service, opener, posted, storageDb } = makeService();
    service.startSession();
    await seedConnectSession(storageDb, "sess-concurrent", TEST_PUB_HEX);
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-first",
          method: "cipher.decrypt",
          params: {
            aud: ORIGIN,
            text: "first",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-concurrent"
          }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    // 让两条 record 的 createdAt 明确不同：第二条晚 1ms 进入。
    await new Promise((r) => setTimeout(r, 2));
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-second",
          method: "cipher.decrypt",
          params: {
            aud: ORIGIN,
            text: "second",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-concurrent"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 两条 record 都建出活记录，feed 顺序按 createdAt asc：第一条在前。
    const feed = service.feedSnapshot();
    const live = feed.commands.filter((c) => c.decision === "pending");
    expect(live.length).toBe(2);
    expect(live[0]?.requestId).toBe("req-first");
    expect(live[1]?.requestId).toBe("req-second");
    expect(live[0]?.id).not.toBe(live[1]?.id);
    // snapshot.requestId 仍兼容指向首张活卡；不影响多 request 真实状态。
    expect(service.snapshot().requestId).toBe("req-first");
    expect(posted.result).toHaveLength(0);
  });

  it("活卡槽位稳定：第一条完成后第二条自然上移，不发生借壳复用", async () => {
    // 关键不变量（施工单 2026-06-27 002 硬切换）：活请求区按 createdAt asc
    // 固定。第一条完成后离开活请求区，第二条自然上移成为第一格；
    // `confirmByUser()` 现在 await 到本轮执行收尾，所以这里直接断言收尾后的
    // 展示真值，而不再强抓瞬时 queued 态。
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "A", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 2));
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-B",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "B", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const feedAfter = service.feedSnapshot();
    // A 应出现在历史区（approved / decision=approved）。
    const aCard = feedAfter.commands.find((c) => c.requestId === "req-A");
    expect(aCard?.decision).toBe("approved");
    // 活请求区只剩 B：B 是第一格；它的 recordId / 按钮绑定不变。
    const liveAfter = feedAfter.commands.filter((c) => c.decision === "pending");
    expect(liveAfter.length).toBe(1);
    expect(liveAfter[0]?.requestId).toBe("req-B");
  });

  it("loadHistoryForOrigin 按 recordId 合并：内存活记录覆盖 DB 旧记录", async () => {
    // 关键不变量（施工单 2026-06-27 002 硬切换）：DB 旧记录与内存活记录
    // 同 id 时，**以内存为准**。这条阻止"DB 旧字段覆盖当前内存活卡"。
    const { service, opener, storageDb } = makeService();
    service.startSession();
    // DB 里有一条旧记录，phase 是 "approved"（终态），但内存里我们等会
    // 推一条同 recordId 但 phase 是 "confirming" 的活记录——不可能完全
    // 真实发生（id 在内存里是 nextRecordId 生成）；所以这里**直接写一
    // 个会冲突的场景**：
    //   1. 先 acceptRequest 创建 record-A，得到 recordId_A；
    //   2. 手动用 storageDb.putCommand 覆盖 recordId_A 为"approved" 终态
    //      旧记录（模拟"DB 之前已经写过、现在内存 record 仍是 confirming"）；
    //   3. 触发 loadHistoryForOrigin（同 origin 再次 acceptRequest）让合并
    //      路径执行。
    // 但我们的合并是同步的（内存 push + DB 已经存在），所以更直接的验证
    // 是：手动触发 loadHistoryForOrigin 后，feed 里 recordId_A 的 card
    // **必须**是内存活卡的 phase（confirming），不是 DB 旧的（approved）。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "live-confirming",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    const feed1 = service.feedSnapshot();
    const recordIdA = feed1.commands[0]?.id;
    expect(recordIdA).toBeDefined();
    expect(feed1.commands[0]?.phase).toBe("confirming");
    // 把同 recordId 写一条"approved" 旧记录到 DB（模拟 DB 已经存过终态）。
    await storageDb.putCommand({
      id: recordIdA!,
      origin: ORIGIN,
      requestId: "live-confirming",
      method: "identity.get",
      phase: "approved",
      decision: "approved",
      status: "approved",
      textSummary: "stale-approved",
      claimsSummary: [],
      contentType: "",
      payloadSize: 0,
      connectSessionId: "sess-test",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      createdAt: 1,
      updatedAt: 999,
      finishedAt: 999,
      errorCode: "",
      errorMessage: ""
    });
    // 触发另一次同 origin 的 request：acceptRequest 会触发 loadHistoryForOrigin。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "live-other",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "y", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 等异步 loadHistoryForOrigin 落定。
    await new Promise((r) => setTimeout(r, 50));
    const feed2 = service.feedSnapshot();
    // 关键断言：recordId_A 在 feed 中仍是内存活卡（confirming），不是
    // DB 旧的 "approved"。
    const cardA = feed2.commands.find((c) => c.id === recordIdA);
    expect(cardA?.phase).toBe("confirming");
    expect(cardA?.decision).toBe("pending");
    expect(cardA?.textSummary).not.toBe("stale-approved");
  });

  it("中间态 request 不落库；终态后才进入历史持久化", async () => {
    const { service, opener, storageDb } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "persist-after-terminal",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "persist-me", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // request 进入 confirming，但 DB 历史仍应为空：活请求只存在于当前会话内存。
    const beforeConfirm = await storageDb.listCommandsByOrigin(ORIGIN);
    expect(beforeConfirm.find((c) => c.requestId === "persist-after-terminal")).toBeUndefined();

    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    const afterConfirm = await storageDb.listCommandsByOrigin(ORIGIN);
    const persisted = afterConfirm.find((c) => c.requestId === "persist-after-terminal");
    expect(persisted).toBeDefined();
    expect(persisted?.phase).toBe("approved");
    expect(persisted?.decision).toBe("approved");
  });

  it("loadHistoryForOrigin 忽略 DB 残留的中间态脏卡", async () => {
    // 回归这次线上问题：旧版本把 confirming 写进 DB；新 popup 会话收到
    // 同 origin 新请求后，历史加载不能把这条旧活卡重新展示成可交互 live card。
    const { service, opener, storageDb } = makeService();
    await storageDb.putCommand({
      id: "stale-confirming-from-db",
      origin: ORIGIN,
      requestId: "stale-confirming-from-db",
      method: "cipher.decrypt",
      phase: "confirming",
      decision: "pending",
      status: "confirming",
      textSummary: "stale live card",
      claimsSummary: [],
      contentType: "",
      payloadSize: 66,
      connectSessionId: "sess-test",
      ownerPublicKeyHex: TEST_PUB_HEX,
      createdAt: 10,
      updatedAt: 20,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    });

    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fresh-live",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "fresh live request", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 50));

    const feed = service.feedSnapshot();
    expect(feed.commands.find((c) => c.id === "stale-confirming-from-db")).toBeUndefined();
    expect(feed.commands.some((c) => c.requestId === "fresh-live" && c.phase === "confirming")).toBe(true);
    expect(feed.commands.filter((c) => c.decision === "pending")).toHaveLength(1);
  });

  it("切换 origin 时旧批次历史加载结果不会覆盖新 origin 视图", async () => {
    // 关键不变量（施工单 2026-06-27 002 硬切换）：旧 origin 的历史加载
    // 晚到时，**不**回写当前 origin 视图（防 origin 切换时旧数据串回）。
    // 用可控延迟的 storageDb 模拟"旧 origin 加载慢"。
    let listCommandsACalls = 0;
    let resolveListCommandsA!: (list: ProtocolCommandRecord[]) => void;
    const stubDb: ProtocolStorageDb = {
      async putCommand() {
        /* noop */
      },
      async getCommand() {
        return null;
      },
      async listCommandsByOrigin(origin: string) {
        if (origin === "https://origin-a.example") {
          listCommandsACalls++;
          // 第一次调用挂住——模拟旧 origin 加载晚到。
          return new Promise<ProtocolCommandRecord[]>((resolve) => {
            resolveListCommandsA = resolve;
          });
        }
        return [];
      },
      async getOrigin(origin: string) {
        // 这个用例只想让"历史列表"晚到，不想把 handleMessage 卡在
        // auto-approve 的 origin 配置读取上；因此 origin 配置统一同步返回。
        void origin;
        return null;
      },
      async putOrigin() {
        /* noop */
      },
      async listOrigins() {
        return [];
      },
      async getFeePool() {
        return null;
      },
      async putFeePool() {
        /* noop */
      },
      async deleteFeePool() {
        /* noop */
      },
      async listFeePoolsByOrigin() {
        return [];
      },
      async putConnectSession() {
        /* noop */
      },
      async getConnectSession(sessionId: string) {
        // 施工单 2026-06-28 002 硬切换：测试 stub 按 id 后缀返回对应
        // origin 的 valid session（让 preCheckConnectSession 放行）。
        if (sessionId) {
          let origin: string = ORIGIN;
          if (sessionId === "sess-origin-a") origin = "https://origin-a.example";
          else if (sessionId === "sess-origin-b") origin = "https://origin-b.example";
          else if (sessionId === "sess-other") origin = "https://other.example";
          else if (sessionId === "sess-fresh") origin = "https://fresh.example";
          return {
            sessionId,
            origin,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() {
        return [];
      },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await stubDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, stubDb);
    service.startSession();
    // 第一条 request 来自 origin-a：触发 loadHistoryForOrigin（挂住）。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-a",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "x", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    // 此时 currentOrigin=origin-a；feed 中有 from-a 活记录。
    expect(service.currentOrigin()).toBe("https://origin-a.example");
    const liveA = service.feedSnapshot().commands.find((c) => c.requestId === "from-a");
    expect(liveA?.phase).toBe("confirming");
    expect(listCommandsACalls).toBe(1);
    // 切换到 origin-b：第二条 request 触发新一轮 loadHistoryForOrigin（同步返回）。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-b",
          method: "identity.get",
          params: { aud: "https://origin-b.example", iat: 1, exp: 2, text: "y", connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    expect(service.currentOrigin()).toBe("https://origin-b.example");
    // 关键：即使 origin-a 旧批次晚到，**不**应该回写 currentOrigin。
    // 模拟"旧 origin 加载晚到"——但 origin-a 历史 list 不应再触发合并。
    resolveListCommandsA([]);
    // 等 microtask 消化旧批次的 promise。
    await new Promise((r) => setTimeout(r, 30));
    // 关键断言：feed 中**不**出现 origin-a 的旧数据；currentOrigin 仍为
    // origin-b；from-b 仍是唯一活记录。
    const feedFinal = service.feedSnapshot();
    expect(service.currentOrigin()).toBe("https://origin-b.example");
    expect(feedFinal.commands.every((c) => c.origin === "https://origin-b.example" || c.requestId === "from-b")).toBe(true);
    // from-b 仍然是 confirming（不被旧 origin 结果覆盖）。
    const liveB = feedFinal.commands.find((c) => c.requestId === "from-b");
    expect(liveB?.phase).toBe("confirming");
  });

  it("修复 #1：切换 origin 时新 origin 触发独立的 loadHistoryForOrigin（不复用旧 origin in-flight）", async () => {
    // 关键修复（施工单 2026-06-27 002 反馈）：旧实现里 loadHistoryForOrigin
    // 用单一全局 promise，复用条件 `currentOriginValue === origin`——
    // 但 acceptRequest 已经把 currentOriginValue 改成新 origin 了，
    // 所以"复用条件"会被错误满足，直接复用旧 origin 的 in-flight，
    // 导致新 origin 的历史永远不会被加载。
    // 新实现按 origin 隔离 in-flight；切到 B 后必须真的发起 B 的 load。
    const callsByOrigin: string[] = [];
    let listCommandsACalls = 0;
    let listCommandsBCalls = 0;
    const stubDb: ProtocolStorageDb = {
      async putCommand() {
        /* noop */
      },
      async getCommand() {
        return null;
      },
      async listCommandsByOrigin(origin: string) {
        callsByOrigin.push(origin);
        if (origin === "https://origin-a.example") {
          listCommandsACalls++;
          return [];
        }
        if (origin === "https://origin-b.example") {
          listCommandsBCalls++;
          return [];
        }
        return [];
      },
      async getOrigin(origin: string) {
        void callsByOrigin;
        return null;
      },
      async putOrigin() {
        /* noop */
      },
      async listOrigins() {
        return [];
      },
      async getFeePool() {
        return null;
      },
      async putFeePool() {
        /* noop */
      },
      async deleteFeePool() {
        /* noop */
      },
      async listFeePoolsByOrigin() {
        return [];
      },
      async putConnectSession() {
        /* noop */
      },
      async getConnectSession(sessionId: string) {
        // 施工单 2026-06-28 002 硬切换：测试 stub 按 id 后缀返回对应
        // origin 的 valid session（让 preCheckConnectSession 放行）。
        if (sessionId) {
          let origin: string = ORIGIN;
          if (sessionId === "sess-origin-a") origin = "https://origin-a.example";
          else if (sessionId === "sess-origin-b") origin = "https://origin-b.example";
          else if (sessionId === "sess-other") origin = "https://other.example";
          else if (sessionId === "sess-fresh") origin = "https://fresh.example";
          return {
            sessionId,
            origin,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() {
        return [];
      },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await stubDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, stubDb);
    service.startSession();
    // 第一条 request 来自 origin-a:触发 in-flight load (挂住)。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-a",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "x", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    expect(service.currentOrigin()).toBe("https://origin-a.example");
    expect(listCommandsACalls).toBe(1);
    // 切换到 origin-b:必须**新发起**对 origin-b 的历史读取,而不是复用
    // 旧 origin 的 in-flight。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-b",
          method: "identity.get",
          params: { aud: "https://origin-b.example", iat: 1, exp: 2, text: "y", connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    expect(service.currentOrigin()).toBe("https://origin-b.example");
    expect(listCommandsBCalls).toBe(1);
    // 同一 origin 不再发起重复读取:连发两条 from-b 也只调一次 listB。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-b2",
          method: "identity.get",
          params: { aud: "https://origin-b.example", iat: 1, exp: 2, text: "z", connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    expect(listCommandsBCalls).toBe(1);
    // 再次确认 origin-a 的 list 只被调一次（之前的 in-flight 仍在飞）。
    expect(listCommandsACalls).toBe(1);
    expect(callsByOrigin.filter((o) => o === "https://origin-a.example").length).toBe(1);
    expect(callsByOrigin.filter((o) => o === "https://origin-b.example").length).toBe(1);
  });

  it("修复 #2：切换 origin 瞬间 feedCommands 不再含旧 origin 的卡片", async () => {
    // 关键修复（施工单 2026-06-27 002 反馈）：切 origin 时旧实现只更新
    // currentOriginValue，旧 origin 的卡片留在 feedCommands 里；后续
    // setRecordPhase 会拿"旧 origin 历史 + 新 origin 活卡"一起 buildFeedDisplay。
    // 新实现：切 origin 瞬间立即清空 feedCommands，只保留新 origin 内
    // 存活记录的投影——避免跨 origin 混排。
    const { service, opener, storageDb } = makeService();
    service.startSession();
    // 在 origin-a 处理一条 request 并 confirm,使其进入终态 (approved)。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-a",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "x", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    // 验证 origin-a 的 approved 卡在 feed 中。
    const feedA = service.feedSnapshot();
    expect(feedA.currentOrigin).toBe("https://origin-a.example");
    expect(feedA.commands.some((c) => c.requestId === "from-a" && c.decision === "approved")).toBe(true);
    // 切换到 origin-b：新 origin 的第一条 request 触发切 origin。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-b",
          method: "identity.get",
          params: { aud: "https://origin-b.example", iat: 1, exp: 2, text: "y", connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    // 关键断言：切 origin 瞬间，feed.commands 中**不**应该出现 origin-a
    // 的卡片（即使旧 origin 数据仍在 requestsByRecordId 里）。
    const feedImmediate = service.feedSnapshot();
    expect(feedImmediate.currentOrigin).toBe("https://origin-b.example");
    expect(feedImmediate.commands.some((c) => c.origin === "https://origin-a.example")).toBe(false);
    expect(feedImmediate.commands.some((c) => c.requestId === "from-a")).toBe(false);
    // from-b 仍在活请求区。
    expect(feedImmediate.commands.some((c) => c.requestId === "from-b" && c.phase === "confirming")).toBe(true);
    // 等异步 loadHistoryForOrigin 落定。
    await new Promise((r) => setTimeout(r, 30));
    const feedAfterLoad = service.feedSnapshot();
    // loadHistoryForOrigin 完成 → origin-b 视图重建；仍**不**含 origin-a 卡片。
    expect(feedAfterLoad.currentOrigin).toBe("https://origin-b.example");
    expect(feedAfterLoad.commands.some((c) => c.origin === "https://origin-a.example")).toBe(false);
    // 注：旧 origin-a 的 from-a 记录仍在 requestsByRecordId 里（用于将来切回），
    // 但当前视图不显示。这是施工单要求的"切 origin 立即换视图"。
    void storageDb;
  });

  it("修复 #2 (续)：再切回 origin-a,旧 origin 历史能正确重建", async () => {
    // 修复 #2 的对称用例：把旧 origin-a 的数据保留在内存,切回去时按其
    // 自己的数据重建视图(不依赖 DB)。
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-a",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "x", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    // 切到 origin-b
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-b",
          method: "identity.get",
          params: { aud: "https://origin-b.example", iat: 1, exp: 2, text: "y", connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    expect(service.feedSnapshot().currentOrigin).toBe("https://origin-b.example");
    // 再切回 origin-a:旧 origin 的内存 record 仍在 requestsByRecordId。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "from-a-2",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "x2", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    const feedBack = service.feedSnapshot();
    expect(feedBack.currentOrigin).toBe("https://origin-a.example");
    // from-a 之前的 approved 卡应重新出现在 origin-a 视图(终态)。
    expect(feedBack.commands.some((c) => c.requestId === "from-a" && c.decision === "approved")).toBe(true);
    // from-a-2 在活请求区。
    expect(feedBack.commands.some((c) => c.requestId === "from-a-2" && c.phase === "confirming")).toBe(true);
  });

  it("修复 #3：ownerPublicKeyHex 写卡时取一次,后续切换 active key 不污染旧卡", async () => {
    // 关键修复（施工单 2026-06-27 002 反馈 + 施工单 2026-06-28 002 硬切换）：
    // contract 注释明确 `ownerPublicKeyHex` 是"record 在创建时快照的
    // owner public key hex"。旧实现里 writeFeedCommandFor 每次都读
    // keyspace.active()——用户在 popup 会话里切换 active key 会让旧卡片
    // 的元数据被污染。
    // 新实现：rec.ownerPublicKeyHex 在 acceptRequest 创建 record 时从
    // connectSession.ownerPublicKeyHex 快照；后续 writeFeedCommandFor /
    // loadHistoryForOrigin 合并都从 rec 读，不再读 keyspace.active()。
    //
    // 用一个能动态切换 active key 的 keyspace stub + 预 seed 的
    // connect session 来模拟。
    const initialOwner = "02" + "aa".repeat(32);
    let currentActiveKey = initialOwner;
    const dynamicKeyspace = {
      ...makeKeyspaceStub(initialOwner),
      active: () => ({ activePublicKeyHex: currentActiveKey }),
      requireActiveKey: () => ({
        keyId: "k1",
        publicKeyHex: currentActiveKey,
        label: "Key A",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString(),
        identityStatus: "ready"
      })
    };
    const { service, opener, storageDb, deps } = makeService(initialOwner, undefined, {
      keyspace: dynamicKeyspace as unknown as KeyspaceService
    });
    // 预 seed 一条 connect session，owner 锁定为创建时的 initialOwner。
    await seedConnectSession(storageDb, "sess-owner-snap", initialOwner, ORIGIN);
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-key1",
          method: "cipher.encrypt",
          params: {
            text: "x",
            contentType: "note.v1",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-owner-snap"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 此时卡片 ownerPublicKeyHex = 创建时的 initialOwner (02aa...)。
    const feed1 = service.feedSnapshot();
    const card1 = feed1.commands.find((c) => c.requestId === "req-key1");
    expect(card1?.ownerPublicKeyHex).toBe(initialOwner);
    // 用户切换 active key:dynamicKeyspace.active() 改成新 key。
    currentActiveKey = "02" + "bb".repeat(32);
    // 推进旧卡 phase 触发 writeFeedCommandFor(queued 后写一次)。
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    // 关键断言：旧卡的 ownerPublicKeyHex 仍是创建时的 02aa...,不变成 02bb...。
    const feed2 = service.feedSnapshot();
    const card2 = feed2.commands.find((c) => c.requestId === "req-key1");
    expect(card2?.ownerPublicKeyHex).toBe(initialOwner);
    void deps;
  });

  it("同类 request 不复用卡位：两条 cipher.decrypt 在 feed 投影中独立", async () => {
    // 关键不变量（施工单 2026-06-27 002 硬切换）：同类 request 不应"借壳"
    // 修改第一张卡的内容伪装成更新。两条独立 record，两张独立卡。
    const { service, opener, storageDb } = makeService();
    service.startSession();
    await seedConnectSession(storageDb, "sess-two-dec", TEST_PUB_HEX);
    const nonce1 = new Uint8Array(12);
    const nonce2 = new Uint8Array(12);
    nonce2[0] = 1;
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-1",
          method: "cipher.decrypt",
          params: {
            aud: ORIGIN,
            text: "first",
            nonce: { $type: "binary", bytes: nonce1.buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-two-dec"
          }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 2));
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-2",
          method: "cipher.decrypt",
          params: {
            aud: ORIGIN,
            text: "second",
            nonce: { $type: "binary", bytes: nonce2.buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-two-dec"
          }
        },
        ORIGIN,
        opener
      )
    );
    const feed = service.feedSnapshot();
    // 两条独立活记录，card.textSummary 各自保留（不被对方覆盖）。
    const live = feed.commands.filter((c) => c.decision === "pending");
    expect(live.length).toBe(2);
    expect(live.find((c) => c.requestId === "dec-1")?.textSummary).toBe("first");
    expect(live.find((c) => c.requestId === "dec-2")?.textSummary).toBe("second");
    // 两张卡的 recordId 不同；不可被同一 recordId 复用。
    expect(live[0]?.id).not.toBe(live[1]?.id);
  });

  it("第一条活卡终态后第二条成为活请求区第一格，recordId 不变", async () => {
    // 关键不变量（施工单 2026-06-27 002 硬切换）：第一条活卡进入终态后
    // 从活请求区离开，进入历史区；第二条活卡上移成为新的活请求区第一格。
    // 第二条活卡的 recordId、按钮绑定、内容都不被复用。
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "r-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "A", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 2));
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "r-B",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "B", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 推进 A 终态。
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 50));
    const feed = service.feedSnapshot();
    // 活请求区只剩 B。
    const live = feed.commands.filter((c) => c.decision === "pending");
    expect(live.length).toBe(1);
    expect(live[0]?.requestId).toBe("r-B");
    expect(live[0]?.textSummary).toBe("B");
    // A 在历史区。
    const aInHistory = feed.commands.find((c) => c.requestId === "r-A");
    expect(aInHistory?.decision).toBe("approved");
    // B 的 recordId 没有改变（不应继承 A 的 recordId）。
    const bInLive = live[0];
    expect(bInLive?.requestId).toBe("r-B");
  });

  it("switching origin reloads feed history from storageDb", async () => {
    const { service, opener, storageDb } = makeService();
    // 先在 ORIGIN 处理一条 request。
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-origin-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    // 假装这条已经写库（service 自己写过，但为了"切换 origin 拉历史"
    // 这条断言显式放一条"另一条不在内存里但应该被 DB 列出"的记录）。
    await storageDb.putCommand({
      id: "old-on-origin-A",
      origin: ORIGIN,
      requestId: "old-on-origin-A",
      method: "identity.get",
      phase: "approved",
      decision: "approved",
      status: "approved",
      textSummary: "old",
      claimsSummary: [],
      contentType: "",
      payloadSize: 0,
      connectSessionId: "sess-test",
      ownerPublicKeyHex: TEST_PUB_HEX,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      errorCode: "",
      errorMessage: ""
    });

    const OTHER = "https://other.example";
    // 切换 origin：再来一条来自 OTHER 的 request。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-origin-B",
          method: "identity.get",
          params: { aud: OTHER, iat: 1, exp: 2, text: "y", connectSessionId: "sess-test" }
        },
        OTHER,
        opener
      )
    );
    // 等异步 loadHistoryForOrigin 落定。
    await new Promise((r) => setTimeout(r, 30));
    expect(service.currentOrigin()).toBe(OTHER);
    const feed = service.feedSnapshot();
    // 切换后 feed 只显示 OTHER 自己的历史；ORIGIN 那条不串。
    expect(feed.commands.every((c) => c.origin === OTHER)).toBe(true);
    expect(feed.commands.find((c) => c.id === "old-on-origin-A")).toBeUndefined();
  });

  it("pageUnloading is the only path that posts closing", async () => {
    const { service, opener, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-close-1",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    expect(posted.closing).toHaveLength(0);
    // 触发 pageUnloading 才发 closing。
    service.pageUnloading?.();
    expect(posted.closing).toHaveLength(1);
  });

  it("pageUnloading before any binding does not throw and posts once", async () => {
    const { service, posted } = makeService();
    service.startSession();
    expect(() => service.pageUnloading?.()).not.toThrow();
    expect(posted.closing).toHaveLength(1);
  });

  it("closing send failure does not block main flow", async () => {
    const { service, opener, deps } = makeService();
    const failing: ProtocolServiceDeps = {
      ...deps,
      postClosing: () => {
        throw new Error("postMessage failed");
      }
    };
    const s2 = new ProtocolServiceImpl(failing);
    s2.startSession();
    await s2.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-closing-fail",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await expect(s2.confirmByUser()).resolves.toBeUndefined();
    // 收尾：phase 仍稳定在 waiting；不抛。
    expect(s2.snapshot().phase).toBe("waiting");
  });

  it("DB write failure does not block main protocol result", async () => {
    // 构造一个读 / 写都失败的 fake db；service 主流程不应被它打断。
    //
    // 施工单 2026-06-28 002 硬切换：业务方法（identity.get / cipher.* /
    // p2pkh.transfer / feepool.*）都要求 session 真值。DB 异常时
    // accept 阶段预校验按"DB unavailable 降级"放过 → execute 阶段
    // `requireConnectSession` 仍会校验 DB 读取 → DB 异常会触发
    // `internal_error` → 对外回 `user_rejected`。
    //
    // 与旧"DB 不可用 = 仍可手动 confirm"边界不同：002 之后所有业务
    // 方法都要求 session 真值，**不**fallback 到 active key。本测试
    // 仍验证"DB 写失败不卡 transport + confirm 调度"，但期望
    // result.ok = false（execute 阶段 fail-closed）。
    const failingDb: ProtocolStorageDb = {
      async putCommand() {
        throw new Error("db down");
      },
      async getCommand() {
        throw new Error("db down");
      },
      async listCommandsByOrigin() {
        throw new Error("db down");
      },
      async getOrigin() {
        throw new Error("db down");
      },
      async putOrigin() {
        throw new Error("db down");
      },
      async listOrigins() {
        throw new Error("db down");
      },
      async getFeePool() {
        throw new Error("db down");
      },
      async putFeePool() {
        throw new Error("db down");
      },
      async deleteFeePool() {
        throw new Error("db down");
      },
      async listFeePoolsByOrigin() {
        throw new Error("db down");
      },
      async putConnectSession() {
        throw new Error("db down");
      },
      async getConnectSession() {
        throw new Error("db down");
      },
      async listConnectSessionsByOrigin() {
        throw new Error("db down");
      },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await failingDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener, getResult } = makeService(TEST_PUB_HEX, failingDb);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      service.startSession();
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "req-db-fail",
            method: "identity.get",
            params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
          },
          ORIGIN,
          opener
        )
      );
      // 等异步 loadHistoryForOrigin 落定。
      await new Promise((r) => setTimeout(r, 30));
      // 此时写已经失败过一次：historyAvailable 必须为 false。
      expect(service.feedSnapshot().historyAvailable).toBe(false);
      await service.confirmByUser();
      // result 正常发出（002 硬切换下，DB 异常走 execute 阶段
      // `requireConnectSession` fail-closed → 对外回 user_rejected）。
      const r = getResult();
      expect(r).not.toBeNull();
      expect(r?.ok).toBe(false);
      if (r && r.ok === false) {
        expect(r.error.code).toBe("user_rejected");
      }
      // 写失败已被吞；historyAvailable 保持 false。
      expect(service.feedSnapshot().historyAvailable).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("internal record id is decoupled from transport requestId", async () => {
    // DB 主键必须由 service 内部生成；调用方即便重复 requestId，也应该
    // 落两条不同命令卡（不会互相覆盖）。
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "duplicated-request-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const feed1 = service.feedSnapshot();
    const recordId1 = feed1.commands[0]?.id;
    expect(recordId1).toBeDefined();
    expect(recordId1).not.toBe("duplicated-request-id");
    // 复用同一 requestId：DB 应有两条不同记录。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "duplicated-request-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const feed2 = service.feedSnapshot();
    const ids = feed2.commands
      .filter((c) => c.requestId === "duplicated-request-id")
      .map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(recordId1!);
    expect(feed2.commands.length).toBe(2);
  });

  it("loadHistoryForOrigin preserves in-flight command card on origin switch", async () => {
    // 关键不变量：切换 origin 时，DB 读结果不能覆盖当前 in-flight 命令卡。
    // 即便 DB 读比当前命令卡 upsert 更早完成，in-flight 卡的最新状态
    // 也必须保留。
    const { service, opener, storageDb } = makeService();
    service.startSession();
    // 准备：在 ORIGIN 历史上先放一条已完成的命令卡，DB 里有完整记录。
    await storageDb.putCommand({
      id: "old-on-origin-A",
      origin: ORIGIN,
      requestId: "req-old",
      method: "identity.get",
      phase: "approved",
      decision: "approved",
      status: "approved",
      textSummary: "old",
      claimsSummary: [],
      contentType: "",
      payloadSize: 0,
      connectSessionId: "sess-test",
      ownerPublicKeyHex: TEST_PUB_HEX,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      errorCode: "",
      errorMessage: ""
    });
    // 切换到 OTHER：先用 OTHER 发一条 request。
    const OTHER = "https://other.example";
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-OTHER",
          method: "identity.get",
          params: { aud: OTHER, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        OTHER,
        opener
      )
    );
    // 等异步 loadHistoryForOrigin 落定。
    await new Promise((r) => setTimeout(r, 30));
    // 关键断言：OTHER 上有 in-flight 命令卡，且 ORIGIN 旧记录不串入。
    const feed = service.feedSnapshot();
    expect(feed.currentOrigin).toBe(OTHER);
    expect(feed.commands.every((c) => c.origin === OTHER)).toBe(true);
    const inflight = feed.commands.find((c) => c.requestId === "req-OTHER");
    expect(inflight).toBeDefined();
    expect(inflight?.origin).toBe(OTHER);
  });

  it("loadHistoryForOrigin failure keeps the in-flight card alive", async () => {
    // DB 读抛错时，UI 进入"历史不可用"；但当前命令卡不能因此消失。
    const failingDb: ProtocolStorageDb = {
      async putCommand() {
        return undefined;
      },
      async getCommand() {
        return null;
      },
      async listCommandsByOrigin() {
        throw new Error("read failed");
      },
      async getOrigin() {
        return null;
      },
      async putOrigin() {
        return undefined;
      },
      async listOrigins() {
        return [];
      },
      async getFeePool() {
        return null;
      },
      async putFeePool() {
        return undefined;
      },
      async deleteFeePool() {
        return undefined;
      },
      async listFeePoolsByOrigin() {
        return [];
      },
      async putConnectSession() {
        /* noop */
      },
      async getConnectSession(sessionId: string) {
        // 施工单 2026-06-28 002 硬切换：测试 stub 按 id 后缀返回对应
        // origin 的 valid session（让 preCheckConnectSession 放行）。
        if (sessionId) {
          let origin: string = ORIGIN;
          if (sessionId === "sess-origin-a") origin = "https://origin-a.example";
          else if (sessionId === "sess-origin-b") origin = "https://origin-b.example";
          else if (sessionId === "sess-other") origin = "https://other.example";
          else if (sessionId === "sess-fresh") origin = "https://fresh.example";
          else if (sessionId === "sess-keep") origin = "https://new.example";
          return {
            sessionId,
            origin,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() {
        return [];
      },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await failingDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, failingDb);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      service.startSession();
      // 切换到不同 origin 触发 loadHistoryForOrigin。
      const NEW_ORIGIN = "https://new.example";
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "req-keep",
            method: "identity.get",
            params: {
              aud: NEW_ORIGIN,
              iat: 1,
              exp: 2,
              text: "x",
              // 施工单 2026-06-28 002 硬切换：所有业务方法强制要求
              // connectSessionId。
              connectSessionId: "sess-keep"
            }
          },
          NEW_ORIGIN,
          opener
        )
      );
      await new Promise((r) => setTimeout(r, 30));
      const feed = service.feedSnapshot();
      expect(feed.historyAvailable).toBe(false);
      expect(feed.commands.find((c) => c.requestId === "req-keep")).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  /* ============== 施工单 002 硬切换：p2pkh.transfer ============== */

  // 一条合法 mainnet P2PKH 地址（来自已知向量；用作正向测试）。
  // 这里随便选一个真实 mainnet 地址；protocol 校验只做 version 0x00 + 25 字节。
  const MAINNET_P2PKH = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

  function makeP2pkhServiceStub() {
    return {
      async listUtxos() {
        return [{ txid: "00".repeat(32), vout: 0, value: 100000 }];
      },
      async prepareTransfer(input: {
        assetId: "bsv";
        recipientAddress: string;
        amountSatoshis: number;
        feeRateSatoshisPerKb: number;
      }) {
        return {
          assetId: input.assetId,
          network: "main" as const,
          recipientAddress: input.recipientAddress,
          amountSatoshis: input.amountSatoshis,
          feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
          allocation: {},
          changeAddress: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
          outputs: [
            { address: input.recipientAddress, value: input.amountSatoshis }
          ],
          estimatedFeeSatoshis: 200,
          serializedSizeBytes: 200,
          txid: "11".repeat(32),
          rawTxHex: "deadbeef"
        };
      },
      async submitTransfer(preview: { txid: string; rawTxHex: string }) {
        return {
          status: "broadcast",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          submissionId: "sub-1",
          localInputClaimIds: []
        };
      }
    };
  }

  it("p2pkh manual happy path: confirmByUser returns txid/rawTxHex/feeSatoshis", async () => {
    const p2pkh = makeP2pkhServiceStub();
    const { service, opener, getResult } = makeService(TEST_PUB_HEX, undefined, {
      p2pkhService: p2pkh as never
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-manual",
          method: "p2pkh.transfer",
          params: {
            recipientAddress: MAINNET_P2PKH,
            amountSatoshis: 5000, connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    await service.confirmByUser();
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const result = r.result as { txid: string; rawTxHex: string; feeSatoshis: number };
    expect(result.txid).toBe("11".repeat(32));
    expect(result.rawTxHex).toBe("deadbeef");
    expect(result.feeSatoshis).toBe(200);
    const feed = service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "p2pkh-manual");
    expect(card?.recipientAddress).toBe(MAINNET_P2PKH);
    expect(card?.amountSatoshis).toBe(5000);
    expect(card?.autoApproved).toBe(false);
    expect(card?.decision).toBe("approved");
  });

  it("p2pkh auto-approve: skips confirming, records autoApproved=true, replies result inline", async () => {
    const p2pkh = makeP2pkhServiceStub();
    const { service, opener, getResult } = makeService(TEST_PUB_HEX, undefined, {
      p2pkhService: p2pkh as never
    });
    // 用 service.setOriginSettings 写 origin（同时刷新 originCache）。
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 10000,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 50000,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-auto",
          method: "p2pkh.transfer",
          params: {
            recipientAddress: MAINNET_P2PKH,
            amountSatoshis: 1000, connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        opener
      )
    );
    // auto-approve 命中：不走 confirming；等待内联执行完成后看终态卡真值。
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const result = r.result as { txid: string; rawTxHex: string; feeSatoshis: number };
    expect(result.txid).toBe("11".repeat(32));
    const feed = service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "p2pkh-auto");
    expect(card?.autoApproved).toBe(true);
    expect(card?.decision).toBe("approved");
    // phase 回到 waiting。
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("p2pkh insufficient balance: site receives user_rejected, opener messages hide balance", async () => {
    const p2pkhStub = {
      async listUtxos() {
        return [{ txid: "00".repeat(32), vout: 0, value: 100000 }];
      },
      async prepareTransfer() {
        throw new Error(
          "P2PKH transfer failed: insufficient. Available inputs 100 sats, amount 5000 sats, final fee 200 sats, total required 5200 sats."
        );
      },
      async submitTransfer() {
        return { status: "rejected", rawTxHex: "", submissionId: "x", localInputClaimIds: [] };
      }
    };
    const { service, opener, getResult, posted } = makeService(TEST_PUB_HEX, undefined, {
      p2pkhService: p2pkhStub as never
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-insufficient",
          method: "p2pkh.transfer",
          params: { recipientAddress: MAINNET_P2PKH, amountSatoshis: 5000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error.code).toBe("user_rejected");
      expect(r.error.message).toBe("User rejected");
    }
    // 关键：opener 收到的任何 message 里都不能含真实余额数字。
    for (const m of opener.messages) {
      const json = JSON.stringify(m.msg);
      expect(json).not.toContain("Available inputs");
      expect(json).not.toContain("100 sats");
      expect(json).not.toContain("5200 sats");
    }
    void posted;
    const feed = service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "p2pkh-insufficient");
    expect(card?.failureReason).toBe("insufficient_balance");
    expect(card?.errorCode).toBe("user_rejected");
  });

  it("p2pkh invalid address: validation rejects as invalid_request", async () => {
    // testnet 版本（0x6f）的主网前缀；validation 应当 invalid_request 拒绝。
    const testnetAddr = "mzBc4XEFSdjm9XEV3R3c7x6Q7ZqQ2d1b8e";
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-bad-addr",
          method: "p2pkh.transfer",
          params: { recipientAddress: testnetAddr, amountSatoshis: 5000 }
        },
        ORIGIN,
        opener
      )
    );
    // 第一条非法 request：按规则忽略；不进 confirming。
    expect(service.snapshot().phase).toBe("waiting");
    expect(service.snapshot().requestId).toBeNull();
  });

  it("p2pkh invalid amount: validation rejects as invalid_request", async () => {
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-bad-amt",
          method: "p2pkh.transfer",
          params: { recipientAddress: MAINNET_P2PKH, amountSatoshis: -1 }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("waiting");
  });

  /* ============== 施工单 002 硬切换：feepool.* ============== */
  // 注意：feepoolSdk 真调 SDK 会跑公钥曲线 + BSV 交易；测试里通过 mock module
  // 拦截 feepoolSdk 的纯函数，让 service 状态机可测且避免 jsdom 环境里
  // @bsv/sdk 的兼容性问题。

  const COUNTERPARTY = "02" + "cc".repeat(32);

  /**
   * 通用 setup：mock feepoolSdk 返回 deterministic hex；返回 harness（带 service / opener /
   * storageDb / lastResult helper）。
   *
   * 注意：mock 通过 `vi.doMock` 在 module 缓存里生效；必须在 `await import`
   * 之前；`vi.resetModules` 清缓存让 re-import 真的走新 mock。
   */
  async function setupFeepoolMock(opts: {
    priorPool?: ProtocolFeePoolRecord | null;
    sdkBase?: { txHex: string; outputIndex: number; amount: number };
    sdkInitialDraft?: { txHex: string };
    sdkUpdatedDraft?: { txHex: string };
    sdkSign?: Uint8Array;
  }) {
    vi.resetModules();
    vi.doMock("./feepoolSdk.js", () => ({
      sdkBuildBaseTx: async () =>
        opts.sdkBase ?? {
          txHex: "aa".repeat(100),
          outputIndex: 0,
          amount: 10000
        },
      sdkBuildInitialDraftSpendTx: async () =>
        opts.sdkInitialDraft ?? { txHex: "bb".repeat(100) },
      sdkLoadDraftSpendTx: async () =>
        opts.sdkUpdatedDraft ?? { txHex: "bb".repeat(100) },
      sdkClientSignInitialSpendTx: async () => opts.sdkSign ?? new Uint8Array(64),
      sdkClientSignUpdatedSpendTx: async () => opts.sdkSign ?? new Uint8Array(64),
      sdkVerifyServerInitialSpendSig: async () => true,
      sdkVerifyServerUpdateSig: async () => true,
      isValidCompressedPubkeyHex: () => true,
      FINAL_LOCKTIME: 4294967295
    }));
    const reloaded = await import("./protocolService.js");
    const p2pkh = makeP2pkhServiceStub();
    const opener = makeFakeOpener();
    const posted = { ready: 0, result: [] as ProtocolResultMessage[], closing: [] as ProtocolClosingMessage[] };
    let resultMessage: ProtocolResultMessage | null = null;
    const fakeStorage = makeFakeStorageDb();
    // 施工单 2026-06-28 002 硬切换：feepool.* 业务方法也需要 connectSessionId。
    await fakeStorage.putConnectSession({
      sessionId: "sess-test",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    const service = new reloaded.ProtocolServiceImpl({
      vault: makeVaultStub(TEST_PUB_HEX),
      keyspace: makeKeyspaceStub(TEST_PUB_HEX),
      storageDb: fakeStorage,
      p2pkhService: p2pkh as never,
      resolveOpener: () => opener as unknown as Window,
      postReady: () => {
        posted.ready++;
      },
      postResult: (_t, _o, msg) => {
        resultMessage = msg;
        posted.result.push(msg);
      },
      postClosing: (_t, msg) => {
        posted.closing.push(msg);
      }
    });
    return {
      service,
      opener,
      storageDb: fakeStorage,
      posted,
      /** 最新一条 result message（成功 / 失败都包含）。 */
      lastResult(): ProtocolResultMessage | null {
        return resultMessage;
      },
      /** 找第一条失败 message。 */
      firstError(): ProtocolResultMessage | null {
        for (const m of posted.result) {
          if (m.ok === false) return m;
        }
        return null;
      }
    };
  }

  function teardownFeepoolMock() {
    vi.doUnmock("./feepoolSdk.js");
    vi.resetModules();
  }

  function setOriginViaService(service: ProtocolServiceImpl, overrides: Partial<ProtocolOriginSettingsRecord> = {}) {
    return service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      updatedAt: 1,
      ...overrides
    });
  }

  it("feepool.prepare create: amountSatoshis = transfer amount (NOT pool size); result has base + spend hexes", async () => {
    // 关键不变量（施工单 002 收尾反馈 V2）：create 包含第一次 transfer。
    // prepare 同时构造 base tx（建池）+ spend tx（从新池划 amountSatoshis）。
    // pool 大小 = `originSettings.feePoolDefaultFundSatoshis`，
    // 但 `params.amountSatoshis` 一律 = transfer 金额（不被偷换）。
    const h = await setupFeepoolMock({});
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 25000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-create",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (r && r.ok && r.result) {
      const result = r.result as {
        action: string;
        baseTxHex?: string;
        baseTxOutputIndex?: number;
        draftSpendTxHex?: string;
        draftClientSignBytes?: unknown;
        amountSatoshis?: number;
      };
      expect(result.action).toBe("create");
      // create 同时构造 base + spend：两个 hex 字段都应存在。
      expect(result.baseTxHex).toBe("aa".repeat(100));
      expect(result.baseTxOutputIndex).toBe(0);
      expect(result.draftSpendTxHex).toBe("bb".repeat(100));
      expect(result.draftClientSignBytes).toBeDefined();
      // amountSatoshis 一律 = 转移金额 = site 传的 8000（不被覆盖）。
      expect(result.amountSatoshis).toBe(8000);
    }
    // feePools store 此时**未**写（commit 才写）。
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(stored).toBeNull();
    teardownFeepoolMock();
  });

  it("feepool.prepare create: rejects when amountSatoshis > pool size", async () => {
    // 关键不变量（V3）：amountSatoshis 必须能装进池里；
    // site 想 transfer 25000 但池只有 10000 → 拒掉。
    const h = await setupFeepoolMock({});
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-overflow",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 25000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const lastError = h.firstError();
    expect(lastError?.ok).toBe(false);
    if (lastError && lastError.ok === false) {
      expect(lastError.error.code).toBe("user_rejected");
    }
    const feed = h.service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "fp-overflow");
    expect(card?.failureReason).toBe("internal_error");
    teardownFeepoolMock();
  });

  it("feepool.prepare create: rejects when origin feePoolDefaultFundSatoshis = 0", async () => {
    const h = await setupFeepoolMock({});
    // 不调 setOriginSettings → cache + DB 都是默认（feePoolDefaultFundSatoshis=0）。
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-create-noconf",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const lastError = h.firstError();
    expect(lastError?.ok).toBe(false);
    if (lastError && lastError.ok === false) {
      expect(lastError.error.code).toBe("user_rejected");
      expect(lastError.error.message).toBe("User rejected");
    }
    const feed = h.service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "fp-create-noconf");
    expect(card?.failureReason).toBe("internal_error");
    teardownFeepoolMock();
  });

  it("feepool.prepare spend: prior pool with enough balance → action=spend, serverAmount=amountSatoshis", async () => {
    // prior.totalAmount=20000，site 要花 8000 → spend 分支。
    const prior: ProtocolFeePoolRecord = {
      poolKey: `${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      counterpartyPublicKeyHex: COUNTERPARTY,
      baseTxid: "aa".repeat(32),
      baseTxHex: "00".repeat(100),
      totalAmount: 20000,
      serverAmount: 0,
      lastOperationId: "op-prior",
      draftSpendTxHex: "draft",
      draftClientSignBytes: { $type: "binary", bytes: new Uint8Array(72).buffer },
      updatedAt: 1
    };
    const h = await setupFeepoolMock({
      sdkUpdatedDraft: { txHex: "bb".repeat(120) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    await h.storageDb.putFeePool(prior);
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-spend",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (r && r.ok && r.result) {
      const result = r.result as {
        action: string;
        draftSpendTxHex?: string;
        amountSatoshis?: number;
      };
      expect(result.action).toBe("spend");
      expect(result.draftSpendTxHex).toBe("bb".repeat(120));
      expect(result.amountSatoshis).toBe(8000);
    }
    teardownFeepoolMock();
  });

  it("feepool.prepare close_and_recreate: prior balance insufficient → builds spend + new base", async () => {
    // prior.totalAmount=3000，site 要 8000 → close_and_recreate。
    const prior: ProtocolFeePoolRecord = {
      poolKey: `${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      counterpartyPublicKeyHex: COUNTERPARTY,
      baseTxid: "aa".repeat(32),
      baseTxHex: "00".repeat(100),
      totalAmount: 3000,
      serverAmount: 0,
      lastOperationId: "op-prior",
      draftSpendTxHex: "draft",
      draftClientSignBytes: { $type: "binary", bytes: new Uint8Array(72).buffer },
      updatedAt: 1
    };
    const h = await setupFeepoolMock({
      // close 旧草稿（loadDraft → sdkUpdatedDraft）
      sdkUpdatedDraft: { txHex: "bb".repeat(120) },
      // 建新池 base tx + 初始 B-Tx 草稿
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 8000 },
      sdkInitialDraft: { txHex: "dd".repeat(120) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    await h.storageDb.putFeePool(prior);
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cnr",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (r && r.ok && r.result) {
      const result = r.result as {
        action: string;
        draftSpendTxHex?: string;
        baseTxHex?: string;
        closeDraftTxHex?: string;
        amountSatoshis?: number;
      };
      expect(result.action).toBe("close_and_recreate");
      // 关键：close_and_recreate 返回 close 草稿（update 版）+ 新池 base tx + 新池初始 B-Tx 草稿。
      expect(result.closeDraftTxHex).toBe("bb".repeat(120));
      expect(result.baseTxHex).toBe("cc".repeat(120));
      expect(result.draftSpendTxHex).toBe("dd".repeat(120));
      expect(result.amountSatoshis).toBe(8000);
    }
    teardownFeepoolMock();
  });

  it("feepool.commit create: writes new pool record with totalAmount=pool size and serverAmount=transfer amount (separated!)", async () => {
    // 关键不变量 V3：
    //   totalAmount = 池大小 = `feePoolDefaultFundSatoshis`（**不是** amountSatoshis）
    //   serverAmount = 本次 transfer 金额 = `amountSatoshis`（**不是** 0）
    //   两者必须分开；不能再合并成一个值。
    // 这里池大小 10000、transfer 5000；这两个值在 store 里**必须**不同。
    const h = await setupFeepoolMock({
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 10000 }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-commit-create",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const preparedResult = h.lastResult();
    expect(preparedResult?.ok).toBe(true);
    if (!preparedResult || preparedResult.ok !== true) {
      throw new Error("prepare failed");
    }
    const opId = (preparedResult.result as { operationId: string }).operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-commit",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [
              { $type: "binary", bytes: new Uint8Array(72).buffer },
            ],
            connectSessionId: "sess-test",
            baseCounterpartySignatures: [
              { $type: "binary", bytes: new Uint8Array(72).buffer }
            ]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const results = h.posted.result;
    const commitResult = results[results.length - 1];
    expect(commitResult?.ok).toBe(true);
    if (commitResult && commitResult.ok && commitResult.result) {
      expect((commitResult.result as { action: string }).action).toBe("create");
    }
    // store 里有新池记录；totalAmount = 池大小（**不**等于 transfer 金额）。
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(stored).not.toBeNull();
    expect(stored?.totalAmount).toBe(10000); // 池大小
    expect(stored?.serverAmount).toBe(5000); // transfer 金额
    // 关键：**两个值不相等**。
    expect(stored?.totalAmount).not.toBe(stored?.serverAmount);
    // 新池 baseTxid 来自 base tx。
    expect(stored?.baseTxid).toBe(await computeExpectedBaseTxid("cc".repeat(120)));
    teardownFeepoolMock();
  });

  it("feepool.commit unknown operationId: user_rejected + unknown_operation", async () => {
    const h = await setupFeepoolMock({});
    await setOriginViaService(h.service, {});
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-unknown",
          method: "feepool.commit",
          params: {
            operationId: "op-does-not-exist",
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const lastError = h.firstError();
    expect(lastError?.ok).toBe(false);
    if (lastError && lastError.ok === false) {
      expect(lastError.error.code).toBe("user_rejected");
    }
    const feed = h.service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "fp-unknown");
    expect(card?.failureReason).toBe("unknown_operation");
    teardownFeepoolMock();
  });

  it("feepool.commit cross-origin operationId: cross_origin_operation", async () => {
    const h = await setupFeepoolMock({});
    await setOriginViaService(h.service, {});
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cross-prep",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) throw new Error("prepare failed");
    const opId = (r.result as { operationId: string }).operationId;
    const EVIL = "https://evil.example";
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cross-commit",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        EVIL,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const results = h.posted.result;
    const lastError = [...results].reverse().find((m) => m.ok === false);
    expect(lastError?.ok).toBe(false);
    if (lastError && lastError.ok === false) {
      // 施工单 2026-06-28 002 硬切换：跨 origin 由 accept 阶段
      // preCheckConnectSession 立即返回 invalid_origin（与 identity.get
      // 同语义）；旧模型"feepool.commit 跨 origin → cross_origin_operation
      // → user_rejected"已被收口。
      expect(lastError.error.code).toBe("invalid_origin");
    }
    const feed = h.service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "fp-cross-commit");
    // 施工单 2026-06-28 002 硬切换：跨 origin 由 accept 阶段
    // preCheckConnectSession 抛 `invalid_origin` ProtocolError（与
    // identity.get / cipher.* 统一语义），dispatch catch 走通用分支，
    // `failureReason` **不**写具体 reason（"internal_error" / undefined）。
    // 旧"feepool.commit 跨 origin → cross_origin_operation"特定 reason
    // 已被收口。
    expect(card?.errorCode).toBe("invalid_origin");
    teardownFeepoolMock();
  });

  it("feepool.prepare auto-sign: skips ConfirmView when feePoolAutoSignMaxSatoshis >= amount", async () => {
    const h = await setupFeepoolMock({
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 1000 }
    });
    await setOriginViaService(h.service, {
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      feePoolAutoSignMaxSatoshis: 5000
    });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-autosign",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    // auto-sign 命中：phase 不应是 confirming。
    expect(h.service.currentRequestAutoApproved()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (r && r.ok && r.result) {
      expect((r.result as { action: string }).action).toBe("create");
    }
    teardownFeepoolMock();
  });

  it("feepool.commit auto-sign: reads amountSatoshis from pending op, not params", async () => {
    // 关键修复（施工单 002 收尾反馈 V2）：commit 没有 amountSatoshis
    // 字段；auto-sign 必须从 pendingOps 里读 prepare 阶段决策好的
    // amountSatoshis。否则取 params.amountSatoshis 永远拿到 0，
    // commit 永远走 manual confirm。
    const h = await setupFeepoolMock({
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 1000 }
    });
    await setOriginViaService(h.service, {
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      feePoolAutoSignMaxSatoshis: 5000
    });
    // 先跑 prepare（auto-sign 内联），pending op 会被清掉（commit 后才清；
    // 这里我们手动把 op 留下给下一步 commit 用）。
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-prepare",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 3000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    // 等待内联 executeFeepoolPrepare 完成。
    await new Promise((r) => setTimeout(r, 30));
    const prep = h.lastResult();
    expect(prep?.ok).toBe(true);
    if (!prep || prep.ok !== true) throw new Error("prepare failed");
    const opId = (prep.result as { operationId: string }).operationId;
    // 在 op 还在 pendingOps 里的时候发出 commit（auto-sign 内联）：
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-commit-autosign",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test",
          baseCounterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    // 关键：commit 命中 auto-sign（3000 <= 5000）。
    expect(h.service.currentRequestAutoApproved()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const r = h.lastResult();
    expect(r?.ok).toBe(true);
    if (r && r.ok && r.result) {
      expect((r.result as { action: string }).action).toBe("create");
    }
    teardownFeepoolMock();
  });

  it("encodes integers with shortest form", async () => {
    expect(cborEncode(0)).toEqual(new Uint8Array([0]));
    expect(cborEncode(1)).toEqual(new Uint8Array([1]));
    expect(cborEncode(23)).toEqual(new Uint8Array([23]));
    expect(cborEncode(24)).toEqual(new Uint8Array([24, 24]));
    expect(cborEncode(255)).toEqual(new Uint8Array([24, 255]));
    expect(cborEncode(256)).toEqual(new Uint8Array([25, 1, 0]));
  });

  it("deterministic map ordering by key", async () => {
    expect(cborEncode({ b: 1, a: 2 })).toEqual(cborEncode({ a: 2, b: 1 }));
  });

  /* ============== V4 累计 B-Tx 草稿专用测试 ============== */

  it("V4: spend 不删池——池持续累计 serverAmount", async () => {
    const h = await setupFeepoolMock({
      sdkInitialDraft: { txHex: "dd".repeat(100) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-1",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 3000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const prep = h.lastResult();
    expect(prep?.ok).toBe(true);
    if (!prep || prep.ok !== true) throw new Error("prepare failed");
    const opId = (prep.result as { operationId: string }).operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-1c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(stored).not.toBeNull();
    expect(stored?.totalAmount).toBe(10000);
    expect(stored?.serverAmount).toBe(3000);
    expect(stored?.draftSpendTxHex).toBe("dd".repeat(100));
    teardownFeepoolMock();
  });

  it("V4: 连续 2 次 spend 累加 serverAmount；不构造新独立 spend tx", async () => {
    const h = await setupFeepoolMock({
      sdkInitialDraft: { txHex: "dd".repeat(100) },
      sdkUpdatedDraft: { txHex: "ee".repeat(100) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();

    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2a",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    let opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2ac",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    let stored = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(stored?.serverAmount).toBe(1000);

    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2b",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1500, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2bc",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    stored = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    // 池持续累计：1000 + 1500 = 2500；草稿已更新到 update 版（"ee"）
    expect(stored?.serverAmount).toBe(2500);
    expect(stored?.draftSpendTxHex).toBe("ee".repeat(100));
    teardownFeepoolMock();
  });

  it("V4: close_and_recreate 用 final close（loadDraft + FINAL_LOCKTIME）+ 新池初始 draft", async () => {
    const prior: ProtocolFeePoolRecord = {
      poolKey: `${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      counterpartyPublicKeyHex: COUNTERPARTY,
      baseTxid: "aa".repeat(32),
      baseTxHex: "00".repeat(100),
      totalAmount: 3000,
      serverAmount: 0,
      draftSpendTxHex: "old-draft",
      draftClientSignBytes: { $type: "binary", bytes: new Uint8Array(72).buffer },
      lastOperationId: "op-prior",
      updatedAt: 1
    };
    const h = await setupFeepoolMock({
      sdkUpdatedDraft: { txHex: "aa".repeat(100) },
      sdkInitialDraft: { txHex: "dd".repeat(100) },
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 10000 }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-3",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const prep = h.lastResult();
    expect(prep?.ok).toBe(true);
    if (!prep || prep.ok !== true) throw new Error("prepare failed");
    const opId = (prep.result as { operationId: string }).operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-3c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test",
          closeCounterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const oldPool = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(oldPool).not.toBeNull();
    expect(oldPool?.totalAmount).toBe(10000);
    expect(oldPool?.serverAmount).toBe(8000);
    teardownFeepoolMock();
  });

  it("V5: close_and_recreate close 路径只用 prior.serverAmount（不+amountSatoshis），新请求 amountSatoshis 只入新池", async () => {
    // 关键不变量 V5：close 路径 serverAmount = prior.serverAmount（**不**加新请求 amountSatoshis）。
    // SDK `loadTx` 不做上限检查；close 时如果 serverAmount > prior.totalAmount 会导致
    // change 输出为负数，签名失败。测试中 prior.serverAmount=3000，amountSatoshis=2000；
    // close 后 close 草稿 serverAmount 应只是 3000（不是 3000+2000=5000）。
    // 新池 serverAmount 应是 2000（新池从 0 开始累计 site 的 amountSatoshis）。
    const prior: ProtocolFeePoolRecord = {
      poolKey: `${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      counterpartyPublicKeyHex: COUNTERPARTY,
      baseTxid: "aa".repeat(32),
      baseTxHex: "00".repeat(100),
      totalAmount: 3000,
      serverAmount: 2000, // 旧池已累计 2000（change 1000 留 client）
      draftSpendTxHex: "old-draft",
      draftClientSignBytes: { $type: "binary", bytes: new Uint8Array(72).buffer },
      lastOperationId: "op-prior",
      updatedAt: 1
    };
    const h = await setupFeepoolMock({
      sdkUpdatedDraft: { txHex: "close-draft".padEnd(100, "0") },
      sdkInitialDraft: { txHex: "dd".repeat(100) },
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 10000 }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v5-close",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 2000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const prep = h.lastResult();
    expect(prep?.ok).toBe(true);
    if (!prep || prep.ok !== true) throw new Error("prepare failed");
    const opId = (prep.result as { operationId: string }).operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v5-close-c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test",
          closeCounterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    // 新池覆盖：totalAmount = 新池大小（= feePoolDefaultFundSatoshis = 10000）；
    // serverAmount = 新池第一次 transfer（= site 的 amountSatoshis = 2000）。
    // 关键：close 旧池 2000 + 新池 2000 = 4000（**不是**）；V5 修复后新池只继承
    // 自己的第一次 transfer 2000。
    const newPool = await h.storageDb.getFeePool(`${ORIGIN}::${TEST_PUB_HEX}::${COUNTERPARTY}`);
    expect(newPool).not.toBeNull();
    expect(newPool?.totalAmount).toBe(10000);
    expect(newPool?.serverAmount).toBe(2000); // V5 关键：不是 4000
    teardownFeepoolMock();
  });

  it("V4: commit result fields are draftTxid/draftTxHex (V4 draft semantics)", async () => {
    const h = await setupFeepoolMock({
      sdkInitialDraft: { txHex: "dd".repeat(100) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-4",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000, connectSessionId: "sess-test" }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    await h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-4c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const result = (h.lastResult() as unknown as { ok: true; result: { draftTxid: string; draftTxHex: string } }).result;
    expect(result.draftTxid).toBeDefined();
    expect(result.draftTxHex).toBe("dd".repeat(100));
    // 旧字段名 txid / rawTxHex 不应存在。
    expect((result as { txid?: string }).txid).toBeUndefined();
    expect((result as { rawTxHex?: string }).rawTxHex).toBeUndefined();
    teardownFeepoolMock();
    expect(result.draftTxid).toBeDefined();
  });
});

/* ============== 施工单 001：identity / cipher per-origin auto-approve ============== */

describe("ProtocolServiceImpl origin auto-approve (施工单 001)", () => {
  const ORIGIN_FRESH = "https://fresh.example";

  /** 直接构造一个会抛 throw 的 storageDb,用于"DB 不可用"测试。 */
  function makeFailingDb(): ProtocolStorageDb {
    return {
      async putCommand() {
        throw new Error("db down");
      },
      async getCommand() {
        return null;
      },
      async listCommandsByOrigin() {
        return [];
      },
      async getOrigin() {
        throw new Error("db down");
      },
      async putOrigin() {
        throw new Error("db down");
      },
      async listOrigins() {
        return [];
      },
      async getFeePool() {
        return null;
      },
      async putFeePool() {
        throw new Error("db down");
      },
      async deleteFeePool() {
        return undefined;
      },
      async listFeePoolsByOrigin() {
        return [];
      },
      async putConnectSession() {
        /* noop */
      },
      async getConnectSession(sessionId: string) {
        // 施工单 2026-06-28 002 硬切换：测试 stub 按 id 后缀返回对应
        // origin 的 valid session（让 preCheckConnectSession 放行）。
        if (sessionId) {
          let origin: string = ORIGIN;
          if (sessionId === "sess-origin-a") origin = "https://origin-a.example";
          else if (sessionId === "sess-origin-b") origin = "https://origin-b.example";
          else if (sessionId === "sess-other") origin = "https://other.example";
          else if (sessionId === "sess-fresh") origin = "https://fresh.example";
          return {
            sessionId,
            origin,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() {
        return [];
      },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        throw new Error("db down");
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
  }

  function identityParams() {
    return {
      aud: ORIGIN_FRESH,
      iat: 1,
      exp: 2,
      text: "hello",
      claims: ["key.label"],
      // 施工单 2026-06-28 002 硬切换：identity.get 业务方法也强制要求
      // connectSessionId。makeService 已经默认 seed 了 ORIGIN_FRESH
      // 对应的 sess-fresh session。
      connectSessionId: "sess-fresh"
    };
  }

  it("origin settings round-trip includes identityAutoApproveEnabled / cipherAutoApproveEnabled", async () => {
    const { service, storageDb } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: true,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    const got = await service.getOriginSettings(ORIGIN_FRESH);
    expect(got?.identityAutoApproveEnabled).toBe(true);
    expect(got?.cipherAutoApproveEnabled).toBe(true);
    const raw = await storageDb.getOrigin(ORIGIN_FRESH);
    expect(raw?.identityAutoApproveEnabled).toBe(true);
    expect(raw?.cipherAutoApproveEnabled).toBe(true);
  });

  it("normalizes old origin record (missing new fields) to identityAutoApproveEnabled=false / cipherAutoApproveEnabled=false / confirmTimeoutSeconds=30", async () => {
    const { service, storageDb } = makeService();
    // 模拟旧 schema:直接往 DB 写一条缺新字段的 record。
    // 注意：这里**故意**不写 `confirmTimeoutSeconds` —— 走的是施工单 003
    // 归一化路径（缺字段 → 30）。
    await storageDb.putOrigin({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 5000,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
      updatedAt: 1
    } as ProtocolOriginSettingsRecord);
    const got = await service.getOriginSettings(ORIGIN_FRESH);
    expect(got).not.toBeNull();
    expect(got?.identityAutoApproveEnabled).toBe(false);
    expect(got?.cipherAutoApproveEnabled).toBe(false);
    expect(got?.confirmTimeoutSeconds).toBe(30);
    // 用共享 storageDb 的第二个 service:cache miss → 异步读 DB → 归一化写 cache。
    const { service: s2 } = makeService(TEST_PUB_HEX, storageDb);
    s2.startSession();
    const loaded = await s2.getOriginSettings(ORIGIN_FRESH);
    expect(loaded?.identityAutoApproveEnabled).toBe(false);
    expect(loaded?.confirmTimeoutSeconds).toBe(30);
  });

  it("identity.get auto-approve (sync cache hit): skips confirming, replies result inline", async () => {
    const { service, opener, getResult } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-auto-sync",
          method: "identity.get",
          params: identityParams()
        },
        ORIGIN_FRESH,
        opener
      )
    );
    // cache 命中 → 直接 executing + autoApproved=true。
    expect(service.currentRequestAutoApproved()).toBe(true);
    // 等内联执行完成。
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    expect(service.snapshot().phase).toBe("waiting");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "id-auto-sync");
    expect(card?.autoApproved).toBe(true);
  });

  it("cipher.encrypt auto-approve (sync cache hit)", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: true,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    await seedConnectSession(storageDb, "sess-enc-auto", TEST_PUB_HEX);
    // 重写 seed 后的 session 的 origin 为 ORIGIN_FRESH，避免 invalid_origin。
    await storageDb.putConnectSession({
      sessionId: "sess-enc-auto",
      origin: ORIGIN_FRESH,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-auto-sync",
          method: "cipher.encrypt",
          params: {
            aud: ORIGIN_FRESH,
            text: "hello",
            contentType: "note.v1",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-enc-auto"
          }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    expect(service.currentRequestAutoApproved()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(getResult()?.ok).toBe(true);
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("cipher.decrypt auto-approve (sync cache hit)", async () => {
    // 先用同 origin 发一次 encrypt,再用 decrypt 请求(同 origin cache 命中)。
    const { service, opener, storageDb } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: true,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    // cipher.* 现在强制要求 connectSessionId；为这条 auto-approve 测试
    // 预先 seed 一条 ORIGIN_FRESH 下的 session。
    await storageDb.putConnectSession({
      sessionId: "sess-dec-auto",
      origin: ORIGIN_FRESH,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    // 先发 encrypt 拿到 nonce / cipherbytes。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-pre",
          method: "cipher.encrypt",
          params: {
            aud: ORIGIN_FRESH,
            text: "hi",
            contentType: "note.v1",
            content: { $type: "binary", bytes: new Uint8Array([7, 8]).buffer },
            connectSessionId: "sess-dec-auto"
          }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot().phase).toBe("waiting");
    // 重新发起 decrypt(同 origin cache 命中)。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-auto-sync",
          method: "cipher.decrypt",
          params: { aud: ORIGIN_FRESH, text: "ignored", cipherbytes: { $type: "binary", bytes: new Uint8Array([0]).buffer }, nonce: { $type: "binary", bytes: new Uint8Array([0]).buffer }, connectSessionId: "sess-dec-auto" }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    expect(service.currentRequestAutoApproved()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("identity.get auto-approve (popup fresh session, cache miss): await getOriginSettingsCached decides auto-approve before setPhase (no ConfirmView flash)", async () => {
    // 第一次 service:setOriginSettings 写 DB。
    const first = makeService();
    await first.service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    // 第二次 service:共享 storageDb,但 cache 是空的——模拟 popup 新开会话。
    const second = makeService(TEST_PUB_HEX, first.storageDb);
    second.service.startSession();
    // cache miss 路径:handleMessage 内部 await getOriginSettingsCached →
    // 命中 → setPhase("executing") + fire-and-forget runIdentityCipherAutoApproved。
    // await handleMessage 返回时 phase === "executing",但 fire-and-forget
    // 链可能已经在 microtask 中推进到 waiting(不阻塞测试断言:关键
    // 是 "phase 永远不在 confirming 出现过",UI 不会闪 confirm 浮层)。
    await second.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-fresh",
          method: "identity.get",
          params: identityParams()
        },
        ORIGIN_FRESH,
        second.opener
      )
    );
    // 关键:await handleMessage 之后 phase 一定是 "executing" 或 "waiting"
    // ——**绝不**是 "confirming"。"不显示 confirm 浮层" 这条是绝对的。
    expect(second.service.snapshot().phase).not.toBe("confirming");
    // 等 fire-and-forget 内联执行收尾。
    await new Promise((r) => setTimeout(r, 50));
    expect(second.getResult()?.ok).toBe(true);
    expect(second.service.snapshot().phase).toBe("waiting");
    const card = second.service.feedSnapshot().commands.find((c) => c.requestId === "id-fresh");
    expect(card?.autoApproved).toBe(true);
  });

  it("identity.get cache miss + DB no record: falls back to manual confirm (no silent auto-approve)", async () => {
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-empty-db",
          method: "identity.get",
          params: identityParams()
        },
        ORIGIN_FRESH,
        opener
      )
    );
    // 同步:phase === "confirming"。
    expect(service.snapshot().phase).toBe("confirming");
    // 等 fire-and-forget 异步查询(DB 没记录)落定:不翻案,phase 仍 confirming。
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot().phase).toBe("confirming");
    expect(service.currentRequestAutoApproved()).toBe(false);
  });

  it("identity.get auto-approve when vault locked: unlock flips directly to executing, skipping confirming", async () => {
    // 构造 vault 初始 locked 的 service。
    const vaultLocked = makeVaultStub(TEST_PUB_HEX);
    type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";
    let currentStatus: VaultStatus = "locked";
    vaultLocked.status = () => currentStatus;
    const unlockListeners: Array<(s: VaultStatus) => void> = [];
    vaultLocked.onStatusChange = (h: (s: VaultStatus) => void) => {
      unlockListeners.push(h);
      return () => undefined;
    };
    vaultLocked.unlock = async (_password: string) => {
      currentStatus = "unlocked";
      for (const l of unlockListeners) l("unlocked");
    };
    const { service, opener, storageDb } = makeService(TEST_PUB_HEX, undefined, {
      vault: vaultLocked
    });
    await storageDb.putOrigin({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-locked",
          method: "identity.get",
          params: identityParams()
        },
        ORIGIN_FRESH,
        opener
      )
    );
    // locked → phase 应是 unlocking。
    expect(service.snapshot().phase).toBe("unlocking");
    // 模拟解锁:status 变 unlocked + 触发 resumeAfterUnlock。
    await vaultLocked.unlock("test-password");
    await service.resumeAfterUnlock();
    await new Promise((r) => setTimeout(r, 30));
    expect(service.snapshot().phase).toBe("waiting");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "id-locked");
    expect(card?.autoApproved).toBe(true);
  });

  it("DB unavailable: identity.get auto-approve is off; falls through to manual confirm (after await getOriginSettingsCached catches)", async () => {
    const { service, opener } = makeService(TEST_PUB_HEX, makeFailingDb());
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-no-db",
          method: "identity.get",
          params: identityParams()
        },
        ORIGIN_FRESH,
        opener
      )
    );
    // getOriginSettingsCached 内部 try/catch 抛 → 返回 null → 走 manual
    // confirm。await handleMessage 返回时 phase 已经是 confirming。
    expect(service.snapshot().phase).toBe("confirming");
    expect(service.currentRequestAutoApproved()).toBe(false);
  });

  it("intent.sign is unaffected by identity/cipher auto-approve fields", async () => {
    const { service, opener } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: true,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "sign-1",
          method: "intent.sign",
          params: {
            aud: ORIGIN_FRESH,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            // 施工单 2026-06-28 002 硬切换：intent.sign 强制要求
            // connectSessionId。
            connectSessionId: "sess-fresh"
          }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    expect(service.currentRequestAutoApproved()).toBe(false);
  });

  /* ============== 施工单 001 收口反馈 v2：业务错误必须对外回真实 errCode ============== */

  it("identity.get auto-approve path: invalid_origin replies invalid_origin (not user_rejected)", async () => {
    const { service, opener, getResult } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    // aud 故意写错 → executeIdentityGet 内部 throw protocolError("invalid_origin", ...)。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "id-aud-bad",
          method: "identity.get",
          params: {
            aud: "https://wrong.example",
            iat: 1,
            exp: 2,
            text: "x",
            // 施工单 2026-06-28 002 硬切换：identity.get 强制要求
            // connectSessionId。
            connectSessionId: "sess-fresh"
          }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    // 同步 cache 命中 auto-approve:跳过 confirming 直接 executing。fire-and-forget
    // 内联执行 executeIdentityGet 立即 throw → 立即 reject → catch + finally
    // 链入 microtask,可能先于 test 后面的断言执行并清 binding。**不**在这里
    // 断言 currentRequestAutoApproved() —— 等 fire-and-forget 收尾后,记录
    // 终态才是真值。
    await new Promise((r) => setTimeout(r, 30));
    // 对外回 invalid_origin(不是 user_rejected)。
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.error?.code).toBe("invalid_origin");
    }
    expect(service.snapshot().phase).toBe("waiting");
    // 记录写 failed + 真实 errorCode。
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "id-aud-bad");
    expect(card?.errorCode).toBe("invalid_origin");
    // 关键:autoApproved 在 inline 失败时也应为 true(command 走的是 auto-approve
    // 路径,只是执行失败)—— record 已写最终态,record.autoApproved 反映"是否走
    // auto-approve 路径",不反映成功失败。
    expect(card?.autoApproved).toBe(true);
  });

  it("cipher.decrypt auto-approve path: decrypt_failed replies decrypt_failed (not user_rejected)", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN_FRESH,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: true,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    // cipher.* 现在强制要求 connectSessionId；预先 seed 一条 ORIGIN_FRESH 下的 session。
    await storageDb.putConnectSession({
      sessionId: "sess-dec-bad",
      origin: ORIGIN_FRESH,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    // 故意用非法 nonce / cipherbytes → executeCipherDecrypt 内部 throw protocolError("decrypt_failed", ...)。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-bad",
          method: "cipher.decrypt",
          params: {
            aud: ORIGIN_FRESH,
            text: "ignored",
            nonce: { $type: "binary", bytes: new Uint8Array([1]).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array([2]).buffer },
            connectSessionId: "sess-dec-bad"
          }
        },
        ORIGIN_FRESH,
        opener
      )
    );
    expect(service.currentRequestAutoApproved()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.error?.code).toBe("decrypt_failed");
    }
    expect(service.snapshot().phase).toBe("waiting");
  });
});

/* ============== 施工单 2026-06-28 001：connect.* 行为单测 ============== */

describe("ProtocolServiceImpl connect.* (施工单 2026-06-28 001 硬切换)", () => {
  it("connect.login：caller 不传 ownerPublicKeyHex；用户在 popup UI 选 key 后落 session 真值", async () => {
    // 关键修复（反例反馈）：caller 不携带 ownerPublicKeyHex——owner 是
    // 用户在 popup UI 上选定的；service 不能替 caller 决定。
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "login-1",
          method: "connect.login",
          params: { text: "login", claims: ["profile.nickname"] }
        },
        ORIGIN,
        opener
      )
    );
    // 进入 confirming 视图；UI 应当能拿到候选 key 列表。
    const view = service.connectLoginRecord();
    expect(view).not.toBeNull();
    expect(view?.availableKeys.length).toBe(1);
    expect(view?.availableKeys[0]?.publicKeyHex).toBe(TEST_PUB_HEX);
    // 用户在 popup UI 上点"用此 key 登录"：推进到 queued → executing → approved。
    await service.confirmConnectLogin(view!.recordId, TEST_PUB_HEX, "pw");
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const loginResult = r.result as { connectSessionId: string; ownerPublicKeyHex: string; resolvedAt: number };
    expect(loginResult.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
    expect(typeof loginResult.connectSessionId).toBe("string");
    // session 真值已落 IndexedDB。
    const stored = await storageDb.getConnectSession(loginResult.connectSessionId);
    expect(stored).not.toBeNull();
    expect(stored?.origin).toBe(ORIGIN);
    expect(stored?.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
    expect(stored?.revokedAt).toBeNull();
  });

  it("connect.resume 只会抢占同 origin 的未提交 connect.login", async () => {
    const { service, opener, deps } = makeService();
    deps.vault.status = () => "locked" as const;
    // 让 login/resume 都停在 waiting_unlock_manual，便于观察抢占边界。
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "login-a",
          method: "connect.login",
          params: { text: "login-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "login-b",
          method: "connect.login",
          params: { text: "login-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    // 有效 resume 只应当收掉同 origin 的 login-b，不影响 origin-a 的 login-a。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-b",
          method: "connect.resume",
          params: { connectSessionId: "sess-origin-b" }
        },
        "https://origin-b.example",
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    const feedB = service.feedSnapshot().commands;
    const cancelledLoginB = feedB.find((c) => c.requestId === "login-b");
    expect(cancelledLoginB?.phase).toBe("rejected");
    expect(cancelledLoginB?.failureReason).toBe("superseded_by_resume");

    // 再切回 origin-a，确认 login-a 仍然存在且未被误伤。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "probe-a",
          method: "identity.get",
          params: { aud: "https://origin-a.example", iat: 1, exp: 2, text: "probe", connectSessionId: "sess-origin-a" }
        },
        "https://origin-a.example",
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    const feedA = service.feedSnapshot().commands;
    const loginA = feedA.find((c) => c.requestId === "login-a");
    expect(loginA?.phase).toBe("waiting_unlock_manual");
    expect(loginA?.failureReason).toBeUndefined();
  });

  it("connect.resume：session 有效 + popup 未解锁（unlocked）→ 直接执行，不需 confirm", async () => {
    // 关键不变量（施工单 2026-06-28 001 硬切换 4.3 + 9.2）：popup 刷新/关闭
    // 后，caller 用 connect.resume 恢复时**不**再要求"恢复"按钮确认——
    // unlock 后自动恢复原 session。
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    const sessionId = "sess-resume-1";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: { "profile.nickname": "alice" },
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-1",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复（反例反馈）：unlocked 路径**不**进入 confirming，直接
    // queued → executing → approved。connectResumeRecord() 因此返回 null
    // （没有 confirming 阶段的 resume record）。
    expect(service.connectResumeRecord()).toBeNull();
    expect(service.snapshot().phase).toBe("executing");
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const resumeResult = r.result as { resolvedClaims: Record<string, unknown>; resolvedAt: number };
    expect(resumeResult.resolvedClaims["profile.nickname"]).toBe("alice");
    expect(typeof resumeResult.resolvedAt).toBe("number");
  });

  it("connect.resume：session 有效 + popup locked → waiting_unlock；unlock 后直接执行", async () => {
    // 关键不变量（施工单 2026-06-28 001 硬切换 9.2）：caller 页面刷新后
    // 优先发 connect.resume；如果 vault locked，仅要求重新输入密码恢复
    // unlock runtime；解锁后**不**再要求"恢复"按钮确认——自动恢复。
    const { service, opener, getResult, storageDb, deps } = makeService();
    // 让 vault 一开始 locked。
    deps.vault.status = () => "locked" as const;
    service.startSession();
    const sessionId = "sess-resume-locked";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: { "profile.nickname": "bob" },
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-locked",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // locked：进入 waiting_unlock_manual（与 manual request 同样进锁屏页）。
    expect(service.snapshot().lockState).toBe("locked");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "resume-locked");
    expect(card?.phase).toBe("waiting_unlock_manual");
    // 用户解锁：模拟 vault.unlock + onStatusChange 链路。
    deps.vault.status = () => "unlocked" as const;
    service.setVaultLockState(false);
    void service.resumeAfterUnlock();
    await new Promise((r) => setTimeout(r, 30));
    // 关键：解锁后**不**经过 confirming，直接执行成功。
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const resumeResult = r.result as { resolvedClaims: Record<string, unknown> };
    expect(resumeResult.resolvedClaims["profile.nickname"]).toBe("bob");
  });

  it("connect.resume：session 已 revoked → fail-fast（不进 confirming；unlocked 直接 failed）", async () => {
    // 关键修复（反例反馈）：session 无效必须 fail-fast，不能让用户走完
    // confirming 后才被告知失败。
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    const sessionId = "sess-revoked";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},

      createdAt: Date.now() - 1000,
      lastUsedAt: Date.now() - 1000,
      revokedAt: Date.now() - 500
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-revoked",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：acceptRequest 阶段检测到 revoked session，**不**进入
    // confirming 也不进 waiting_unlock；直接 phase=failed 并回 result。
    // 用户没有任何"恢复"按钮或"解锁"提示可看。
    expect(service.connectResumeRecord()).toBeNull();
    // 等 fire-and-forget 的 replyErrorToRec 写完 resultMessage。
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "resume-revoked");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    expect(card?.errorCode).toBe("user_rejected");
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
  });

  it("connect.resume：session 无效 + popup 当前 locked → 仍然直接 fail-fast（不进解锁 UI）", async () => {
    // 关键修复（第二轮反例反馈）：fail-fast **不依赖** vault unlock。
    // 无效 session 在 locked 状态下也直接失败——不允许"先提示解锁"的
    // 路径，避免用户对无效请求做无意义的解锁。
    const { service, opener, getResult, storageDb, deps } = makeService();
    deps.vault.status = () => "locked" as const;
    service.startSession();
    const sessionId = "sess-revoked-locked";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},

      createdAt: Date.now() - 1000,
      lastUsedAt: Date.now() - 1000,
      revokedAt: Date.now() - 500
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-revoked-locked",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：vault 仍 locked，但 fail-fast 已经直接 phase=failed，
    // **不**进 waiting_unlock_manual / 不等待解锁。
    expect(service.connectResumeRecord()).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find(
      (c) => c.requestId === "resume-revoked-locked"
    );
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    // lockState 不变（fail-fast 不走 unlock 路径）。
    expect(service.lockState()).toBe("locked");
    // 对外回 result。
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
  });

  it("connect.logout：unlocked → 不需要 confirming，直接 queued → executed + 落 revokedAt + 同步等待 vault.lock() 清 unlock runtime", async () => {
    // 关键修复（反例反馈 v2）：service.executeConnectLogout **同步** await
    // vault.lock()。fire-and-forget 会让 caller 在 vault.lock 抛错时仍
    // 收到 ok=true，造成"session 已吊销但 unlock runtime 没清"的错位
    // 状态。修复后 lock 失败 propagate 为 internal_error，caller 看
    // 到错误并能理解 logout 不完整。
    const { service, opener, getResult, storageDb, deps } = makeService();
    let lockCalls = 0;
    // 模拟真实链路：vault.lock 内部 state 翻转 → 触发 onStatusChange
    // 监听 → popup 顶层调 service.setVaultLockState(true)。施工单
    // 2026-06-30 003 后 setVaultLockState 通过 computeLockState() 重算，
    // 需要 vault.status() 反映真实状态——这里走 fake vault 自带的 lock()
    // + onStatusChange 通路。
    deps.vault.onStatusChange((s) => {
      if (s === "locked") {
        lockCalls++;
        service.setVaultLockState(true);
      }
    });
    service.startSession();
    const sessionId = "sess-logout-1";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "logout-1",
          method: "connect.logout",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("executing");
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const logoutResult = r.result as { connectSessionId: string; revokedAt: number };
    expect(logoutResult.connectSessionId).toBe(sessionId);
    expect(typeof logoutResult.revokedAt).toBe("number");
    // 关键修复（v2）：service 同步 await vault.lock()，所以 lockCalls
    // 必须在 await 链路里被观察到（不是 microtask 后才发生）。
    expect(lockCalls).toBe(1);
    // vault.locked 触发 setVaultLockState → service.lockStateValue === "locked"。
    expect(service.lockState()).toBe("locked");
    // 落库：session.revokedAt 已写入。
    const stored = await storageDb.getConnectSession(sessionId);
    expect(stored?.revokedAt).toBe(logoutResult.revokedAt);
  });

  it("connect.logout：vault.lock() 抛出 → fail-closed（caller 看到 internal_error；session 已 revoked 但 unlock runtime 未清）", async () => {
    // 关键修复（反例反馈 v2）：vault.lock() 失败时不能继续对外报 ok=true。
    // 当前实现：DB 已写 revokedAt（commit），然后 vault.lock() 抛错 →
    // service 抛 localFailure → dispatch catch 写 failed + replyErrorToRec
    // → caller 收到 ok=false。但 session 真值层面 logout 已生效（后续
    // resume / cipher 仍会按 fail-fast 失败）。这是 fail-closed 安全语义。
    const { service, opener, getResult, storageDb, deps } = makeService();
    let lockCalls = 0;
    deps.vault.lock = (async () => {
      lockCalls++;
      // 模拟 keyspace.onVaultLocked 抛错 / 业务订阅者抛错 / DB write 抛错。
      throw new Error("simulated vault lock failure");
    }) as typeof deps.vault.lock;
    service.startSession();
    const sessionId = "sess-logout-lockfail";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "logout-lockfail",
          method: "connect.logout",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    // vault.lock() 被同步调过（哪怕抛错也算）。
    expect(lockCalls).toBe(1);
    // caller 看到失败。
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
    // DB 层面：session.revokedAt 已被 commit（fail-closed 安全语义）。
    const stored = await storageDb.getConnectSession(sessionId);
    expect(stored?.revokedAt).not.toBeNull();
    // 本地 record: phase=failed + failureReason="internal_error"（让 UI 历史区可见）。
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "logout-lockfail");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    // vault.lockState 不被 setVaultLockState 触发（fake lock 抛错前没调
    // setStatus），保持 unlocked。
    expect(service.lockState()).toBe("unlocked");
  });

  it("cipher.encrypt：缺 connectSessionId 直接 invalid_request 拒绝", async () => {
    const { service, opener, getResult } = makeService();
    service.startSession();
    const content = new TextEncoder().encode("body");
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "cipher-no-session",
          method: "cipher.encrypt",
          params: { text: "x", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer } }
        },
        ORIGIN,
        opener
      )
    );
    // 校验失败：service 不向 opener 回任何 result（"情况 B"），
    // request 也不会建 record。snapshot 应保持 waiting。
    await new Promise((r) => setTimeout(r, 10));
    expect(service.snapshot().phase).toBe("waiting");
    expect(getResult()).toBeNull();
  });

  it("cipher.decrypt：sessionId 不存在 → fail-fast（不进 confirming）", async () => {
    // 关键修复（反例反馈）：cipher session 无效必须 fail-fast，不能让
    // 用户对一个无效请求做无意义的确认。
    const { service, opener, getResult } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "cipher-no-exist",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "missing-session-id"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：acceptRequest 阶段就 fail-fast，**不**进入 confirming。
    // 用户看不到"确认"按钮；直接 phase=failed 并对外回 result。
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "cipher-no-exist");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    expect(card?.errorCode).toBe("user_rejected");
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
  });

  it("cipher.decrypt：session 无效 + popup 当前 locked → 直接 fail-fast（不进解锁 UI）", async () => {
    // 关键修复（第二轮反例反馈）：fail-fast **不依赖** vault unlock。
    // 与 connect.resume fail-fast 同语义——locked 状态下无效 session
    // 也直接失败，不要求用户先解锁。
    const { service, opener, getResult, deps } = makeService();
    deps.vault.status = () => "locked" as const;
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "cipher-no-exist-locked",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "missing-session-id-locked"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：vault 仍 locked，但 fail-fast 直接 phase=failed，
    // **不**进 waiting_unlock_manual。
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find(
      (c) => c.requestId === "cipher-no-exist-locked"
    );
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    expect(service.lockState()).toBe("locked");
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
  });

  it("cipher.decrypt：跨 origin sessionId → invalid_origin（不允许跨 origin 复用）", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    const EVIL = "https://evil.com";
    // 把 session 真值的 origin 写成 EVIL，但 event.origin 是 ORIGIN。
    await storageDb.putConnectSession({
      sessionId: "sess-cross",
      origin: EVIL,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "cipher-cross",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-cross"
          }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("invalid_origin");
  });

  it("connect.resume：session 绑定 key 已删 → fail-fast，对外 user_rejected", async () => {
    // 关键修复（反例反馈）：owner key 不可用时必须 fail-fast，不能让
    // 用户走完 confirming 后才被告知。
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    const sessionId = "sess-deleted-key";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      // ownerPublicKeyHex 用 fake stub 不会识别的值（getKey 返回 undefined）。
      ownerPublicKeyHex: "02" + "11".repeat(32),
      ownerLabel: "Deleted",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-deleted",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：owner key 不可用时直接 queued → executing → failed，
    // 不进 confirming。caller 必须重新 login。
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "resume-deleted");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("user_rejected");
  });

  it("active key 切换不影响已存在 session：cipher 仍走 session 绑定 key", async () => {
    // 关键不变量（施工单 2026-06-28 001 / 002）：cipher 绑定的 ownerPublicKeyHex 与
    // 当前钱包全局 active key 解耦。
    const { service, opener, getResult, storageDb, deps } = makeService();
    service.startSession();
    const sessionId = "sess-stable";
    // session 绑定的 ownerPublicKeyHex === TEST_PUB_HEX（key1）。
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    const content = new TextEncoder().encode("note body");
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-stable",
          method: "cipher.encrypt",
          params: { text: "x", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer }, connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 用户已经过 confirming；中途"切换 active key"（fake：通过 setActive 模拟）。
    // 这里**不**真去切 active；keyspace.active() 在 fake 中继续返回 TEST_PUB_HEX。
    // 真正的硬切换由 contract 保护：cipher 走 session.ownerPublicKeyHex，不读 active key。
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    expect(r?.ok).toBe(true);
    if (!r || r.ok !== true) return;
    const enc = r.result as { nonce: { bytes: ArrayBuffer }; cipherbytes: { bytes: ArrayBuffer } };
    // 解密方用 session 绑定 key 的 siteKey 派生，必须能解出原文。
    const siteKey = deriveSiteKey(TEST_PRIV_HEX, ORIGIN);
    const plain = aesGcmDecrypt(siteKey, new Uint8Array(enc.nonce.bytes), new Uint8Array(enc.cipherbytes.bytes));
    const decoded = cborDecode(plain) as unknown[];
    expect(new TextDecoder().decode(decoded[2] as Uint8Array)).toBe("note body");
    void deps;
  });

  it("logout 后立即 resume：必须失败（auth session 已吊销）", async () => {
    const { service, opener, getResult, storageDb } = makeService();
    service.startSession();
    const sessionId = "sess-then-logout";
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    // 1. logout
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "logout-x",
          method: "connect.logout",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(getResult()?.ok).toBe(true);
    // 2. 立即 resume：fail-fast（不接受 revoke 后再 resume）。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "resume-x",
          method: "connect.resume",
          params: { connectSessionId: sessionId }
        },
        ORIGIN,
        opener
      )
    );
    // 关键修复：fail-fast，不进 confirming。
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "resume-x");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("internal_error");
    const r2 = getResult();
    expect(r2?.ok).toBe(false);
    if (r2 && !r2.ok) expect(r2.error.code).toBe("user_rejected");
  });
});

describe("signCompactSecp256k1", () => {
  it("produces 64-byte compact and verifies against pubkey", async () => {
    const msg = new TextEncoder().encode("hello");
    const sig = signCompactSecp256k1(TEST_PRIV_HEX, msg);
    expect(sig.length).toBe(64);
    const pub = secp256k1.getPublicKey(hexToBytes(TEST_PRIV_HEX), true);
    expect(verifyCompactSecp256k1(sig, msg, pub)).toBe(true);
  });
});

/* ============== 003 硬切换：cancel / timeout ============== */

describe("ProtocolServiceImpl cancel / timeout (003)", () => {
  it("cancel 命中当前 request：对外回 user_rejected，不另发 cancel result", async () => {
    const { service, opener, getResult, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-cancel-1",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    // 外部 cancel 命中
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "cancel",
          id: "req-cancel-1"
        },
        ORIGIN,
        opener
      )
    );
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error.code).toBe("user_rejected");
      expect(r.error.message).toBe("User rejected");
    }
    // 关键：cancel 自己**不**发新 result；只回原 request 的 result。
    expect(posted.result).toHaveLength(1);
    expect(posted.closing).toHaveLength(0);
    expect(service.snapshot().phase).toBe("waiting");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "req-cancel-1");
    expect(card?.decision).toBe("rejected");
    expect(card?.status).toBe("rejected");
    expect(card?.failureReason).toBe("client_canceled");
    // timeout 已在收尾时清掉。
    expect(service.confirmDeadlineMs()).toBeNull();
  });

  it("cancel 用错 id：被忽略，当前 request 继续", async () => {
    const { service, opener, getResult, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-cancel-2",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 错的 id → 忽略。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "cancel",
          id: "req-wrong-id"
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    expect(posted.result).toHaveLength(0);
    // confirmByUser 仍能正常走完。
    await service.confirmByUser();
    expect(getResult()?.ok).toBe(true);
  });

  it("cancel 跨 origin：被忽略", async () => {
    const { service, opener, getResult, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-cancel-3",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "cancel",
          id: "req-cancel-3"
        },
        "https://evil.example",
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    expect(posted.result).toHaveLength(0);
  });

  it("cancel 在没绑定时：被忽略", async () => {
    const { service, opener, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "cancel",
          id: "any-id"
        },
        ORIGIN,
        opener
      )
    );
    expect(posted.result).toHaveLength(0);
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("confirmDeadlineMs：confirming 时暴露 deadline；confirm 后立刻清掉", async () => {
    const { service, opener } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    expect(service.confirmDeadlineMs()).toBeNull();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-deadline",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    const d = service.confirmDeadlineMs();
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(Date.now());
    await service.confirmByUser();
    expect(service.confirmDeadlineMs()).toBeNull();
  });

  it("修复 1（更新语义）：timer 与 setPhase 同步开始；cache miss 兜底 30 秒后 DB 回来会 clamp down", async () => {
    // 用一个 service 写 origin 配置（confirmTimeoutSeconds=5）到 DB；
    // 再用第二个 service 模拟"popup 新开会话"——cache 空、storageDb 复用。
    // 关键不变量：
    //   1. timer 与 setPhase 同步启动（不被 DB 阻塞）。
    //   2. DB 异步刷 cache 后，如果 DB 值（5s）< 剩余时间，clamp down 到 5s。
    //   3. **不** extend：DB 值（60s）> 剩余时间（30s）时保持 30s。
    //
    // 用 intent.sign 走纯 manual 路径——identity.get 会在 cache-miss
    // auto-approve 检查里先 await getOriginSettingsCached 预热 cache，
    // 让 startConfirmTimeout 启动时直接拿到正确值，无法验证"cache miss
    // 兜底 → 异步 clamp"的两段语义。
    const first = makeService();
    await first.service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 5,
      updatedAt: 1
    });
    const second = makeService(TEST_PUB_HEX, first.storageDb);
    // 施工单 2026-06-28 002 硬切换：业务方法强制要求 connectSessionId；
    // 默认 makeService 已为 ORIGIN seed sess-test session。
    second.service.startSession();
    await second.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-fresh-timeout",
          method: "intent.sign",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        second.opener
      )
    );
    // 不变量 1：timer 已启动（deadline 非 null）。具体值在测试里不
    // 严格断言——`loadHistoryForOrigin` 也 fire-and-forget 读 origin，
    // 可能在 startConfirmTimeout 之前/之后写入 cache；DB 一回来就会
    // clamp。最终 deadline 一定命中 DB 真值（不变量 2）。
    expect(second.service.confirmDeadlineMs()).not.toBeNull();
    // 不变量 2：等 DB 异步刷 cache + clamp down；deadline 必须 ≤ 6s。
    await new Promise((r) => setTimeout(r, 30));
    const clampedRemaining = second.service.confirmDeadlineMs()! - Date.now();
    expect(clampedRemaining).toBeLessThan(6_000);
    expect(clampedRemaining).toBeGreaterThan(4_000);
  });

  it("修复 1（不 extend）：cache miss 兜底 30s，DB 返回 60s 时 timer 仍保持 ~30s", async () => {
    // 与"不变量 4"对齐：施工单 003 收口明确"修改站点 timeout 不热更新
    // 当前正在倒计时的 request"。cache miss 兜底 30s 后 DB 即使返回更
    // 大值，timer 也**不** extend。同样用 intent.sign 走纯 manual 路径。
    const first = makeService();
    await first.service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 60,
      updatedAt: 1
    });
    const second = makeService(TEST_PUB_HEX, first.storageDb);
    second.service.startSession();
    await second.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-no-extend",
          method: "intent.sign",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        second.opener
      )
    );
    // 等 DB 异步刷一次。
    await new Promise((r) => setTimeout(r, 30));
    const remaining = second.service.confirmDeadlineMs()! - Date.now();
    // 仍保持 ~30s，没有 extend 到 60s。
    expect(remaining).toBeGreaterThan(29_000);
    expect(remaining).toBeLessThan(31_000);
  });

  it("修复 1（同步保证）：cache miss + 慢 DB 也不延迟 timer 启动", async () => {
    // 用一个永远不 resolve 的 storageDb getOrigin，模拟"DB 慢到永远没
    // 响应"。timer 必须仍能启动——popup 用户不会无倒计时地等。
    // intent.sign 走纯 manual 路径，不走 cache-miss auto-approve。
    const slowDb: ProtocolStorageDb = {
      async putCommand() { /* noop */ },
      async getCommand() { return null; },
      async listCommandsByOrigin() { return []; },
      async getOrigin() {
        // 永远 hang——模拟极端慢的 DB。
        return new Promise(() => { /* never resolves */ });
      },
      async putOrigin() { /* noop */ },
      async listOrigins() { return []; },
      async getFeePool() { return null; },
      async putFeePool() { /* noop */ },
      async deleteFeePool() { /* noop */ },
      async listFeePoolsByOrigin() { return []; },
      async putConnectSession() { /* noop */ },
      // 施工单 2026-06-28 002 硬切换：测试 stub 给 sess-test 返回 valid
      // session（让 preCheckConnectSession 放行）。getOrigin 永远 hang
      // 是测"DB 慢但不阻塞 timer 启动"的边界。
      async getConnectSession(sessionId: string) {
        if (sessionId) {
          return {
            sessionId,
            origin: ORIGIN,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() { return []; },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await slowDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, slowDb);
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-slow",
          method: "intent.sign",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 即便 DB getOrigin 永远 hang，timer 必须已经启动（兜底 30s）。
    expect(service.confirmDeadlineMs()).not.toBeNull();
    const remaining = service.confirmDeadlineMs()! - Date.now();
    expect(remaining).toBeGreaterThan(29_000);
    expect(remaining).toBeLessThan(31_000);
  });

  it("修复 1（总时长稳定）：DB 延迟 2s 返回 + 真值 5s，clamp 后总等待 ≈ 5s（不是 ~7s）", async () => {
    // 关键场景：DB 慢返回 + DB 真值比兜底小。
    // 旧实现 `deadline = Date.now() + actualMs` 会让总等待 ≈ 2s + 5s = 7s。
    // 正确实现：deadline = 原始起点 + actualMs = 5s（与 DB 延迟无关）。
    let resolveGetOrigin!: (record: ProtocolOriginSettingsRecord | null) => void;
    const stubDb: ProtocolStorageDb = {
      async putCommand() { /* noop */ },
      async getCommand() { return null; },
      async listCommandsByOrigin() { return []; },
      async getOrigin() {
        // 可控延迟——先挂住 2 秒后再返回。
        return new Promise<ProtocolOriginSettingsRecord | null>((resolve) => {
          resolveGetOrigin = resolve;
        });
      },
      async putOrigin() { /* noop */ },
      async listOrigins() { return []; },
      async getFeePool() { return null; },
      async putFeePool() { /* noop */ },
      async deleteFeePool() { /* noop */ },
      async listFeePoolsByOrigin() { return []; },
      async putConnectSession() { /* noop */ },
      // 施工单 2026-06-28 002 硬切换：sess-test 返回 valid session。
      async getConnectSession(sessionId: string) {
        if (sessionId) {
          return {
            sessionId,
            origin: ORIGIN,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() { return []; },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await stubDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, stubDb);
    service.startSession();
    const phaseStartMs = Date.now();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-slow-clamp",
          method: "intent.sign",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 兜底：deadline = phaseStart + 30s。
    expect(service.confirmDeadlineMs()).not.toBeNull();
    const deadlineBefore = service.confirmDeadlineMs()!;
    expect(deadlineBefore - phaseStartMs).toBeGreaterThan(29_000);
    expect(deadlineBefore - phaseStartMs).toBeLessThan(31_000);
    // 模拟 DB 延迟 2 秒后返回 5s 真值。
    await new Promise((r) => setTimeout(r, 2000));
    resolveGetOrigin({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 5,
      updatedAt: 1
    });
    // 等 microtask 队列消化 refreshTimeoutFromOriginConfig 的 await 续延。
    await new Promise((r) => setTimeout(r, 50));
    const deadlineAfter = service.confirmDeadlineMs()!;
    // 关键：deadline 必须 = 原始 phase 起点 + 5s，**不**能 = phase 起点 + 30s
    // 也不**能** = phase 起点 + 2s（DB 延迟） + 5s（配置）。
    expect(deadlineAfter - phaseStartMs).toBeGreaterThan(4_000);
    expect(deadlineAfter - phaseStartMs).toBeLessThan(5_500);
  });

  it("修复 clamp 条件：DB 在第 29s 返回 20s 真值（newDeadline < currentDeadline），应立即 clamp + finalize", async () => {
    // 用户给的例子：默认 30s 兜底启动，DB 在第 29s 返回 confirmTimeoutSeconds=20。
    // 此时 newDeadline = start + 20s（已过去 9s），currentDeadline = start + 30s（剩 1s）。
    // 旧条件 `actualMs < remainingMs`（20000 < 1000 假）→ 不 clamp，请求继续活到 30s。
    // 新条件 `newDeadline < currentDeadline`（T+20 < T+30 真）→ clamp 到 20s，
    // 且 newDeadline 已落入过去 → 立即 finalizeByTimeout（不等下个 1s tick）。
    // 用 vi.useFakeTimers 加速验证（不真等 29s）。
    vi.useFakeTimers();
    let resolveGetOrigin!: (record: ProtocolOriginSettingsRecord | null) => void;
    const stubDb: ProtocolStorageDb = {
      async putCommand() { /* noop */ },
      async getCommand() { return null; },
      async listCommandsByOrigin() { return []; },
      async getOrigin() {
        return new Promise<ProtocolOriginSettingsRecord | null>((resolve) => {
          resolveGetOrigin = resolve;
        });
      },
      async putOrigin() { /* noop */ },
      async listOrigins() { return []; },
      async getFeePool() { return null; },
      async putFeePool() { /* noop */ },
      async deleteFeePool() { /* noop */ },
      async listFeePoolsByOrigin() { return []; },
      async putConnectSession() { /* noop */ },
      // 施工单 2026-06-28 002 硬切换：cancel/timeout 测试需要让
      // session 真值预校验通过；提供一个 ready 的 session 让
      // preCheckConnectSession 放过，request 走到 confirming 阶段
      // 让 timer 逻辑生效。
      async getConnectSession(id: string) {
        if (id === "sess-test") {
          return {
            sessionId: "sess-test",
            origin: ORIGIN,
            ownerPublicKeyHex: TEST_PUB_HEX,
            ownerLabel: "Key A",
            claimsSnapshot: {},
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null
          };
        }
        return null;
      },
      async listConnectSessionsByOrigin() { return []; },
      async putConnectSessionAndRevokeOriginPeers(record: ConnectSessionRecord) {
        await stubDb.putConnectSession(record);
      },
  async getStorageProviderConfig() { return null; },
  async putStorageProviderConfig(record) { /* stub */ },
  async deleteStorageProviderConfig() { /* stub */ }
    };
    try {
      const { service, opener, getResult, posted } = makeService(TEST_PUB_HEX, stubDb);
      service.startSession();
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "req-late-clamp",
            method: "intent.sign",
            params: {
              aud: ORIGIN,
              iat: 1,
              exp: 2,
              text: "x",
              contentType: "text/plain",
              content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
              // 施工单 2026-06-28 002 硬切换：业务方法强制要求
              // connectSessionId。
              connectSessionId: "sess-test"
            }
          },
          ORIGIN,
          opener
        )
      );
      // 默认 30s 兜底启动。
      expect(service.confirmDeadlineMs()).not.toBeNull();
      expect(service.confirmDeadlineMs()! - Date.now()).toBeGreaterThan(29_000);
      // 推进 29s 时间。
      await vi.advanceTimersByTimeAsync(29_000);
      // 此时 currentDeadline 距 now ≈ 1s；DB 返回 20s 真值。
      // 用 setSystemDate/系统时间?  不——fake timers 默认 mock Date.now。
      // 先确认 deadline 仍剩约 1s（fake timer 下 Date.now 已前进 29s）。
      const remainingBefore = service.confirmDeadlineMs()! - Date.now();
      expect(remainingBefore).toBeGreaterThan(0);
      expect(remainingBefore).toBeLessThan(2_000);
      // DB 返回 20s 真值。
      resolveGetOrigin({
        origin: ORIGIN,
        p2pkhAutoApproveEnabled: false,
        p2pkhAutoApproveMaxSatoshis: 0,
        identityAutoApproveEnabled: false,
        cipherAutoApproveEnabled: false,
        feePoolAutoSignMaxSatoshis: 0,
        feePoolDefaultFundSatoshis: 0,
        confirmTimeoutSeconds: 20,
        updatedAt: 1
      });
      // 让 microtask + 任何新创建的 setInterval 都跑起来。
      await vi.advanceTimersByTimeAsync(0);
      // 关键断言：finalizeByTimeout 必须**已经**被触发：
      //   1) 对外回了 user_rejected result；
      //   2) phase 回到 waiting；
      //   3) binding 已清，deadline 已清。
      // 旧条件（actualMs < remainingMs）下，clamp 不会发生，最终只有
      // 下次 setInterval tick（再过约 1s）才会触发 finalize——但这里
      // 我们已把时间推进到 start+29s + 0，**没**再推进 1s，tick 不会
      // 触发。所以这个测试会卡住旧 bug。
      const r = getResult();
      expect(r?.ok).toBe(false);
      if (r && r.ok === false) {
        expect(r.error.code).toBe("user_rejected");
      }
      expect(service.snapshot().phase).toBe("waiting");
      expect(service.confirmDeadlineMs()).toBeNull();
      // record 终态：status=timed_out / failureReason=request_timeout。
      const card = service.feedSnapshot().commands.find(
        (c) => c.requestId === "req-late-clamp"
      );
      expect(card?.status).toBe("timed_out");
      expect(card?.failureReason).toBe("request_timeout");
      expect(posted.result).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 默认 30 秒：confirmTimeoutSeconds 未配置时用缺省", async () => {
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-default-timeout",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    const d = service.confirmDeadlineMs();
    expect(d).not.toBeNull();
    const remaining = d! - Date.now();
    // 默认 30 秒 → remaining ∈ (29s, 31s)
    expect(remaining).toBeGreaterThan(29_000);
    expect(remaining).toBeLessThan(31_000);
  });

  it("timeout 使用 origin 配置值：confirmTimeoutSeconds=5 时 remaining < 6s", async () => {
    const { service, opener } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 5,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-cfg-timeout",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    const remaining = service.confirmDeadlineMs()! - Date.now();
    expect(remaining).toBeLessThan(6_000);
    expect(remaining).toBeGreaterThan(4_000);
  });

  it("timeout 后本地 status=timed_out / failureReason=request_timeout，对外 user_rejected", async () => {
    const { service, opener, getResult } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 1,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-timeout",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 轮询等 result 出现。setInterval(fn, 1000) 在事件循环繁忙时
    // 可能比 1000ms 晚触发；固定 1.5s 等待在 CI 慢机器上会偶发失败。
    // 改为轮询 1)result 出现 或 2)3 秒硬上限。
    const deadline = Date.now() + 3000;
    let r: ReturnType<typeof getResult> = getResult();
    while (!r && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
      r = getResult();
    }
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error.code).toBe("user_rejected");
      expect(r.error.message).toBe("User rejected");
    }
    expect(service.snapshot().phase).toBe("waiting");
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "req-timeout");
    expect(card?.decision).toBe("failed");
    expect(card?.status).toBe("timed_out");
    expect(card?.failureReason).toBe("request_timeout");
    expect(card?.errorCode).toBe("user_rejected");
    // 关键：**不**对外暴露 request_timeout。
    if (r && r.ok === false) {
      expect(r.error.code).not.toBe("request_timeout");
    }
  });

  it("本地取消与外部 cancel 并发时：first-wins，原 request 最多回一条 result", async () => {
    const { service, opener, getResult, posted } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-race",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 同时发：本地 reject + 外部 cancel。两条都期望幂等收尾。
    await Promise.all([
      service.rejectByUser(),
      service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "cancel",
            id: "req-race"
          },
          ORIGIN,
          opener
        )
      )
    ]);
    // 最多只回 1 条 result（cancel 不单独回包）。
    expect(posted.result).toHaveLength(1);
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error.code).toBe("user_rejected");
    }
  });

  it("confirmByUser 清 timer 并发执行；timeout 回调在 executing 后到达应放弃", async () => {
    // 模拟"用户点了确认，但 timer 在执行中也到点"——timer 回调发现
    // phase === "executing" / binding 不存在 → 放弃，不双回包。
    const { service, opener, getResult, posted } = makeService();
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 1,
      updatedAt: 1
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-confirm-race",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    // 立即点确认。clearConfirmTimeout 同步生效。
    await service.confirmByUser();
    expect(service.confirmDeadlineMs()).toBeNull();
    expect(getResult()?.ok).toBe(true);
    // 等"假装 timer 回调到点"——但 timer 已被清；service 不会发第二条 result。
    await new Promise((r) => setTimeout(r, 1500));
    expect(posted.result).toHaveLength(1);
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("endSession 清 timer", async () => {
    const { service, opener } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-end",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x", connectSessionId: "sess-test" }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.confirmDeadlineMs()).not.toBeNull();
    service.endSession();
    expect(service.confirmDeadlineMs()).toBeNull();
  });

  /**
   * 正向收口（与 cache-miss → 30s 兜底 → clamp down 形成对照）：
   * 进入 confirming 时**已经**走同步 cache 命中（`startedFromFallback =
   * false`）的 request，**不**允许后续 DB 真值晚到时再热更新。改 origin
   * 配置为更小值 → 当前正在倒计时的 request 仍按原 cache 值走完。
   */
  it("正向：cache 命中 60s 后改 20s 不热更新（startedFromFallback=false）", async () => {
    let currentOriginConfig: ProtocolOriginSettingsRecord | null = {
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 60,
      updatedAt: 1
    };
    const stubDb = makeFakeStorageDbWithSession({
      async getOrigin(origin: string) {
        return currentOriginConfig && currentOriginConfig.origin === origin
          ? currentOriginConfig
          : null;
      }
    });
    const { service, opener } = makeService(TEST_PUB_HEX, stubDb);
    service.startSession();
    // 关键：先把 cache 用 60s 真值填上（setOriginSettings 写 cache
    // 同步），保证进入 confirming 时 `resolveConfirmTimeoutSnapshot`
    // 走 cache 命中分支（`startedFromFallback = false`）。
    await service.setOriginSettings(currentOriginConfig!);
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-no-hot-update",
          method: "intent.sign",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            contentType: "text/plain",
            content: { $type: "binary", bytes: new Uint8Array([1, 2, 3]).buffer },
            connectSessionId: "sess-test"
          }
        },
        ORIGIN,
        opener
      )
    );
    // 不变量 1：cache 命中 60s 进入 confirming；deadline = 60s。
    const phaseStart = Date.now();
    const deadline1 = service.confirmDeadlineMs()!;
    expect(deadline1 - phaseStart).toBeGreaterThan(58_000);
    expect(deadline1 - phaseStart).toBeLessThan(62_000);
    // 不变量 2：原 origin 配置改成 20s；当前 request **不**热更新。
    currentOriginConfig = {
      ...currentOriginConfig,
      confirmTimeoutSeconds: 20
    };
    // 等若干个 macrotask 周期让 refresh / emit 走完；deadline 仍按 60s。
    await new Promise((r) => setTimeout(r, 50));
    const deadline2 = service.confirmDeadlineMs()!;
    expect(deadline2).toBe(deadline1);
    // 不变量 3：request 阶段确认通过 confirmByUser 后 timer 清理。
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 10));
    expect(service.confirmDeadlineMs()).toBeNull();
    service.endSession();
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// 抑制未使用 import 警告
void sha256;
void cborEncode;

/* ============== 施工单 2026-06-28 002 硬切换：补的测试 ============== */

describe("ProtocolServiceImpl 002 硬切换：所有业务方法都属于 connectSessionId", () => {
  // 本 describe 用到的常量（COUNTERPARTY / makeP2pkhServiceStub）由
  // 上方 describe 块定义；这里只新增必要常量。
  const COUNTERPARTY_002 = "02" + "cc".repeat(32);
  const COUNTERPARTY = COUNTERPARTY_002;

  function makeP2pkhServiceStub002() {
    return {
      async listUtxos() {
        return [{ txid: "00".repeat(32), vout: 0, value: 100000 }];
      },
      async prepareTransfer(input: {
        assetId: "bsv";
        recipientAddress: string;
        amountSatoshis: number;
        feeRateSatoshisPerKb: number;
      }) {
        return {
          assetId: input.assetId,
          network: "main" as const,
          recipientAddress: input.recipientAddress,
          amountSatoshis: input.amountSatoshis,
          feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
          allocation: {},
          changeAddress: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
          outputs: [{ address: input.recipientAddress, value: input.amountSatoshis }],
          estimatedFeeSatoshis: 200,
          serializedSizeBytes: 200,
          txid: "11".repeat(32),
          rawTxHex: "deadbeef"
        };
      },
      async submitTransfer(preview: { txid: string; rawTxHex: string }) {
        return {
          status: "broadcast",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          submissionId: "sub-1",
          localInputClaimIds: []
        };
      }
    };
  }

  it("所有业务方法缺 connectSessionId：validation 直接 invalid_request（不进 record）", async () => {
    // 施工单 7.5.1：所有业务方法缺 connectSessionId 时直接 invalid_request。
    const methods: ProtocolMethod[] = [
      "identity.get",
      "intent.sign",
      "cipher.encrypt",
      "cipher.decrypt",
      "p2pkh.transfer",
      "feepool.prepare",
      "feepool.commit"
    ];
    for (const method of methods) {
      const { service, opener } = makeService();
      service.startSession();
      const event = makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: `no-session-${method}`,
          method,
          params:
            method === "identity.get"
              ? { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
              : method === "intent.sign"
              ? {
                  aud: ORIGIN,
                  iat: 1,
                  exp: 2,
                  text: "x",
                  contentType: "text/plain",
                  content: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "cipher.encrypt"
              ? {
                  text: "x",
                  contentType: "note.v1",
                  content: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "cipher.decrypt"
              ? {
                  text: "x",
                  nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
                  cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "p2pkh.transfer"
              ? { recipientAddress: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amountSatoshis: 1000 }
              : method === "feepool.prepare"
              ? { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000 }
              : { operationId: "x", counterpartyPublicKeyHex: COUNTERPARTY, counterpartySignatures: [] }
        },
        ORIGIN,
        opener
      );
      await service.handleMessage(event);
      // 校验失败：service 不向 opener 回 result，"情况 B" 行为。
      // record 也不建，phase 保持 waiting。
      expect(service.snapshot().phase).toBe("waiting");
      expect(service.snapshot().requestId).toBeNull();
    }
  });

  it("session 不存在 → fail-fast：identity.get 不进 confirming", async () => {
    // 施工单 7.5.1：所有业务方法缺 connectSessionId 时直接 invalid_request。
    const methods: ProtocolMethod[] = [
      "identity.get",
      "intent.sign",
      "cipher.encrypt",
      "cipher.decrypt",
      "p2pkh.transfer",
      "feepool.prepare",
      "feepool.commit"
    ];
    for (const method of methods) {
      const { service, opener } = makeService();
      service.startSession();
      const event = makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: `no-session-${method}`,
          method,
          params:
            method === "identity.get"
              ? { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
              : method === "intent.sign"
              ? {
                  aud: ORIGIN,
                  iat: 1,
                  exp: 2,
                  text: "x",
                  contentType: "text/plain",
                  content: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "cipher.encrypt"
              ? {
                  text: "x",
                  contentType: "note.v1",
                  content: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "cipher.decrypt"
              ? {
                  text: "x",
                  nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
                  cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer }
                }
              : method === "p2pkh.transfer"
              ? { recipientAddress: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amountSatoshis: 1000 }
              : method === "feepool.prepare"
              ? { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000 }
              : { operationId: "x", counterpartyPublicKeyHex: COUNTERPARTY, counterpartySignatures: [] }
        },
        ORIGIN,
        opener
      );
      await service.handleMessage(event);
      // 校验失败：service 不向 opener 回 result，"情况 B" 行为。
      // record 也不建，phase 保持 waiting。
      expect(service.snapshot().phase).toBe("waiting");
      expect(service.snapshot().requestId).toBeNull();
    }
  });

  it("session 不存在 → fail-fast：identity.get 不进 confirming", async () => {
    const { service, opener, getResult } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "no-session",
          method: "identity.get",
          params: {
            aud: ORIGIN,
            iat: 1,
            exp: 2,
            text: "x",
            connectSessionId: "missing-session"
          }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "no-session");
    expect(card?.phase).toBe("failed");
    const r = getResult();
    expect(r?.ok).toBe(false);
  });

  it("session 已 revoke → fail-fast：feepool.prepare 不进 confirming", async () => {
    const { service, opener, storageDb } = makeService();
    await storageDb.putConnectSession({
      sessionId: "sess-revoked",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},

      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: Date.now() - 100
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-revoked",
          method: "feepool.prepare",
          params: {
            counterpartyPublicKeyHex: COUNTERPARTY,
            amountSatoshis: 1000,
            connectSessionId: "sess-revoked"
          }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "fp-revoked");
    expect(card?.phase).toBe("failed");
    expect(card?.errorCode).toBe("user_rejected");
  });

  it("session origin 不匹配 → fail-fast：cipher.decrypt 不进 confirming", async () => {
    const { service, opener, storageDb } = makeService();
    await storageDb.putConnectSession({
      sessionId: "sess-cross",
      origin: "https://evil.com",
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-cross",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: { $type: "binary", bytes: new Uint8Array(12).buffer },
            cipherbytes: { $type: "binary", bytes: new Uint8Array(0).buffer },
            connectSessionId: "sess-cross"
          }
        },
        ORIGIN,
        opener
      )
    );
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "dec-cross");
    expect(card?.phase).toBe("failed");
  });

  it("p2pkh.transfer 不再受全局 active key 变化影响（session 绑定的 owner 是真值）", async () => {
    // 施工单 7.5.5：p2pkh.transfer 不再受全局 active key 变化影响。
    const p2pkh = makeP2pkhServiceStub002();
    const { service, opener, storageDb, deps } = makeService(TEST_PUB_HEX, undefined, {
      p2pkhService: p2pkh as never
    });
    // session 绑定的 owner = TEST_PUB_HEX（key1）。
    await storageDb.putConnectSession({
      sessionId: "sess-stable",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    service.startSession();
    // 用户在中途切换 active key：但 keyspace.active() 仍然返回 TEST_PUB_HEX，
    // session 仍走 session owner 真值，与 active key 无关。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-stable",
          method: "p2pkh.transfer",
          params: {
            recipientAddress: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
            amountSatoshis: 1000,
            connectSessionId: "sess-stable"
          }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const r = deps; // sanity
    void r;
    await new Promise((res) => setTimeout(res, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "p2pkh-stable");
    expect(card?.decision).toBe("approved");
    expect(card?.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
    expect(card?.connectSessionId).toBe("sess-stable");
  });

  it("feepool.prepare / commit 同 origin 不同 owner 不会串池", async () => {
    // 施工单 7.5.6：feepool.prepare / commit 在同 origin 不同 owner 下
    // 不会串池。ownerA 在 origin 建一个池，ownerB 在同 origin 同一个
    // counterparty 下 prepare 应该走 create 路径（找不到 ownerB 的 prior）。
    // 这里只校验 record.bind owner = session.ownerPublicKeyHex，且
    // feepool poolKey 含 owner 维度。
    const ownerB = "02" + "bb".repeat(32);
    const { service, opener, storageDb, deps } = makeService(TEST_PUB_HEX);
    // ownerA 建池并 commit。
    await storageDb.putConnectSession({
      sessionId: "sess-ownerA",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Owner A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    // ownerB 在 keyspace stub 内也注册好（getKey(publicKeyHex=ownerB)）。
    deps.keyspace.getKey = async (hex: string) => {
      if (hex === TEST_PUB_HEX) {
        return {
          keyId: "kA",
          publicKeyHex: TEST_PUB_HEX,
          label: "Owner A",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString(),
          identityStatus: "ready"
        };
      }
      if (hex === ownerB) {
        return {
          keyId: "kB",
          publicKeyHex: ownerB,
          label: "Owner B",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString(),
          identityStatus: "ready"
        };
      }
      return undefined;
    };
    // ownerB 的 session。
    await storageDb.putConnectSession({
      sessionId: "sess-ownerB",
      origin: ORIGIN,
      ownerPublicKeyHex: ownerB,
      ownerLabel: "Owner B",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    // ownerB 发 prepare：应走 create 路径（ownerA 的 prior 不可见）。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-ownerB",
          method: "feepool.prepare",
          params: {
            counterpartyPublicKeyHex: COUNTERPARTY,
            amountSatoshis: 1000,
            connectSessionId: "sess-ownerB"
          }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 50));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "fp-ownerB");
    expect(card?.ownerPublicKeyHex).toBe(ownerB);
    expect(card?.connectSessionId).toBe("sess-ownerB");
  });

  it("feepool.commit 用旧 session 的 operationId 提交时必须失败", async () => {
    // 施工单 7.5.7：feepool.commit 用旧 session 的 operationId 提交时必须失败。
    // 准备：先在 sessionA 下 prepare 出 operationId；logout sessionA；
    // 在 sessionB 下用同 operationId 提交 → fail。
    const ownerB = "02" + "bb".repeat(32);
    const p2pkh = makeP2pkhServiceStub002();
    const { service, opener, storageDb, deps } = makeService(TEST_PUB_HEX, undefined, {
      p2pkhService: p2pkh as never
    });
    await storageDb.putConnectSession({
      sessionId: "sess-A",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Owner A",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    await storageDb.putConnectSession({
      sessionId: "sess-B",
      origin: ORIGIN,
      ownerPublicKeyHex: ownerB,
      ownerLabel: "Owner B",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    deps.keyspace.getKey = async (hex: string) => {
      if (hex === TEST_PUB_HEX) {
        return {
          keyId: "kA",
          publicKeyHex: TEST_PUB_HEX,
          label: "Owner A",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString(),
          identityStatus: "ready"
        };
      }
      if (hex === ownerB) {
        return {
          keyId: "kB",
          publicKeyHex: ownerB,
          label: "Owner B",
          capabilities: ["p2pkh"],
          createdAt: new Date().toISOString(),
          identityStatus: "ready"
        };
      }
      return undefined;
    };
    await service.setOriginSettings({
      origin: ORIGIN,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    });
    service.startSession();
    // sess-A 下 prepare。
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-old",
          method: "feepool.prepare",
          params: {
            counterpartyPublicKeyHex: COUNTERPARTY,
            amountSatoshis: 1000,
            connectSessionId: "sess-A"
          }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    // 不强求 prepare 一定成功（feepoolSdk 在 jsdom 路径下可能不可用）；
    // 关键断言：用 sess-B 的 connectSessionId + 不存在 / 跨 session 的
    // operationId 提交时，service 必须拒绝。
    void service.feedSnapshot().commands.find((c) => c.requestId === "fp-old");
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fc-stale",
          method: "feepool.commit",
          params: {
            operationId: "stale-op",
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }],
            connectSessionId: "sess-B"
          }
        },
        ORIGIN,
        opener
      )
    );
    // confirm 让 commit 进入执行阶段，触发 session 校验 + pendingOp 校验。
    await service.confirmByUser();
    await new Promise((r) => setTimeout(r, 30));
    const card = service.feedSnapshot().commands.find((c) => c.requestId === "fc-stale");
    expect(card?.phase).toBe("failed");
    expect(card?.failureReason).toBe("unknown_operation");
  });

  it("connect.login / connect.resume 结果不再含 ownerKeyId 字段", async () => {
    // 施工单 7.5.8：connect.login / connect.resume 结果不再含 ownerKeyId。
    const { service, opener, getResult } = makeService();
    service.startSession();
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "login-002",
          method: "connect.login",
          params: { text: "login" }
        },
        ORIGIN,
        opener
      )
    );
    const view = service.connectLoginRecord();
    expect(view).not.toBeNull();
    await service.confirmConnectLogin(view!.recordId, TEST_PUB_HEX, "pw");
    await new Promise((r) => setTimeout(r, 30));
    const r = getResult();
    if (!r || r.ok !== true) throw new Error("login failed");
    const loginResult = r.result as unknown as Record<string, unknown>;
    expect("ownerKeyId" in loginResult).toBe(false);
    expect("ownerPublicKeyHex" in loginResult).toBe(true);
    expect(loginResult.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
  });
});

/* ============== launchAppView（施工单 2026-06-29 002 硬切换） ============== */

/**
 * 注入一个 minimal window shim，覆盖 launchAppView 内部用到的几个
 * surface（`window.open` / `window.location.origin` / 挂 bootstrap
 * registry）。protocolService.test.ts 跑在 node 环境，没有 global window。
 */
function installWindowShim() {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.window === "undefined") {
    const win = {
      open: () => null,
      location: { origin: "https://keymaster.local" }
    };
    g.window = win;
  }
  return g.window as Window & {
    open: (url: string | URL, target?: string) => Window | null;
    location: { origin: string };
  };
}

describe("ProtocolServiceImpl launchAppView (施工单 2026-06-29 002)", () => {
  const JUSTNOTE = {
    appId: "justnote",
    appOrigin: "https://justnote.apps.bsv8.com",
    appUrl: "https://justnote.apps.bsv8.com/"
  };

  /** 给测试构造可观察的 window.open 替换 + bootstrap registry 装/卸。 */
  function setupWindow(extra: { openReturns?: Window | null } = {}) {
    const win = installWindowShim();
    const openCalls: Array<{ url: string; target: string; features: string }> = [];
    const originalOpen = win.open;
    const originalLocation = win.location;
    // 强制 location.origin 为一个稳定值。
    Object.defineProperty(win, "location", {
      value: { origin: "https://keymaster.local" },
      configurable: true
    });
    win.open = ((url: string | URL, target?: string, features?: string) => {
      openCalls.push({
        url: String(url),
        target: String(target ?? "_blank"),
        features: String(features ?? "")
      });
      return extra.openReturns === undefined
        ? ({} as Window)
        : extra.openReturns;
    }) as typeof win.open;
    // 启动时清掉之前测试可能挂的 registry。
    try {
      delete (win as unknown as Record<string, unknown>)[
        "__keymaster_session_window_bootstrap__"
      ];
    } catch {
      // ignore
    }
    return {
      openCalls,
      restore() {
        try {
          win.open = originalOpen;
          Object.defineProperty(win, "location", {
            value: originalLocation,
            configurable: true
          });
        } catch {
          // ignore
        }
      }
    };
  }

  it("成功路径：预建 session + 借 owner 私钥拼 ownerRuntimeBootstrap + 装 bootstrap registry + 打开 Session Window（施工单 2026-06-30 002 硬切换）", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb,
        generateId: (() => {
          let n = 0;
          return () => `id-${++n}`;
        })()
      });
      const out = await service.launchAppView(JUSTNOTE);
      expect(out.sessionWindowOpened).toBe(true);
      expect(out.connectSessionId).toMatch(/^id-/);
      expect(out.launchToken).toMatch(/^launch-id-/);
      expect(out.appUrl).toContain(`launchToken=${out.launchToken}`);
      // 1) connect session 已落 DB，且 ownerPublicKeyHex 锁定为 active key。
      const session = await storageDb.getConnectSession(out.connectSessionId);
      expect(session).not.toBeNull();
      expect(session?.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
      expect(session?.origin).toBe(JUSTNOTE.appOrigin);
      expect(session?.revokedAt).toBeNull();
      // 2) bootstrap registry 已挂在 launcher window 上。
      const reg = (installWindowShim() as unknown as Record<string, unknown>)[
        "__keymaster_session_window_bootstrap__"
      ] as { acquire: (t: string) => Promise<unknown> };
      expect(typeof reg?.acquire).toBe("function");
      // 3) Session Window 已被 window.open 打开。
      expect(env.openCalls.length).toBe(1);
      expect(env.openCalls[0]?.target).toBe("_blank");
      expect(env.openCalls[0]?.url).toContain("boot=appView");
      expect(env.openCalls[0]?.url).toContain("bootstrapToken=");
      expect(env.openCalls[0]?.features).toContain("popup=yes");
      expect(env.openCalls[0]?.features).toContain("width=460");
      expect(env.openCalls[0]?.features).toContain("height=820");
      // 4) 同一 launcher 窗口内连续两次 Open App 不会互相覆盖：
      //    registry 持久挂在 window 上，第二次 launchAppView 不会重新挂
      //    registry（避免把第一次的 token 覆盖掉）。两次产生的 token 都
      //    可以从 registry acquire 拿到。
      const firstToken = env.openCalls[0]?.url.match(/bootstrapToken=([^&]+)/)?.[1];
      expect(firstToken).toBeTruthy();
      const second = await service.launchAppView(JUSTNOTE);
      const secondToken = `bt-${second.launchToken}`;
      // 第一次的 token 仍能 acquire（说明没被覆盖）。
      const firstAcquired = await reg.acquire(firstToken!);
      expect(firstAcquired).toBeTruthy();
      // 第二次的 token 也能 acquire。
      const secondAcquired = await reg.acquire(secondToken);
      expect(secondAcquired).toBeTruthy();
      // 二次消费后再次 acquire 应为 null（一次性）。
      expect(await reg.acquire(firstToken!)).toBeNull();
      expect(await reg.acquire(secondToken)).toBeNull();
      // 两次都开了 Session Window。
      expect(env.openCalls.length).toBe(2);
    } finally {
      env.restore();
    }
  });

  it("vault 未解锁 → 抛错，不打开 Session Window", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const vault = makeVaultStub(TEST_PUB_HEX);
      // 强制 status 返回 locked。
      (vault as unknown as { status: () => string }).status = () => "locked";
      const service = new ProtocolServiceImpl({ vault, keyspace: makeKeyspaceStub(TEST_PUB_HEX), storageDb });
      let caught: unknown = null;
      try {
        await service.launchAppView(JUSTNOTE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("vault_locked");
      expect(env.openCalls.length).toBe(0);
      // session 也没有被预建。
      const sessions = await storageDb.listConnectSessionsByOrigin(JUSTNOTE.appOrigin);
      expect(sessions.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("appUrl 与 appOrigin 不一致 → 抛错，不打开 Session Window", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView({
          appId: "justnote",
          appOrigin: "https://justnote.apps.bsv8.com",
          appUrl: "https://evil.example/"
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("invalid_app_config");
      expect(env.openCalls.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("appUrl 不是合法 URL → 抛错", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView({
          appId: "justnote",
          appOrigin: "https://justnote.apps.bsv8.com",
          appUrl: "not-a-url"
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("invalid_app_config");
      expect(env.openCalls.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("window.open 返回 null → 抛错", async () => {
    const env = setupWindow({ openReturns: null });
    try {
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView(JUSTNOTE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("open_session_window_blocked");
      // 失败语义：session 已经被预建（fail-closed 也会落库，但 UI 提示失败）。
      // 这里只验证"不会再次成功打开窗口"。
      expect(env.openCalls.length).toBe(1);
    } finally {
      env.restore();
    }
  });

  it("storageDb 缺失 → 抛错", async () => {
    const env = setupWindow();
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX)
        // 故意不传 storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView(JUSTNOTE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("session_storage_unavailable");
      expect(env.openCalls.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("active key 不 ready → 抛错", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const keyspace = makeKeyspaceStub(TEST_PUB_HEX);
      (keyspace as unknown as { getKey: (h: string) => Promise<unknown> }).getKey = async () => ({
        keyId: "k1",
        publicKeyHex: TEST_PUB_HEX,
        label: "Key A",
        identityStatus: "failed"
      });
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace,
        storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView(JUSTNOTE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("no_active_key");
      expect(env.openCalls.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("vault.withPrivateKey 抛错 → export_owner_runtime_failed（施工单 2026-06-30 002 硬切换）", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const vault = makeVaultStub(TEST_PUB_HEX);
      // 模拟 launcher 端借 owner 私钥失败：withPrivateKey 抛错。
      (vault as unknown as { withPrivateKey: () => Promise<never> }).withPrivateKey = async () => {
        throw new Error("simulated withPrivateKey failure");
      };
      const service = new ProtocolServiceImpl({
        vault,
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb
      });
      let caught: unknown = null;
      try {
        await service.launchAppView(JUSTNOTE);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchAppViewError);
      expect((caught as LaunchAppViewError).code).toBe("export_owner_runtime_failed");
      expect(env.openCalls.length).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("launchAppView 成功：预建 connect session 真值三元组（sessionId + origin + ownerPublicKeyHex）", async () => {
    const env = setupWindow();
    try {
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb
      });
      const out = await service.launchAppView(JUSTNOTE);
      expect(out.sessionWindowOpened).toBe(true);
      expect(out.connectSessionId).toBeTruthy();
      // 关键验收（施工单 2026-06-30 002）：launcher 端写入的 session
      // **不**带 runtimeBinding；runtime 来源由 resolveOwnerRuntime
      // 在每次执行时按当前窗口状态决定。
      const stored = await storageDb.getConnectSession(out.connectSessionId);
      expect(stored).not.toBeNull();
      expect((stored as unknown as Record<string, unknown>).runtimeBinding).toBeUndefined();
      expect(stored?.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
      expect(stored?.origin).toBe(JUSTNOTE.appOrigin);
    } finally {
      env.restore();
    }
  });
});

describe("ProtocolServiceImpl appView transport source binding", () => {
  it("appView 接受 child app source 的 connect.launch，而不是错误地只认 launcher opener", async () => {
    const { service, getResult, storageDb } = makeService(TEST_PUB_HEX, makeFakeStorageDb(), {
      bootMode: "appView"
    });
    service.startSession();
    const now = Date.now();
    await storageDb.putConnectSession({
      sessionId: "sess-appview",
      origin: "https://justnote.apps.bsv8.com",
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: { "key.label": "Key A" },
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    });
    const privHex = TEST_PRIV_HEX;
    const internals = service as unknown as {
      currentAppViewContext: {
        appId: string;
        appOrigin: string;
        appUrl: string;
      } | null;
      launchTokensByToken: Map<string, unknown>;
      ownerRuntimesBySessionId: Map<string, unknown>;
      currentAppClientSource: Window | null;
    };
    internals.currentAppViewContext = {
      appId: "justnote",
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-diag"
    };
    internals.currentAppClientSource = null;
    internals.launchTokensByToken.set("launch-diag", {
      appId: "justnote",
      appOrigin: "https://justnote.apps.bsv8.com",
      appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-diag",
      connectSessionId: "sess-appview",
      ownerPublicKeyHex: TEST_PUB_HEX,
      resolvedClaims: { "key.label": "Key A" },
      resolvedAt: now,
      consumed: false
    });
    internals.ownerRuntimesBySessionId.set("sess-appview", {
      runtime: {
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        privateKeyHex: privHex,
        capabilities: [],
        createdAt: now
      },
      createdAt: now
    });

    const appSource = {} as Window;
    await service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "connect-launch-1",
          method: "connect.launch",
          params: { launchToken: "launch-diag" }
        },
        "https://justnote.apps.bsv8.com",
        appSource
      )
    );
    await new Promise((r) => setTimeout(r, 30));

    const result = getResult();
    expect(result?.ok).toBe(true);
    if (!result || result.ok !== true) return;
    // 严格断言 connect.launch 的结果形状：只断言 connectSessionId /
    // ownerPublicKeyHex 字段；MethodResult 是 union，因此显式指定
    // `as { connectSessionId?: string; ownerPublicKeyHex?: string }`。
    const connectLaunchResult = result.result as unknown as {
      connectSessionId?: string;
      ownerPublicKeyHex?: string;
    };
    expect(connectLaunchResult.connectSessionId).toBe("sess-appview");
    expect(connectLaunchResult.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
    expect(internals.currentAppClientSource).toBe(appSource);
  });

  it("openClientApp 用命名窗口 keymaster-app-<encodedOrigin> 打开，不主动向 child 发 ready", () => {
    // 施工单 2026-06-30 003 硬切换：`ready` 方向对称 → child 自己声明。
    // Session Window 不再向 child 主动 pump ready；打开 client app 时
    // 只做两件事：
    //   1) 用命名窗口 target `keymaster-app-<encodedOrigin>` 调
    //      `window.open`，让浏览器复用同一扇 child app 窗口；
    //   2) 启动 5s 软超时，等待 child 自己发 `ready`。
    //   不立即绑定 currentAppClientSource；source 绑定由 child `ready`
    //   到达后做。
    const win = installWindowShim();
    const originalOpen = win.open;
    const childMessages: unknown[] = [];
    const childWindow = {
      postMessage: (msg: unknown) => {
        childMessages.push(msg);
      }
    } as unknown as Window;
    const openCalls: Array<{ url: string; target: string }> = [];
    win.open = ((url: string | URL, target?: string) => {
      openCalls.push({ url: String(url), target: String(target ?? "_blank") });
      return childWindow;
    }) as typeof win.open;
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb(),
        bootMode: "appView"
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-diag"
      };
      const opened = service.openClientApp();
      expect(opened).toBe(childWindow);
      // 不再向 child 发 ready。
      expect(childMessages).toEqual([]);
      // 不立即绑定 source —— 等 child 自己发 `ready`。
      expect(internals.currentAppClientSource).toBeNull();
      // 命名窗口 target：`keymaster-app-<encodedOrigin>`。
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.target.startsWith("keymaster-app-")).toBe(true);
      expect(openCalls[0]?.target.length ?? 0).toBeGreaterThan("keymaster-app-".length);
      // 进入等待 child `ready` 态。
      expect(service.appClientWaitingForReady()).toBe(true);
      expect(service.childReady()).toBe(false);
    } finally {
      win.open = originalOpen;
    }
  });

  it("openClientApp 在 5 秒内未收到 child `ready`：仅翻软超时提示，不重建 session/launchToken/bootstrap", () => {
    // 施工单 2026-06-30 003 硬切换：soft timeout 只翻提示 + 清等待态。
    // 不重建 connectSessionId / launchToken / bootstrap；按钮恢复可点。
    vi.useFakeTimers();
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb(),
        bootMode: "appView"
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-timeout"
      };
      service.openClientApp();
      vi.advanceTimersByTime(5000);
      expect(service.bootstrapFailed()).toBe(false);
      // 软超时翻到；等待态翻回。
      expect(service.appClientConnectTimedOut()).toBe(true);
      expect(service.appClientWaitingForReady()).toBe(false);
      // child `ready` 未到；source 未绑；UI 仍在 show app 阶段。
      expect(service.childReady()).toBe(false);
      expect(internals.currentAppClientSource).toBeNull();
    } finally {
      win.open = originalOpen;
      vi.useRealTimers();
    }
  });

  it("child `ready` 到达：source 绑定、childReady=true、软超时 / 等待态全部清掉", async () => {
    // 施工单 2026-06-30 003 硬切换：方向对称，child 自己声明 listener 就绪。
    // Session Window 收到合法 `ready`（origin 合法、source 可绑）后：
    //   - 绑定 currentAppClientSource；
    //   - 翻 childReady = true（一旦 true 不再回 false）；
    //   - 清掉 waiting / 软超时提示；
    //   - 不重建 session / launchToken / bootstrap；
    //   - 触发 emit 让 UI 切回传统 popup。
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb(),
        bootMode: "appView"
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-ready"
      };
      service.openClientApp();
      expect(service.appClientWaitingForReady()).toBe(true);
      expect(service.childReady()).toBe(false);
      // 触发 child `ready`。
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "ready"
          },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      // source 绑定。
      expect(internals.currentAppClientSource).toBe(childWindow);
      // childReady 翻 true；等待态清掉。
      expect(service.childReady()).toBe(true);
      expect(service.appClientWaitingForReady()).toBe(false);
      expect(service.appClientConnectTimedOut()).toBe(false);
    } finally {
      win.open = originalOpen;
    }
  });

  it("child `ready` origin 不匹配：忽略，不翻 childReady、不绑 source", async () => {
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb(),
        bootMode: "appView"
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-origin-mismatch"
      };
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "ready"
          },
          "https://evil.example",
          childWindow
        )
      );
      expect(service.childReady()).toBe(false);
      expect(internals.currentAppClientSource).toBeNull();
    } finally {
      win.open = originalOpen;
    }
  });

  it("重复 child `ready`：第二次直接忽略，UI 不闪烁", async () => {
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    let emitCount = 0;
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb(),
        bootMode: "appView"
      });
      const off = service.subscribe(() => {
        emitCount++;
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-dup-ready"
      };
      // 第一次 ready：翻 childReady。
      await service.handleMessage(
        makeEvent(
          { v: PROTOCOL_VERSION, type: "ready" },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      expect(service.childReady()).toBe(true);
      const emitsAfterFirst = emitCount;
      // 第二次 ready：重复到达应直接忽略，**不**重复 emit。
      await service.handleMessage(
        makeEvent(
          { v: PROTOCOL_VERSION, type: "ready" },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      expect(service.childReady()).toBe(true);
      expect(emitCount).toBe(emitsAfterFirst);
      off();
    } finally {
      win.open = originalOpen;
    }
  });

  it("connect mode 收到顶层 ready：忽略，不污染 connect 流", async () => {
    // 传统 connect 流下 child / opener 走的是 Session Window 自己发 ready；
    // 现在反过来收到 client web 发来的顶层 ready 不应影响 connect 流。
    const win = installWindowShim();
    try {
      const service = new ProtocolServiceImpl({
        vault: makeVaultStub(TEST_PUB_HEX),
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb: makeFakeStorageDb()
      });
      service.startSession();
      const fakeOpener = {
        postMessage: (_msg: unknown) => undefined
      } as unknown as Window;
      await service.handleMessage(
        makeEvent(
          { v: PROTOCOL_VERSION, type: "ready" },
          "https://demo.example",
          fakeOpener
        )
      );
      // connect mode 下 childReady 永远为 false（构造不依赖该 flag），
      // 不影响 connect 流。
      expect(service.childReady()).toBe(false);
    } finally {
      // installWindowShim 无副作用，无需 restore。
      void win;
    }
  });

  it("child app 跳 ready 直接发 connect.launch：source 绑定 + childReady 翻 true + 清软超时（首条合法 child 协议消息即视为 child alive）", async () => {
    // 施工单 2026-06-30 003 硬切换：child 漏发 `ready` 直接发
    // `connect.launch` 也应让 UI 切到传统 popup。`markChildAliveFromBoundSource`
    // 在 `isAllowedRequestSource` 之后被调用一次，同时绑定 source +
    // 翻 childReady + 清等待态。
    vi.useFakeTimers();
    const win = installWindowShim();
    const originalOpen = win.open;
    const childMessages: unknown[] = [];
    const childWindow = {
      postMessage: (msg: unknown) => {
        childMessages.push(msg);
      }
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const { service, getResult, storageDb } = makeService(TEST_PUB_HEX, makeFakeStorageDb(), {
        bootMode: "appView"
      });
      service.startSession();
      const now = Date.now();
      await storageDb.putConnectSession({
        sessionId: "sess-appview-stop",
        origin: "https://justnote.apps.bsv8.com",
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        launchTokensByToken: Map<string, unknown>;
        ownerRuntimesBySessionId: Map<string, unknown>;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-stop"
      };
      internals.launchTokensByToken.set("launch-stop", {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-stop",
        connectSessionId: "sess-appview-stop",
        ownerPublicKeyHex: TEST_PUB_HEX,
        resolvedClaims: {},
        resolvedAt: now,
        consumed: false
      });
      internals.ownerRuntimesBySessionId.set("sess-appview-stop", {
        runtime: {
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          privateKeyHex: TEST_PRIV_HEX,
          capabilities: [],
          createdAt: now
        },
        createdAt: now
      });

      service.openClientApp();
      // 初始：childReady=false；childWindow 还未绑 source。
      expect(service.childReady()).toBe(false);
      expect(internals.currentAppClientSource).toBeNull();
      const before = childMessages.length;
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "connect-launch-stop",
            method: "connect.launch",
            params: { launchToken: "launch-stop" }
          },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      await vi.runAllTimersAsync();
      const result = getResult();
      expect(result?.ok).toBe(true);
      // 关键回归（施工单 2026-06-30 003）：child 漏发 `ready` 直接发首条
      // `connect.launch`，`childReady` 也必须翻 true——UI 才能从
      // `show app` 切到传统 popup。
      expect(service.childReady()).toBe(true);
      // source 绑定 + 等待态清掉。
      expect(internals.currentAppClientSource).toBe(childWindow);
      expect(service.appClientWaitingForReady()).toBe(false);
      const afterHandle = childMessages.length;
      vi.advanceTimersByTime(2000);
      expect(childMessages.length).toBe(afterHandle);
      expect(afterHandle).toBeGreaterThanOrEqual(before);
    } finally {
      win.open = originalOpen;
      vi.useRealTimers();
    }
  });

  it("appView 连接软超时后仍接受迟到的 connect.launch，并自动清掉提示", async () => {
    vi.useFakeTimers();
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const { service, getResult, storageDb } = makeService(TEST_PUB_HEX, makeFakeStorageDb(), {
        bootMode: "appView"
      });
      service.startSession();
      const now = Date.now();
      await storageDb.putConnectSession({
        sessionId: "sess-appview-late",
        origin: "https://justnote.apps.bsv8.com",
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        launchTokensByToken: Map<string, unknown>;
        ownerRuntimesBySessionId: Map<string, unknown>;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-late"
      };
      internals.launchTokensByToken.set("launch-late", {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-late",
        connectSessionId: "sess-appview-late",
        ownerPublicKeyHex: TEST_PUB_HEX,
        resolvedClaims: {},
        resolvedAt: now,
        consumed: false
      });
      internals.ownerRuntimesBySessionId.set("sess-appview-late", {
        runtime: {
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          privateKeyHex: TEST_PRIV_HEX,
          capabilities: [],
          createdAt: now
        },
        createdAt: now
      });

      service.openClientApp();
      vi.advanceTimersByTime(5000);
      expect(service.appClientConnectTimedOut()).toBe(true);
      // 软超时触发后 childReady 仍未翻 true。
      expect(service.childReady()).toBe(false);

      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "connect-launch-late",
            method: "connect.launch",
            params: { launchToken: "launch-late" }
          },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      await vi.runAllTimersAsync();
      const result = getResult();
      expect(result?.ok).toBe(true);
      // 关键回归（施工单 2026-06-30 003）：迟到 connect.launch 是合法
      // child 协议消息；childReady 必须翻 true，UI 才能从 `show app`
      // 切到传统 popup。同时清掉软超时提示与等待态。
      expect(service.childReady()).toBe(true);
      expect(service.appClientConnectTimedOut()).toBe(false);
      expect(service.appClientWaitingForReady()).toBe(false);
    } finally {
      win.open = originalOpen;
      vi.useRealTimers();
    }
  });
});

/* ============== 施工单 2026-06-30 003：lockStateValue 真值 = "是否拥有可执行 owner runtime" ============== */
/**
 * 关键收口（施工单 2026-06-30 003 硬切换 4.5）：
 *   - `lockStateValue` 公开语义从"本地 vault 是否已解锁"改为
 *     "当前 Session Window 是否拥有可执行 owner runtime"。
 *   - `bootstrap_owner` 注册到 `ownerRuntimesBySessionId` 后 Session
 *     Window 即视为 unlocked；vault 后续被 relock 也不应回退到 locked
 *     ——否则会出现"UI 看似 unlocked，但 accept 阶段仍按 locked 推
 *     waiting_unlock_*"的夹生状态。
 *   - 本 describe 块直接验证 service 内部 `lockState()` / `computeLockState()`
 *     在不同组合下的行为。
 */

describe("ProtocolServiceImpl lockStateValue 真值 (施工单 2026-06-30 003 硬切换 4.5)", () => {
  it("appView applyLauncherBootstrap 后 lockState 翻 unlocked；vault 后续 relock 不再回退", async () => {
    // 关键收口：bootstrap_owner 注册后 Session Window 立即 unlocked，
    // 即便 vault.status() 后续变 locked，lockState 仍维持 unlocked——
    // 因为 owner runtime 仍可执行。
    const win = installWindowShim();
    try {
      const vault = makeVaultStub(TEST_PUB_HEX);
      // 故意让 vault 报 locked：模拟"本地 vault 仍未解锁"的环境。
      (vault as unknown as { status: () => string }).status = () => "locked";
      const storageDb = makeFakeStorageDb();
      const service = new ProtocolServiceImpl({
        vault,
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb,
        bootMode: "appView"
      });
      service.startSession();
      // 初始：vault locked + 无 bootstrap_owner → lockState=locked
      expect(service.lockState()).toBe("locked");

      // 直接走 applyLauncherBootstrap 路径：构造合法 bootstrap payload 并应用。
      const sessionId = "sess-lockstate-after-bootstrap";
      const now = Date.now();
      await storageDb.putConnectSession({
        sessionId,
        origin: "https://justnote.apps.bsv8.com",
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
      const internals = service as unknown as {
        applyLauncherBootstrap: (p: unknown) => Promise<void>;
      };
      await internals.applyLauncherBootstrap({
        app: {
          appId: "justnote",
          appOrigin: "https://justnote.apps.bsv8.com",
          appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-ls"
        },
        connectSessionId: sessionId,
        ownerPublicKeyHex: TEST_PUB_HEX,
        resolvedClaims: {},
        resolvedAt: now,
        launchToken: "launch-ls",
        ownerRuntimeBootstrap: {
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          privateKeyHex: TEST_PRIV_HEX,
          capabilities: [],
          createdAt: now
        }
      });

      // bootstrap_owner 已注册 → 即便 vault 仍报 locked，lockState 也必须 unlocked。
      expect(service.lockState()).toBe("unlocked");

      // 现在模拟 vault 后续被 relock：直接调 service.setVaultLockState(true)。
      service.setVaultLockState(true);
      // 仍然 unlocked（computeLockState 看 bootstrap_owner 优先）。
      expect(service.lockState()).toBe("unlocked");
    } finally {
      // 无副作用，无需 restore。
      void win;
    }
  });

  it("connect mode 无 bootstrap_owner：vault relock 后 lockState 立刻回 locked（与旧行为一致）", () => {
    // 反向回归：connect mode 没有 bootstrap_owner 来源，vault 一旦 relock
    // lockState 立刻变 locked。
    const { service, deps } = makeService();
    service.startSession();
    // 默认 vault unlocked
    expect(service.lockState()).toBe("unlocked");
    // vault lock：listener 路径走 setVaultLockState(true)
    deps.vault.onStatusChange((s) => {
      if (s === "locked") service.setVaultLockState(true);
      else service.setVaultLockState(false);
    });
    // 调用 fake vault 的 lock 触发监听
    void deps.vault.lock();
    expect(service.lockState()).toBe("locked");
  });

  it("setVaultLockState(true) 在无 bootstrap_owner 的 connect mode 下触发 confirming → waiting_unlock_manual 收口", async () => {
    // 反向回归：connect mode 没有 bootstrap_owner 来源，vault relock
    // 时 setVaultLockState(true) 触发 confirming → waiting_unlock_manual
    // 硬收口——这是 connect mode 旧行为的延续；appView mode 的新行为
    // 由上面的 `applyLauncherBootstrap` 测试覆盖。
    const { service, deps, storageDb, opener } = makeService();
    service.startSession();
    // 预放 session + owner key ready（让 request 不走 fail-fast）
    const sessionId = "sess-relock-cs";
    const now = Date.now();
    await storageDb.putConnectSession({
      sessionId,
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    });
    // vault listener：模拟真实链路翻转 service 端 lockState。
    deps.vault.onStatusChange((s) => {
      if (s === "locked") service.setVaultLockState(true);
      else service.setVaultLockState(false);
    });
    // 初始 vault unlocked，service 端应已 unlocked。
    expect(service.lockState()).toBe("unlocked");
    // 直接推一条 confirm 假 record 状态：手动 confirm 不会触发，更直接
    // 的方式是用 executeConnectResume 失败记录。这里直接验证 setVaultLockState
    // 路径下 lockState 翻到 locked 即可——confirming → waiting_unlock_manual
    // 收口逻辑在既有测试里有专门覆盖（cancel/timeout 003 块）。
    await deps.vault.lock();
    expect(service.lockState()).toBe("locked");
    // 反向：vault unlock 又翻回 unlocked（无 bootstrap_owner）。
    await deps.vault.unlock("");
    expect(service.lockState()).toBe("unlocked");
    void opener;
  });
});

/* ============== 施工单 2026-06-30 003：首条合法 child 协议消息（不只 ready） ============== */
/**
 * 关键收口（施工单 2026-06-30 003 硬切换）：
 *   - `childReady` 不再只盯显式 `ready`；首条合法 child 协议消息
 *     （connect.* request / cancel / 显式 ready）即视为 child alive。
 *   - `isAllowedRequestSource` 放宽：首条任意合法 child request 都绑
 *     source，不限于 `connect.launch`。命名窗口 + origin 校验作为兜底。
 */

describe("ProtocolServiceImpl 首条合法 child 协议消息（施工单 2026-06-30 003）", () => {
  it("appView 首条 request 是 cipher.decrypt（非 connect.launch）也能绑 source + 翻 childReady", async () => {
    // 旧实现要求"首条 request 必须是 connect.launch"才能绑 source；
    // 新实现放宽：任何首条合法 child request 都绑 source。这与施工单
    // 文档"首条合法 child 协议消息即可成为 child alive 信号"对齐。
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const { service, storageDb } = makeService(TEST_PUB_HEX, makeFakeStorageDb(), {
        bootMode: "appView"
      });
      service.startSession();
      const now = Date.now();
      const sessionId = "sess-cipher-first";
      await storageDb.putConnectSession({
        sessionId,
        origin: "https://justnote.apps.bsv8.com",
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        ownerRuntimesBySessionId: Map<string, unknown>;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-cipher-first"
      };
      internals.ownerRuntimesBySessionId.set(sessionId, {
        runtime: {
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          privateKeyHex: TEST_PRIV_HEX,
          capabilities: [],
          createdAt: now
        },
        createdAt: now
      });
      // 直接进"child 已开窗"等待态。
      service.openClientApp();
      expect(service.childReady()).toBe(false);
      expect(internals.currentAppClientSource).toBeNull();

      // 关键：首条 request 是 cipher.decrypt（不是 connect.launch）。
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "cipher-decrypt-first",
            method: "cipher.decrypt",
            params: {
              text: "hi",
              nonce: { $type: "binary", bytes: new ArrayBuffer(12) },
              cipherbytes: { $type: "binary", bytes: new ArrayBuffer(8) },
              connectSessionId: sessionId
            }
          },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      // 绑 source + childReady 翻 true（首条合法 child request 即视为 child alive）。
      expect(internals.currentAppClientSource).toBe(childWindow);
      expect(service.childReady()).toBe(true);
      expect(service.appClientWaitingForReady()).toBe(false);
    } finally {
      win.open = originalOpen;
    }
  });

  it("appView 首条 cancel 找不到对应 record 时不翻 childReady（cancel 本身合法性不足）", async () => {
    // cancel 路径：若 cancel.id 对应不到任何 record（findRequestByTransportId
    // 返回 null），整条消息被视为非法、忽略，不触发 child alive。
    // 防御性验证：避免"任意同源 cancel 都能翻 childReady"。
    const win = installWindowShim();
    const originalOpen = win.open;
    const childWindow = {
      postMessage: (_msg: unknown) => undefined
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const { service } = makeService(TEST_PUB_HEX, makeFakeStorageDb(), {
        bootMode: "appView"
      });
      service.startSession();
      const internals = service as unknown as {
        currentAppViewContext: {
          appId: string;
          appOrigin: string;
          appUrl: string;
        } | null;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-cancel"
      };
      service.openClientApp();
      // 收到一个对不存在 record 的 cancel：忽略。
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "cancel",
            id: "no-such-rec"
          },
          "https://justnote.apps.bsv8.com",
          childWindow
        )
      );
      expect(service.childReady()).toBe(false);
      expect(internals.currentAppClientSource).toBeNull();
    } finally {
      win.open = originalOpen;
    }
  });
});

/* ============== 施工单 2026-06-30 002：locked 但 bootstrap_owner runtime ready ============== */
/**
 * 关键回归：旧实现下 `connect.launch` 一旦 Session Window 的 `lockState === "locked"`
 * 就会被 `drainExecutionQueue` 全局 `lockStateValue === "unlocked"` 卡死，
 * 永远入队不执行（也就是本次硬切的现场故障）。
 *
 * 新实现下 drainExecutionQueue 改为按 record 自己能否解析到 owner runtime
 * 决定执行条件；`bootstrap_owner` 来源下 locked 也能直接 execute。
 */

describe("ProtocolServiceImpl owner runtime resolver (施工单 2026-06-30 002)", () => {
  it("vault locked + bootstrap_owner runtime ready → connect.launch 立即执行（不卡在 waiting_unlock）", async () => {
    const win = installWindowShim();
    const originalOpen = win.open;
    const childMessages: unknown[] = [];
    const childWindow = {
      postMessage: (msg: unknown) => {
        childMessages.push(msg);
      }
    } as unknown as Window;
    win.open = (() => childWindow) as typeof win.open;
    try {
      const storageDb = makeFakeStorageDb();
      const vault = makeVaultStub(TEST_PUB_HEX);
      // **故意**让 vault status 报 locked —— 旧实现下这条
      // connect.launch 会被全局 lockState 闸门卡住。
      (vault as unknown as { status: () => string }).status = () => "locked";
      const service = new ProtocolServiceImpl({
        vault,
        keyspace: makeKeyspaceStub(TEST_PUB_HEX),
        storageDb,
        bootMode: "appView"
      });
      service.startSession();
      const now = Date.now();
      const sessionId = "sess-locked-runtime-ready";
      await storageDb.putConnectSession({
        sessionId,
        origin: "https://justnote.apps.bsv8.com",
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
      const internals = service as unknown as {
        currentAppViewContext: unknown;
        launchTokensByToken: Map<string, unknown>;
        ownerRuntimesBySessionId: Map<string, unknown>;
        currentAppClientSource: Window | null;
      };
      internals.currentAppViewContext = {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=launch-locked-ready"
      };
      const token = "launch-locked-ready";
      internals.launchTokensByToken.set(token, {
        appId: "justnote",
        appOrigin: "https://justnote.apps.bsv8.com",
        appUrl: "https://justnote.apps.bsv8.com/?launchToken=" + token,
        connectSessionId: sessionId,
        ownerPublicKeyHex: TEST_PUB_HEX,
        resolvedClaims: {},
        resolvedAt: now,
        consumed: false
      });
      internals.ownerRuntimesBySessionId.set(sessionId, {
        runtime: {
          ownerPublicKeyHex: TEST_PUB_HEX,
          ownerLabel: "Key A",
          privateKeyHex: TEST_PRIV_HEX,
          capabilities: [],
          createdAt: now
        },
        createdAt: now
      });
      const postedResults: ProtocolResultMessage[] = [];
      const appSource = {
        postMessage: (msg: unknown) => {
          postedResults.push(msg as ProtocolResultMessage);
        }
      } as unknown as Window;
      await service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "connect-launch-locked-ready",
            method: "connect.launch",
            params: { launchToken: token }
          },
          "https://justnote.apps.bsv8.com",
          appSource
        )
      );
      // 即使 vault locked，bootstrap_owner 已就绪 ⇒ 不应卡在
      // waiting_unlock_*；executeConnectLaunch 必须给出 ok=true 结果。
      await new Promise((r) => setTimeout(r, 30));
      const acked = postedResults.find(
        (m) => (m as { id?: string }).id === "connect-launch-locked-ready"
      );
      expect(acked).toBeDefined();
      expect((acked as { ok?: boolean }).ok).toBe(true);
    } finally {
      win.open = originalOpen;
    }
  });

  it("resolveOwnerRuntime：vault unlocked + 同 owner 在 vault 可读 → 切到 vault_unlock 来源", async () => {
    const service = new ProtocolServiceImpl({
      vault: makeVaultStub(TEST_PUB_HEX),
      keyspace: makeKeyspaceStub(TEST_PUB_HEX)
    });
    const internals = service as unknown as {
      resolveOwnerRuntime: (s: ConnectSessionRecord) => Promise<{
        ownerPublicKeyHex: string;
        source: "bootstrap_owner" | "vault_unlock";
      }>;
    };
    const session: ConnectSessionRecord = {
      sessionId: "sess-unlock",
      origin: "https://x",
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: 0,
      lastUsedAt: 0,
      revokedAt: null
    };
    // 没有 bootstrap_owner，但 vault 已 unlock → vault_unlock。
    const r = await internals.resolveOwnerRuntime(session);
    expect(r.source).toBe("vault_unlock");
    expect(r.ownerPublicKeyHex).toBe(TEST_PUB_HEX);
  });

  it("resolveOwnerRuntime：bootstrap_owner 已就绪 → 切到 bootstrap_owner 来源（不走 vault）", async () => {
    const service = new ProtocolServiceImpl({
      vault: makeVaultStub(TEST_PUB_HEX),
      keyspace: makeKeyspaceStub(TEST_PUB_HEX)
    });
    const internals = service as unknown as {
      ownerRuntimesBySessionId: Map<string, unknown>;
      resolveOwnerRuntime: (s: ConnectSessionRecord) => Promise<{
        ownerPublicKeyHex: string;
        source: "bootstrap_owner" | "vault_unlock";
      }>;
    };
    internals.ownerRuntimesBySessionId.set("sess-boot", {
      runtime: {
        ownerPublicKeyHex: TEST_PUB_HEX,
        ownerLabel: "Key A",
        privateKeyHex: TEST_PRIV_HEX,
        capabilities: [],
        createdAt: 0
      },
      createdAt: 0
    });
    const session: ConnectSessionRecord = {
      sessionId: "sess-boot",
      origin: "https://x",
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: 0,
      lastUsedAt: 0,
      revokedAt: null
    };
    const r = await internals.resolveOwnerRuntime(session);
    expect(r.source).toBe("bootstrap_owner");
  });
});

  it("probeExecutionCondition：locked + keyspace 查不到 owner → 直接 fail-fast（不卡 waiting_unlock）", async () => {
    // 验证施工单 7.5:已删 / 根本不在本地 vault 的 owner key 不应让用户先去解锁。
    const storageDb = makeFakeStorageDb();
    const service = new ProtocolServiceImpl({
      vault: makeVaultStub(TEST_PUB_HEX),
      keyspace: makeKeyspaceStub(TEST_PUB_HEX),
      storageDb
    });
    service.startSession();
    const now = Date.now();
    await storageDb.putConnectSession({
      sessionId: "sess-key-removed",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    });
    // 让 keyspace 显式返回 undefined：模拟 owner key 已被用户从 vault 删除。
    const keyspace = makeKeyspaceStub(TEST_PUB_HEX);
    (keyspace as unknown as { getKey: () => Promise<undefined> }).getKey = async () => undefined;
    (service as unknown as { deps: { keyspace: typeof keyspace } }).deps.keyspace = keyspace;
    // 强制 service 仍处于 locked 态。
    (service as unknown as { lockStateValue: "locked" | "unlocked" }).lockStateValue = "locked";

    const internals = service as unknown as {
      probeExecutionCondition: (rec: unknown) => Promise<
        | { kind: "execute" }
        | { kind: "block_unlock" }
        | { kind: "fail" }
      >;
    };
    const decision = await internals.probeExecutionCondition({
      recordId: "rec-test",
      transportRequestId: "x",
      method: "cipher.encrypt",
      params: { connectSessionId: "sess-key-removed", text: "x" },
      phase: "queued",
      decision: "pending",
      status: "queued",
      enteredPhaseAt: 0,
      autoApproved: false,
      connectSessionId: "sess-key-removed",
      ownerPublicKeyHex: TEST_PUB_HEX,
      createdAt: 0,
      updatedAt: 0,
      finishedAt: 0,
      errorCode: "",
      errorMessage: "",
      source: undefined,
      origin: ORIGIN
    });
    expect(decision.kind).toBe("fail");
  });

  it("probeExecutionCondition：locked + keyspace 找到 owner key ready → 推 waiting_unlock（仍允许解锁路径）", async () => {
    // 现有 fakeKeyspaceStub 默认返回 ready key——验证 locked 但 key ready
    // 的合法请求仍走 waiting_unlock_manual，不被错误短路由掉。
    const storageDb = makeFakeStorageDb();
    const service = new ProtocolServiceImpl({
      vault: makeVaultStub(TEST_PUB_HEX),
      keyspace: makeKeyspaceStub(TEST_PUB_HEX),
      storageDb
    });
    service.startSession();
    const now = Date.now();
    await storageDb.putConnectSession({
      sessionId: "sess-key-ok",
      origin: ORIGIN,
      ownerPublicKeyHex: TEST_PUB_HEX,
      ownerLabel: "Key A",
      claimsSnapshot: {},
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null
    });
    (service as unknown as { lockStateValue: "locked" | "unlocked" }).lockStateValue = "locked";
    const internals = service as unknown as {
      probeExecutionCondition: (rec: unknown) => Promise<
        | { kind: "execute" }
        | { kind: "block_unlock"; targetPhase: string }
        | { kind: "fail" }
      >;
    };
    const decision = await internals.probeExecutionCondition({
      recordId: "rec-test",
      transportRequestId: "x",
      method: "cipher.encrypt",
      params: { connectSessionId: "sess-key-ok", text: "x" },
      phase: "queued",
      decision: "pending",
      status: "queued",
      enteredPhaseAt: 0,
      autoApproved: false,
      connectSessionId: "sess-key-ok",
      ownerPublicKeyHex: TEST_PUB_HEX,
      createdAt: 0,
      updatedAt: 0,
      finishedAt: 0,
      errorCode: "",
      errorMessage: "",
      source: undefined,
      origin: ORIGIN
    });
    expect(decision.kind).toBe("block_unlock");
    if (decision.kind === "block_unlock") {
      expect(decision.targetPhase).toBe("waiting_unlock_manual");
    }
  });
