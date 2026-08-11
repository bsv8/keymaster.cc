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
