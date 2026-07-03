// packages/plugin-poker/src/pokerSessionKey.test.ts
// 验证硬切换 004 + 硬切换 005 收尾后 session key 解析：
//   - vault 未解锁 → vaultLocked；
//   - activePublicKeyHex 缺省 → noActiveKey；
//   - 有 publicKeyHex + keyspace 内可找到 → ready；
//   - keyspace 找不到该 publicKeyHex → missing。
//
// 硬切换 002 收尾：identityStatus 字段已删除，per-key uninitialized / failed
// 不再是合法稳态；本文件不再覆盖 notReady 分支（实现也已不返回该 kind）。

import { beforeEach, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { resolvePokerSessionKey } from "./pokerSessionKey.js";

// 硬切换 002 收尾：fixture 用真实压缩公钥 hex，不再用 `"pkhA"` / `"kA"`。
const PRIV_A = "0000000000000000000000000000000000000000000000000000000000000001";
function derivePubHex(privHex: string): string {
  const clean = privHex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  const pub = secp256k1.getPublicKey(bytes, true);
  return Array.from(pub, (b) => b.toString(16).padStart(2, "0")).join("");
}
const PUB_A = derivePubHex(PRIV_A);

const KEY_A = {
  publicKeyHex: PUB_A,
  label: "A",
  capabilities: ["poker"],
  createdAt: "" as const
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
  private state: { activePublicKeyHex?: string } = { activePublicKeyHex: PUB_A };
  private meta = new Map<string, any>([[PUB_A, KEY_A]]);
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

  it("returns ready when activePublicKeyHex present and keyspace has the key", async () => {
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.key.publicKeyHex).toBe(PUB_A);
    }
  });

  it("returns missing when keyspace has no entry for active publicKeyHex", async () => {
    keyspace.setActive("03" + "ff".repeat(32));
    const state = await resolvePokerSessionKey(vault as any, keyspace as any);
    expect(state.kind).toBe("missing");
  });
});
