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
  type KeyspaceService,
  type VaultService,
  type ProtocolClosingMessage,
  type ProtocolCommandRecord,
  type ProtocolFeePoolRecord,
  type ProtocolOriginSettingsRecord,
  type ProtocolResultMessage,
  type ProtocolStorageDb
} from "@keymaster/contracts";
import { ProtocolServiceImpl, type ProtocolServiceDeps } from "./protocolService.js";
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
  return {
    status: () => "unlocked",
    onStatusChange: () => () => undefined,
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
    unlock: async () => undefined,
    lock: async () => undefined,
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
    getKey: async () => undefined,
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
  it("posts ready on startSession", () => {
    const { service, posted } = makeService();
    service.startSession();
    expect(posted.ready).toBe(1);
    expect(service.snapshot().phase).toBe("waiting");
  });

  it("binds first request and moves to confirming when vault unlocked", () => {
    const { service, opener } = makeService();
    service.startSession();
    const event = makeEvent(
      {
        v: PROTOCOL_VERSION,
        type: "request",
        id: "req-1",
        method: "identity.get",
        params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "hello", claims: ["key.label"] }
      },
      ORIGIN,
      opener
    );
    service.handleMessage(event);
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
        params: { aud: "https://evil.com", iat: 1000, exp: 2000, text: "hello" }
      },
      ORIGIN,
      opener
    );
    service.handleMessage(event);
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-3",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "x" }
        },
        ORIGIN,
        opener
      )
    );
    await service.rejectByUser();
    const r = getResult();
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.error.code).toBe("user_rejected");
    // 施工单 002：拒绝不结束 popup 会话；phase 回到 waiting、不发 closing。
    expect(service.snapshot().phase).toBe("waiting");
    expect(posted.closing).toHaveLength(0);
  });

  it("identity.get envelope is deterministic cbor with signed envelope bytes", async () => {
    const { service, opener, getResult } = makeService();
    service.startSession();
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1000, exp: 2000, text: "hi", claims: ["key.label"] }
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
    const { service, opener, getResult } = makeService();
    service.startSession();
    const content = new TextEncoder().encode("note body");
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-1",
          method: "cipher.encrypt",
          params: { text: "encrypt", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer } }
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
    const { service, opener, getResult } = makeService();
    service.startSession();
    const content = new TextEncoder().encode("body");
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "enc-2",
          method: "cipher.encrypt",
          params: { text: "x", contentType: "note.v1", content: { $type: "binary", bytes: content.buffer } }
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
    const opener2 = evil.opener;
    evil.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "dec-2",
          method: "cipher.decrypt",
          params: {
            text: "x",
            nonce: enc.nonce,
            cipherbytes: enc.cipherbytes
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

  it("ignores non-request messages before binding", () => {
    const { service, opener } = makeService();
    service.startSession();
    service.handleMessage(makeEvent({ foo: "bar" }, ORIGIN, opener));
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
    s2.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-no-key",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-ok-1",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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

    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "A" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    expect(posted.closing).toHaveLength(0);
    expect(service.snapshot().phase).toBe("waiting");

    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-B",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "B" }
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

  it("rejects while another request is in flight (second message ignored)", () => {
    const { service, opener, posted } = makeService();
    service.startSession();
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-first",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().phase).toBe("confirming");
    // 第二个 request 来自同 source/origin 应被忽略。
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-second",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "y" }
        },
        ORIGIN,
        opener
      )
    );
    expect(service.snapshot().requestId).toBe("req-first");
    expect(posted.result).toHaveLength(0);
  });

  it("switching origin reloads feed history from storageDb", async () => {
    const { service, opener, storageDb } = makeService();
    // 先在 ORIGIN 处理一条 request。
    service.startSession();
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-origin-A",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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
      activePublicKeyHex: TEST_PUB_HEX,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      errorCode: "",
      errorMessage: ""
    });

    const OTHER = "https://other.example";
    // 切换 origin：再来一条来自 OTHER 的 request。
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-origin-B",
          method: "identity.get",
          params: { aud: OTHER, iat: 1, exp: 2, text: "y" }
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-close-1",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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

  it("pageUnloading before any binding does not throw and posts once", () => {
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
    s2.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-closing-fail",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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
      }
    };
    const { service, opener, getResult } = makeService(TEST_PUB_HEX, failingDb);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      service.startSession();
      service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "req-db-fail",
            method: "identity.get",
            params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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
      // result 正常发出。
      const r = getResult();
      expect(r?.ok).toBe(true);
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "duplicated-request-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "duplicated-request-id",
          method: "identity.get",
          params: { aud: ORIGIN, iat: 1, exp: 2, text: "x" }
        },
        ORIGIN,
        opener
      )
    );
    await service.confirmByUser();
    const feed2 = service.feedSnapshot();
    const recordId2 = feed2.commands[0]?.id;
    expect(recordId2).toBeDefined();
    expect(recordId2).not.toBe(recordId1);
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
      activePublicKeyHex: TEST_PUB_HEX,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      errorCode: "",
      errorMessage: ""
    });
    // 切换到 OTHER：先用 OTHER 发一条 request。
    const OTHER = "https://other.example";
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "req-OTHER",
          method: "identity.get",
          params: { aud: OTHER, iat: 1, exp: 2, text: "x" }
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
      }
    };
    const { service, opener } = makeService(TEST_PUB_HEX, failingDb);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      service.startSession();
      // 切换到不同 origin 触发 loadHistoryForOrigin。
      const NEW_ORIGIN = "https://new.example";
      service.handleMessage(
        makeEvent(
          {
            v: PROTOCOL_VERSION,
            type: "request",
            id: "req-keep",
            method: "identity.get",
            params: { aud: NEW_ORIGIN, iat: 1, exp: 2, text: "x" }
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-manual",
          method: "p2pkh.transfer",
          params: {
            recipientAddress: MAINNET_P2PKH,
            amountSatoshis: 5000
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
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 50000,
      updatedAt: 1
    });
    service.startSession();
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-auto",
          method: "p2pkh.transfer",
          params: {
            recipientAddress: MAINNET_P2PKH,
            amountSatoshis: 1000
          }
        },
        ORIGIN,
        opener
      )
    );
    // auto-approve 命中：phase 不应是 confirming（因为 binding.autoApproved=true）。
    expect(service.currentRequestAutoApproved()).toBe(true);
    // 等内联执行完成（异步 fire & forget）。
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
    service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "p2pkh-insufficient",
          method: "p2pkh.transfer",
          params: { recipientAddress: MAINNET_P2PKH, amountSatoshis: 5000 }
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
    service.handleMessage(
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
    service.handleMessage(
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
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-create",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000 }
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
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
    expect(stored).toBeNull();
    teardownFeepoolMock();
  });

  it("feepool.prepare create: rejects when amountSatoshis > pool size", async () => {
    // 关键不变量（V3）：amountSatoshis 必须能装进池里；
    // site 想 transfer 25000 但池只有 10000 → 拒掉。
    const h = await setupFeepoolMock({});
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-overflow",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 25000 }
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-create-noconf",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000 }
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
      poolKey: `${ORIGIN}::${COUNTERPARTY}`,
      origin: ORIGIN,
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-spend",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000 }
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
      poolKey: `${ORIGIN}::${COUNTERPARTY}`,
      origin: ORIGIN,
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cnr",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000 }
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-commit-create",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000 }
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
    h.service.handleMessage(
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
              { $type: "binary", bytes: new Uint8Array(72).buffer }
            ],
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
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-unknown",
          method: "feepool.commit",
          params: {
            operationId: "op-does-not-exist",
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cross-prep",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000 }
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-cross-commit",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
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
      expect(lastError.error.code).toBe("user_rejected");
    }
    const feed = h.service.feedSnapshot();
    const card = feed.commands.find((c) => c.requestId === "fp-cross-commit");
    expect(card?.failureReason).toBe("cross_origin_operation");
    teardownFeepoolMock();
  });

  it("feepool.prepare auto-sign: skips ConfirmView when feePoolAutoSignMaxSatoshis >= amount", async () => {
    const h = await setupFeepoolMock({
      sdkBase: { txHex: "cc".repeat(120), outputIndex: 0, amount: 1000 }
    });
    await setOriginViaService(h.service, {
      feePoolDefaultFundSatoshis: 10000,
      feePoolAutoSignMaxSatoshis: 5000
    });
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-autosign",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000 }
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
      feePoolAutoSignMaxSatoshis: 5000
    });
    // 先跑 prepare（auto-sign 内联），pending op 会被清掉（commit 后才清；
    // 这里我们手动把 op 留下给下一步 commit 用）。
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fp-prepare",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 3000 }
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
    h.service.handleMessage(
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

  it("encodes integers with shortest form", () => {
    expect(cborEncode(0)).toEqual(new Uint8Array([0]));
    expect(cborEncode(1)).toEqual(new Uint8Array([1]));
    expect(cborEncode(23)).toEqual(new Uint8Array([23]));
    expect(cborEncode(24)).toEqual(new Uint8Array([24, 24]));
    expect(cborEncode(255)).toEqual(new Uint8Array([24, 255]));
    expect(cborEncode(256)).toEqual(new Uint8Array([25, 1, 0]));
  });

  it("deterministic map ordering by key", () => {
    expect(cborEncode({ b: 1, a: 2 })).toEqual(cborEncode({ a: 2, b: 1 }));
  });

  /* ============== V4 累计 B-Tx 草稿专用测试 ============== */

  it("V4: spend 不删池——池持续累计 serverAmount", async () => {
    const h = await setupFeepoolMock({
      sdkInitialDraft: { txHex: "dd".repeat(100) }
    });
    await setOriginViaService(h.service, { feePoolDefaultFundSatoshis: 10000 });
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-1",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 3000 }
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-1c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const stored = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
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

    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2a",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1000 }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    let opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2ac",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    let stored = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
    expect(stored?.serverAmount).toBe(1000);

    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2b",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 1500 }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-2bc",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    stored = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
    // 池持续累计：1000 + 1500 = 2500；草稿已更新到 update 版（"ee"）
    expect(stored?.serverAmount).toBe(2500);
    expect(stored?.draftSpendTxHex).toBe("ee".repeat(100));
    teardownFeepoolMock();
  });

  it("V4: close_and_recreate 用 final close（loadDraft + FINAL_LOCKTIME）+ 新池初始 draft", async () => {
    const prior: ProtocolFeePoolRecord = {
      poolKey: `${ORIGIN}::${COUNTERPARTY}`,
      origin: ORIGIN,
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
    await h.storageDb.putFeePool(prior);
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-3",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 8000 }
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
    h.service.handleMessage(
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
            closeCounterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
          }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const oldPool = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
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
      poolKey: `${ORIGIN}::${COUNTERPARTY}`,
      origin: ORIGIN,
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
    await h.storageDb.putFeePool(prior);
    h.service.startSession();
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v5-close",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 2000 }
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
    h.service.handleMessage(
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
    const newPool = await h.storageDb.getFeePool(`${ORIGIN}::${COUNTERPARTY}`);
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
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-4",
          method: "feepool.prepare",
          params: { counterpartyPublicKeyHex: COUNTERPARTY, amountSatoshis: 5000 }
        },
        ORIGIN,
        h.opener
      )
    );
    await h.service.confirmByUser();
    const opId = (h.lastResult() as unknown as { ok: true; result: { operationId: string } }).result.operationId;
    h.service.handleMessage(
      makeEvent(
        {
          v: PROTOCOL_VERSION,
          type: "request",
          id: "fe-v4-4c",
          method: "feepool.commit",
          params: {
            operationId: opId,
            counterpartyPublicKeyHex: COUNTERPARTY,
            counterpartySignatures: [{ $type: "binary", bytes: new Uint8Array(72).buffer }]
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

describe("signCompactSecp256k1", () => {
  it("produces 64-byte compact and verifies against pubkey", () => {
    const msg = new TextEncoder().encode("hello");
    const sig = signCompactSecp256k1(TEST_PRIV_HEX, msg);
    expect(sig.length).toBe(64);
    const pub = secp256k1.getPublicKey(hexToBytes(TEST_PRIV_HEX), true);
    expect(verifyCompactSecp256k1(sig, msg, pub)).toBe(true);
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
