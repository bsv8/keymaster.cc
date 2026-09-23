import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@keymaster/contracts";
import { parseRequestMessage } from "./protocolValidation.js";

describe("storage protocol validation", () => {
  it("accepts an explicit empty list prefix as the app root", () => {
    const parsed = parseRequestMessage({
      v: PROTOCOL_VERSION,
      type: "request",
      id: "list-root",
      method: "storage.list",
      params: { connectSessionId: "session", prefix: "" }
    });
    expect(parsed.params).toMatchObject({ connectSessionId: "session", prefix: "" });
  });

  it("rejects a path segment longer than 255 characters", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION,
      type: "request",
      id: "list-long",
      method: "storage.list",
      params: { connectSessionId: "session", prefix: "x".repeat(256) }
    })).toThrowError(/valid relative path/iu);
  });

  it("rejects get ranges whose end exceeds safe integer bounds", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION,
      type: "request",
      id: "get-overflow",
      method: "storage.get",
      params: { connectSessionId: "session", path: "file", offset: Number.MAX_SAFE_INTEGER, length: 2 }
    })).toThrowError(/safe integer/iu);
  });
});

describe("price protocol validation", () => {
  it.each(["price.get", "price.subscribe", "price.unsubscribe"] as const)(
    "%s accepts exactly connectSessionId",
    (method) => {
      const parsed = parseRequestMessage({
        v: PROTOCOL_VERSION,
        type: "request",
        id: "price-1",
        method,
        params: { connectSessionId: "session" }
      });
      expect(parsed.params).toEqual({ connectSessionId: "session" });
    }
  );

  it("rejects extra caller-supplied fields", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION,
      type: "request",
      id: "price-extra",
      method: "price.get",
      params: { connectSessionId: "session", assetId: "bsv-mainnet" }
    })).toThrowError(/unsupported field/iu);
  });

  it("rejects a missing session id", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION,
      type: "request",
      id: "price-missing-session",
      method: "price.subscribe",
      params: {}
    })).toThrowError(/price params/iu);
  });
});

describe("connect.login local catalog trust boundary", () => {
  const proof = { version: 1 as const, publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", app: { id: "stable-app-id", name: "Stable App", description: "Description" }, requirements: [] as ("private-key" | "storage")[], signature: "ba7206e5617360697c0199ffdb3c82a2728b2e46a5b48b39d405ec65009bc3c34a3a91e0acf1f37ff88654a7a60d3f4da8532875d3f333859a22c8eb9feb7af7" };
  const base = {
    v: PROTOCOL_VERSION,
    type: "request",
    id: "login",
    method: "connect.login",
    params: { text: "Login", claims: [] }
  } as const;

  it("accepts text, claims and signed proof", () => {
    expect(parseRequestMessage({ ...base, params: { ...base.params, appIdentity: proof } }).params).toMatchObject({ text: "Login", appIdentity: proof });
  });

  it.each(["appMetadata", "publisherPublicKey", "requirements", "unknown"])("rejects caller-supplied %s", (field) => {
    expect(() => parseRequestMessage({
      ...base,
      params: { ...base.params, [field]: field === "requirements" ? ["storage"] : {} }
    })).toThrowError(/unsupported field/iu);
  });
});

describe("connect.launch signed proof boundary", () => {
  const proof = { version: 1 as const, publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", app: { id: "stable-app-id", name: "Stable App", description: "Description" }, requirements: [] as ("private-key" | "storage")[], signature: "ba7206e5617360697c0199ffdb3c82a2728b2e46a5b48b39d405ec65009bc3c34a3a91e0acf1f37ff88654a7a60d3f4da8532875d3f333859a22c8eb9feb7af7" };
  const base = {
    v: PROTOCOL_VERSION,
    type: "request",
    id: "launch",
    method: "connect.launch",
    params: { launchToken: "launch-token", appIdentity: proof }
  } as const;

  it("accepts launchToken with signed appIdentity", () => {
    expect(parseRequestMessage(base).params).toMatchObject({ launchToken: "launch-token", appIdentity: proof });
  });

  it.each(["appMetadata", "publisherPublicKey", "requirements", "extra"])("rejects extra field %s", (field) => {
    expect(() => parseRequestMessage({
      ...base,
      params: { ...base.params, [field]: {} }
    })).toThrowError(/unsupported field/iu);
  });
});

describe("msfile protocol validation", () => {
  const SUPPLIER = "035f3d296df6e017c017270bfc0293dc7d197ff9e04a25c096260420644d86d21a";
  const SOURCE = `remote-proxy:${SUPPLIER}`;
  const HASH = "ab".repeat(32);

  it("accepts the three canonical shapes", () => {
    expect(parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "s1", method: "msfile.stat",
      params: { connectSessionId: "session", seedHashHex: HASH }
    }).params).toMatchObject({ connectSessionId: "session" });
    expect(parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "s2", method: "msfile.seed.read",
      params: { connectSessionId: "session", sourceId: SOURCE, seedHashHex: HASH }
    }).params).toMatchObject({ sourceId: SOURCE });
    expect(parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "s3", method: "msfile.block.read",
      params: { connectSessionId: "session", sourceId: SOURCE, seedHashHex: HASH, blockHashHex: HASH }
    }).params).toMatchObject({ sourceId: SOURCE, seedHashHex: HASH });
  });

  // SDK 传入 maxPriceSatoshis / fileId / blockIndex 等额外字段必须全部拒绝。
  it.each([
    "maxPriceSatoshis",
    "contentKind",
    "kind",
    "fileId",
    "accessId",
    "seedAccessId",
    "blockIndex",
    "ownerPublicKeyHex",
    "appIdentity"
  ])("rejects forbidden field %s on msfile.seed.read", (field) => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "x", method: "msfile.seed.read",
      params: {
        connectSessionId: "session",
        sourceId: SOURCE,
        seedHashHex: HASH,
        [field]: field === "blockIndex" ? 1 : field.includes("Satoshis") ? "10" : {}
      }
    })).toThrowError(/forbidden|invalid_request/i);
  });

  it("rejects non-canonical hashes and malformed source routes", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "x", method: "msfile.stat",
      params: { connectSessionId: "s", seedHashHex: "AB".repeat(32) }
    })).toThrowError(/64 lower-case hex/iu);
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "x", method: "msfile.block.read",
      params: { connectSessionId: "s", sourceId: "remote-proxy:04" + "11".repeat(32), seedHashHex: HASH, blockHashHex: HASH }
    })).toThrowError(/source route/iu);
  });

  it("requires connectSessionId like every other business method family", () => {
    expect(() => parseRequestMessage({
      v: PROTOCOL_VERSION, type: "request", id: "x", method: "msfile.stat",
      params: { seedHashHex: HASH }
    })).toThrowError(/connectSessionId/iu);
  });
});

describe("p2pkh.transfer / feepool 多资产校验（施工单 2026-09-18 001）", () => {
  // 公开资产标识只区分 `bsv-mainnet` / `bsv-testnet`；地址 version 必须匹配。
  const MAINNET_P2PKH = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
  const TESTNET_P2PKH = "mzBc4XEFSdjm9XEV3R3c7x6Q7ZqQ2d1b8e";
  const baseP2pkh = {
    v: PROTOCOL_VERSION,
    type: "request" as const,
    id: "p2pkh-asset",
    method: "p2pkh.transfer" as const,
    params: {
      recipientAddress: MAINNET_P2PKH,
      amountSatoshis: 1000,
      connectSessionId: "session"
    }
  };
  const baseFeepool = {
    v: PROTOCOL_VERSION,
    type: "request" as const,
    id: "feepool-asset",
    method: "feepool.prepare" as const,
    params: {
      counterpartyPublicKeyHex: "02" + "11".repeat(32),
      amountSatoshis: 1000,
      connectSessionId: "session"
    }
  };

  it("缺省 assetId 保持 undefined（service 层归一化为 bsv-mainnet）并接受 mainnet 地址", () => {
    const parsed = parseRequestMessage(baseP2pkh);
    expect(parsed.params).toMatchObject({ recipientAddress: MAINNET_P2PKH, assetId: undefined });
    const explicit = parseRequestMessage({ ...baseP2pkh, params: { ...baseP2pkh.params, assetId: "bsv-mainnet" } });
    expect(explicit.params).toMatchObject({ assetId: "bsv-mainnet" });
  });

  it("bsv-testnet 接受 testnet 地址", () => {
    const parsed = parseRequestMessage({
      ...baseP2pkh,
      params: { ...baseP2pkh.params, recipientAddress: TESTNET_P2PKH, assetId: "bsv-testnet" }
    });
    expect(parsed.params).toMatchObject({ recipientAddress: TESTNET_P2PKH, assetId: "bsv-testnet" });
  });

  it("拒绝资产与地址 version 不匹配", () => {
    expect(() => parseRequestMessage({
      ...baseP2pkh,
      params: { ...baseP2pkh.params, recipientAddress: MAINNET_P2PKH, assetId: "bsv-testnet" }
    })).toThrowError(/testnet P2PKH/iu);
    expect(() => parseRequestMessage({
      ...baseP2pkh,
      params: { ...baseP2pkh.params, recipientAddress: TESTNET_P2PKH, assetId: "bsv-mainnet" }
    })).toThrowError(/mainnet P2PKH/iu);
  });

  it("拒绝未知 assetId 字面量", () => {
    expect(() => parseRequestMessage({
      ...baseP2pkh,
      params: { ...baseP2pkh.params, assetId: "bsv" }
    })).toThrowError(/assetId/iu);
    expect(() => parseRequestMessage({
      ...baseFeepool,
      params: { ...baseFeepool.params, assetId: "bsvtest" }
    })).toThrowError(/assetId/iu);
  });

  it("feepool.prepare 接受 bsv-testnet，缺省时 assetId 为 undefined", () => {
    const parsed = parseRequestMessage({ ...baseFeepool, params: { ...baseFeepool.params, assetId: "bsv-testnet" } });
    expect(parsed.params).toMatchObject({ assetId: "bsv-testnet" });
    const defaults = parseRequestMessage(baseFeepool);
    expect(defaults.params).toMatchObject({ assetId: undefined });
  });
});
