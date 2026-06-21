// packages/plugin-poker/src/pokerSessionKey.test.ts
// 验证硬切换 004 + 硬切换 005 收尾后 session key 解析：
//   - vault 未解锁 → vaultLocked；
//   - activePublicKeyHex 缺省 → noActiveKey；
//   - 有 hash + identityStatus ready → ready；
//   - hash 在 keyspace 找不到 → missing；
//   - identityStatus = uninitialized / failed → notReady。

import { beforeEach, describe, expect, it } from "vitest";
import { resolvePokerSessionKey } from "./pokerSessionKey.js";

const KEY_A = {
  keyId: "kA",
  publicKeyHex: "02" + "ab".repeat(32),
  label: "A",
  capabilities: ["poker"],
  createdAt: "",
  identityStatus: "ready" as const
};

class FakeVault {
  private s: "unlocked" | "locked" = "unlocked";
  status() {
    return this.s;
  }
  setStatus(s: "unlocked" | "locked") {
    this.s = s;
  }
}

class FakeKeyspace {
  private state: { activePublicKeyHex?: string } = { activePublicKeyHex: "pkhA" };
  private meta = new Map<string, any>([["pkhA", KEY_A]]);
  active() {
    return { ...this.state };
  }
  setActive(pkh: string) {
    this.state = { activePublicKeyHex: pkh };
  }
  clearActive() {
    this.state = {};
  }
  async getKey(pkh: string) {
    return this.meta.get(pkh);
  }
  setKeyMeta(pkh: string, meta: any) {
    if (meta === null) {
      this.meta.delete(pkh);
    } else {
      this.meta.set(pkh, meta);
    }
  }
}

let vault: FakeVault;
let keyspace: FakeKeyspace;

beforeEach(() => {
  vault = new FakeVault();
  keyspace = new FakeKeyspace();
});

describe("resolvePokerSessionKey", () => {
  it("returns vaultLocked when vault is locked", async () => {
    vault.setStatus("locked");
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("vaultLocked");
  });

  it("returns noActiveKey when activePublicKeyHex missing", async () => {
    // 硬切换 005 收尾：原 "allMode" 已被 `noActiveKey` 替代。
    keyspace.clearActive();
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("noActiveKey");
  });

  it("returns ready when activePublicKeyHex present and identityStatus ready", async () => {
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHex).toBe("02" + "ab".repeat(32));
    }
  });

  it("returns missing when keyspace has no entry for active hash", async () => {
    keyspace.setActive("pkhGhost");
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("missing");
  });

  it("returns notReady when identityStatus = uninitialized", async () => {
    keyspace.setKeyMeta("pkhA", { ...KEY_A, identityStatus: "uninitialized" });
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("notReady");
    if (state.kind === "notReady") {
      expect(state.reason).toBe("uninitialized");
    }
  });

  it("returns notReady with reason from identityError when failed", async () => {
    keyspace.setKeyMeta("pkhA", { ...KEY_A, identityStatus: "failed", identityError: "decrypt failed" });
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("notReady");
    if (state.kind === "notReady") {
      expect(state.reason).toBe("decrypt failed");
    }
  });

  it("returns ready when identityStatus missing (treated as ready)", async () => {
    keyspace.setKeyMeta("pkhA", { ...KEY_A });
    delete (keyspace as any).meta.get("pkhA").identityStatus;
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("ready");
  });
});
