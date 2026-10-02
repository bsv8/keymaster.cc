// Worker 只读浏览服务的验收测试。
//
// 覆盖施工单验收矩阵里最关键、也最容易在重构中悄悄退化的几类行为：
//   A01 非平台调用与重放：受信任单元、端口归属、游标跨目录/跨会话、过期句柄
//   A02 路径边界：绝对路径、父路径、非法片段、相似前缀
//   F06 目录浏览 I/O：列举只读元数据，不读字节
//   L01/L02 版本条件读取、删除、锁定与世代变化后的失效
//   P06 预览 1 MiB 上限由 Worker 强制，截断内容不做结构化解析

import { describe, expect, it } from "vitest";
import {
  STORAGE_BROWSE_CURSOR_TTL_MS,
  STORAGE_BROWSE_MAX_LIMIT,
  STORAGE_BROWSE_PREVIEW_CONCURRENCY,
  STORAGE_BROWSE_PREVIEW_MAX_BYTES,
  type StorageBrowseWallet,
} from "@keymaster/contracts";
import { createStorageBrowseService, type StorageBrowseRuntime } from "./storageBrowseService.js";

const TRUSTED_UNIT = "storage.window";
const PAGE_CLIENT = "client-page";
/** 即时构造的浏览服务夹具使用的固定授权 id。 */
const AD_HOC_AUTHORIZATION = "auth-ad-hoc";
const ENCODER = new TextEncoder();

interface StoredObject {
  path: string;
  bytes: Uint8Array;
  revision?: number;
  contentType?: string;
  lastModified?: string;
}

interface HarnessOptions {
  objects?: StoredObject[];
  /** 覆盖默认只读夹具；用于构造「忽略取消、迟到成功」的读取。 */
  wallet?: StorageBrowseWallet;
  walletGeneration?: string;
  sessionEpoch?: string;
  runGeneration?: string;
  unlocked?: boolean;
  /** 已签发的浏览授权：id -> 归属端口。缺省时只有 PAGE_CLIENT 有一张。 */
  authorizations?: Record<string, string>;
  now?: () => number;
  pageSize?: number;
}

interface ListCall {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

interface Harness {
  runtime: StorageBrowseRuntime;
  wallet: StorageBrowseWallet & { listCalls: ListCall[]; getCalls: string[] };
  state: {
    walletGeneration: string;
    sessionEpoch: string;
    runGeneration: string;
    unlocked: boolean;
    /** Coordinator 侧签发的授权表；浏览服务只能按 id 查这里。 */
    authorizations: Map<string, { clientId: string; unitId: string }>;
    now: number;
  };
}

/** 造一个只读钱包夹具：list 只返回元数据，get 才返回字节。 */
function createHarness(options: HarnessOptions = {}): Harness {
  const objects = (options.objects ?? [])
    .map((object) => ({
      size: object.bytes.byteLength,
      revision: object.revision ?? 1,
      lastModified: object.lastModified ?? "2026-10-01T00:00:00.000Z",
      ...object,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const listCalls: ListCall[] = [];
  const getCalls: string[] = [];
  const wallet: Harness["wallet"] = {
    listCalls,
    getCalls,
    async list(input) {
      listCalls.push({
        ...(input?.prefix === undefined ? {} : { prefix: input.prefix }),
        ...(input?.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      });
      const prefix = input?.prefix;
      const matched = prefix === undefined ? objects : objects.filter((object) => object.path.startsWith(prefix));
      const after = input?.cursor;
      const start = after === undefined ? 0 : matched.findIndex((object) => object.path === after) + 1;
      const limit = Math.min(input?.limit ?? 50, options.pageSize ?? 50);
      const page = matched.slice(start, start + limit);
      const last = page[page.length - 1];
      return {
        objects: page.map((object) => ({
          path: object.path,
          size: object.size,
          lastModified: object.lastModified,
          revision: object.revision,
          ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        })),
        ...(last !== undefined && start + limit < matched.length ? { nextCursor: last.path } : {}),
      };
    },
    async get(path) {
      getCalls.push(path);
      const object = objects.find((candidate) => candidate.path === path);
      if (!object) return undefined;
      return {
        path: object.path,
        size: object.size,
        lastModified: object.lastModified,
        revision: object.revision,
        ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        bytes: object.bytes,
      };
    },
  };

  const state: Harness["state"] = {
    walletGeneration: options.walletGeneration ?? "wallet-1",
    sessionEpoch: options.sessionEpoch ?? "epoch-1",
    runGeneration: options.runGeneration ?? "run-1",
    unlocked: options.unlocked ?? true,
    authorizations: new Map(Object.entries(options.authorizations ?? { "auth-page": PAGE_CLIENT, "auth-other": "client-other" })
      .map(([id, clientId]) => [id, { clientId, unitId: TRUSTED_UNIT }] as const)),
    now: 1_000,
  };

  let idCounter = 0;
  const runtime = createStorageBrowseService({
    wallet: options.wallet ?? wallet,
    walletGeneration: () => state.walletGeneration,
    sessionEpoch: () => state.sessionEpoch,
    runGeneration: () => state.runGeneration,
    // 授权只能由 Coordinator 在已验证的端口上下文里签发；浏览服务自己只查表。
    trustedAuthorization: (clientId, authorizationId) => {
      const record = typeof authorizationId === "string" ? state.authorizations.get(authorizationId) : undefined;
      if (!record || record.clientId !== clientId) return undefined;
      return {
        unitId: record.unitId,
        clientId,
        walletGeneration: state.walletGeneration,
        sessionEpoch: state.sessionEpoch,
        runGeneration: state.runGeneration,
      };
    },
    isUnlocked: () => state.unlocked,
    now: options.now ?? (() => state.now),
    // 确定性句柄：游标与世代测试不依赖随机数。
    generateId: () => "id-" + (++idCounter),
  });

  return { runtime, wallet, state };
}

/** 该端口在 Coordinator 侧持有的授权 id；缺省夹具只有 PAGE_CLIENT 有授权。 */
function authorizationIdOf(harness: Harness, clientId: string = PAGE_CLIENT): string {
  for (const [id, record] of harness.state.authorizations) if (record.clientId === clientId) return id;
  return "auth-missing";
}

async function openSession(harness: Harness, clientId: string = PAGE_CLIENT): Promise<string> {
  const session = await harness.runtime.openSession(clientId, { authorizationId: authorizationIdOf(harness, clientId) });
  return session.browseSessionId;
}

function text(path: string, value: string, extra: Partial<StoredObject> = {}): StoredObject {
  return { path, bytes: ENCODER.encode(value), ...extra };
}

describe("storage browse service authorization (A01)", () => {
  it("only a Coordinator-issued, port-bound authorization can open a session", async () => {
    const harness = createHarness();
    // 没有任何「自报身份」的口子：请求体只有 Coordinator 签发的不透明授权 id。
    for (const authorizationId of ["", "x".repeat(257), "auth-guessed", "storage.window", TRUSTED_UNIT]) {
      await expect(harness.runtime.openSession(PAGE_CLIENT, { authorizationId }), authorizationId)
        .rejects.toMatchObject({ code: "storage_forbidden" });
    }
    await expect(harness.runtime.openSession(PAGE_CLIENT, {} as { authorizationId: string }))
      .rejects.toMatchObject({ code: "storage_forbidden" });
    const session = await harness.runtime.openSession(PAGE_CLIENT, { authorizationId: "auth-page" });
    expect(session.browseSessionId).not.toBe("");
    expect(session).toMatchObject({ walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1" });
  });

  it("rejects an untrusted peer that replays the trusted unit id (A01)", async () => {
    // 夹具里只有 PAGE_CLIENT 拿到了 Coordinator 签发的授权。另一个 peer 即使知道
    // 受信任单元的 id，也无法换取浏览会话：授权按端口绑定，且只能由 Coordinator 签发。
    const harness = createHarness({ authorizations: { "auth-page": PAGE_CLIENT } });
    for (const claimed of [TRUSTED_UNIT, "auth-page"]) {
      await expect(harness.runtime.openSession("client-evil", { authorizationId: claimed }), claimed)
        .rejects.toMatchObject({ code: "storage_forbidden" });
    }
    // 伪造额外字段（模仿旧的自报 unitId）同样不改变结果。
    await expect(harness.runtime.openSession("client-evil", { authorizationId: "auth-page", unitId: TRUSTED_UNIT } as never))
      .rejects.toMatchObject({ code: "storage_forbidden" });
  });

  it("rejects a revoked or replaced authorization on an already opened session (L02)", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    // Coordinator 撤销该端口的授权（端口断开 / 会话关闭 / 换代）后，旧句柄立刻作废。
    harness.state.authorizations.clear();
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("rejects an authorization issued for a different port", async () => {
    const harness = createHarness({ authorizations: { "auth-page": PAGE_CLIENT } });
    const session = await harness.runtime.openSession(PAGE_CLIENT, { authorizationId: "auth-page" });
    // 授权在 Coordinator 侧改绑到别的端口后，持有者立刻失去访问权。
    harness.state.authorizations.set("auth-page", { clientId: "client-other", unitId: TRUSTED_UNIT });
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: session.browseSessionId, prefix: "" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("refuses to open a session while the wallet is locked", async () => {
    const harness = createHarness({ unlocked: false });
    await expect(harness.runtime.openSession(PAGE_CLIENT, { authorizationId: "auth-page" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("binds the session to the calling port and hides foreign handles", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    // 另一个端口拿同一个句柄只会看到「不可用」，而不是任何内容。
    await expect(harness.runtime.list("client-other", { browseSessionId: sessionId, prefix: "" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId + "-guessed", prefix: "" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
    for (const id of ["", "x".repeat(257)]) {
      await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: id, prefix: "" }))
        .rejects.toMatchObject({ code: "storage_invalid_path" });
    }
  });

  it("revoking a port invalidates exactly its own sessions", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const pageSession = await openSession(harness, PAGE_CLIENT);
    const otherSession = await openSession(harness, "client-other");
    harness.runtime.revokeClient(PAGE_CLIENT);
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: pageSession, prefix: "" }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(harness.runtime.list("client-other", { browseSessionId: otherSession, prefix: "" })).resolves.toBeDefined();
  });

  it("revokeAll invalidates every session, including its cursors (L02)", async () => {
    const harness = createHarness({ objects: [text("notes/a.txt", "a"), text("notes/b.txt", "b")], pageSize: 1 });
    const sessionId = await openSession(harness);
    const first = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" });
    expect(first.nextCursor).toBeDefined();
    harness.runtime.revokeAll();
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "", cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("invalidates handles on lock, epoch change, wallet reset and worker restart (L02)", async () => {
    const scenarios: Array<{ label: string; mutate: (state: Harness["state"]) => void }> = [
      { label: "lock", mutate: (state) => { state.unlocked = false; } },
      { label: "session epoch", mutate: (state) => { state.sessionEpoch = "epoch-2"; } },
      { label: "wallet generation", mutate: (state) => { state.walletGeneration = "wallet-2"; } },
      { label: "worker run generation", mutate: (state) => { state.runGeneration = "run-2"; } },
    ];
    for (const scenario of scenarios) {
      const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
      const sessionId = await openSession(harness);
      await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" });
      scenario.mutate(harness.state);
      await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" }), scenario.label)
        .rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "notes/readme.txt" }), scenario.label)
        .rejects.toMatchObject({ code: "storage_unavailable" });
    }
  });
});

describe("storage browse listing (F03/F04/F06)", () => {
  it("lists metadata only and never reads bytes", async () => {
    const harness = createHarness({
      objects: [text("notes/readme.txt", "hello"), text("notes/b.json", "{}")],
    });
    const sessionId = await openSession(harness);
    const page = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "notes/" });
    expect(page.entries.map((entry) => entry.path)).toEqual(["notes/b.json", "notes/readme.txt"]);
    expect(page.entries[0]).toMatchObject({ size: 2, revision: "1", lastModified: "2026-10-01T00:00:00.000Z" });
    expect(harness.wallet.getCalls).toEqual([]);
  });

  it("scans a directory prefix with a trailing slash so similar names stay out", async () => {
    const harness = createHarness({
      objects: [
        { path: "apps/a/.dir", bytes: new Uint8Array(0), contentType: "application/x-directory" },
        text("apps/a/settings.json", "{}"),
        { path: "apps/a-evil/.dir", bytes: new Uint8Array(0), contentType: "application/x-directory" },
      ],
    });
    const sessionId = await openSession(harness);
    const page = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "apps/a" });
    expect(page.entries.map((entry) => entry.path)).toEqual(["apps/a/.dir", "apps/a/settings.json"]);
    expect(harness.wallet.listCalls[0]?.prefix).toBe("apps/a/");
  });

  it("paginates with a cursor bound to its directory", async () => {
    const objects = Array.from({ length: 7 }, (_, index) => text("deep/file-" + index + ".txt", String(index)));
    const harness = createHarness({ objects, pageSize: 3 });
    const sessionId = await openSession(harness);
    const first = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep" });
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();

    // 换一个目录继续加载就是越界；伪造游标同样失败。
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "", cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "storage_conflict" });
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep", cursor: String(first.nextCursor) + "-forged" }))
      .rejects.toMatchObject({ code: "storage_conflict" });
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep", cursor: "" }))
      .rejects.toMatchObject({ code: "storage_conflict" });

    const second = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep", cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.path)).toEqual(["deep/file-3.txt", "deep/file-4.txt", "deep/file-5.txt"]);
    const third = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep", cursor: second.nextCursor });
    expect(third.entries.map((entry) => entry.path)).toEqual(["deep/file-6.txt"]);
    // 最后一页没有游标：这是「目录已扫完」的唯一依据。
    expect(third.nextCursor).toBeUndefined();
  });

  it("does not let one session's cursor work in another session", async () => {
    const harness = createHarness({ objects: [text("deep/a.txt", "a"), text("deep/b.txt", "b")], pageSize: 1 });
    const firstSession = await openSession(harness, PAGE_CLIENT);
    const secondSession = await openSession(harness, "client-other");
    const page = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: firstSession, prefix: "deep" });
    await expect(harness.runtime.list("client-other", { browseSessionId: secondSession, prefix: "deep", cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: "storage_conflict" });
  });

  it("expires cursors after their TTL", async () => {
    const harness = createHarness({
      objects: [text("deep/a.txt", "a"), text("deep/b.txt", "b"), text("deep/c.txt", "c")],
      pageSize: 2,
    });
    const sessionId = await openSession(harness);
    const first = await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep" });
    harness.state.now += STORAGE_BROWSE_CURSOR_TTL_MS + 1;
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "deep", cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "storage_conflict" });
  });

  it("bounds the page size and rejects malformed limits", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    await harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "", limit: STORAGE_BROWSE_MAX_LIMIT });
    const badLimits: unknown[] = [0, -1, 1.5, STORAGE_BROWSE_MAX_LIMIT + 1, Number.NaN, Number.POSITIVE_INFINITY, "10"];
    for (const limit of badLimits) {
      await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "", limit: limit as number }))
        .rejects.toMatchObject({ code: "storage_limit_exceeded" });
    }
  });
});

describe("storage browse path boundaries (A02)", () => {
  it("rejects absolute paths, parent traversal and illegal segments before any read", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    const badPaths = ["/etc/passwd", "/notes", "../secrets", "notes/../../secrets", "notes//readme.txt", "./notes", "notes/./readme.txt", "notes/", "", "/"];
    for (const path of badPaths) {
      await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path }), path)
        .rejects.toMatchObject({ code: "storage_invalid_path" });
    }
    // 边界失败必须发生在读之前，否则越界路径仍会碰到钱包。
    expect(harness.wallet.getCalls).toEqual([]);
  });

  it("treats the logical root as a listing target but not as an object path", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    // 显示用根在 RPC 层表示为空串；"/" 不是合法的列表前缀语义，也不是对象路径。
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "/" })).resolves.toBeDefined();
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" })).resolves.toBeDefined();
    await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "/" }))
      .rejects.toMatchObject({ code: "storage_invalid_path" });
  });

  it("rejects traversal and absolute listing prefixes", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    for (const prefix of ["/apps", "../apps", "apps/../../etc", "apps/./x"]) {
      await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix }), prefix)
        .rejects.toMatchObject({ code: "storage_invalid_path" });
    }
    expect(harness.wallet.listCalls).toEqual([]);
  });
});

describe("storage browse preview (P01/P02/P05/P06/L01)", () => {
  it("returns JSON metadata with the declared content type", async () => {
    const harness = createHarness({ objects: [text("a.json", '{"a":1}', { contentType: "application/json" })] });
    const sessionId = await openSession(harness);
    const preview = await harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "a.json" });
    expect(preview).toMatchObject({
      path: "a.json",
      format: "json",
      totalSize: 7,
      returnedSize: 7,
      truncated: false,
      revision: "1",
      contentType: "application/json",
    });
    expect(new TextDecoder().decode(preview.bytes)).toBe('{"a":1}');
  });

  it("enforces the 1 MiB cap in the worker and refuses to parse truncated content (P06)", async () => {
    const oversized = new Uint8Array(STORAGE_BROWSE_PREVIEW_MAX_BYTES + 128);
    oversized.set(ENCODER.encode('{"head":1'), 0);
    const harness = createHarness({ objects: [text("big.json", "", { bytes: oversized, contentType: "application/json" })] });
    const sessionId = await openSession(harness);
    const preview = await harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "big.json" });
    expect(preview.returnedSize).toBe(STORAGE_BROWSE_PREVIEW_MAX_BYTES);
    expect(preview.totalSize).toBe(oversized.byteLength);
    expect(preview.truncated).toBe(true);
    // 半个 JSON 不是 JSON：截断时不做结构化解析。
    expect(preview.format).toBe("truncated");
    expect(preview.kvPayload).toBeUndefined();
    expect(preview.kvError).toBeUndefined();
  });

  it("does not claim a successful decode for a truncated K-V envelope (P05)", async () => {
    const oversized = new Uint8Array(STORAGE_BROWSE_PREVIEW_MAX_BYTES + 64);
    oversized.set(ENCODER.encode("keymaster-kv-value-v1:"), 0);
    const harness = createHarness({ objects: [text("big-value.bin", "", { bytes: oversized })] });
    const sessionId = await openSession(harness);
    const preview = await harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "big-value.bin" });
    expect(preview.format).toBe("truncated");
    expect(preview.kvPayload).toBeUndefined();
    expect(preview.kvError).toBeUndefined();
  });

  it("reports a conflict instead of silently returning another version (L01)", async () => {
    const harness = createHarness({ objects: [text("a.json", '{"v":1}', { revision: 4 })] });
    const sessionId = await openSession(harness);
    await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "a.json", ifRevision: "3" }))
      .rejects.toMatchObject({ code: "storage_conflict" });
    await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "a.json", ifRevision: "4" }))
      .resolves.toMatchObject({ revision: "4" });
    for (const ifRevision of ["v4", "", "4.0", "-1", 4]) {
      await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "a.json", ifRevision: ifRevision as string }))
        .rejects.toMatchObject({ code: "storage_invalid_path" });
    }
  });

  it("reports a deleted object as not found (L01)", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness);
    await expect(harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "notes/gone.txt" }))
      .rejects.toMatchObject({ code: "storage_not_found" });
  });

  it("never starts the read when the caller already cancelled (L01)", async () => {
    let getCalls = 0;
    let observedSignal = true;
    const wallet: StorageBrowseWallet = {
      async list() {
        return { objects: [] };
      },
      async get(_path, getOptions) {
        getCalls += 1;
        observedSignal = getOptions?.signal?.aborted === true;
        return undefined;
      },
    };
    const runtime = createStorageBrowseService({
      wallet,
      walletGeneration: () => "wallet-1",
      sessionEpoch: () => "epoch-1",
      runGeneration: () => "run-1",
      trustedAuthorization: (_clientId, authorizationId) => authorizationId === AD_HOC_AUTHORIZATION
        ? { unitId: TRUSTED_UNIT, clientId: PAGE_CLIENT, walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1" }
        : undefined,
      isUnlocked: () => true,
    });
    const session = await runtime.openSession(PAGE_CLIENT, { authorizationId: AD_HOC_AUTHORIZATION });
    const controller = new AbortController();
    controller.abort();
    // 已经取消的请求连 WalletStore 都不该碰到：入场复核直接把它挡下来。
    await expect(runtime.preview(PAGE_CLIENT, { browseSessionId: session.browseSessionId, path: "a.json" }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "storage_unavailable" });
    expect(getCalls).toBe(0);
    expect(observedSignal).toBe(true);
  });

  it("propagates an in-flight cancellation to the underlying read", async () => {
    let observedAbort = false;
    const wallet: StorageBrowseWallet = {
      async list() {
        return { objects: [] };
      },
      async get(_path, getOptions) {
        return await new Promise((_resolve, reject) => {
          const signal = getOptions?.signal;
          if (!signal || signal.aborted) {
            observedAbort = true;
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    };
    const runtime = createStorageBrowseService({
      wallet,
      walletGeneration: () => "wallet-1",
      sessionEpoch: () => "epoch-1",
      runGeneration: () => "run-1",
      trustedAuthorization: (_clientId, authorizationId) => authorizationId === AD_HOC_AUTHORIZATION
        ? { unitId: TRUSTED_UNIT, clientId: PAGE_CLIENT, walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1" }
        : undefined,
      isUnlocked: () => true,
    });
    const session = await runtime.openSession(PAGE_CLIENT, { authorizationId: AD_HOC_AUTHORIZATION });
    const controller = new AbortController();
    const pending = runtime.preview(PAGE_CLIENT, { browseSessionId: session.browseSessionId, path: "slow.json" }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(observedAbort).toBe(true);
  });

  it("stops in-flight previews when the session closes (L02)", async () => {
    let observedAbort = false;
    const wallet: StorageBrowseWallet = {
      async list() {
        return { objects: [] };
      },
      async get(_path, getOptions) {
        return await new Promise((_resolve, reject) => {
          const signal = getOptions?.signal;
          if (!signal || signal.aborted) {
            observedAbort = true;
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    };
    const runtime = createStorageBrowseService({
      wallet,
      walletGeneration: () => "wallet-1",
      sessionEpoch: () => "epoch-1",
      runGeneration: () => "run-1",
      trustedAuthorization: (_clientId, authorizationId) => authorizationId === AD_HOC_AUTHORIZATION
        ? { unitId: TRUSTED_UNIT, clientId: PAGE_CLIENT, walletGeneration: "wallet-1", sessionEpoch: "epoch-1", runGeneration: "run-1" }
        : undefined,
      isUnlocked: () => true,
    });
    const session = await runtime.openSession(PAGE_CLIENT, { authorizationId: AD_HOC_AUTHORIZATION });
    const pending = runtime.preview(PAGE_CLIENT, { browseSessionId: session.browseSessionId, path: "slow.json" });
    await runtime.closeSession(PAGE_CLIENT, session.browseSessionId);
    await expect(pending).rejects.toThrow();
    expect(observedAbort).toBe(true);
  });

  it("never hands back bytes that arrive after the session was revoked (L02)", async () => {
    // 底层读取忽略 AbortSignal 并在撤销之后才成功：这正是「读取前检查一次」漏掉的
    // 那条路径。服务必须在 await 之后再核一次会话与授权。
    const gate: Array<() => void> = [];
    const readPaths: string[] = [];
    const wallet: StorageBrowseWallet = {
      async list() {
        return { objects: [] };
      },
      async get(path) {
        readPaths.push(path);
        await new Promise<void>((resolve) => gate.push(resolve));
        return { path, size: 2, lastModified: "2026-10-01T00:00:00.000Z", revision: 1, bytes: ENCODER.encode("hi") };
      },
    };
    const harness = createHarness({ wallet });
    const sessionId = await openSession(harness);
    const pending = harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "notes/late.json" });
    await Promise.resolve();
    expect(readPaths).toContain("notes/late.json");

    // 读取尚未完成时授权被撤销：随后到达的成功结果不能变成文件内容。
    harness.state.authorizations.clear();
    gate.forEach((release) => release());
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("never returns a metadata page that arrives after the session was revoked (L02)", async () => {
    const gate: Array<() => void> = [];
    const wallet: StorageBrowseWallet = {
      async list() {
        await new Promise<void>((resolve) => gate.push(resolve));
        return { objects: [{ path: "notes/a.txt", size: 1, lastModified: "2026-10-01T00:00:00.000Z", revision: 1 }] };
      },
      async get() {
        return undefined;
      },
    };
    const harness = createHarness({ wallet });
    const sessionId = await openSession(harness);
    const pending = harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" });
    await Promise.resolve();

    harness.runtime.revokeClient(PAGE_CLIENT);
    gate.forEach((release) => release());
    await expect(pending).rejects.toMatchObject({ code: "storage_unavailable" });
  });

  it("does not start a queued read whose session was revoked while it waited (L02)", async () => {
    // 并发闸是 2：前两个读取占满闸门，第三个在排队。排队期间撤销会话后，第三个
    // 必须在真正开始之前就被拦下，一个字节都不读。
    const gate: Array<() => void> = [];
    const readPaths: string[] = [];
    const wallet: StorageBrowseWallet = {
      async list() {
        return { objects: [] };
      },
      async get(path) {
        readPaths.push(path);
        if (readPaths.length <= STORAGE_BROWSE_PREVIEW_CONCURRENCY) {
          await new Promise<void>((resolve) => gate.push(resolve));
        }
        return { path, size: 2, lastModified: "2026-10-01T00:00:00.000Z", revision: 1, bytes: ENCODER.encode("hi") };
      },
    };
    const harness = createHarness({ wallet });
    const sessionId = await openSession(harness);
    const slow = ["a", "b"].map((name) => harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: name + ".json" }));
    await Promise.resolve();
    await Promise.resolve();
    const queued = harness.runtime.preview(PAGE_CLIENT, { browseSessionId: sessionId, path: "queued.json" });
    await Promise.resolve();
    expect(readPaths).toHaveLength(STORAGE_BROWSE_PREVIEW_CONCURRENCY);

    harness.state.authorizations.clear();
    gate.forEach((release) => release());
    await Promise.allSettled(slow);
    await expect(queued).rejects.toMatchObject({ code: "storage_unavailable" });
    // 第三个请求从未真正开始过读取。
    expect(readPaths).not.toContain("queued.json");
  });

  it("closing a foreign handle is a no-op, not a cross-port action", async () => {
    const harness = createHarness({ objects: [text("notes/readme.txt", "hi")] });
    const sessionId = await openSession(harness, PAGE_CLIENT);
    await harness.runtime.closeSession("client-other", sessionId);
    await expect(harness.runtime.list(PAGE_CLIENT, { browseSessionId: sessionId, prefix: "" })).resolves.toBeDefined();
  });
});
