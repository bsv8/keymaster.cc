// packages/plugin-token-bsv21/src/bsv21Service.test.ts
// bsv21Service 回归测试：覆盖 service 的核心组合逻辑——
//   1. 按 active key 的 publicKeyHex 过滤 P2PKH 资源；
//   2. 对每个地址先 listAddressTokens 再逐 origin getAddressTokenBalance；
//   3. includeTestnet 决定是否纳入 "bsvtest" 资源；
//   4. getToken 按 origin 命中 / 落空。
// 这些是"key -> address -> WOC token"流程最易回归的点。

import { describe, expect, it } from "vitest";
import type { KeyspaceService, WocBsv21Service } from "@keymaster/contracts";
import {
  createBsv21Service,
  type P2pkhKeyResourceForBsv21,
  type P2pkhServiceForBsv21
} from "./bsv21Service.js";

const ACTIVE_PK = "pk-active";

/** 只实现 service 实际调用的 keyspace.active()。 */
function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return { active: () => ({ activePublicKeyHex }) } as unknown as KeyspaceService;
}

function res(assetId: "bsv" | "bsvtest", publicKeyHex: string, address: string): P2pkhKeyResourceForBsv21 {
  return { publicKeyHex, address, network: assetId === "bsv" ? "main" : "test" };
}

/** 记录被查询的 assetId，便于断言 testnet 行为。 */
function fakeP2pkh(
  resources: Partial<Record<"bsv" | "bsvtest", P2pkhKeyResourceForBsv21[]>>,
  includeTestnet: boolean,
  calls?: string[]
): P2pkhServiceForBsv21 {
  return {
    listResources: (assetId) => {
      calls?.push(assetId);
      return Promise.resolve(resources[assetId] ?? []);
    },
    getGlobalSettings: () => ({ includeTestnet })
  };
}

/** 每个地址固定返回一个 token，余额随地址变化，便于断言聚合。 */
function fakeWoc(tokensByAddress: Record<string, string[]>): WocBsv21Service {
  return {
    listAddressTokens: (_network, address) =>
      Promise.resolve((tokensByAddress[address] ?? []).map((origin) => ({ origin, symbol: origin.toUpperCase() }))),
    getAddressTokenBalance: (_network, _address, origin) =>
      Promise.resolve({ confirmed: origin.length, unconfirmed: 0 })
  };
}

describe("createBsv21Service", () => {
  it("缺关键依赖时立即抛错", () => {
    expect(() => createBsv21Service({} as never)).toThrow(/required/);
  });

  it("无 active key 时返回空列表", async () => {
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(undefined),
      p2pkh: fakeP2pkh({}, false),
      wocBsv21: fakeWoc({})
    });
    expect(await svc.listActiveKeyTokens()).toEqual([]);
  });

  it("只取 active publicKeyHex 的地址，逐 origin 查余额", async () => {
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh(
        { bsv: [res("bsv", ACTIVE_PK, "addr-A"), res("bsv", "pk-other", "addr-B")] },
        false
      ),
      wocBsv21: fakeWoc({ "addr-A": ["tok1"], "addr-B": ["tokX"] })
    });
    const out = await svc.listActiveKeyTokens();
    // 只应包含 active key 的 addr-A，不含 addr-B 的 tokX。
    expect(out.map((t) => t.meta.origin)).toEqual(["tok1"]);
    expect(out[0]!.address).toBe("addr-A");
    expect(out[0]!.balance.confirmed).toBe("tok1".length);
  });

  it("includeTestnet=false 时不查询 bsvtest", async () => {
    const calls: string[] = [];
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh({ bsv: [res("bsv", ACTIVE_PK, "addr-A")] }, false, calls),
      wocBsv21: fakeWoc({ "addr-A": ["tok1"] })
    });
    await svc.listActiveKeyTokens();
    expect(calls).toEqual(["bsv"]);
  });

  it("includeTestnet=true 时纳入 bsvtest 资源", async () => {
    const calls: string[] = [];
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh(
        { bsv: [res("bsv", ACTIVE_PK, "addr-A")], bsvtest: [res("bsvtest", ACTIVE_PK, "addr-T")] },
        true,
        calls
      ),
      wocBsv21: fakeWoc({ "addr-A": ["tok1"], "addr-T": ["tokt"] })
    });
    const out = await svc.listActiveKeyTokens();
    expect(calls).toEqual(["bsv", "bsvtest"]);
    expect(out.map((t) => t.meta.origin).sort()).toEqual(["tok1", "tokt"]);
  });

  it("includeTestnet 选项覆盖 p2pkh 全局设置", async () => {
    const calls: string[] = [];
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh({ bsv: [res("bsv", ACTIVE_PK, "addr-A")] }, true, calls),
      wocBsv21: fakeWoc({ "addr-A": ["tok1"] }),
      includeTestnet: () => false
    });
    await svc.listActiveKeyTokens();
    expect(calls).toEqual(["bsv"]);
  });

  it("getToken 命中 origin 返回 meta+balance，落空返回 null", async () => {
    const svc = createBsv21Service({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh({ bsv: [res("bsv", ACTIVE_PK, "addr-A")] }, false),
      wocBsv21: fakeWoc({ "addr-A": ["tok1"] })
    });
    expect(await svc.getToken("tok1")).not.toBeNull();
    expect(await svc.getToken("nope")).toBeNull();
  });
});
