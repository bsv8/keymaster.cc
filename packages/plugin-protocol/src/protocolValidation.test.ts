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
