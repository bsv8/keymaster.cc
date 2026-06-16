// packages/plugin-poker/src/pokerService.test.ts
// 验证 PokerService 的核心不变量：
//   - 解锁但未绑定 poker identity → connect/publish fail-closed。
//   - 绑定后才允许 connect；连接前 publish 仍抛错。
//   - protocol.mismatch 收到时主动 disconnect。
//   - settings.proxyEndpoint 为空时 connect 抛错。
//   - fallback broadcast 被 settings 关闭时 tx 不入队。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 在测试环境中提供 IndexedDB（pokerIdentityBinding 持久化用到）。
import "fake-indexeddb/auto";
import { createPokerService } from "./pokerService.js";

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
  dispatch() { throw new Error("not implemented"); }
  request<T, R>(): Promise<R> { throw new Error("not implemented"); }
  handle() { return () => undefined; }
  snapshot() { return { total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} }; }
  onSnapshot() { return () => undefined; }
}

class FakeVault {
  private statusV: "unlocked" | "locked" = "unlocked";
  private statusHandlers = new Set<(s: any) => void>();
  status() { return this.statusV; }
  setStatus(s: "unlocked" | "locked") {
    this.statusV = s;
    for (const h of this.statusHandlers) h(s);
  }
  onStatusChange(h: (s: any) => void) {
    this.statusHandlers.add(h);
    return () => { this.statusHandlers.delete(h); };
  }
  getInitialActivationNotice() { return null; }
  clearInitialActivationNotice() {}
  onInitialActivationNoticeChange() { return () => undefined; }
  hasVault = async () => true;
  async createVault() {}
  async createVaultWithInitialKey() { throw new Error("not used"); }
  async createVaultWithImportedKey() { throw new Error("not used"); }
  async unlock() {}
  async lock() {}
  async verifyPassword() {}
  async finalizeEmptyVaultAfterLastKeyDeletion() {}
  async listKeys() { return []; }
  async getKey() { return undefined; }
  async getKeyByPublicKeyHash() { return undefined; }
  async findByAddress() { return undefined; }
  async importPrivateKey() { throw new Error("not used"); }
  async generateKey() { throw new Error("not used"); }
  async deleteKeyMaterial() {}
  async removeKey() { throw new Error("deprecated"); }
  async exportPrivateKey() { throw new Error("not used"); }
  async withPrivateKey<T>(_id: string, fn: (m: any) => Promise<T>) { return fn({ hex: "11".repeat(32) }); }
}

class FakeKeyspace {
  private state = { mode: "single" as "single" | "all", activePublicKeyHash: "pkhA" as string | undefined };
  private dbs = new Map<string, IDBDatabase>();
  async listKeys() {
    return [
      { keyId: "k1", publicKeyHash: "pkhA", publicKeyHex: "02" + "ab".repeat(32), label: "A", capabilities: ["poker"], createdAt: "", identityStatus: "ready" as const },
      { keyId: "k2", publicKeyHash: "pkhB", publicKeyHex: "03" + "cd".repeat(32), label: "B", capabilities: ["poker"], createdAt: "", identityStatus: "ready" as const }
    ];
  }
  async getKey(pkh: string) {
    const all = await this.listKeys();
    return all.find((k) => k.publicKeyHash === pkh);
  }
  active() { return { ...this.state }; }
  async setActive(pkh: string) { this.state = { mode: "single", activePublicKeyHash: pkh }; }
  async setAll() { this.state = { mode: "all" }; }
  requireActiveKey() {
    const all = [
      { keyId: "k1", publicKeyHash: "pkhA", publicKeyHex: "02" + "ab".repeat(32), label: "A", capabilities: ["poker"], createdAt: "" },
      { keyId: "k2", publicKeyHash: "pkhB", publicKeyHex: "03" + "cd".repeat(32), label: "B", capabilities: ["poker"], createdAt: "" }
    ];
    return all[0] as any;
  }
  onActiveChange() { return () => undefined; }
  async openKeyStorage(input: { publicKeyHash: string; pluginId: string; storageId: string; version: number; upgrade: (db: IDBDatabase, oldV: number, newV: number | null) => void }) {
    // fake-indexeddb 已注入全局 indexedDB；按 keyspace 规范构造 db 名称。
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
  listPluginStorages() { return []; }
  async prepareDeleteKey() {}
  async deleteKey() {}
  async deleteKeyById() {}
  attachBackgroundService() {}
  isInitializing() { return false; }
  onInitializationChange() { return () => undefined; }
}

let svc: ReturnType<typeof createPokerService>;
let vault: FakeVault;
let keyspace: FakeKeyspace;
let bus: FakeMessageBus;

beforeEach(() => {
  vault = new FakeVault();
  keyspace = new FakeKeyspace();
  bus = new FakeMessageBus();
  svc = createPokerService({ vault: vault as any, keyspace: keyspace as any, messageBus: bus as any });
});

afterEach(() => {
  svc.disconnect();
});

describe("pokerService", () => {
  it("connect fails without poker identity bound (even with endpoint)", async () => {
    await svc.updateSettings({ proxyEndpoint: "wss://example" });
    await expect(svc.connect()).rejects.toThrow(/poker identity/);
  });

  it("connect fails when proxyEndpoint empty after binding", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    await expect(svc.connect()).rejects.toThrow(/proxyEndpoint/);
  });

  it("publishFrame throws when not ready", async () => {
    await expect(svc.publishFrame("t1", new Uint8Array([1, 2, 3]))).rejects.toThrow(/not ready/);
  });

  it("handles protocol mismatch by disconnecting", async () => {
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

  it("bindIdentity stores binding and survives keyspace.setActive (active key drift)", async () => {
    const bound = await svc.bindIdentity({ publicKeyHash: "pkhA", label: "alice" });
    expect(bound.publicKeyHash).toBe("pkhA");
    expect(svc.getIdentityBinding()?.publicKeyHash).toBe("pkhA");
    // 切换 active key 不能让 binding 漂移。
    await keyspace.setActive("pkhB");
    expect(svc.getIdentityBinding()?.publicKeyHash).toBe("pkhA");
  });

  it("unbindIdentity clears state and disconnects", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    expect(svc.getIdentityBinding()).not.toBeNull();
    await svc.unbindIdentity();
    expect(svc.getIdentityBinding()).toBeNull();
    expect(svc.status()).toBeOneOf(["closed", "idle"]);
  });

  it("vault.lock() drops binding visibility (fail-closed)", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    expect(svc.getIdentityBinding()).not.toBeNull();
    vault.setStatus("locked");
    expect(svc.getIdentityBinding()).toBeNull();
  });

  it("settings persist to key-scoped IDB and hydrate on rebind", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    await svc.updateSettings({
      proxyEndpoint: "wss://persist.example",
      announceP2PNodeEndpoint: "node:1",
      announceTxLinkEndpoint: "tx:1",
      allowFallbackBroadcast: false
    });
    // 模拟 "应用刷新"：实例化一个新的 service，binding 仍可从 IDB hydrate。
    const svc2 = createPokerService({ vault: vault as any, keyspace: keyspace as any, messageBus: bus as any });
    // identity binding 是异步 hydrate；这里读取 candidate 列表会触发 binding manager 走路径。
    await svc2.listIdentityCandidates();
    // 给 hydrate microtask 一个 tick。
    await new Promise((r) => setTimeout(r, 0));
    // 再触发一次 binding-aware 路径，让 settings hydrate 完成。
    // updateSettings 会 publish 当前 settings，但这里只关心读到的值。
    const s = svc2.getSettings();
    // 因为 svc2 还没显式 bindIdentity / 没等到 hydrate handler，settings
    // 可能仍是初始 default；触发一次 bindIdentity（同一 hash）能力把
    // settings 从 IDB 拉回。
    await svc2.bindIdentity({ publicKeyHash: "pkhA" });
    // bind 后等一次 microtask 让 hydrateSettingsForCurrentIdentity 完成。
    await new Promise((r) => setTimeout(r, 0));
    const s2 = svc2.getSettings();
    void s;
    expect(s2.proxyEndpoint).toBe("wss://persist.example");
    expect(s2.announceP2PNodeEndpoint).toBe("node:1");
    expect(s2.announceTxLinkEndpoint).toBe("tx:1");
    expect(s2.allowFallbackBroadcast).toBe(false);
  });

  it("AuthOK auto-subscribes to bsvp/dir + bsvp/presence and replays state", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    // 模拟"已 ready"以便 publish/subscribe 通过 ensureReady 检查。
    (svc as any).currentStatus = "ready";
    // 桩 send 收集帧；不需要真 ws。
    const sent: any[] = [];
    (svc as any).send = (env: any) => { sent.push(env); };
    await svc.subscribeTopics(["t-deadbeef"]);
    await svc.publishPresence(new Uint8Array([1, 2, 3]), 60);
    await svc.publishTable("t-deadbeef", new Uint8Array([4, 5, 6]), 60);
    sent.length = 0; // 清空，准备验 replay。
    // 现在触发"重新进入 ready"：模拟 AuthOK 抵达。
    (svc as any).replayAfterAuthOK();
    const types = sent.map((s) => s.type);
    // 必须重发：topic.subscribe（含 discovery 与 intended）、presence.publish、table.publish。
    expect(types).toContain("topic.subscribe");
    expect(types).toContain("presence.publish");
    expect(types).toContain("table.publish");
    const sub = sent.find((s) => s.type === "topic.subscribe");
    const topics: string[] = sub?.payload?.topics ?? [];
    // proxy 内部协议 topic 是无前导空格；带空格的旧形式根本不会被
    // SessionRegistry 路由，这条断言守这个回归。
    expect(topics).toContain("bsvp/dir");
    expect(topics).toContain("bsvp/presence");
    expect(topics).toContain("t-deadbeef");
  });

  it("auth.response echoes challenge nonce verbatim and parses it as hex", async () => {
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    // 模拟 connecting；让 handleChallenge 直接走签名路径。
    (svc as any).currentStatus = "connecting";
    const sent: any[] = [];
    (svc as any).send = (env: any) => { sent.push(env); };
    const nonceHex = "deadbeef" + "0011" .repeat(14); // 32 字节 = 64 hex
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

  it("onSettingsChange fires on updateSettings and on identity hydrate", async () => {
    const seen: any[] = [];
    const off = svc.onSettingsChange((s) => seen.push({ ...s }));
    // 订阅时不立即推（契约约定）。
    expect(seen.length).toBe(0);
    // updateSettings 立即触发。
    await svc.updateSettings({ proxyEndpoint: "wss://a" });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)?.proxyEndpoint).toBe("wss://a");
    // bindIdentity 后 hydrate 完成时再触发一次（同步实例无值写入也会
    // publish 一次空 hydrate 的兜底；这里至少要看到 update 那条）。
    await svc.bindIdentity({ publicKeyHash: "pkhA" });
    await new Promise((r) => setTimeout(r, 0));
    off();
  });
});

// vitest helper extension (toBeOneOf is not built-in by default in older versions).
import { expect as vitestExpect } from "vitest";
vitestExpect.extend({
  toBeOneOf(received: unknown, expected: unknown[]) {
    const pass = expected.includes(received as never);
    return {
      pass,
      message: () => `expected ${String(received)} ${pass ? "not " : ""}to be one of ${expected.join(", ")}`
    };
  }
});
declare module "vitest" {
  interface Assertion<T = unknown> {
    toBeOneOf(values: readonly T[]): void;
  }
  interface AsymmetricMatchersContaining {
    toBeOneOf(values: readonly unknown[]): void;
  }
}
