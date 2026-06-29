// packages/plugin-token-stas/src/stasService.test.ts
// stasService 回归测试：覆盖 phase 1 的关键约束——
//   1. 强制走 main network，testnet 资源不进入列表；
//   2. 按 active key 的 publicKeyHex 过滤地址；
//   3. STAS entry 自带 balance，service 直接透传。

import { describe, expect, it } from "vitest";
import type { KeyspaceService, WocStasService } from "@keymaster/contracts";
import {
  createStasService,
  type P2pkhKeyResourceForStas,
  type P2pkhServiceForStas
} from "./stasService.js";

const ACTIVE_PK = "pk-active";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return { active: () => ({ activePublicKeyHex }) } as unknown as KeyspaceService;
}

function fakeP2pkh(resources: P2pkhKeyResourceForStas[]): P2pkhServiceForStas {
  return { listResources: () => Promise.resolve(resources) };
}

/** 每个地址返回固定 entry，balance 取地址长度便于断言透传。 */
function fakeWoc(): WocStasService {
  return {
    listAddressTokens: (_network, address) =>
      Promise.resolve([{ symbol: `S-${address}`, balance: address.length }])
  };
}

describe("createStasService", () => {
  it("缺关键依赖时立即抛错", () => {
    expect(() => createStasService({} as never)).toThrow(/required/);
  });

  it("无 active key 时返回空列表", async () => {
    const svc = createStasService({
      keyspace: fakeKeyspace(undefined),
      p2pkh: fakeP2pkh([]),
      wocStas: fakeWoc()
    });
    expect(await svc.listActiveKeyTokens()).toEqual([]);
  });

  it("只取 active key 的 main 地址，过滤 testnet 与其它 key", async () => {
    const svc = createStasService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([
        { publicKeyHex: ACTIVE_PK, address: "addr-main", network: "main" },
        { publicKeyHex: ACTIVE_PK, address: "addr-test", network: "test" },
        { publicKeyHex: "pk-other", address: "addr-other", network: "main" }
      ]),
      wocStas: fakeWoc()
    });
    const out = await svc.listActiveKeyTokens();
    expect(out.map((t) => t.address)).toEqual(["addr-main"]);
    expect(out[0]!.network).toBe("main");
  });

  it("透传 WOC entry 的 balance", async () => {
    const svc = createStasService({
      keyspace: fakeKeyspace(ACTIVE_PK),
      p2pkh: fakeP2pkh([{ publicKeyHex: ACTIVE_PK, address: "addr-main", network: "main" }]),
      wocStas: fakeWoc()
    });
    const out = await svc.listActiveKeyTokens();
    expect(out[0]!.entry.balance).toBe("addr-main".length);
  });
});
