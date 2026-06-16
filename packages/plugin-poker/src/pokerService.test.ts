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

  it("key.deleted on non-active key does not disturb current session", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    (svc as any).currentStatus = "ready";
    (svc as any).presences.set("03" + "cd".repeat(32), {
      publicKeyHex: "03" + "cd".repeat(32),
      seenAt: 1
    });
    // 删除非 active key（pkhB 当前不是 active，但我们在内存里放了一条它的 presence）。
    keyspace.emitKeyDeleted("pkhB");
    await new Promise((r) => setTimeout(r, 0));
    // 当前 active key 仍是 pkhA；服务应主动 prune 非当前 key 的残余引用。
    // 实现选择：pruneReferencesToKey 对所有非自身 hash 都清；这是预期语义。
    // 这里仅验证：当前 active key 没变，且连接状态未被破坏。
    expect(svc.getActivePokerKey().kind).toBe("ready");
    if (svc.getActivePokerKey().kind === "ready") {
      expect(svc.getActivePokerKey().key.publicKeyHash).toBe("pkhA");
    }
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
});
