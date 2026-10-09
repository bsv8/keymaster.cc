// Forum Worker 受限网络能力的实现。
//
// 单独成模块有两个原因：
//   1. 这一层是「Worker → Window executor bridge」的唯一接线点，必须能被测试直接调用；
//   2. 它不依赖 Worker 单��注册的上下文，只依赖注入的 bridge 函数与 scope 有效性，
//      因此锁定、租约撤销、scope 失效都能在这里 fail closed。
//
// 实例边界（阶段 1 的第二条承诺）：能力必须绑定**提供它的那一次 scope**。
// executor bridge 检查的是「当前租约是否有效」，那只能证明 Host 可用，证明不了
// 调用者还是那个仍然有效的 Forum 实例——撤销之后，一个被别处保留的旧引用照样能
// 借到新的租约把请求发出去。因此每次调用前都断言 scope，撤销时中止在途请求，
// 并且迟到的结果不得再以成功返回。

import {
  FORUM_WORKER_LANE_ID,
  FORUM_WORKER_ROUNDTRIP_KIND,
  isForumWorkerRoundtripRequest,
  type ForumWorkerNetwork,
  type ForumWorkerRoundtripOutcome,
  type ForumWorkerRoundtripRequest,
} from "@keymaster/contracts";

/**
 * 现有 Worker→Window executor bridge 的操作入口形状。
 *
 * 它就是 `requestWindowP2pExecutorOperation`：Host、唯一租约与 bridge 字节预算都由
 * 那一条路径负责，所以 Forum 复用它就等于复用「唯一 Host 和现有租约机制」，
 * 而不是新开一条网络通道。
 */
export type ForumWorkerExecutorBridge = (
  operation: { type: "lane"; laneId: string; operation: { kind: string } & Record<string, unknown> },
  signal?: AbortSignal,
) => Promise<unknown>;

/** 提供实例的 scope 有效性判断；撤销后 `assertActive` 必须抛错。 */
export interface ForumWorkerScope {
  assertActive(): void;
}

export function createForumWorkerNetwork(
  bridge: ForumWorkerExecutorBridge,
  scope: ForumWorkerScope,
  onRevoke?: (cancel: (reason: Error) => void) => void,
): ForumWorkerNetwork {
  // 本实例的在途请求：scope 撤销时全部中止，迟到结果不再返回成功。
  const inFlight = new Set<AbortController>();

  const revoked = (reason: Error): void => {
    for (const controller of inFlight) controller.abort(reason);
    inFlight.clear();
  };
  onRevoke?.(revoked);

  return Object.freeze({
    async roundtrip(request: ForumWorkerRoundtripRequest, signal?: AbortSignal): Promise<ForumWorkerRoundtripOutcome> {
      // 形状校验放在 Worker 侧：畸形或超限的帧不应该走到 Host。
      if (!isForumWorkerRoundtripRequest(request)) {
        return Object.freeze({ ok: false as const, code: "forum-worker-request", message: "roundtrip 请求形状或大小不合法" });
      }
      // 每次调用都断言：旧引用不能在实例撤销后继续用。
      try {
        scope.assertActive();
      } catch {
        return Object.freeze({ ok: false as const, code: "forum-worker-revoked", message: "Forum Worker 实例已失效" });
      }
      // 调用方传进来时就已经取消：必须在碰 bridge **之前**结束。
      // 否则 addEventListener 永远不会触发（事件已发生），请求会照常发出去——
      // 「已取消的调用仍然花掉一次 Host 往返」就是这么来的。
      if (signal?.aborted === true) {
        return Object.freeze({ ok: false as const, code: "forum-worker-cancelled", message: "调用已在发出前取消" });
      }
      const controller = new AbortController();
      inFlight.add(controller);
      // 调用方的 signal 与实例生命周期合成一个：任一撤销都要真正中止 bridge 请求。
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let outcome: unknown;
      try {
        outcome = await bridge({
          type: "lane",
          laneId: FORUM_WORKER_LANE_ID,
          operation: {
            kind: FORUM_WORKER_ROUNDTRIP_KIND,
            address: request.address,
            forumPublicKeyHex: request.forumPublicKeyHex,
            requestBytesHex: request.requestBytesHex,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          },
        }, controller.signal);
      } catch (error) {
        // Host/租约不可用或被撤销：明确失败。绝不静默改走 Window 本地权威——
        // 那会让同一笔发布出现两套仲裁。
        return Object.freeze({
          ok: false as const,
          code: "forum-worker-network",
          message: error instanceof Error ? error.message : "受限网络能力不可用",
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        inFlight.delete(controller);
      }
      // 撤销后到达的迟到结果不得再报成功：那笔请求是在一个已经失效的实例上发出的。
      try {
        scope.assertActive();
      } catch {
        return Object.freeze({ ok: false as const, code: "forum-worker-revoked", message: "Forum Worker 实例已失效" });
      }
      if (typeof outcome !== "object" || outcome === null) {
        return Object.freeze({ ok: false as const, code: "forum-worker-response", message: "lane 返回了无法识别的结果" });
      }
      const record = outcome as Record<string, unknown>;
      // lane 侧的 ok/code/message 由 Window 侧判定；这里只做形状收窄，不重新解释业务结果。
      if (record.ok === true && typeof record.responseBytesHex === "string") {
        return Object.freeze({ ok: true as const, responseBytesHex: record.responseBytesHex });
      }
      return Object.freeze({
        ok: false as const,
        code: typeof record.code === "string" ? record.code : "forum-worker-lane",
        message: typeof record.message === "string" ? record.message : "lane 调用失败",
      });
    },
  });
}