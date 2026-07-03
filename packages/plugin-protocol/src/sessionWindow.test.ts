// packages/plugin-protocol/src/sessionWindow.test.ts
// Session Window 行为测试：
//   - sessionWindowBootstrap 路径 normalize / boot mode 解析；
//   - protocolStorageDb schema（施工单 2026-06-30 002 起 session record
//     不再带 `runtimeBinding`，统一执行 runtime 来源由 resolver 决定）。
//
// 施工单 2026-06-30 002 硬切换补充：
//   - owner runtime bootstrap 校验（hex 派生公钥 === ownerPublicKeyHex）；
//   - vault 不再提供 export/importUnlockRuntime*。
//
// 施工单 2026-07-01 001 硬切换补充：
//   - storage.* / storageObjectService / normalizeStoragePath 已彻底移除；
//     本文件不再验证 storage 相关行为。

// priv=0x...01 对应 secp256k1 压缩公钥（来自 noble secp256k1.getPublicKey 派生）。
// 用真实配对让 applyLauncherBootstrap 的"私钥 → 公钥"校验通过。
const TEST_PRIV_HEX_PRIV1 =
  "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PUB_HEX_PRIV1 =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

import { describe, expect, it, vi } from "vitest";
import {
  consumeLauncherBootstrap,
  encodeOrigin,
  parseBootMode,
  parseBootstrapToken,
  parseSessionWindowOrigin
} from "./sessionWindowBootstrap.js";
import type {
  ConnectSessionRecord,
  ProtocolOriginSettingsRecord,
  ProtocolFeePoolRecord,
  ProtocolCommandRecord,
  VaultService
} from "@keymaster/contracts";

describe("sessionWindowBootstrap", () => {
  it("parseBootMode: 缺省 = connect", () => {
    expect(parseBootMode("")).toBe("connect");
    expect(parseBootMode("?")).toBe("connect");
    expect(parseBootMode("?foo=bar")).toBe("connect");
  });
  it("parseBootMode: boot=appView 解析成 appView", () => {
    expect(parseBootMode("?boot=appView")).toBe("appView");
    expect(parseBootMode("?boot=appView&other=x")).toBe("appView");
  });
  it("parseBootMode: 未知 boot 值降级到 connect", () => {
    expect(parseBootMode("?boot=other")).toBe("connect");
  });

  it("encodeOrigin: base64url 不含 padding / + / /", () => {
    const out = encodeOrigin("https://example.com:8080/path");
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).not.toContain("=");
    // 可逆：base64url 解码后等于原文
    const padded = out + "===".slice(0, (4 - (out.length % 4)) % 4);
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(b64);
    expect(decoded).toBe("https://example.com:8080/path");
  });

  // 施工单 2026-06-30 004 硬切换：appView launch 真值收口为
  // `sessionWindowOrigin`；Session Window 在 openClientApp() 时把
  // 自己的 `window.location.origin` 显式注入 child URL；下游 client
  // app 在 appView 模式下**只**认这份值做 transport target origin，
  // **不**再读 UI / 用户输入的 `targetOrigin`。下面验证
  // `parseSessionWindowOrigin` 的 fail-closed 行为。
  it("parseSessionWindowOrigin: 缺省 / 缺失返回 null", () => {
    expect(parseSessionWindowOrigin("")).toBeNull();
    expect(parseSessionWindowOrigin("?")).toBeNull();
    expect(parseSessionWindowOrigin("?foo=bar")).toBeNull();
    expect(parseSessionWindowOrigin("?sessionWindowOrigin=")).toBeNull();
  });
  it("parseSessionWindowOrigin: 合法 http(s) origin 直接返回 origin", () => {
    expect(parseSessionWindowOrigin("?sessionWindowOrigin=https://keymaster.cc"))
      .toBe("https://keymaster.cc");
    expect(
      parseSessionWindowOrigin(
        "?launchToken=x&sessionWindowOrigin=http://localhost:8080"
      )
    ).toBe("http://localhost:8080");
  });
  it("parseSessionWindowOrigin: 拒绝 * / 缺 scheme / 含 path / 非 http(s)", () => {
    expect(parseSessionWindowOrigin("?sessionWindowOrigin=*")).toBeNull();
    expect(parseSessionWindowOrigin("?sessionWindowOrigin=keymaster.cc")).toBeNull();
    expect(parseSessionWindowOrigin("?sessionWindowOrigin=domain:443")).toBeNull();
    expect(
      parseSessionWindowOrigin("?sessionWindowOrigin=https://keymaster.cc/path")
    ).toBeNull();
    expect(
      parseSessionWindowOrigin("?sessionWindowOrigin=file:///etc/passwd")
    ).toBeNull();
    expect(
      parseSessionWindowOrigin("?sessionWindowOrigin=chrome-extension://abc/foo")
    ).toBeNull();
  });
});

describe("protocolStorageDb stores (smoke)", () => {
  // 验证 ConnectSessionRecord / OriginSettingsRecord 等结构仍兼容旧逻辑
  it("ConnectSessionRecord 不含 ownerKeyId / runtimeBinding 字段（施工单 2026-06-30 002）", () => {
    const rec: ConnectSessionRecord = {
      sessionId: "s",
      origin: "https://x",
      ownerPublicKeyHex: "a".repeat(66),
      ownerLabel: "L",
      claimsSnapshot: {},
      createdAt: 0,
      lastUsedAt: 0,
      revokedAt: null
    };
    expect((rec as unknown as Record<string, unknown>).ownerKeyId).toBeUndefined();
    expect((rec as unknown as Record<string, unknown>).runtimeBinding).toBeUndefined();
  });

  it("ProtocolFeePoolRecord 主键格式 = origin::owner::counterparty", () => {
    const rec: ProtocolFeePoolRecord = {
      poolKey: "https://x::a::b",
      origin: "https://x",
      ownerPublicKeyHex: "a",
      counterpartyPublicKeyHex: "b",
      baseTxid: "",
      baseTxHex: "",
      totalAmount: 0,
      serverAmount: 0,
      draftSpendTxHex: "",
      draftClientSignBytes: { $type: "binary", bytes: new ArrayBuffer(0) },
      lastOperationId: "",
      updatedAt: 0
    };
    expect(rec.poolKey).toBe("https://x::a::b");
  });

  it("ProtocolCommandRecord 必含 connectSessionId + ownerPublicKeyHex", () => {
    const rec: ProtocolCommandRecord = {
      id: "r",
      origin: "https://x",
      requestId: "r",
      method: "connect.resume",
      phase: "approved",
      decision: "approved",
      status: "approved",
      textSummary: "",
      claimsSummary: [],
      contentType: "",
      payloadSize: 0,
      connectSessionId: "s",
      ownerPublicKeyHex: "a".repeat(66),
      createdAt: 0,
      updatedAt: 0,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    };
    expect(rec.connectSessionId).toBe("s");
    expect(rec.ownerPublicKeyHex).toHaveLength(66);
  });

  it("ProtocolOriginSettingsRecord 默认值归一", () => {
    const rec: ProtocolOriginSettingsRecord = {
      origin: "https://x",
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 30,
      updatedAt: 0
    };
    expect(rec.confirmTimeoutSeconds).toBe(30);
  });
});

/* ============== 修复 issue #3：bootstrap fail-closed ==============
 *
 * 施工单 2026-06-30 002 硬切换后，Session Window bootstrap 改用
 * owner runtime bootstrap 模型：applyLauncherBootstrap 不再调
 * `vault.importUnlockRuntimeFromLauncher`，只校验 owner runtime
 * payload 完整性 + 私钥 → 公钥派生。
 *
 * 下面的 3 个测试都是 fail-closed 路径上的"应当不通过"用例：
 *   1. signer 私钥派生的公钥与声明的 ownerPublicKeyHex 不一致
 *      （原"vault.importUnlockRuntimeFromLauncher 抛错"对应现在的
 *      "ownerRuntime 校验失败"）；
 *   2. payload 缺 ownerRuntimeBootstrap（原"缺 unlockRuntime"）；
 *   3. bootstrap 失败时不再向 opener 发 ack（修复 issue #2）。
 */

import type { ProtocolServiceImpl } from "./protocolService.js";

function makeFakeVaultService(): VaultService {
  return {
    status: () => "locked",
    onStatusChange: () => () => undefined,
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => undefined,
    onInitialActivationNoticeChange: () => () => undefined,
    hasVault: async () => true,
    createVault: async () => undefined,
    createVaultWithInitialKey: async () => {
      throw new Error("not used");
    },
    createVaultWithImportedKey: async () => {
      throw new Error("not used");
    },
    unlock: async () => undefined,
    lock: async () => undefined,
    verifyPassword: async () => undefined,
    finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
    recoverEmptyVaultToUninitialized: async () => undefined,
    listKeys: async () => [],
    getKey: async () => undefined,
        importPrivateKey: async () => {
      throw new Error("not used");
    },
    generateKey: async () => {
      throw new Error("not used");
    },
    deleteKeyMaterial: async () => undefined,
    removeKey: async () => {
      throw new Error("not used");
    },
    exportPrivateKey: async () => {
      throw new Error("not used");
    },
    withPrivateKey: async () => {
      throw new Error("not used");
    }
  };
}

function makeFakeKeyspace(): ConstructorParameters<typeof ProtocolServiceImpl>[0]["keyspace"] {
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => ({}),
    setActive: async () => undefined,
    requireActiveKey: () => {
      throw new Error("not used");
    },
    onActiveChange: () => () => undefined,
    openKeyStorage: async () => ({ db: {} as IDBDatabase, name: "x", close: () => undefined }),
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  } as unknown as ConstructorParameters<typeof ProtocolServiceImpl>[0]["keyspace"];
}

describe("ProtocolService bootstrap fail-closed (修复 issue #3)", () => {
  it("ownerRuntimeBootstrap 私钥派生的公钥 ≠ signer.ownerPublicKeyHex → bootstrapFailed = true", async () => {
    const { ProtocolServiceImpl } = await import("./protocolService.js");
    const vault = makeFakeVaultService();
    const svc = new ProtocolServiceImpl({
      vault,
      keyspace: makeFakeKeyspace(),
      bootMode: "appView"
    });
    type PrivProto = {
      applyLauncherBootstrap: (payload: unknown) => Promise<void>;
      bootstrapFailed: () => boolean;
      bootstrapFailureReason: () => string | null;
    };
    const priv = svc as unknown as PrivProto;
    // 用真实 priv=0x...01 配对派生出真实公钥，但 payload 声明的
    // ownerPublicKeyHex 是 "a".repeat(66)——故意错配，触发
    // `bootstrap_owner_runtime_pubkey_mismatch` 失败路径。
    await priv.applyLauncherBootstrap({
      app: { appId: "a", appOrigin: "https://x", appUrl: "https://x" },
      connectSessionId: "s",
      ownerPublicKeyHex: "a".repeat(66),
      resolvedClaims: {},
      resolvedAt: 0,
      launchToken: "tok",
      ownerRuntimeBootstrap: {
        ownerPublicKeyHex: TEST_PUB_HEX_PRIV1,
        ownerLabel: "Key A",
        privateKeyHex: TEST_PRIV_HEX_PRIV1,
        capabilities: ["p2pkh"],
        createdAt: 0
      }
    });
    expect(priv.bootstrapFailed()).toBe(true);
    expect(priv.bootstrapFailureReason()).toMatch(/pubkey_mismatch|invalid|missing/i);
  });

  it("payload 不完整（缺 ownerRuntimeBootstrap）→ bootstrapFailed = true", async () => {
    const { ProtocolServiceImpl } = await import("./protocolService.js");
    const vault = makeFakeVaultService();
    const svc = new ProtocolServiceImpl({
      vault,
      keyspace: makeFakeKeyspace(),
      bootMode: "appView"
    });
    type PrivProto = {
      applyLauncherBootstrap: (payload: unknown) => Promise<void>;
      bootstrapFailed: () => boolean;
      bootstrapFailureReason: () => string | null;
    };
    const priv = svc as unknown as PrivProto;
    await priv.applyLauncherBootstrap({
      app: { appId: "a", appOrigin: "https://x", appUrl: "https://x" },
      connectSessionId: "s",
      ownerPublicKeyHex: "a".repeat(66),
      resolvedClaims: {},
      resolvedAt: 0,
      launchToken: "tok",
      // ownerRuntimeBootstrap 故意缺字段
      ownerRuntimeBootstrap: undefined as unknown as never
    });
    expect(priv.bootstrapFailed()).toBe(true);
    expect(priv.bootstrapFailureReason()).toMatch(/owner_runtime_missing|invalid/i);
  });

  it("applyLauncherBootstrap 失败时不再向 opener 发 ack（修复 issue #2）", async () => {
    const { ProtocolServiceImpl } = await import("./protocolService.js");
    const vault = makeFakeVaultService();
    const svc = new ProtocolServiceImpl({
      vault,
      keyspace: makeFakeKeyspace(),
      bootMode: "appView"
    });
    const postedMessages: Array<{ type: string }> = [];
    const fakeOpener = {
      location: { origin: "https://launcher.example" },
      postMessage: (msg: { type?: string }) => {
        if (msg && typeof msg === "object") {
          postedMessages.push({ type: String(msg.type) });
        }
      }
    };
    const originalOpener = (globalThis as { window?: { opener?: unknown } }).window?.opener;
    (globalThis as { window?: { opener?: unknown } }).window = {
      ...((globalThis as { window?: unknown }).window ?? {}),
      opener: fakeOpener
    } as unknown as { opener?: unknown };
    try {
      type PrivProto = {
        applyLauncherBootstrap: (payload: unknown) => Promise<void>;
      };
      const priv = svc as unknown as PrivProto;
      // ownerRuntimeBootstrap 缺字段 → 走失败路径。
      await priv.applyLauncherBootstrap({
        app: { appId: "a", appOrigin: "https://x", appUrl: "https://x" },
        connectSessionId: "s",
        ownerPublicKeyHex: "a".repeat(66),
        resolvedClaims: {},
        resolvedAt: 0,
        launchToken: "tok",
        ownerRuntimeBootstrap: undefined as unknown as never
      });
      // 修复 issue #2：失败路径**不**发任何 ack。
      const ackCalls = postedMessages.filter((m) => m.type === "session-window.bootstrap.ack");
      expect(ackCalls).toHaveLength(0);
    } finally {
      (globalThis as { window?: { opener?: unknown } }).window = {
        ...((globalThis as { window?: unknown }).window ?? {}),
        opener: originalOpener
      } as unknown as { opener?: unknown };
    }
  });
});

/* ============== 修复 issue #1：direct consume bootstrap capsule ============== */

describe("consumeLauncherBootstrap direct-consume 模型 (修复 issue #1)", () => {
  function makeOpener(opts: {
    origin: string;
    closed?: boolean;
    registry?: unknown;
    throwOnLocation?: boolean;
  }): Window {
    const opener = {
      closed: opts.closed ?? false,
      location: {
        get origin() {
          if (opts.throwOnLocation) throw new DOMException("cross-origin", "SecurityError");
          return opts.origin;
        }
      }
    };
    (opener as unknown as Record<string, unknown>).__keymaster_session_window_bootstrap__ =
      opts.registry;
    return opener as unknown as Window;
  }

  function makeFakeBootstrap(): import("@keymaster/contracts").AppBootstrapPayload {
    // priv=0x...01 对应压缩公钥 0279be...f81798（来自 noble secp256k1）；
    // 这里用真实配对以让 applyLauncherBootstrap 的私钥 → 公钥派生校验通过。
    return {
      app: { appId: "a", appOrigin: "https://x", appUrl: "https://x" },
      connectSessionId: "s",
      ownerPublicKeyHex: TEST_PUB_HEX_PRIV1,
      resolvedClaims: {},
      resolvedAt: 0,
      launchToken: "tok",
      ownerRuntimeBootstrap: {
        ownerPublicKeyHex: TEST_PUB_HEX_PRIV1,
        ownerLabel: "Key A",
        privateKeyHex: TEST_PRIV_HEX_PRIV1,
        capabilities: ["p2pkh"],
        createdAt: 0
      }
    };
  }

  it("opener 不存在 → failureReason = launcher_opener_unavailable", async () => {
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: null,
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_opener_unavailable");
  });

  it("opener 已关闭 → failureReason = launcher_closed", async () => {
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({ origin: "https://launcher.example", closed: true }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_closed");
  });

  it("opener origin 跨源 → failureReason = launcher_cross_origin", async () => {
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({ origin: "https://attacker.example" }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_cross_origin");
  });

  it("读 opener.location 抛错 → failureReason = launcher_cross_origin", async () => {
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({ origin: "", throwOnLocation: true }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_cross_origin");
  });

  it("registry 不在 opener 上 → failureReason = launcher_registry_missing", async () => {
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({ origin: "https://launcher.example" }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_registry_missing");
  });

  it("registry.acquire 返回 null → failureReason = launcher_token_not_found", async () => {
    const registry = {
      acquire: vi.fn(async () => null)
    };
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({
        origin: "https://launcher.example",
        registry
      }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(registry.acquire).toHaveBeenCalledWith("tok");
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("launcher_token_not_found");
  });

  it("registry.acquire 抛错 → failureReason = err.message", async () => {
    const registry = {
      acquire: vi.fn(async () => {
        throw new Error("vault_locked");
      })
    };
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({
        origin: "https://launcher.example",
        registry
      }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("vault_locked");
  });

  it("registry.acquire 慢于超时 → failureReason 包含 timeout", async () => {
    const registry = {
      acquire: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(makeFakeBootstrap()), 500);
        })
    };
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({
        origin: "https://launcher.example",
        registry
      }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 50
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toMatch(/timeout/i);
  });

  it("happy path：registry.acquire 返回 capsule → bootstrap 命中 + failureReason null", async () => {
    const capsule = makeFakeBootstrap();
    const registry = {
      acquire: vi.fn(async (token: string) => {
        expect(token).toBe("tok");
        return capsule;
      })
    };
    const out = await consumeLauncherBootstrap({
      token: "tok",
      opener: makeOpener({
        origin: "https://launcher.example",
        registry
      }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toEqual(capsule);
    expect(out.failureReason).toBeNull();
    expect(registry.acquire).toHaveBeenCalledTimes(1);
    expect(registry.acquire).toHaveBeenCalledWith("tok");
  });

  it("token 为 null → failureReason = bootstrap_token_missing", async () => {
    const out = await consumeLauncherBootstrap({
      token: null,
      opener: makeOpener({ origin: "https://launcher.example" }),
      ownOrigin: "https://launcher.example",
      timeoutMs: 100
    });
    expect(out.bootstrap).toBeNull();
    expect(out.failureReason).toBe("bootstrap_token_missing");
  });
});

describe("parseBootstrapToken", () => {
  it("缺省 → null", () => {
    expect(parseBootstrapToken("")).toBeNull();
    expect(parseBootstrapToken("?")).toBeNull();
  });
  it("有 token → 解出", () => {
    expect(parseBootstrapToken("?bootstrapToken=abc")).toBe("abc");
    expect(parseBootstrapToken("?boot=appView&bootstrapToken=tok-1&foo=bar")).toBe("tok-1");
  });
  it("token 为空串 → null", () => {
    expect(parseBootstrapToken("?bootstrapToken=")).toBeNull();
  });
});

/* ============== 端到端：awaitLauncherBootstrap 走完整 direct-consume 路径 ============== */

describe("ProtocolService.awaitLauncherBootstrap 端到端 (direct consume)", () => {
  /**
   * 端到端：用 fake `window.opener` + 替换 `window.location.search` 走完整
   * direct-consume 链路：
   *   - launcher 端在 `window.opener.__keymaster_session_window_bootstrap__`
   *     挂 `LauncherBootstrapRegistry`；
   *   - URL `?bootstrapToken=<id>`；
   *   - `service.awaitLauncherBootstrap()` 触发 `consumeLauncherBootstrap`
   *     → 命中 launcher 的 `acquire(token)` → 应用 `applyLauncherBootstrap`。
   *
   * 目的：守住 `window.location.search` 解析 + `bootstrapConsumed` 幂等位
   * + 同步 vs 异步 consume 时机。后续实现者改这些路径时这条测试会立即报错。
   */

  function patchWindow(input: {
    search: string;
    opener: Window | null;
  }): () => void {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const replacement = {
      ...(typeof originalWindow === "object" && originalWindow !== null
        ? (originalWindow as Record<string, unknown>)
        : {}),
      opener: input.opener,
      location: {
        ...(((typeof originalWindow === "object" &&
          (originalWindow as { location?: unknown }).location) as
          | Record<string, unknown>
          | undefined) ?? {}),
        origin: "https://launcher.example",
        search: input.search
      }
    };
    (globalThis as { window?: unknown }).window = replacement;
    return () => {
      (globalThis as { window?: unknown }).window = originalWindow;
    };
  }

  function makeOpenerWithRegistry(
    registry: import("@keymaster/contracts").LauncherBootstrapRegistry
  ): Window {
    const opener = {
      closed: false,
      location: { origin: "https://launcher.example" }
    };
    (opener as unknown as Record<string, unknown>).__keymaster_session_window_bootstrap__ = registry;
    return opener as unknown as Window;
  }

  function makeFakeBootstrap(
    overrides: Partial<import("@keymaster/contracts").AppBootstrapPayload> = {}
  ): import("@keymaster/contracts").AppBootstrapPayload {
    return {
      app: {
        appId: "app-x",
        appOrigin: "https://app.example",
        appUrl: "https://app.example/?launchToken=tok"
      },
      connectSessionId: "sess-x",
      ownerPublicKeyHex: TEST_PUB_HEX_PRIV1,
      resolvedClaims: {},
      resolvedAt: 0,
      launchToken: "tok",
      ownerRuntimeBootstrap: {
        ownerPublicKeyHex: TEST_PUB_HEX_PRIV1,
        ownerLabel: "Key A",
        privateKeyHex: TEST_PRIV_HEX_PRIV1,
        capabilities: ["p2pkh"],
        createdAt: 0
      },
      ...overrides
    };
  }

  function makeFakeVaultService(
    overrides: { importUnlockRuntime?: () => Promise<void> } = {}
  ): VaultService {
    return {
      status: () => "locked",
      onStatusChange: () => () => undefined,
      getInitialActivationNotice: () => null,
      clearInitialActivationNotice: () => undefined,
      onInitialActivationNoticeChange: () => () => undefined,
      hasVault: async () => true,
      createVault: async () => undefined,
      createVaultWithInitialKey: async () => {
        throw new Error("not used");
      },
      createVaultWithImportedKey: async () => {
        throw new Error("not used");
      },
      unlock: async () => undefined,
      lock: async () => undefined,
      verifyPassword: async () => undefined,
      finalizeEmptyVaultAfterLastKeyDeletion: async () => undefined,
      recoverEmptyVaultToUninitialized: async () => undefined,
      listKeys: async () => [],
      getKey: async () => undefined,
            importPrivateKey: async () => {
        throw new Error("not used");
      },
      generateKey: async () => {
        throw new Error("not used");
      },
      deleteKeyMaterial: async () => undefined,
      removeKey: async () => {
        throw new Error("not used");
      },
      exportPrivateKey: async () => {
        throw new Error("not used");
      },
      withPrivateKey: async () => {
        throw new Error("not used");
      }
    };
  }

  it("happy path：URL token 命中 launcher → appViewContext 写入 + bootstrapFailed=false", async () => {
    const capsule = makeFakeBootstrap();
    const acquire = vi.fn(async (token: string) => {
      expect(token).toBe("tok-e2e");
      return capsule;
    });
    const registry: import("@keymaster/contracts").LauncherBootstrapRegistry = { acquire };
    const opener = makeOpenerWithRegistry(registry);
    const restoreWindow = patchWindow({
      search: "?boot=appView&bootstrapToken=tok-e2e",
      opener
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "appView"
      });
      // 起点：等待 bootstrap。
      expect(svc.appViewContext()).toBeNull();
      expect(svc.bootstrapFailed()).toBe(false);

      svc.awaitLauncherBootstrap();

      // 让 microtask 跑完 consume + applyLauncherBootstrap。
      await new Promise((r) => setTimeout(r, 20));

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire).toHaveBeenCalledWith("tok-e2e");
      expect(svc.bootstrapFailed()).toBe(false);
      expect(svc.appViewContext()).not.toBeNull();
      const ctx = svc.appViewContext()!;
      expect(ctx.appId).toBe("app-x");
      expect(ctx.appOrigin).toBe("https://app.example");
      expect(ctx.connectSessionId).toBe("sess-x");
      expect(ctx.ownerPublicKeyHex).toBe(TEST_PUB_HEX_PRIV1);
    } finally {
      restoreWindow();
    }
  });

  it("acquire 抛错 → bootstrapFailed=true + bootstrapFailureReason 含 vault 错误", async () => {
    const registry: import("@keymaster/contracts").LauncherBootstrapRegistry = {
      acquire: vi.fn(async () => {
        throw new Error("vault_locked");
      })
    };
    const opener = makeOpenerWithRegistry(registry);
    const restoreWindow = patchWindow({
      search: "?boot=appView&bootstrapToken=tok-err",
      opener
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "appView"
      });
      svc.awaitLauncherBootstrap();
      await new Promise((r) => setTimeout(r, 20));
      expect(svc.bootstrapFailed()).toBe(true);
      expect(svc.bootstrapFailureReason()).toBe("vault_locked");
      expect(svc.appViewContext()).toBeNull();
    } finally {
      restoreWindow();
    }
  });

  it("URL 缺 bootstrapToken → bootstrapFailed=true + bootstrap_token_missing", async () => {
    const registry: import("@keymaster/contracts").LauncherBootstrapRegistry = {
      acquire: vi.fn(async () => null)
    };
    const opener = makeOpenerWithRegistry(registry);
    const restoreWindow = patchWindow({
      search: "?boot=appView",
      opener
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "appView"
      });
      svc.awaitLauncherBootstrap();
      await new Promise((r) => setTimeout(r, 20));
      expect(registry.acquire).not.toHaveBeenCalled();
      expect(svc.bootstrapFailed()).toBe(true);
      expect(svc.bootstrapFailureReason()).toBe("bootstrap_token_missing");
    } finally {
      restoreWindow();
    }
  });

  it("opener 不存在 → bootstrapFailed=true + launcher_opener_unavailable", async () => {
    const restoreWindow = patchWindow({
      search: "?boot=appView&bootstrapToken=tok",
      opener: null
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "appView"
      });
      svc.awaitLauncherBootstrap();
      await new Promise((r) => setTimeout(r, 20));
      expect(svc.bootstrapFailed()).toBe(true);
      expect(svc.bootstrapFailureReason()).toBe("launcher_opener_unavailable");
    } finally {
      restoreWindow();
    }
  });

  it("幂等：连续两次 awaitLauncherBootstrap 只触发一次 acquire", async () => {
    const capsule = makeFakeBootstrap();
    const acquire = vi.fn(async () => capsule);
    const registry: import("@keymaster/contracts").LauncherBootstrapRegistry = { acquire };
    const opener = makeOpenerWithRegistry(registry);
    const restoreWindow = patchWindow({
      search: "?boot=appView&bootstrapToken=tok-idem",
      opener
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "appView"
      });
      svc.awaitLauncherBootstrap();
      svc.awaitLauncherBootstrap();
      svc.awaitLauncherBootstrap();
      await new Promise((r) => setTimeout(r, 20));
      // 幂等位 bootstrapConsumed 防止 acquire 被重复触发。
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(svc.bootstrapFailed()).toBe(false);
      expect(svc.appViewContext()).not.toBeNull();
    } finally {
      restoreWindow();
    }
  });

  it("connect mode 下 awaitLauncherBootstrap 是 no-op：不触发 acquire", async () => {
    const acquire = vi.fn(async () => null);
    const registry: import("@keymaster/contracts").LauncherBootstrapRegistry = { acquire };
    const opener = makeOpenerWithRegistry(registry);
    const restoreWindow = patchWindow({
      search: "?bootstrapToken=tok",
      opener
    });
    try {
      const { ProtocolServiceImpl } = await import("./protocolService.js");
      const svc = new ProtocolServiceImpl({
        vault: makeFakeVaultService(),
        keyspace: makeFakeKeyspace(),
        bootMode: "connect"
      });
      svc.awaitLauncherBootstrap();
      await new Promise((r) => setTimeout(r, 20));
      expect(acquire).not.toHaveBeenCalled();
      expect(svc.bootstrapFailed()).toBe(false);
    } finally {
      restoreWindow();
    }
  });
});