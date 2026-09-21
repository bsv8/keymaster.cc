import { describe, expect, it } from "vitest";
import { isDefinitelyNotDispatchedBroadcastError } from "./broadcast.js";

describe("isDefinitelyNotDispatchedBroadcastError", () => {
  it("treats plain WoC 4xx responses as ambiguous", () => {
    // 中文：Provider 对"交易已在 mempool / 已存在"也可能返回 4xx；
    // 这类错误不能当作"确定未派发"去回滚快照消费。
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 400 Bad Request"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 413 Payload Too Large"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 422 Unprocessable Entity"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 404 Not Found"))).toBe(false);
  });

  it("treats timeout, network, 429 and 5xx as ambiguous", () => {
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 429"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("WOC 500 Internal Server Error"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("The operation was aborted"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("Failed to fetch"))).toBe(false);
    expect(isDefinitelyNotDispatchedBroadcastError({ statusCode: 400 })).toBe(false);
  });

  it("accepts explicit node rejections of the transaction body", () => {
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("bad-txns-inputs-missingorspent"))).toBe(true);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("invalid transaction"))).toBe(true);
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("malformed payload"))).toBe(true);
  });

  it("does not accept a generic rejected message", () => {
    expect(isDefinitelyNotDispatchedBroadcastError(new Error("transaction rejected"))).toBe(false);
  });

  it("accepts the structured definitive marker only when the adapter sets it", () => {
    expect(isDefinitelyNotDispatchedBroadcastError(Object.assign(new Error("WOC 400 Bad Request"), { code: "definitive-not-dispatched" }))).toBe(true);
    expect(isDefinitelyNotDispatchedBroadcastError(Object.assign(new Error("WOC 400 Bad Request"), { code: "http-error" }))).toBe(false);
  });
});
