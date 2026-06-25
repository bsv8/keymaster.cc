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
  type ProtocolCommandDb,
  type ProtocolCommandRecord,
  type ProtocolResultMessage
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
 * 内存 fake commandDb：保留持久语义（同 id 覆盖、按 origin 隔离、
 * updatedAt desc 排序），不引入 fake-indexeddb。
 */
function makeFakeCommandDb(): ProtocolCommandDb & { writes: number; readFailures: number; writeFailures: number } {
  const map = new Map<string, ProtocolCommandRecord>();
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
    async putCommand(record) {
      writes++;
      if (record.id === "__force_write_fail__") {
        writeFailures++;
        throw new Error("forced write failure");
      }
      map.set(record.id, { ...record });
    },
    async getCommand(id) {
      const v = map.get(id);
      return v ? { ...v } : null;
    },
    async listCommandsByOrigin(origin) {
      const out: ProtocolCommandRecord[] = [];
      for (const v of map.values()) {
        if (v.origin === origin) out.push({ ...v });
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      return out;
    }
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
  commandDb: ReturnType<typeof makeFakeCommandDb>;
}

function makeService(publicKeyHex = TEST_PUB_HEX, commandDb: ProtocolCommandDb | undefined = makeFakeCommandDb()): ServiceHarness {
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
    }
  };
  if (commandDb) {
    deps.commandDb = commandDb;
  }
  const service = new ProtocolServiceImpl(deps);
  return {
    service,
    opener,
    deps,
    posted,
    getResult: () => resultMessage,
    commandDb: commandDb as ReturnType<typeof makeFakeCommandDb>
  };
}

function makeEvent<T>(data: T, origin = ORIGIN, source: object | null = null): MessageEvent {
  return {
    data,
    origin,
    source
  } as unknown as MessageEvent;
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

  it("switching origin reloads feed history from commandDb", async () => {
    const { service, opener, commandDb } = makeService();
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
    await commandDb.putCommand({
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
    await new Promise((r) => setTimeout(r, 5));
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
    const failingDb: ProtocolCommandDb = {
      async putCommand() {
        throw new Error("db down");
      },
      async getCommand() {
        throw new Error("db down");
      },
      async listCommandsByOrigin() {
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
      await new Promise((r) => setTimeout(r, 5));
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
    const { service, opener, commandDb } = makeService();
    service.startSession();
    // 准备：在 ORIGIN 历史上先放一条已完成的命令卡，DB 里有完整记录。
    await commandDb.putCommand({
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
    await new Promise((r) => setTimeout(r, 5));
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
    const failingDb: ProtocolCommandDb = {
      async putCommand() {
        return undefined;
      },
      async getCommand() {
        return null;
      },
      async listCommandsByOrigin() {
        throw new Error("read failed");
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
      await new Promise((r) => setTimeout(r, 5));
      const feed = service.feedSnapshot();
      expect(feed.historyAvailable).toBe(false);
      expect(feed.commands.find((c) => c.requestId === "req-keep")).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("protocolCbor", () => {
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
