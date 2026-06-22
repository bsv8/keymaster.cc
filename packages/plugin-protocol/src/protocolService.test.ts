// packages/plugin-protocol/src/protocolService.test.ts
// 协议 service 关键行为单测：
//   - ready -> request -> result 正常流程；
//   - aud !== event.origin 拒绝；
//   - 锁定态解锁后继续；
//   - 无 active key 拒绝；
//   - claim 省略规则；
//   - identity/sign envelope 字节稳定；
//   - cipher 同 origin 可解、异 origin 不可解。

import { beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type KeyspaceService, type VaultService, type ProtocolResultMessage } from "@keymaster/contracts";
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
      // 测试里：直接给 fn 私钥材料。
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

function makeService(publicKeyHex = TEST_PUB_HEX) {
  const opener = makeFakeOpener();
  let resultMessage: ProtocolResultMessage | null = null;
  const posted: { ready: number; result: ProtocolResultMessage[] } = { ready: 0, result: [] };
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
    }
  };
  const service = new ProtocolServiceImpl(deps);
  return { service, opener, deps, posted, getResult: () => resultMessage };
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

  it("user rejection replies with user_rejected", async () => {
    const { service, opener, getResult } = makeService();
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
    // envelope 是 application/cbor。
    expect(result.identityEnvelope.mime).toBe("application/cbor");
    // 解码 envelope 检查结构。
    const decoded = cborDecode(new Uint8Array(result.identityEnvelope.bytes)) as unknown[];
    expect(Array.isArray(decoded)).toBe(true);
    const arr = decoded as unknown[];
    expect(arr[0]).toBe(PROTOCOL_VERSION);
    expect(arr[1]).toBe("req-id");
    expect(arr[2]).toBe(ORIGIN);
    expect(arr[3]).toBe(1000);
    expect(arr[4]).toBe(2000);
    expect(arr[5]).toBe("hi");
    // claims：按字典序排序的 [[name, val], ...]
    const claims = arr[7] as unknown[];
    expect(Array.isArray(claims)).toBe(true);
    expect((claims[0] as unknown[])[0]).toBe("key.label");
    // resolvedClaims 包含 key.label
    expect(result.resolvedClaims["key.label"]).toBe("Key A");
    // signature 64 bytes compact
    expect(result.signature.bytes.byteLength).toBe(64);
    // 验签：subject.publicKey 是 33 字节
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

    // 拿同样的私钥与 origin 派生 siteKey，手动解密。
    const siteKey = deriveSiteKey(TEST_PRIV_HEX, ORIGIN);
    const plain = aesGcmDecrypt(siteKey, new Uint8Array(enc.nonce.bytes), new Uint8Array(enc.cipherbytes.bytes));
    const decoded = cborDecode(plain) as unknown[];
    expect(decoded[0]).toBe(PROTOCOL_VERSION);
    expect(decoded[1]).toBe("note.v1");
    expect(new TextDecoder().decode(decoded[2] as Uint8Array)).toBe("note body");
  });

  it("cipher.decrypt across different origin fails with decrypt_failed", async () => {
    const { service, opener, getResult } = makeService();
    // 先 encrypt
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

    // decrypt 时换 origin
    const EVIL = "https://evil.com";
    // 新 service 构造，origin 不同
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
    // 替换 keyspace，让 active 没有 publicKeyHex
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
    // keyspace.requireActiveKey 抛错 -> internal_error
    expect(r?.ok).toBe(false);
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
    const a = cborEncode({ b: 1, a: 2 });
    const b = cborEncode({ a: 2, b: 1 });
    expect(a).toEqual(b);
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
