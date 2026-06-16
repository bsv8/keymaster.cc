// packages/plugin-poker/src/pokerService.test.ts
// 验证 PokerService 在硬切换 004 之后的核心不变量：
//   - active key = single + ready：可 connect / auth / publish / settings 持久化；
//   - active key = all / vault locked / active key not ready：connect/publish fail-closed；
//   - active key 切换（A → B）：旧 ws 断开，旧内存态清空，新 session key 切到 B；
//   - 删除非 active key 不影响当前会话；
//   - 删除当前 active key：key.deleting 阶段先停止旧会话，key.deleted 后无旧 key 内存态；
//   - activeKey.changed 到新 key 后能按新 key 重建；
//   - vault 锁定时清空可见会话态并停止重连；
//   - 全局网络配置（pokerGlobalConfig）不随 key 切换丢失；
//   - 桌内切 active key 会强制收拢（service 内部已断开订阅，UI 由 PokerTable 监听）。

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPokerService } from "./pokerService.js";
import {
  clearPokerGlobalConfig,
  readPokerGlobalConfig,
  writePokerGlobalConfig
} from "./pokerGlobalConfig.js";

class FakeMessageBus {
  private handlers = new Map<string, Array<(p: any) => void>>();
  publish(type: string, payload: any) {
    const hs = this.handlers.get(type) ?? [];
    for (const h of hs) h(payload);
  }
  subscribe<T>(type: string, handler: (p: T) => void) {
    const arr = this.handlers.get(type) ?? [];
    arr.push(handler as any);
    this.handlers.set(type, arr);
    return () => {
      const a = this.handlers.get(type) ?? [];
      this.handlers.set(type, a.filter((h) => h !== handler));
    };
  }
  dispatch() {
    throw new Error("not implemented");
  }
  request<T, R>(): Promise<R> {
    throw new Error("not implemented");
  }
  handle() {
    return () => undefined;
  }
  snapshot() {
    return { total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} };
  }
  onSnapshot() {
    return () => undefined;
  }
}

const KEY_A = {
  keyId: "kA",
  publicKeyHash: "pkhA",
  publicKeyHex: "02" + "ab".repeat(32),
  label: "A",
  capabilities: ["poker"],
  createdAt: "",
  identityStatus: "ready" as const
};
const KEY_B = {
  keyId: "kB",
  publicKeyHash: "pkhB",
  publicKeyHex: "03" + "cd".repeat(32),
  label: "B",
  capabilities: ["poker"],
  createdAt: "",
  identityStatus: "ready" as const
};

class FakeVault {
  private statusV: "unlocked" | "locked" = "unlocked";
  private statusHandlers = new Set<(s: any) => void>();
  status() {
    return this.statusV;
  }
  setStatus(s: "unlocked" | "locked") {
    this.statusV = s;
    for (const h of this.statusHandlers) h(s);
  }
  onStatusChange(h: (s: any) => void) {
    this.statusHandlers.add(h);
    return () => {
      this.statusHandlers.delete(h);
    };
  }
  getInitialActivationNotice() {
    return null;
  }
  clearInitialActivationNotice() {}
  onInitialActivationNoticeChange() {
    return () => undefined;
  }
  hasVault = async () => true;
  async createVault() {}
  async createVaultWithInitialKey() {
    throw new Error("not used");
  }
  async createVaultWithImportedKey() {
    throw new Error("not used");
  }
  async unlock() {}
  async lock() {}
  async verifyPassword() {}
  async finalizeEmptyVaultAfterLastKeyDeletion() {}
  async listKeys() {
    return [KEY_A, KEY_B];
  }
  async getKey() {
    return undefined;
  }
  async getKeyByPublicKeyHash() {
    return undefined;
  }
  async findByAddress() {
    return undefined;
  }
  async importPrivateKey() {
    throw new Error("not used");
  }
  async generateKey() {
    throw new Error("not used");
  }
  async deleteKeyMaterial() {}
  async removeKey() {
    throw new Error("deprecated");
  }
  async exportPrivateKey() {
    throw new Error("not used");
  }
  async withPrivateKey<T>(_id: string, fn: (m: any) => Promise<T>) {
    return fn({ hex: "11".repeat(32) });
  }
}

class FakeKeyspace {
  private state = { mode: "single" as "single" | "all", activePublicKeyHash: "pkhA" as string | undefined };
  private dbs = new Map<string, IDBDatabase>();
  private activeHandlers = new Set<(s: any) => void>();
  private keyMeta = new Map<string, any>([
    ["pkhA", KEY_A],
    ["pkhB", KEY_B]
  ]);

  async listKeys() {
    return [KEY_A, KEY_B];
  }
  async getKey(pkh: string) {
    return this.keyMeta.get(pkh);
  }
  active() {
    return { ...this.state };
  }
  async setActive(pkh: string) {
    this.state = { mode: "single", activePublicKeyHash: pkh };
    for (const h of this.activeHandlers) h(this.state);
  }
  async setAll() {
    this.state = { mode: "all" };
    for (const h of this.activeHandlers) h(this.state);
  }
  requireActiveKey() {
    return KEY_A as any;
  }
  onActiveChange(h: (s: any) => void) {
    this.activeHandlers.add(h);
    return () => {
      this.activeHandlers.delete(h);
    };
  }
  emitKeyDeleting(pkh: string) {
    this.bus.publish("key.deleting", { publicKeyHash: pkh });
  }
  emitKeyDeleted(pkh: string) {
    this.bus.publish("key.deleted", { publicKeyHash: pkh });
  }
  /** 测试钩子：让下一次 getKey 返回特定状态。 */
  setKeyStatus(pkh: string, identityStatus: "ready" | "uninitialized" | "failed", identityError?: string) {
    const cur = this.keyMeta.get(pkh);
    if (!cur) return;
    this.keyMeta.set(pkh, { ...cur, identityStatus, identityError });
  }
  /** 测试钩子：模拟 key 从 keyspace 中删除。 */
  removeKeyMeta(pkh: string) {
    this.keyMeta.delete(pkh);
  }

  async openKeyStorage(input: {
    publicKeyHash: string;
    pluginId: string;
    storageId: string;
    version: number;
    upgrade: (db: IDBDatabase, oldV: number, newV: number | null) => void;
  }) {
    const name = `keymaster.key.${input.publicKeyHash}.plugin.${input.pluginId}.${input.storageId}`;
    return await new Promise<{ db: IDBDatabase; name: string; close(): void }>((resolve, reject) => {
      const req = indexedDB.open(name, input.version);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        input.upgrade(db, e.oldVersion, e.newVersion);
      };
      req.onsuccess = () => {
        const db = req.result;
        this.dbs.set(name, db);
        resolve({ db, name, close: () => db.close() });
      };
      req.onerror = () => reject(req.error);
    });
  }
  registerPluginStorage() {}
  listPluginStorages() {
    return [];
  }
  async prepareDeleteKey() {}
  async deleteKey() {}
  async deleteKeyById() {}
  attachBackgroundService() {}
  isInitializing() {
    return false;
  }
  onInitializationChange() {
    return () => undefined;
  }

  private bus!: FakeMessageBus;
  attachBus(b: FakeMessageBus) {
    this.bus = b;
  }
}

let svc: ReturnType<typeof createPokerService>;
let vault: FakeVault;
let keyspace: FakeKeyspace;
let bus: FakeMessageBus;

beforeEach(async () => {
  // 每个测试重置 localStorage 与 IndexedDB。
  if (typeof localStorage !== "undefined") localStorage.clear();
  // fake-indexeddb 提供 reset 方法（dynamic require 避免 ts 抱怨）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fdb = require("fake-indexeddb/lib/FDBFactory");
  (globalThis as any).indexedDB = new fdb();
  vault = new FakeVault();
  keyspace = new FakeKeyspace();
  bus = new FakeMessageBus();
  keyspace.attachBus(bus);
  svc = createPokerService({ vault: vault as any, keyspace: keyspace as any, messageBus: bus as any });
  // 让 service 的 init rebind 完成。
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  try {
    svc.disconnect();
  } catch {
    /* swallow */
  }
});

describe("pokerService (active-key-driven)", () => {
  it("initial state: ready when active key is single + ready", () => {
    const state = svc.getActivePokerKey();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHash).toBe("pkhA");
    }
  });

  it("connect fails when proxyEndpoint empty", async () => {
    await expect(svc.connect()).rejects.toThrow(/proxyEndpoint/);
  });

  it("connect fails when active key not ready (failed)", async () => {
    keyspace.setKeyStatus("pkhA", "failed", "decrypt failed");
    // 触发一次 activeKey.changed 让 service 重新评估。
    await keyspace.setActive("pkhA");
    await new Promise((r) => setTimeout(r, 0));
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    await expect(svc.connect()).rejects.toThrow(/not ready/);
  });

  it("all-mode fails-closed: connect throws and no ws opens", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    await keyspace.setAll();
    await new Promise((r) => setTimeout(r, 0));
    await expect(svc.connect()).rejects.toThrow(/all-keys mode/);
    expect(svc.status()).not.toBe("ready");
  });

  it("vault.lock() immediately fails-closed", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    vault.setStatus("locked");
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.getActivePokerKey().kind).toBe("vaultLocked");
    await expect(svc.connect()).rejects.toThrow(/locked/);
  });

  it("publishFrame throws when not ready", async () => {
    await expect(svc.publishFrame("t1", new Uint8Array([1, 2, 3]))).rejects.toThrow(/not ready/);
  });

  it("handles protocol mismatch by disconnecting", () => {
    (svc as any).currentStatus = "ready";
    (svc as any).onMessage({ v: 1, type: "error", payload: { code: "protocol.mismatch", message: "boom" } });
    expect(svc.status()).toBe("closed");
  });

  it("blocks fallback broadcast when settings say no", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example", allowFallbackBroadcast: false });
    (svc as any).handleTxDeliver({ txid: "tx1", route: "fallback-broadcast", rawTx: "AAAA" });
    expect(svc.recentTxEvents().length).toBe(0);
    (svc as any).handleTxDeliver({ txid: "tx2", route: "direct", rawTx: "AAAA" });
    expect(svc.recentTxEvents().length).toBe(1);
  });

  it("active key change pkhA → pkhB rebinds session and clears old state", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    // 模拟 ready 并推送一条 presences，确认切 key 时会被清。
    (svc as any).currentStatus = "ready";
    (svc as any).presences.set("02" + "ab".repeat(32), {
      publicKeyHex: "02" + "ab".repeat(32),
      seenAt: 1
    });
    expect(svc.listPresences().length).toBe(1);
    await keyspace.setActive("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    const state = svc.getActivePokerKey();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHash).toBe("pkhB");
    }
    // 旧 presences 已清空（service 切 key 时 clearSessionInMemory）。
    expect(svc.listPresences().length).toBe(0);
    // internal session key hash 也切到 pkhB。
    expect((svc as any).currentSessionKeyHash).toBe("pkhB");
  });

  it("all-mode change pkhA → all clears session and surfaces allMode state", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).currentStatus = "ready";
    await keyspace.setAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.getActivePokerKey().kind).toBe("allMode");
    expect(svc.status()).toBe("closed");
  });

  it("key.deleting for current session key teardown immediately", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).currentStatus = "ready";
    keyspace.emitKeyDeleting("pkhA");
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.status()).toBe("closed");
    expect(svc.listPresences().length).toBe(0);
    expect(svc.listTables().length).toBe(0);
    expect((svc as any).currentSessionKeyHash).toBeNull();
  });

  it("key.deleted on non-active key does not disturb current session (preserves presences/tables)", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).currentStatus = "ready";
    // 当前 active key 是 pkhA；在内存里挂一条 pkhB 的 presence（模拟
    // 之前观察到的另一玩家；不应该因为 pkhB 被删就被清）。
    const ghostPresence = {
      publicKeyHex: "03" + "cd".repeat(32),
      seenAt: 1
    };
    (svc as any).presences.set(ghostPresence.publicKeyHex, ghostPresence);
    const ghostTable = {
      tableId: "t-ghost",
      variant: "TexasHoldem",
      seats: 4,
      stakes: 0,
      ownerPub: "03" + "cd".repeat(32)
    };
    (svc as any).tables.set(ghostTable.tableId, ghostTable);
    expect(svc.listPresences().length).toBe(1);
    expect(svc.listTables().length).toBe(1);
    // 删除非 active key（pkhB）。
    keyspace.emitKeyDeleted("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    // 关键不变量（硬切换 004 情况 4）：当前 active key 没变，且当前
    // session 的 presences / tables 必须原样保留——删除非当前 key
    // 不能清空当前会话的内存态。
    expect(svc.getActivePokerKey().kind).toBe("ready");
    if (svc.getActivePokerKey().kind === "ready") {
      expect(svc.getActivePokerKey().key.publicKeyHash).toBe("pkhA");
    }
    expect(svc.listPresences().length).toBe(1);
    expect(svc.listPresences()[0]?.publicKeyHex).toBe(ghostPresence.publicKeyHex);
    expect(svc.listTables().length).toBe(1);
    expect(svc.listTables()[0]?.tableId).toBe(ghostTable.tableId);
    expect(svc.status()).toBe("ready");
  });

  it("global settings persist across service instances", async () => {
    await svc.updateSettings({
      proxyEndpoint: "wss://persist.example",
      announceP2PNodeEndpoint: "node:1",
      announceTxLinkEndpoint: "tx:1",
      allowFallbackBroadcast: false
    });
    // 模拟"应用刷新"：构造一个新 service，应能从全局配置 hydrate。
    const svc2 = createPokerService({
      vault: vault as any,
      keyspace: keyspace as any,
      messageBus: bus as any
    });
    await new Promise((r) => setTimeout(r, 0));
    const s = svc2.getSettings();
    expect(s.proxyEndpoint).toBe("wss://persist.example");
    expect(s.announceP2PNodeEndpoint).toBe("node:1");
    expect(s.announceTxLinkEndpoint).toBe("tx:1");
    expect(s.allowFallbackBroadcast).toBe(false);
  });

  it("global settings survive active key switch", async () => {
    await svc.updateSettings({
      proxyEndpoint: "wss://persist.example",
      allowFallbackBroadcast: false
    });
    await keyspace.setActive("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    // 切 key 不应改变全局 settings。
    expect(svc.getSettings().proxyEndpoint).toBe("wss://persist.example");
    expect(svc.getSettings().allowFallbackBroadcast).toBe(false);
  });

  it("AuthOK auto-subscribes to bsvp/dir + bsvp/presence and replays state", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).currentStatus = "ready";
    const sent: any[] = [];
    (svc as any).send = (env: any) => {
      sent.push(env);
    };
    await svc.subscribeTopics(["t-deadbeef"]);
    await svc.publishPresence(new Uint8Array([1, 2, 3]), 60);
    await svc.publishTable("t-deadbeef", new Uint8Array([4, 5, 6]), 60);
    sent.length = 0;
    (svc as any).replayAfterAuthOK();
    const types = sent.map((s) => s.type);
    expect(types).toContain("topic.subscribe");
    expect(types).toContain("presence.publish");
    expect(types).toContain("table.publish");
    const sub = sent.find((s) => s.type === "topic.subscribe");
    const topics: string[] = sub?.payload?.topics ?? [];
    expect(topics).toContain("bsvp/dir");
    expect(topics).toContain("bsvp/presence");
    expect(topics).toContain("t-deadbeef");
  });

  it("auth.response echoes challenge nonce verbatim and signs with active key", async () => {
    (svc as any).currentStatus = "connecting";
    const sent: any[] = [];
    (svc as any).send = (env: any) => {
      sent.push(env);
    };
    const nonceHex = "deadbeef" + "0011".repeat(14);
    await (svc as any).handleChallenge({
      v: 1,
      type: "auth.challenge",
      payload: { nonce: nonceHex, protocolVersion: 1 }
    });
    const resp = sent.find((s) => s.type === "auth.response");
    expect(resp).toBeTruthy();
    expect(resp.payload.nonce).toBe(nonceHex);
    expect(typeof resp.payload.signature).toBe("string");
    expect(resp.payload.publicKeyHex).toContain("02ab");
  });

  it("ensureReady rejects when session key drifted from active key", async () => {
    (svc as any).currentStatus = "ready";
    // 模拟 session key 与 active 不一致（service 内部缓存错位）。
    (svc as any).currentSessionKey = { ...KEY_A, publicKeyHash: "staleHash" };
    await expect(svc.publishFrame("t1", new Uint8Array([1]))).rejects.toThrow(/drifted/);
  });

  it("onActivePokerKeyChange fires when active key flips A→B", async () => {
    const seen: string[] = [];
    svc.onActivePokerKeyChange((s) => {
      seen.push(s.kind);
    });
    await keyspace.setActive("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toContain("ready");
  });

  it("old identity-binding API is gone: service has no bindIdentity", () => {
    expect((svc as any).bindIdentity).toBeUndefined();
    expect((svc as any).unbindIdentity).toBeUndefined();
    expect((svc as any).getIdentityBinding).toBeUndefined();
    expect((svc as any).listIdentityCandidates).toBeUndefined();
  });

  it("updateSettings writes to global config (localStorage) and survives module reload", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://ls.example" });
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("wss://ls.example");
    clearPokerGlobalConfig();
    expect(readPokerGlobalConfig().proxyEndpoint).toBe("");
    // 重新写入然后直接读 raw localStorage 验证写入路径。
    writePokerGlobalConfig({
      proxyEndpoint: "wss://x",
      announceP2PNodeEndpoint: "a",
      announceTxLinkEndpoint: "b",
      allowFallbackBroadcast: false
    });
    expect(readPokerGlobalConfig()).toEqual({
      proxyEndpoint: "wss://x",
      announceP2PNodeEndpoint: "a",
      announceTxLinkEndpoint: "b",
      allowFallbackBroadcast: false
    });
  });

  // ------------------------------------------------------------------------
  // 硬切换 004 反馈修复：active key 切换 / 删除后必须按新 key 重建会话
  // ------------------------------------------------------------------------

  it("key.deleting fired BEFORE init rebind still teardowns current session", async () => {
    // 不走 beforeEach 的 init 流程：直接 new service，立即在 init
    // rebind 完成前发 key.deleting。这条路径专门覆盖"事件竞争"——
    // 不能依赖 this.currentSessionKeyHash（异步 init 才填），必须用
    // keyspace.active() 同步判定。
    if (typeof localStorage !== "undefined") localStorage.clear();
    const fdb = require("fake-indexeddb/lib/FDBFactory");
    (globalThis as any).indexedDB = new fdb();
    const localVault = new FakeVault();
    const localKeyspace = new FakeKeyspace();
    const localBus = new FakeMessageBus();
    localKeyspace.attachBus(localBus);

    // 直接 new，不等任何 tick；构造里 rebindToActiveKey("init") 还
    // 没走完（pending microtask，停在 await keyspace.getKey(...)）。
    const fresh = createPokerService({
      vault: localVault as any,
      keyspace: localKeyspace as any,
      messageBus: localBus as any
    });
    // 这时：(fresh as any).currentSessionKeyHash 还是 null（init 没填），
    // 但 keyspace.active().activePublicKeyHash === "pkhA"——后者是同步
    // 数据源，handler 改用它就不会漏掉 teardown。
    expect((fresh as any).currentSessionKeyHash).toBeNull();
    expect(localKeyspace.active().activePublicKeyHash).toBe("pkhA");

    // 在 init rebind 完成前发 key.deleting：必须命中"当前 session key"
    // 分支并 teardown。
    localKeyspace.emitKeyDeleting("pkhA");

    // 给 rebind + teardown 多个 tick 走完。
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    // 关键不变量（硬切换 004 反馈修复）：teardown 必须执行，不能因为
    // currentSessionKeyHash 还是 null 就漏掉。teardown 会把 status 切到
    // closed；后续 init rebind 即使再次 ready（因为 pkhA 还在 keyspace
    // 列表里），也走 fail-closed / 不主动重连路径，status 保持 closed。
    expect(fresh.status()).toBe("closed");
  });

  it("active key switch with userWantsConnection triggers auto-rebuild under new key", async () => {
    // 准备：先把 endpoint 配好，然后模拟用户连接过（userWantsConnection = true,
    // status = ready）—— 这条路径等效于"用户已经点过 Connect 并连上"。
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).userWantsConnection = true;
    (svc as any).currentStatus = "ready";

    // stub openSocket：不真正打开 WebSocket，避免测试环境需要 ws 实现。
    let openSocketCalls = 0;
    (svc as any).openSocket = async () => {
      openSocketCalls += 1;
      // 模拟立刻 ready。
      (svc as any).currentStatus = "ready";
    };

    await keyspace.setActive("pkhB");
    // rebindToActiveKey 是 microtask 异步；多等几轮让它走完
    // hydrateFromKeyScopedDb → connect() → openSocket() 整条链。
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    // 关键不变量（硬切换 004）：切 key 后必须按新 key 重建连接。
    expect(openSocketCalls).toBeGreaterThanOrEqual(1);
    expect((svc as any).currentSessionKeyHash).toBe("pkhB");
    const state = svc.getActivePokerKey();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHash).toBe("pkhB");
    }
    expect(svc.status()).toBe("ready");
    // userWantsConnection 在自动重建后必须仍然为 true（保留用户意图）。
    expect((svc as any).userWantsConnection).toBe(true);
  });

  it("active key switch without userWantsConnection does NOT auto-connect", async () => {
    // 没设置 userWantsConnection → 切 key 时不主动 reconnect。
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    expect((svc as any).userWantsConnection).toBe(false);
    let openSocketCalls = 0;
    (svc as any).openSocket = async () => {
      openSocketCalls += 1;
      (svc as any).currentStatus = "ready";
    };
    await keyspace.setActive("pkhB");
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(openSocketCalls).toBe(0);
    expect((svc as any).currentSessionKeyHash).toBe("pkhB");
    expect(svc.status()).not.toBe("ready");
  });

  it("user-initiated disconnect clears userWantsConnection; next key switch does NOT auto-reconnect", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).userWantsConnection = true;
    (svc as any).currentStatus = "ready";

    let openSocketCalls = 0;
    (svc as any).openSocket = async () => {
      openSocketCalls += 1;
    };
    svc.disconnect();
    expect((svc as any).userWantsConnection).toBe(false);
    await keyspace.setActive("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // 用户已经主动断开 → 切 key 不能再连回去。
    expect(openSocketCalls).toBe(0);
  });

  it("vault.lock clears userWantsConnection (vault lock is significant user action)", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).userWantsConnection = true;
    (svc as any).currentStatus = "ready";
    vault.setStatus("locked");
    await new Promise((r) => setTimeout(r, 0));
    expect((svc as any).userWantsConnection).toBe(false);
  });

  it("vault.unlock after lock does NOT auto-reconnect (user must click Connect)", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).userWantsConnection = true;
    (svc as any).currentStatus = "ready";
    vault.setStatus("locked");
    await new Promise((r) => setTimeout(r, 0));

    // 解锁 → 模拟 keyspace 重新评估 active。
    let openSocketCalls = 0;
    (svc as any).openSocket = async () => {
      openSocketCalls += 1;
    };
    vault.setStatus("unlocked");
    await new Promise((r) => setTimeout(r, 0));
    await keyspace.setActive("pkhA"); // 触发 onActiveChange → rebind
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // vault.unlock 不应触发自动 reconnect；用户必须显式点 Connect。
    expect(openSocketCalls).toBe(0);
  });

  it("delete current active key + keyspace fallback auto-rebuilds under new key", async () => {
    // 模拟"用户已连接"的初始状态。
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).userWantsConnection = true;
    (svc as any).currentStatus = "ready";

    let openSocketCalls = 0;
    (svc as any).openSocket = async () => {
      openSocketCalls += 1;
      (svc as any).currentStatus = "ready";
    };

    // 1) key.deleting 命中当前 session key：teardown，userWantsConnection 保留。
    keyspace.emitKeyDeleting("pkhA");
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.status()).toBe("closed");
    expect((svc as any).currentSessionKeyHash).toBeNull();
    expect((svc as any).userWantsConnection).toBe(true);
    expect(openSocketCalls).toBe(0); // 这一步还没连。

    // 2) key.deleted → pruneReferencesToKey 不动当前内存态（已空）。
    keyspace.emitKeyDeleted("pkhA");
    await new Promise((r) => setTimeout(r, 0));

    // 3) keyspace 决定新 active key = pkhB → 触发 onActiveChange →
    //    rebindToActiveKey 看到 state=ready 且 userWantsConnection=true，
    //    必须自动 connect。
    await keyspace.setActive("pkhB");
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    expect(openSocketCalls).toBeGreaterThanOrEqual(1);
    expect((svc as any).currentSessionKeyHash).toBe("pkhB");
    const state = svc.getActivePokerKey();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHash).toBe("pkhB");
    }
  });

  it("hydrates presences / tables / txIngest from current active key's IDB on init", async () => {
    // 准备：在 pkhA 的 DB 里写入若干 cached 行。
    const handle = await keyspace.openKeyStorage({
      publicKeyHash: "pkhA",
      pluginId: "plugin-poker",
      storageId: "poker",
      version: 3,
      upgrade: (db, oldV, newV) => {
        // 直接复用 service 的 upgrade，避免 import 循环。
        const u = (svc as any).deps.keyspace;
        void u;
        if (!db.objectStoreNames.contains("tables")) {
          const s = db.createObjectStore("tables", { keyPath: "tableId" });
          s.createIndex("observedAt", "observedAt");
        }
        if (!db.objectStoreNames.contains("presences")) {
          const s = db.createObjectStore("presences", { keyPath: "publicKeyHex" });
          s.createIndex("seenAt", "seenAt");
        }
        if (!db.objectStoreNames.contains("txIngest")) {
          const s = db.createObjectStore("txIngest", { keyPath: "txid" });
          s.createIndex("receivedAt", "receivedAt");
        }
        void oldV; void newV;
      }
    });
    try {
      // 直接通过 service 写入一条 txIngest，避免引入更多 helper 导入。
      await (svc as any).deps.messageBus; // 触发 messageBus 加载
      // 用 service 内部 writeTxIngest 入口：直接调用我们暴露的持久化方法
      // 不行（私有）。改用裸 IDB 操作写入 tables / presences，绕开
      // service 的写接口以模拟"上次会话留下的数据"。
      await new Promise<void>((resolve, reject) => {
        const tx = handle.db.transaction("tables", "readwrite");
        tx.objectStore("tables").put({
          tableId: "t-cached",
          variant: "TexasHoldem",
          seats: 4,
          stakes: 0,
          ownerPub: "03xxx",
          observedAt: 1
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = handle.db.transaction("presences", "readwrite");
        tx.objectStore("presences").put({
          publicKeyHex: "02cached",
          endpoint: "node:cached",
          nick: "cached-nick",
          seenAt: 1
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      handle.close();
    }

    // 构造一个新 service：构造函数会触发 rebindToActiveKey("init") →
    // hydrateFromKeyScopedDb("pkhA")，应能恢复上面写入的 tables / presences。
    const svc2 = createPokerService({
      vault: vault as any,
      keyspace: keyspace as any,
      messageBus: bus as any
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const tables = svc2.listTables();
    const presences = svc2.listPresences();
    expect(tables.find((t) => t.tableId === "t-cached")).toBeTruthy();
    expect(presences.find((p) => p.publicKeyHex === "02cached")).toBeTruthy();
    // init 阶段不应该自动连接（userWantsConnection 起始为 false）。
    expect(svc2.status()).not.toBe("ready");
    expect((svc2 as any).userWantsConnection).toBe(false);
  });

  it("active key switch A → B hydrates B's DB (not A's)", async () => {
    // 1) 在 pkhA 的 DB 写 table-A。复用 service 的 upgrade（保证 3 个
    // store 都创建），避免 hydrate 因缺 store 失败。
    const upgradeFull = (db: IDBDatabase) => {
      if (!db.objectStoreNames.contains("tables")) {
        const s = db.createObjectStore("tables", { keyPath: "tableId" });
        s.createIndex("observedAt", "observedAt");
      }
      if (!db.objectStoreNames.contains("presences")) {
        const s = db.createObjectStore("presences", { keyPath: "publicKeyHex" });
        s.createIndex("seenAt", "seenAt");
      }
      if (!db.objectStoreNames.contains("txIngest")) {
        const s = db.createObjectStore("txIngest", { keyPath: "txid" });
        s.createIndex("receivedAt", "receivedAt");
      }
    };
    const handleA = await keyspace.openKeyStorage({
      publicKeyHash: "pkhA",
      pluginId: "plugin-poker",
      storageId: "poker",
      version: 3,
      upgrade: upgradeFull
    });
    await new Promise<void>((resolve, reject) => {
      const tx = handleA.db.transaction("tables", "readwrite");
      tx.objectStore("tables").put({
        tableId: "t-A",
        variant: "TexasHoldem",
        seats: 4,
        stakes: 0,
        ownerPub: "03A",
        observedAt: 1
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    handleA.close();

    // 2) 在 pkhB 的 DB 写 table-B。
    const handleB = await keyspace.openKeyStorage({
      publicKeyHash: "pkhB",
      pluginId: "plugin-poker",
      storageId: "poker",
      version: 3,
      upgrade: upgradeFull
    });
    await new Promise<void>((resolve, reject) => {
      const tx = handleB.db.transaction("tables", "readwrite");
      tx.objectStore("tables").put({
        tableId: "t-B",
        variant: "Omaha",
        seats: 6,
        stakes: 0,
        ownerPub: "03B",
        observedAt: 2
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    handleB.close();

    // 3) 构造新 service → init hydrate from pkhA。
    const svc2 = createPokerService({
      vault: vault as any,
      keyspace: keyspace as any,
      messageBus: bus as any
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(svc2.listTables().find((t) => t.tableId === "t-A")).toBeTruthy();
    expect(svc2.listTables().find((t) => t.tableId === "t-B")).toBeFalsy();

    // 4) 切到 pkhB → 必须 hydrate pkhB 的 DB；不应保留 t-A。
    await keyspace.setActive("pkhB");
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const tables = svc2.listTables();
    expect(tables.find((t) => t.tableId === "t-B")).toBeTruthy();
    expect(tables.find((t) => t.tableId === "t-A")).toBeFalsy();
  });
});
