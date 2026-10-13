// 受限网络能力的形状边界（第 1 阶段）。
//
// 这些是 Worker 侧**唯一**允许发出去的帧约束：这里放宽一点，就等于让 Forum 的
// Worker 变成通用帧通道或把 Host 占得更久。

import { describe, expect, it } from "vitest";

import {
  FORUM_WORKER_DEFAULT_TIMEOUT_MS,
  FORUM_WORKER_MAX_FRAME_BYTES,
  FORUM_WORKER_ROUNDTRIP_KIND,
  isForumWorkerRoundtripRequest,
} from "./forumWorker.js";

const VALID = {
  kind: FORUM_WORKER_ROUNDTRIP_KIND,
  address: "/ip4/127.0.0.1/tcp/8080/p2p/12D3KooW",
  forumPublicKeyHex: `02${"11".repeat(32)}`,
  requestBytesHex: "0102ff",
} as const;

describe("受限 roundtrip 请求的形状校验", () => {
  it("接受形状正确的 roundtrip", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID })).toBe(true);
    expect(isForumWorkerRoundtripRequest({ ...VALID, timeoutMs: FORUM_WORKER_DEFAULT_TIMEOUT_MS })).toBe(true);
  });

  it("只接受 forum.roundtrip 一种 kind", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID, kind: "forum.publish" })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, kind: undefined })).toBe(false);
  });

  it("论坛公钥必须是 33 字节压缩公钥", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID, forumPublicKeyHex: `11${"11".repeat(32)}` })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, forumPublicKeyHex: "11" })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, forumPublicKeyHex: `02${"11".repeat(31)}` })).toBe(false);
    // 大写 hex 也拒绝：公钥比较是逐字节的，不做大小写归一。
    expect(isForumWorkerRoundtripRequest({ ...VALID, forumPublicKeyHex: `02${"AB".repeat(32)}` })).toBe(false);
  });

  it("请求体必须是偶数长度的 hex", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID, requestBytesHex: "010" })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, requestBytesHex: "01zz" })).toBe(false);
  });

  it("超过帧上限直接拒绝", () => {
    const oversized = "00".repeat(FORUM_WORKER_MAX_FRAME_BYTES + 1);
    expect(isForumWorkerRoundtripRequest({ ...VALID, requestBytesHex: oversized })).toBe(false);
    const atLimit = "00".repeat(FORUM_WORKER_MAX_FRAME_BYTES);
    expect(isForumWorkerRoundtripRequest({ ...VALID, requestBytesHex: atLimit })).toBe(true);
  });

  it("超时不接受非正数、非整数或超过上界的值", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID, timeoutMs: 0 })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, timeoutMs: -1 })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, timeoutMs: 1.5 })).toBe(false);
    expect(isForumWorkerRoundtripRequest({ ...VALID, timeoutMs: FORUM_WORKER_DEFAULT_TIMEOUT_MS + 1 })).toBe(false);
  });

  it("空地址与非对象一律拒绝", () => {
    expect(isForumWorkerRoundtripRequest({ ...VALID, address: "" })).toBe(false);
    expect(isForumWorkerRoundtripRequest(null)).toBe(false);
    expect(isForumWorkerRoundtripRequest("forum.roundtrip")).toBe(false);
    expect(isForumWorkerRoundtripRequest(undefined)).toBe(false);
  });
});

import { FORUM_WORKER_SERVICE_CAPABILITY } from "./forumWorker.js";
describe("Forum Worker structured domain boundary", () => {
  it("accepts structured domain methods with their declared arguments", () => {
    expect(FORUM_WORKER_SERVICE_CAPABILITY.request.parse({ method: "cancelUndispatched", args: ["task"] })).toEqual({ method: "cancelUndispatched", args: ["task"] });
    expect(FORUM_WORKER_SERVICE_CAPABILITY.request.parse({ method: "listConfigs", args: [] })).toEqual({ method: "listConfigs", args: [] });
  });
  it("rejects arbitrary digest, raw broadcast and storage methods", () => {
    for (const method of ["signDigest", "broadcast", "put", "__proto__", "constructor"]) expect(() => FORUM_WORKER_SERVICE_CAPABILITY.request.parse({ method, args: [] })).toThrow();
  });
  it("rejects missing or surplus arguments rather than silently dropping them", () => {
    expect(() => FORUM_WORKER_SERVICE_CAPABILITY.request.parse({ method: "saveConfig", args: [] })).toThrow();
    expect(() => FORUM_WORKER_SERVICE_CAPABILITY.request.parse({ method: "listConfigs", args: ["owner"] })).toThrow();
  });
});
