import { describe, expect, it, vi } from "vitest";
import { definePlugin, type RuntimeHandle } from "webloom-framework";
import { createWindowAppFromHost } from "webloom-framework/advanced";
import { connectSharedWorkerForTesting, startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "webloom-framework/testing";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { attachKeymasterRemoteRuntime, getWebLoomHost } from "@keymaster/runtime/assembly";
import { FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY, defineRuntimeUnitDependencies, type ForumPublishTask, type ForumService, type PluginContext } from "@keymaster/contracts";
import { createProtectedOutpointRegistry } from "@keymaster/runtime/test-support";
import { createForumRepository, createForumWorkerService, createForumServiceProxy, executeForumWorkerRequest, streamForumAttachment } from "@keymaster/plugin-forum/coordinator";

function createMemoryOwnerFileStore(): import("@keymaster/contracts").BorrowedModuleFileStore {
  const files = new Map<string, { bytes: Uint8Array; revision: string; lastModified: string }>(); let seq = 0;
  const check = (path: string, condition?: import("@keymaster/contracts").StorageWriteCondition) => {
    if (condition?.ifNoneMatch && files.has(path) || condition?.ifRevision !== undefined && condition.ifRevision !== files.get(path)?.revision) throw new Error("revision conflict");
  };
  const put = async (path: string, bytes: Uint8Array, condition?: import("@keymaster/contracts").StorageWriteCondition) => {
    check(path, condition); const entry = { bytes: bytes.slice(), revision: String(++seq), lastModified: "now" }; files.set(path, entry); return entry;
  };
  return { walletGeneration: "wallet", sessionEpoch: "epoch", runGeneration: "run",
    get: async path => { const row = files.get(path); return row ? { path, ...row, bytes: row.bytes.slice() } : undefined; },
    getRange: async (path, range) => { const row = files.get(path); return row ? { path, ...row, bytes: row.bytes.slice(range.offset, range.offset + range.length) } : undefined; },
    list: async input => ({ files: [...files].filter(([path]) => path.startsWith(input?.prefix ?? "")).map(([path, row]) => ({ path, size: row.bytes.length, revision: row.revision, lastModified: row.lastModified })) }),
    put, delete: async (path, condition) => { check(path, condition); files.delete(path); },
    batch: async input => { for (const condition of input.conditions ?? []) check(condition.path, condition); for (const operation of input.operations) { if (operation.type === "put") await put(operation.path, operation.bytes); else files.delete(operation.path); } return { paths: input.operations.map(operation => operation.path), committedAt: "now" }; },
  };
}

const owner = "02" + "aa".repeat(32);
const seedHashHex = "bb".repeat(32);
const config = { id: "forum-test", label: "Forum", network: "test" as const, forumTxid: "cc".repeat(32), forumPublicKeyHex: owner, endpoints: [{ kind: "https" as const, url: "https://forum.example" }] };

async function fixture(observation: "rejected" | "dropped" | "unknown" = "unknown") {
  let active = true;
  const storage = createMemoryOwnerFileStore();
  const repo = createForumRepository(storage);
  await repo.writeConfig(config);
  const task: ForumPublishTask = { taskId: "task-1", ownerPublicKeyHex: owner, network: "test", forumConfigId: config.id, forumTxid: config.forumTxid, forumPublicKeyHex: owner,
    kind: "reply", targetTxid: "dd".repeat(32), tipPrice: "0", phase: "draft", broadcastState: "not-dispatched", chainObservation: { state: "unknown", observedAtMs: 1 }, indexObservation: { state: "unknown", eventAcceptanceQueryable: true, observedAtMs: 1 }, createdAtMs: 1, updatedAtMs: 1 };
  await repo.writeTask(task);
  const bytes = new Uint8Array(32 * 1024 * 1024); bytes[0] = 89; bytes[bytes.length - 1] = 90;
  const wallet = { spend: {}, funding: {}, observer: { observeProtocolSubmission: async () => observation }, protectedOutpoints: createProtectedOutpointRegistry() };
  const runtime = await createForumWorkerService({ owner, epoch: "epoch", storage, assertActive: () => { if (!active) throw new Error("owner-session-revoked"); },
    wallet: { getService: async () => wallet } as never,
    crypto: { createActiveKeyCrypto: async () => { throw new Error("This read/cancel fixture must not sign"); } },
    network: { roundtrip: async () => { throw new Error("This read/cancel fixture must not use the Host"); } },
    query: {} as never,
    content: { openVerifiedAttachment: async () => ({ seedHashHex, bytes, byteLength: String(bytes.length), mediaType: "image/png" }) } as never,
  });
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const app = startSharedWorkerAppForTesting({ id: "forum-test-worker", globalScope: scope,
    plugins: [definePlugin({ id: "forum", name: "Forum", unitId: "forum.coordinator-worker", runtime: "shared-worker",
      provides: [FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY],
      setup(ctx) {
        ctx.handle(FORUM_WORKER_SERVICE_CAPABILITY, (request, call) => executeForumWorkerRequest(runtime.service, request, call.signal, () => { ctx.scope.assertActive(); if (!active) throw new Error("owner-session-revoked"); }));
        ctx.handle(FORUM_WORKER_ATTACHMENT_CAPABILITY, (request, call) => streamForumAttachment(runtime.service, request, call.signal, () => { ctx.scope.assertActive(); if (!active) throw new Error("owner-session-revoked"); }));
      },
    })], expose: [FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY],
  });
  await app.ready();
  const windows: { host: ReturnType<typeof createFixtureHost>; connection: RuntimeHandle; service: ForumService }[] = [];
  async function openWindow(id: string) {
    let service: ForumService | undefined;
    const host = createFixtureHost({ runtime: "window-main", runtimeUnitImplementationRegistry: { get: () => (ctx: PluginContext) => { service = createForumServiceProxy(ctx.capability(FORUM_WORKER_SERVICE_CAPABILITY), ctx.capability(FORUM_WORKER_ATTACHMENT_CAPABILITY)); } } });
    const page = await createWindowAppFromHost({ id, host: getWebLoomHost(host) });
    const connection = connectSharedWorkerForTesting({ id: app.runtimeId, url: "test:forum", client: { app: page } }, () => { const channel = new MessageChannel(); queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] })); return { port: channel.port1 }; });
    await vi.waitFor(() => expect(connection.state().state).toBe("ready"));
    attachKeymasterRemoteRuntime(host, connection);
    await host.registerAll([{ id: "forum-page", name: "Forum Page", units: [{ id: "forum-page.window", runtime: "window-main", scopeKind: "root", dependencies: defineRuntimeUnitDependencies([
      { capability: FORUM_WORKER_SERVICE_CAPABILITY, sourceRuntime: "shared-worker" }, { capability: FORUM_WORKER_ATTACHMENT_CAPABILITY, sourceRuntime: "shared-worker" },
    ]) }] }]);
    expect(host.state("forum-page").kind).toBe("enabled");
    const item = { host, connection, service: service! }; windows.push(item); return item;
  }
  return { openWindow, repo, revoke: () => { active = false; runtime.dispose(); }, async close() { for (const page of windows) { await page.connection.dispose(); await page.host.dispose(); } await app.dispose(); runtime.dispose(); } };
}

describe("Forum owner-session service over the real MessagePort framework", () => {
  it("two Window proxies observe the same Worker config and cancelled task", async () => {
    const f = await fixture(); try {
      const a = await f.openWindow("tab-a"), b = await f.openWindow("tab-b");
      await a.service.saveConfig({ ...config, label: "Changed" });
      expect((await b.service.getConfig(config.id))?.label).toBe("Changed");
      await a.service.cancelUndispatched("task-1");
      expect(await b.service.getPublishTask("task-1")).toMatchObject({ phase: "failed", failureCode: "cancelled", ownerPublicKeyHex: owner });
      expect(await f.repo.readTask("task-1")).toMatchObject({ phase: "failed", failureCode: "cancelled" });
    } finally { await f.close(); }
  });
  it("streams a verified 32 MiB attachment without exceeding RPC message limits", async () => {
    const f = await fixture(); try {
      const a = await f.openWindow("attachment-tab");
      const content = await a.service.readAttachmentContent(config.id, seedHashHex);
      expect(content?.bytes.byteLength).toBe(32 * 1024 * 1024); expect(content?.bytes[0]).toBe(89); expect(content?.bytes.at(-1)).toBe(90);
    } finally { await f.close(); }
  });
  it("retained proxies fail after owner revocation and never fall back to local mutation", async () => {
    const f = await fixture(); try {
      const a = await f.openWindow("old-tab"); f.revoke();
      await expect(a.service.saveConfig({ ...config, label: "Forbidden" })).rejects.toThrow("owner-session-revoked");
      expect((await f.repo.readConfig(config.id))?.label).toBe("Forum");
    } finally { await f.close(); }
  });
  it.each(["rejected", "dropped", "unknown"] as const)("%s wallet evidence does not authorize cancelling a signed task", async observation => {
    const f = await fixture(observation); try {
      const task = (await f.repo.readTask("task-1"))!;
      await f.repo.writeTask({ ...task, phase: "raw-prepared", submissionId: "submission-1", txid: "ee".repeat(32) });
      const a = await f.openWindow("signed-tab");
      await expect(a.service.cancelUndispatched("task-1")).rejects.toThrow();
      expect((await f.repo.readTask("task-1"))?.phase).toBe("raw-prepared");
    } finally { await f.close(); }
  });
  it("pre-cancelled calls do not mutate Worker tasks", async () => {
    const f = await fixture(); try {
      const a = await f.openWindow("cancelled-tab");
      await expect(a.service.quotePublish("task-1", { signal: AbortSignal.abort() })).rejects.toBeDefined();
      expect((await f.repo.readTask("task-1"))?.phase).toBe("draft");
    } finally { await f.close(); }
  });
});
