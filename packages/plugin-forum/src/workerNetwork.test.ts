// Forum Worker 受限网络能力的装配测试。
//
// 重点不是「能发出去」，而是三件边界：
//   1. 只允许 forum.roundtrip 一种帧——它不能变成通用帧通道；
//   2. Host/租约不可用时明确失败——不能静默退回 Window 本地权威；
//   3. lane 侧的业务结论原样透出，Worker 侧不重新解释。

import { describe, expect, it, vi } from "vitest";
import { FORUM_WORKER_LANE_ID, FORUM_WORKER_MAX_FRAME_BYTES } from "@keymaster/contracts";

import { createForumWorkerNetwork, type ForumWorkerExecutorBridge, type ForumWorkerScope } from "./workerNetwork.js";

/** 可撤销的 scope 替身：撤销后 assertActive 抛错，与真实 scope 语义一致。 */
function revocableScope() {
  let active = true;
  const revokeListeners: Array<(error: Error) => void> = [];
  const scope: ForumWorkerScope = {
    assertActive() {
      if (!active) throw new Error("scope revoked");
    },
  };
  const network = (bridge: ForumWorkerExecutorBridge) => createForumWorkerNetwork(bridge, scope, (cancel) => {
    revokeListeners.push(cancel);
  });
  return {
    scope,
    network,
    revoke(reason = new Error("Forum Worker unit revoked")) {
      active = false;
      for (const cancel of revokeListeners) cancel(reason);
    },
  };
}

const VALID = {
  kind: "forum.roundtrip" as const,
  address: "/ip4/127.0.0.1/tcp/8080/p2p/12D3KooW",
  forumPublicKeyHex: `02${"11".repeat(32)}`,
  requestBytesHex: "0102ff",
};

function harness(bridge: ForumWorkerExecutorBridge) {
  const session = revocableScope();
  return { ...session, network: session.network(bridge), calls: [] as unknown[] };
}

describe("Forum Worker 受限网络能力", () => {
  it("通过现有 bridge 的 forum lane 发出 roundtrip，且只发这一种", async () => {
    const seen: unknown[] = [];
    const h = harness(async (operation) => {
      seen.push(operation);
      return { ok: true, responseBytesHex: "aabb" };
    });

    const outcome = await h.network.roundtrip({ ...VALID });
    expect(outcome).toEqual({ ok: true, responseBytesHex: "aabb" });
    expect(seen).toHaveLength(1);
    // lane id 与 Window 侧注册的一致，bridge 因此仍然走唯一 Host。
    expect(seen[0]).toMatchObject({ type: "lane", laneId: FORUM_WORKER_LANE_ID });
    expect((seen[0] as { operation: { kind: string } }).operation.kind).toBe("forum.roundtrip");
    // 未给出 timeout 时不额外编一个：让 lane 用它自己的默认上界。
    expect((seen[0] as { operation: Record<string, unknown> }).operation).not.toHaveProperty("timeoutMs");
  });

  it("给出 timeout 时按调用方值透传", async () => {
    const seen: Record<string, unknown>[] = [];
    const h = harness(async (operation) => {
      seen.push(operation.operation as Record<string, unknown>);
      return { ok: true, responseBytesHex: "00" };
    });
    await h.network.roundtrip({ ...VALID, timeoutMs: 1_000 });
    expect(seen[0]?.timeoutMs).toBe(1_000);
  });

  it.each([
    ["非 forum.roundtrip 的 kind", { ...VALID, kind: "forum.publish" }],
    ["非法论坛公钥", { ...VALID, forumPublicKeyHex: "11" }],
    ["奇数长度请求体", { ...VALID, requestBytesHex: "010" }],
    ["超限请求体", { ...VALID, requestBytesHex: "00".repeat(FORUM_WORKER_MAX_FRAME_BYTES + 1) }],
    ["超出上界的超时", { ...VALID, timeoutMs: 60_000 }],
  ])("%s 直接拒绝，根本不碰 bridge", async (_label, request) => {
    const bridge = vi.fn(async () => ({ ok: true, responseBytesHex: "00" }));
    const network = revocableScope().network(bridge);
    const outcome = await network.roundtrip(request as typeof VALID);
    expect(outcome).toMatchObject({ ok: false, code: "forum-worker-request" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it("bridge 抛错（Host/租约不可用）时明确失败，不改走别的路径", async () => {
    const h = harness(async () => {
      throw new Error("Window P2P executor is unavailable");
    });
    const outcome = await h.network.roundtrip({ ...VALID });
    expect(outcome).toMatchObject({ ok: false, code: "forum-worker-network" });
    expect((outcome as { message: string }).message).toContain("executor is unavailable");
  });

  it("lane 的业务失败原样透出（Worker 不重新解释 code）", async () => {
    const h = harness(async () => ({ ok: false, code: "forum-lane-identity", message: "远端身份与论坛公钥不一致" }));
    expect(await h.network.roundtrip({ ...VALID })).toEqual({
      ok: false, code: "forum-lane-identity", message: "远端身份与论坛公钥不一致",
    });
  });

  it("lane 返回非对象或缺字段时报可识别的失败，而不是假装成功", async () => {
    const session = revocableScope();
    expect(await session.network(async () => undefined).roundtrip({ ...VALID }))
      .toMatchObject({ ok: false, code: "forum-worker-response" });
    // ok:true 但没有响应体：不能当成已收到答案。
    expect(await session.network(async () => ({ ok: true })).roundtrip({ ...VALID }))
      .toMatchObject({ ok: false, code: "forum-worker-lane" });
  });

  it("能力对象是冻结的：Worker 侧无法就地改写实现", () => {
    const network = revocableScope().network(async () => ({ ok: true, responseBytesHex: "00" }));
    expect(Object.isFrozen(network)).toBe(true);
  });
});

// 实例生命周期：executor bridge 只证明「当前租约有效」，证明不了调用者还是那个
// 仍然有效的 Forum 实例。撤销后被保留的旧引用必须立刻失效。
describe("Forum Worker 受限网络的实例生命周期", () => {
  const VALID = {
    kind: "forum.roundtrip" as const,
    address: "/ip4/127.0.0.1/tcp/8080/p2p/12D3KooW",
    forumPublicKeyHex: `02${"11".repeat(32)}`,
    requestBytesHex: "0102ff",
  };

  it("撤销后保留的旧引用不能借新租约发请求", async () => {
    const session = revocableScope();
    const bridge = vi.fn(async () => ({ ok: true, responseBytesHex: "aabb" }));
    const retained = session.network(bridge);
    expect(await retained.roundtrip({ ...VALID })).toMatchObject({ ok: true });

    session.revoke();
    // 同一个引用、同一份实现：实例已经失效，因此明确失败。
    expect(await retained.roundtrip({ ...VALID })).toMatchObject({ ok: false, code: "forum-worker-revoked" });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("撤销会中止在途请求，并拒绝把迟到结果报成成功", async () => {
    const session = revocableScope();
    let releaseBridge: (() => void) | undefined;
    const bridge = vi.fn(async (_operation: unknown, signal?: AbortSignal) => {
      // 模拟一个还在飞的请求：撤销会 abort 它，但实现仍会「晚到」返回结果。
      await new Promise<void>((resolve, reject) => {
        releaseBridge = resolve;
        signal?.addEventListener("abort", () => reject(new Error("aborted by revoke")), { once: true });
      });
      return { ok: true, responseBytesHex: "deadbeef" };
    });
    const network = session.network(bridge);

    const pending = network.roundtrip({ ...VALID });
    await Promise.resolve();
    session.revoke();
    // 迟到结果不得变成成功。
    expect(await pending).toMatchObject({ ok: false });
    releaseBridge?.();
  });

  it("会话重建后新实例可以正常发请求，旧实例不会复活", async () => {
    const first = revocableScope();
    const oldNetwork = first.network(async () => ({ ok: true, responseBytesHex: "00" }));
    expect(await oldNetwork.roundtrip({ ...VALID })).toMatchObject({ ok: true });
    first.revoke();

    const second = revocableScope();
    const newNetwork = second.network(async () => ({ ok: true, responseBytesHex: "01" }));
    expect(await newNetwork.roundtrip({ ...VALID })).toMatchObject({ ok: true, responseBytesHex: "01" });
    // 旧引用仍然失效。
    expect(await oldNetwork.roundtrip({ ...VALID })).toMatchObject({ ok: false, code: "forum-worker-revoked" });
  });

  it("调用方 signal 取消时也真正中止 bridge 请求", async () => {
    const session = revocableScope();
    let aborted = false;
    const bridge = vi.fn(async (_operation: unknown, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted by caller"));
        }, { once: true });
      });
      return { ok: true, responseBytesHex: "00" };
    });
    const controller = new AbortController();
    const pending = session.network(bridge).roundtrip({ ...VALID }, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "forum-worker-network" });
    expect(aborted).toBe(true);
  });
});
describe("已取消的调用不碰 bridge", () => {
  const VALID = {
    kind: "forum.roundtrip" as const,
    address: "/ip4/127.0.0.1/tcp/8080/p2p/12D3KooW",
    forumPublicKeyHex: `02${"11".repeat(32)}`,
    requestBytesHex: "0102ff",
  };

  it("传入时已 abort 的 signal 直接结束，不发起 Host 往返", async () => {
    const session = revocableScope();
    const bridge = vi.fn(async () => ({ ok: true, responseBytesHex: "00" }));
    const controller = new AbortController();
    controller.abort();
    expect(await session.network(bridge).roundtrip({ ...VALID }, controller.signal))
      .toMatchObject({ ok: false, code: "forum-worker-cancelled" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it("无效 signal 形状不影响正常调用", async () => {
    const session = revocableScope();
    const bridge = vi.fn(async () => ({ ok: true, responseBytesHex: "01" }));
    expect(await session.network(bridge).roundtrip({ ...VALID }, AbortSignal.abort()))
      .toMatchObject({ ok: false, code: "forum-worker-cancelled" });
    expect(bridge).not.toHaveBeenCalled();
  });
});
