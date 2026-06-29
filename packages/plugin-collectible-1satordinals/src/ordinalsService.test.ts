// packages/plugin-collectible-1satordinals/src/ordinalsService.test.ts
// ordinalsService 回归测试：覆盖最易错的 outpoint 格式映射与 404 语义——
//   1. WOC 查询键必须是 "txid_vout"（下划线），用户可见 outpoint 是
//      "txid:vout"（冒号）；两者刻意分开，绝不能混用；
//   2. getOutpointInscription 返回 null（404 / not-found）的 UTXO 被静默跳过；
//   3. getOutpoint 解析 "txid:vout" 形参，非法格式返回 null。

import { describe, expect, it } from "vitest";
import type {
  KeyspaceService,
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

function fakeP2pkh(utxos: P2pkhUtxoFor1Sat[]): P2pkhServiceFor1Sat {
  return { listUtxos: () => Promise.resolve(utxos) };
}

function inscription(outpoint: string): Woc1SatOrdinalsInscription {
  return { inscriptionId: `insc-${outpoint}`, outpoint };
}

/**
 * 记录每次被查询的 outpoint 字符串；hits 集合里的 outpoint 返回 inscription，
 * 其余返回 null（模拟 404 / not-found）。
 */
function fakeWoc(hits: Set<string>, queried: string[]): Woc1SatOrdinalsService {
  return {
    getOutpointInscription: (_network, outpoint) => {
      queried.push(outpoint);
      return Promise.resolve(hits.has(outpoint) ? inscription(outpoint) : null);
    }
  };
}

describe("createOrdinalsService", () => {
  it("缺关键依赖时立即抛错", () => {
    expect(() => createOrdinalsService({} as never)).toThrow(/required/);
  });

  it("无 active key 时返回空列表", async () => {
    const queried: string[] = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(undefined),
      p2pkh: fakeP2pkh([{ txid: "aa", vout: 0, address: "addr" }]),
      wocOneSat: fakeWoc(new Set(), queried)
    });
    expect(await svc.listActiveKeyCollectibles()).toEqual([]);
    expect(queried).toEqual([]);
  });

  it("WOC 查询键用 txid_vout（下划线），展示 outpoint 用 txid:vout（冒号）", async () => {
    const queried: string[] = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ txid: "deadbeef", vout: 2, address: "addr-A" }]),
      wocOneSat: fakeWoc(new Set(["deadbeef_2"]), queried)
    });
    const out = await svc.listActiveKeyCollectibles();
    // 查询走下划线。
    expect(queried).toEqual(["deadbeef_2"]);
    // 展示走冒号。
    expect(out.map((h) => h.outpoint)).toEqual(["deadbeef:2"]);
    expect(out[0]!.address).toBe("addr-A");
  });

  it("getOutpointInscription 返回 null（404）的 UTXO 被跳过", async () => {
    const queried: string[] = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([
        { txid: "hit", vout: 0, address: "addr-A" },
        { txid: "miss", vout: 1, address: "addr-A" }
      ]),
      wocOneSat: fakeWoc(new Set(["hit_0"]), queried)
    });
    const out = await svc.listActiveKeyCollectibles();
    // 两个都查询了，但只有命中的进入结果。
    expect(queried).toEqual(["hit_0", "miss_1"]);
    expect(out.map((h) => h.outpoint)).toEqual(["hit:0"]);
  });

  it("getOutpoint 解析 txid:vout，命中返回 hit", async () => {
    const queried: string[] = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([]),
      wocOneSat: fakeWoc(new Set(["cafe_3"]), queried)
    });
    const hit = await svc.getOutpoint("cafe:3");
    expect(queried).toEqual(["cafe_3"]);
    expect(hit?.outpoint).toBe("cafe:3");
  });

  it("getOutpoint 非法格式返回 null，不查询 WOC", async () => {
    const queried: string[] = [];
    const svc = createOrdinalsService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([]),
      wocOneSat: fakeWoc(new Set(), queried)
    });
    expect(await svc.getOutpoint("no-colon")).toBeNull();
    expect(await svc.getOutpoint("txid:notanumber")).toBeNull();
    expect(queried).toEqual([]);
  });
});
