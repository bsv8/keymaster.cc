// packages/plugin-woc/src/wocTokensPaths.test.ts
// BSV-21 / STAS / 1Sat WOC 路径映射回归测试。
//
// 关键不变量（施工单 004）：
//   1. BSV-21 list 端点：GET /token/bsv21/<address>/balance
//   2. BSV-21 单 token 余额：GET /token/bsv21/<address>/balance/<origin>
//   3. BSV-21 token 详情：GET /token/bsv21/id/<id>
//   4. STAS list 端点：GET /token/stas/<address>/balance
//   5. 1Sat outpoint 端点：GET /token/1satordinals/<txid>_<vout>
//      关键：outpoint 字符串是 "txid_vout"（下划线），不是 "txid:vout"。
//   6. 1Sat 404 / not-found 翻译为 null；其它错误向上抛。
//   7. 业务侧 outpoint 格式错误（不含 "_"）直接返回 null，不抛错。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageBus } from "@keymaster/runtime";
import type { BsvNetwork } from "@keymaster/contracts";
import { createWocActor } from "./wocActor.js";
import { createWocService } from "./wocService.js";
import { createWocBsv21Service } from "./wocBsv21Service.js";
import { createWocStasService } from "./wocStasService.js";
import { createWoc1SatOrdinalsService } from "./woc1SatOrdinalsService.js";

const MAIN: BsvNetwork = "main";
const TEST: BsvNetwork = "test";

function installFetchMock(handler: (url: string) => Response | undefined) {
  const fn = vi.fn(async (url: string) => {
    const r = handler(url);
    if (r) return r;
    throw new Error(`unhandled URL in mock: ${url}`);
  });
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const fetchLog: string[] = [];

beforeEach(() => {
  fetchLog.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BSV-21 / STAS / 1Sat WOC 路径映射", () => {
  it("getRawTransaction 使用当前 WOC raw transaction 路径", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(JSON.stringify({ hex: "00" }), { status: 200 });
    });
    const bus = createMessageBus();
    const svc = createWocService({ messageBus: bus });
    await expect(svc.getRawTransaction!(MAIN, "ab".repeat(32))).resolves.toBe("00");
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/tx\/(?:ab){32}\/hex$/);
    svc.dispose();
  });

  it("BSV-21 listAddressTokens → /token/bsv21/<address>/balance", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(
        JSON.stringify({ result: [{ origin: "abc", symbol: "X", decimals: 8, issuer: "me" }] }),
        { status: 200 }
      );
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    const out = await svc.listAddressTokens(MAIN, "1Address");
    expect(out).toEqual([{ origin: "abc", symbol: "X", decimals: 8, issuer: "me", network: "main" }]);
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/bsv21\/1Address\/balance$/);
    actor.dispose();
  });

  it("BSV-21 listAddressTokens 走 testnet 时 URL 包含 /v1/bsv/test/", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    await svc.listAddressTokens(TEST, "1Addr");
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/test\/token\/bsv21\/1Addr\/balance$/);
    actor.dispose();
  });

  it("BSV-21 listAddressTokens 404 返回空数组", async () => {
    installFetchMock(() => new Response("not found", { status: 404 }));
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    const out = await svc.listAddressTokens(MAIN, "EmptyAddr");
    expect(out).toEqual([]);
    actor.dispose();
  });

  it("BSV-21 getAddressTokenBalance → /token/bsv21/<address>/balance/<origin>", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(JSON.stringify({ confirmed: 100, unconfirmed: 5 }), { status: 200 });
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    const out = await svc.getAddressTokenBalance(MAIN, "1Addr", "txid_orig");
    expect(out).toEqual({ confirmed: 100, unconfirmed: 5 });
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/bsv21\/1Addr\/balance\/txid_orig$/);
    actor.dispose();
  });

  it("BSV-21 getTokenById → /token/bsv21/id/<id>", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(
        JSON.stringify({
          token: {
            outpoint: "abc_0",
            current: { txid: "abc", txIndex: 10 }
          }
        }),
        { status: 200 }
      );
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    const out = await svc.getTokenById(MAIN, "abc_0");
    expect(out?.token.outpoint).toBe("abc_0");
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/bsv21\/id\/abc_0$/);
    actor.dispose();
  });

  it("BSV-21 listAddressUnspentTokens → /token/bsv21/<address>/unspent", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(
        JSON.stringify({
          tokens: [
            {
              outpoint: "tx0_0",
              data: {
                insc: {
                  json: {
                    amt: "999000",
                    id: "tx0_0",
                    op: "transfer",
                    p: "bsv-20"
                  }
                },
                bsv20: {
                  amt: 999000,
                  id: "tx0_0",
                  op: "transfer",
                  protocol: "bsv-20"
                }
              },
              current: { txid: "tx0", txIndex: 0 },
              ownerAddress: "1Addr"
            }
          ]
        }),
        { status: 200 }
      );
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocBsv21Service({ messageBus: bus });
    const out = await svc.listAddressUnspentTokens(MAIN, "1Addr");
    expect(out).toEqual([
      {
        network: "main",
        outpoint: "tx0_0",
        tokenId: "tx0_0",
        amount: "999000",
        ownerAddress: "1Addr",
        observation: "unconfirmed",
        canonicalTxid: "tx0",
        current: { txid: "tx0", txIndex: 0, blockHeight: undefined, blockTime: undefined }
      }
    ]);
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/bsv21\/1Addr\/unspent$/);
    actor.dispose();
  });

  it("STAS listAddressTokens → /token/stas/<address>/balance", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(
        JSON.stringify({ result: [{ symbol: "STASA", issuer: "i", balance: 42 }] }),
        { status: 200 }
      );
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocStasService({ messageBus: bus });
    const out = await svc.listAddressTokens(MAIN, "1Addr");
    expect(out).toEqual([{ symbol: "STASA", issuer: "i", balance: 42 }]);
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/stas\/1Addr\/balance$/);
    actor.dispose();
  });

  it("STAS listAddressTokens 404 返回空数组", async () => {
    installFetchMock(() => new Response("not found", { status: 404 }));
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWocStasService({ messageBus: bus });
    const out = await svc.listAddressTokens(MAIN, "Empty");
    expect(out).toEqual([]);
    actor.dispose();
  });

  it("1Sat getOutpointInscription 命中 → 返回 inscription，URL 用下划线", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      return new Response(
        JSON.stringify({
          inscriptionId: "insc-1",
          contentType: "image/png",
          preview: "https://preview.example/x.png"
        }),
        { status: 200 }
      );
    });
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWoc1SatOrdinalsService({ messageBus: bus });
    const out = await svc.getOutpointInscription(MAIN, "abcdef_0");
    // outpoint 字符串格式："txid_vout"（下划线）。
    expect(out).not.toBeNull();
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/token\/1satordinals\/abcdef_0$/);
    actor.dispose();
  });

  it("1Sat getOutpointInscription 404 → null（不抛错、不记 provider 错误）", async () => {
    installFetchMock(() => new Response("not found", { status: 404 }));
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWoc1SatOrdinalsService({ messageBus: bus });
    const out = await svc.getOutpointInscription(MAIN, "txid_0");
    expect(out).toBeNull();
    actor.dispose();
  });

  it("1Sat outpoint 格式错误（不含下划线）→ null（不抛错）", async () => {
    installFetchMock(() => new Response("{}", { status: 200 }));
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWoc1SatOrdinalsService({ messageBus: bus });
    // 业务侧把 txid / vout 拼成冒号格式（错），应当直接 null。
    const out = await svc.getOutpointInscription(MAIN, "txid:0");
    expect(out).toBeNull();
    actor.dispose();
  });

  it("1Sat 非 404 错误向上抛", async () => {
    installFetchMock(() => new Response("server error", { status: 500 }));
    const bus = createMessageBus();
    const actor = createWocActor();
    actor.attach(bus);
    const svc = createWoc1SatOrdinalsService({ messageBus: bus });
    await expect(svc.getOutpointInscription(MAIN, "txid_0")).rejects.toThrow(/WOC 500/);
    actor.dispose();
  });

  it("transaction observation 先查 confirmed，再查 propagation；confirmed 命中返回 confirmed", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      if (url.includes("/tx/hash/tx-confirmed")) {
        return new Response(JSON.stringify({ txid: "tx-confirmed" }), { status: 200 });
      }
      throw new Error(`unhandled URL in mock: ${url}`);
    });
    const bus = createMessageBus();
    const woc = createWocService({ messageBus: bus });
    const obs = await woc.getTransactionObservation(MAIN, "tx-confirmed");
    expect(obs).toEqual({ canonicalTxid: "tx-confirmed", observation: "confirmed" });
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/tx\/hash\/tx-confirmed$/);
    expect(fetchLog).toHaveLength(1);
    woc.dispose();
  });

  it("transaction observation confirmed 不存在时回退到 propagation；两边都无则 undefined", async () => {
    installFetchMock((url) => {
      fetchLog.push(url);
      if (url.includes("/tx/hash/tx-unconfirmed")) {
        if (url.endsWith("/propagation")) {
          return new Response(JSON.stringify({ propagated: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/tx/hash/tx-missing")) {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unhandled URL in mock: ${url}`);
    });
    const bus = createMessageBus();
    const woc = createWocService({ messageBus: bus });
    const unconfirmed = await woc.getTransactionObservation(MAIN, "tx-unconfirmed");
    expect(unconfirmed).toEqual({ canonicalTxid: "tx-unconfirmed", observation: "unconfirmed" });
    const missing = await woc.getTransactionObservation(TEST, "tx-missing");
    expect(missing).toEqual({ canonicalTxid: "tx-missing", observation: undefined });
    expect(fetchLog[0]).toMatch(/\/v1\/bsv\/main\/tx\/hash\/tx-unconfirmed$/);
    expect(fetchLog[1]).toMatch(/\/v1\/bsv\/main\/tx\/hash\/tx-unconfirmed\/propagation$/);
    expect(fetchLog[2]).toMatch(/\/v1\/bsv\/test\/tx\/hash\/tx-missing$/);
    expect(fetchLog[3]).toMatch(/\/v1\/bsv\/test\/tx\/hash\/tx-missing\/propagation$/);
    woc.dispose();
  });
});
