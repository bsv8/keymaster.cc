// packages/plugin-poker/src/pokerIdentityBinding.test.ts
// 验证稳定 poker identity 绑定的核心不变量：
//   - bind 后写盘并出现在 get() 中；
//   - vault 锁定时 get() 返回 null（fail-closed）；
//   - listCandidates 不包含 identityStatus !== "ready" 的 key；
//   - bind 时清掉其它 namespace 的残留 binding（不变量 "0 or 1"）。

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createPokerIdentityBinding } from "./pokerIdentityBinding.js";

class FakeVault {
  private statusV: "unlocked" | "locked" = "unlocked";
  private handlers = new Set<(s: any) => void>();
  status() { return this.statusV; }
  setStatus(s: "unlocked" | "locked") {
    this.statusV = s;
    for (const h of this.handlers) h(s);
  }
  onStatusChange(h: (s: any) => void) {
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }
}

class FakeKeyspace {
  private keys = [
    { keyId: "k1", publicKeyHash: "pkhA", publicKeyHex: "02" + "ab".repeat(32), label: "A", capabilities: [], createdAt: "", identityStatus: "ready" as const },
    { keyId: "k2", publicKeyHash: "pkhB", publicKeyHex: "03" + "cd".repeat(32), label: "B", capabilities: [], createdAt: "", identityStatus: "ready" as const },
    { keyId: "k3", publicKeyHash: "pkhC", publicKeyHex: "02" + "ef".repeat(32), label: "C", capabilities: [], createdAt: "", identityStatus: "failed" as const }
  ];
  active() { return { mode: "single" as const, activePublicKeyHash: "pkhA" as string | undefined }; }
  async listKeys() { return [...this.keys]; }
  async getKey(pkh: string) { return this.keys.find((k) => k.publicKeyHash === pkh); }
  async openKeyStorage(input: { publicKeyHash: string; pluginId: string; storageId: string; version: number; upgrade: (db: IDBDatabase, oldV: number, newV: number | null) => void }) {
    const name = `keymaster.key.${input.publicKeyHash}.plugin.${input.pluginId}.${input.storageId}`;
    return await new Promise<{ db: IDBDatabase; name: string; close(): void }>((resolve, reject) => {
      const req = indexedDB.open(name, input.version);
      req.onupgradeneeded = (e) => input.upgrade(req.result, e.oldVersion, e.newVersion);
      req.onsuccess = () => {
        const db = req.result;
        resolve({ db, name, close: () => db.close() });
      };
      req.onerror = () => reject(req.error);
    });
  }
}

let vault: FakeVault;
let keyspace: FakeKeyspace;

beforeEach(() => {
  // 每个 test 重置 indexedDB；fake-indexeddb 暴露 IDBFactory 重置方法。
  // 使用 dynamic require 避免 typescript 抱怨。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fdb = require("fake-indexeddb/lib/FDBFactory");
  (globalThis as any).indexedDB = new fdb();
  vault = new FakeVault();
  keyspace = new FakeKeyspace();
});

describe("pokerIdentityBinding", () => {
  it("get() returns null before bind", () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    expect(mgr.get()).toBeNull();
  });

  it("listCandidates filters out failed identityStatus", async () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    const list = await mgr.listCandidates();
    expect(list.map((k) => k.publicKeyHash)).toEqual(["pkhA", "pkhB"]);
  });

  it("bind persists binding and survives reload", async () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    const bound = await mgr.bind({ publicKeyHash: "pkhA" });
    expect(bound.publicKeyHash).toBe("pkhA");
    expect(mgr.get()?.publicKeyHash).toBe("pkhA");

    // 新建一个新实例 → loadFromVault 应能恢复绑定。
    const mgr2 = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    await mgr2.loadFromVault();
    expect(mgr2.get()?.publicKeyHash).toBe("pkhA");
  });

  it("bind to a different key clears the prior binding (invariant: 0 or 1)", async () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    await mgr.bind({ publicKeyHash: "pkhA" });
    await mgr.bind({ publicKeyHash: "pkhB" });
    expect(mgr.get()?.publicKeyHash).toBe("pkhB");

    // 新实例 hydrate 也只能找到一份。
    const mgr2 = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    await mgr2.loadFromVault();
    expect(mgr2.get()?.publicKeyHash).toBe("pkhB");
  });

  it("vault lock returns null (fail-closed)", async () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    await mgr.bind({ publicKeyHash: "pkhA" });
    expect(mgr.get()).not.toBeNull();
    vault.setStatus("locked");
    expect(mgr.get()).toBeNull();
  });

  it("active key change (pkhA → pkhB) does NOT shift binding", async () => {
    const mgr = createPokerIdentityBinding({ vault: vault as any, keyspace: keyspace as any });
    await mgr.bind({ publicKeyHash: "pkhA" });
    // simulate active key drift; binding must stay on pkhA.
    expect(mgr.get()?.publicKeyHash).toBe("pkhA");
    // 即使 keyspace.active() 现在指向 pkhB，绑定仍是 pkhA。
    (keyspace as any).active = () => ({ mode: "single", activePublicKeyHash: "pkhB" });
    expect(mgr.get()?.publicKeyHash).toBe("pkhA");
  });
});
