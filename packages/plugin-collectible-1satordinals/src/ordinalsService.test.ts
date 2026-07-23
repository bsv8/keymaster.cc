// packages/plugin-collectible-1satordinals/src/ordinalsService.test.ts
// ordinalsService 回归测试：覆盖最易错的 outpoint 格式映射与 404 语义——
//   1. WOC 查询键必须是 "txid_vout"（下划线），用户可见 outpoint 是
//      "txid:vout"（冒号）；两者刻意分开，绝不能混用；
//   2. getOutpointInscription 返回 null（404 / not-found）的 UTXO 被静默跳过；
//   3. listActiveKeyCollectibles 同时扫描 main / test；
//   4. getOutpoint 解析 "txid:vout" 形参，非法格式返回 null，并会回落到 testnet。

import { describe, expect, it } from "vitest";
import type {
  KeyspaceService,
  Woc1SatOrdinalsContent,
  Woc1SatOrdinalsInscription,
  Woc1SatOrdinalsService
} from "@keymaster/contracts";
import {
  createOrdinalsService,
  type P2pkhServiceFor1Sat,
  type P2pkhUtxoFor1Sat
} from "./ordinalsService.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return { active: () => ({ activePublicKeyHex }) } as unknown as KeyspaceService;
}

function fakeP2pkh(utxos: P2pkhUtxoFor1Sat[], includeTestnet = false): P2pkhServiceFor1Sat {
  return {
    listUtxos: () => Promise.resolve(utxos),
    getGlobalSettings: () => ({ includeTestnet })
  };
}

function inscription(outpoint: string, overrides?: Partial<Woc1SatOrdinalsInscription>): Woc1SatOrdinalsInscription {
  return { inscriptionId: `insc-${outpoint}`, outpoint, observation: overrides?.observation, canonicalTxid: overrides?.canonicalTxid, ...overrides };
}

/**
 * 记录每次被查询的 outpoint 字符串；hits 集合里的 outpoint 返回 inscription，
 * 其余返回 null（模拟 404 / not-found）。
 */
function fakeWoc(hits: Set<string>, queried: Array<{ network: string; outpoint: string }>): Woc1SatOrdinalsService {
  return {
    getOutpointInscription: (network, outpoint) => {
      queried.push({ network, outpoint });
      return Promise.resolve(hits.has(`${network}:${outpoint}`) ? inscription(outpoint) : null);
    },
    getOutpointContent: async (): Promise<Woc1SatOrdinalsContent | null> => null,
    getTransactionOutputScript: async (): Promise<Uint8Array> => new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])
  };
}

describe("createOrdinalsService", () => {
  it("缺关键依赖时立即抛错", () => {
    expect(() => createOrdinalsService({} as never)).toThrow(/required/);
  });

  it("无 active key 时返回空列表", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(undefined),
      p2pkh: fakeP2pkh([{ txid: "aa", vout: 0, value: 1000, address: "addr" }]),
      wocOneSat: fakeWoc(new Set(), queried)
    });
    expect(await svc.listActiveKeyCollectibles()).toEqual([]);
    expect(queried).toEqual([]);
  });

  it("WOC 查询键用 txid_vout（下划线），展示 outpoint 用 txid:vout（冒号）", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ txid: "deadbeef", vout: 2, value: 1000, address: "addr-A" }]),
      wocOneSat: fakeWoc(new Set(["main:deadbeef_2"]), queried)
    });
    const out = await svc.listActiveKeyCollectibles();
    // 查询走下划线；默认仅扫 mainnet。
    expect(queried).toEqual([{ network: "main", outpoint: "deadbeef_2" }]);
    // 展示走冒号。
    expect(out.map((h) => h.outpoint)).toEqual(["deadbeef:2"]);
    expect(out[0]!.address).toBe("addr-A");
  });

  it("includeTestnet=true 时同时扫描 main / test", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ txid: "deadbeef", vout: 2, value: 1000, address: "addr-A" }], true),
      wocOneSat: fakeWoc(new Set(["main:deadbeef_2"]), queried)
    });
    const out = await svc.listActiveKeyCollectibles();
    expect(queried).toEqual([
      { network: "main", outpoint: "deadbeef_2" },
      { network: "test", outpoint: "deadbeef_2" }
    ]);
    expect(out.map((h) => h.outpoint)).toEqual(["deadbeef:2"]);
  });

  it("返回的 hit 会携带 observation / canonicalTxid", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ txid: "c0ffee", vout: 1, value: 1000, address: "addr-A" }]),
      wocOneSat: {
        getOutpointInscription: (network, outpoint) => {
          queried.push({ network, outpoint });
          return Promise.resolve(network === "main" ? inscription(outpoint, { observation: "unconfirmed", canonicalTxid: "c0ffee" }) : null);
        },
        getOutpointContent: async (): Promise<Woc1SatOrdinalsContent | null> => null,
        getTransactionOutputScript: async (): Promise<Uint8Array> => new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])
      }
    });
    const hit = await svc.getOutpoint("c0ffee:1");
    expect(hit?.observation).toBe("unconfirmed");
    expect(hit?.canonicalTxid).toBe("c0ffee");
  });

  it("getOutpointInscription 返回 null（404）的 UTXO 被跳过", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([
        { txid: "hit", vout: 0, value: 1000, address: "addr-A" },
        { txid: "miss", vout: 1, value: 1000, address: "addr-A" }
      ], true),
      wocOneSat: fakeWoc(new Set(["main:hit_0"]), queried)
    });
    const out = await svc.listActiveKeyCollectibles();
    // 两个都查询了，但只有命中的进入结果。
    expect(queried).toEqual([
      { network: "main", outpoint: "hit_0" },
      { network: "main", outpoint: "miss_1" },
      { network: "test", outpoint: "hit_0" },
      { network: "test", outpoint: "miss_1" }
    ]);
    expect(out.map((h) => h.outpoint)).toEqual(["hit:0"]);
  });

  it("getOutpoint 解析 txid:vout，命中返回 hit", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([]),
      wocOneSat: fakeWoc(new Set(["main:cafe_3"]), queried)
    });
    const hit = await svc.getOutpoint("cafe:3");
    expect(queried).toEqual([{ network: "main", outpoint: "cafe_3" }]);
    expect(hit?.outpoint).toBe("cafe:3");
  });

  it("getOutpoint 会回落到 testnet 查询", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([], true),
      wocOneSat: fakeWoc(new Set(["test:testhit_4"]), queried)
    });
    const hit = await svc.getOutpoint("testhit:4");
    expect(queried).toEqual([
      { network: "main", outpoint: "testhit_4" },
      { network: "test", outpoint: "testhit_4" }
    ]);
    expect(hit?.network).toBe("test");
  });

  it("getOutpoint 非法格式返回 null，不查询 WOC", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([]),
      wocOneSat: fakeWoc(new Set(), queried)
    });
    expect(await svc.getOutpoint("no-colon")).toBeNull();
    expect(await svc.getOutpoint("txid:notanumber")).toBeNull();
    expect(queried).toEqual([]);
  });

  it("sync 会复扫并通知订阅者", async () => {
    const queried: Array<{ network: string; outpoint: string }> = [];
    const listeners: Array<() => void> = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ txid: "deadbeef", vout: 2, value: 1000, address: "addr-A" }]),
      wocOneSat: fakeWoc(new Set(["main:deadbeef_2"]), queried)
    });
    const off = svc.onChange(() => listeners.push(() => {}));
    await svc.sync();
    off();
    expect(queried).toEqual([{ network: "main", outpoint: "deadbeef_2" }]);
    expect(listeners.length).toBe(1);
  });
});
