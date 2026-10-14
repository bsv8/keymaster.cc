import { sameNetworkIdentity } from "@keymaster/contracts";
import { defineWorkerRequestRoute } from "@keymaster/contracts";
import type {
  CoordinatorClientRequest, CoordinatorResponse, CoordinatorMsFileData, CoordinatorMsFileControl,
  MsFileErrorCode, MsFileConnectAppContext, SessionEpoch, MsFileReadConcurrencySettings
} from "@keymaster/contracts";
import { createMsfileDataQueue, createMsfileDataExecutor, type MsFileServiceImpl } from "./coordinator.js";
export interface MsFileWorkerRequestPorts {
  session(): { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string };
  runtime: { current(): MsFileServiceImpl | undefined; ensure(): Promise<MsFileServiceImpl> };
  settings(): MsFileReadConcurrencySettings;
  appSession(identity: import("@keymaster/contracts").NetworkIdentity, origin: string): Promise<{ networkIdentity: import("@keymaster/contracts").NetworkIdentity; sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: MsFileConnectAppContext["appIdentity"] } | null>;
  changed(): void;
  available(): boolean;
  blocked(requestId: string): CoordinatorResponse;
  admission: { revoked(peerId: string): boolean; response(requestId: string): CoordinatorResponse };
  identity: { cancelClient(peerId: string): void; cancel(peerId: string, requestId: string): void };
  control: { execute(request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>, signal: AbortSignal): Promise<CoordinatorResponse>; mutates(control: CoordinatorMsFileControl): boolean };
  io: { run<T>(operation: "read" | "write", signal: AbortSignal | undefined, execute: () => Promise<T>, options: { auditOperation: "msfile.data" | "msfile.control"; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean; durableLease?: boolean }): Promise<T> };
}
/** MSFile 所有授权、请求取消与公平数据队列都绑定此 Worker 实例。 */
export function createMsFileWorkerRequests(ports: MsFileWorkerRequestPorts) {
  const msfileRequests = new Map<string, { controller: AbortController; clientId: string; walletPublicKeyHex?: string }>();

  const msfileRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;

  const msfileGrants = new Map<string, { context: MsFileConnectAppContext; clientId: string; sessionEpoch: SessionEpoch }>();

  const msfileDataQueue = createMsfileDataQueue(ports.settings, message => msfileError("msfile_unavailable", message));

  const pumpMsfileDataWaiters = msfileDataQueue.pump;

  const withMsfileDataSlot = msfileDataQueue.run;

  const rejectMsfileDataWaiters = msfileDataQueue.rejectQueued;

  async function resolveMsfileGrant(
    grantId: string,
    actualClientId: string,
    expectedSessionEpoch: SessionEpoch
  ): Promise<{ context: MsFileConnectAppContext; walletPublicKeyHex: string }> {
    // 前置检查（session 查询前）。
    const grant = msfileGrants.get(grantId);
    if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== ports.session().sessionEpoch) {
      throw msfileError("msfile_identity_required", "MSFile grant is invalid");
    }
    const authoritative = await ports.appSession(grant.context, grant.context.transportOrigin);
    // 审查修复：await 返回后重新获取 grant 并复核全部前置条件——
    // 挂起期间发生的 lock / session abort / key switch 都必须使本次请求失效。
    const fresh = msfileGrants.get(grantId);
    if (!fresh || fresh.clientId !== actualClientId || fresh.sessionEpoch !== ports.session().sessionEpoch) {
      throw msfileError("msfile_identity_required", "MSFile grant was revoked during session lookup");
    }
    if (expectedSessionEpoch !== ports.session().sessionEpoch || ports.session().vaultStatus !== "unlocked") {
      throw msfileError("msfile_identity_required", "MSFile session changed during lookup");
    }
    if (!authoritative || !sameNetworkIdentity(authoritative.networkIdentity, fresh.context) || authoritative.origin !== fresh.context.transportOrigin || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(fresh.context.appIdentity)) {
      throw msfileError("msfile_identity_required", "MSFile session is invalid or revoked");
    }
    if (authoritative.ownerPublicKeyHex !== fresh.context.ownerPublicKeyHex) {
      throw msfileError("msfile_identity_required", "MSFile session owner changed during lookup");
    }
    if (!ports.session().activePublicKeyHex || authoritative.ownerPublicKeyHex !== ports.session().activePublicKeyHex) {
      throw msfileError("msfile_identity_required", "MSFile session owner does not match the active runtime owner");
    }
    return { context: fresh.context, walletPublicKeyHex: fresh.context.walletPublicKeyHex };
  }

  function msfileError(code: MsFileErrorCode, message: string): Error & { code: MsFileErrorCode } {
    const error = new Error(message) as Error & { code: MsFileErrorCode };
    error.code = code;
    return error;
  }

  async function executeMsfileData(request: Extract<CoordinatorClientRequest, { kind: "msfile.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
    const data: CoordinatorMsFileData = request.data;
    const signal = controller.signal;
    return withMsfileDataSlot(actualClientId, data, async () => {
      // MSFile 数据面的最终 lease 在 slot 已分配后取得，避免等待队列参与
      // authority 排序；Provider 调用、grant 复核和迟到结果检查仍在同一
      // lease 内完成。
      return ports.io.run(
        "read",
        signal,
        () => executeMsfileDataUnsafe(request, controller, actualClientId),
        { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "msfile.data" },
      );
    }, signal);
  }

  const executeMsfileDataUnsafe = createMsfileDataExecutor({
    runtime: () => ports.runtime.ensure(),
    sessionEpoch: () => ports.session().sessionEpoch,
    resolveGrant: resolveMsfileGrant,
    unavailable: message => msfileError("msfile_unavailable", message),
  });

  async function executeMsfileRequest(
    request: Extract<CoordinatorClientRequest, { kind: "msfile.grant" | "msfile.control" | "msfile.data" | "msfile.cancel" | "msfile.session.abort" }>,
    actualClientId: string, requestSignal?: AbortSignal
  ): Promise<CoordinatorResponse> {
    if (ports.admission.revoked(actualClientId)) return ports.admission.response(request.requestId);
    if (request.kind !== "msfile.cancel"
      && request.kind !== "msfile.session.abort"
      && !ports.available()) {
      return ports.blocked(request.requestId);
    }
    // cancel/session.abort 是纯本地清理，不能因为旧 authority 失效而被
    // 阻塞；其余请求则把授权查询、Provider I/O 和本地结果检查放在同一
    // 个最终 lease 中。锁定态沿用原有快速返回，解锁态才申请 lease。
    if (request.kind === "msfile.cancel" || request.kind === "msfile.session.abort") {
      return executeMsfileRequestUnsafe(request, actualClientId);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(requestSignal?.reason);
    if (requestSignal?.aborted) abort(); else requestSignal?.addEventListener("abort", abort, { once: true });
    const requestKey = msfileRequestKey(actualClientId, request.requestId);
    msfileRequests.set(requestKey, {
      controller,
      clientId: actualClientId,
      walletPublicKeyHex: request.kind === "msfile.data" && request.data.grantId !== undefined
        ? msfileGrants.get(request.data.grantId)?.context.walletPublicKeyHex
        : undefined,
    });
    try {
      if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex) {
        return executeMsfileRequestUnsafe(request, actualClientId, controller);
      }
      // 数据面先进入本地并发槽位，再取得最终 lease。若在排队前取得
      // authority lease，lease 的 CAS 顺序会取代 MSFile 自身的 client 轮转，
      // 使同一个持续请求的 client 抢在后来进入的 Connect client 前面。
      // 真正的 Provider/授权读取仍由 executeMsfileData 在物理执行边界保护。
      if (request.kind === "msfile.data") return executeMsfileRequestUnsafe(request, actualClientId, controller);
      const operation = request.kind === "msfile.control"
        ? (ports.control.mutates(request.control) ? "write" : "read")
        : "read";
      try {
        return await ports.io.run(
          operation,
          controller.signal,
          () => executeMsfileRequestUnsafe(request, actualClientId, controller),
          {
            allowLocalLock: true,
            allowLocalOwnerTransition: true,
            auditOperation: "msfile.control",
            // settings.get 等控制面读取只读取 Coordinator 自有状态，不会
            // 触发供应商/支付副作用；真正的配置变更仍登记内存 write lease。
            durableLease: operation === "write",
          },
        );
      } catch (error) {
        // 请求可能在等待内存 I/O lease 时经历 lock → unlock；此时旧 gate
        // 会先被撤销，不能把“旧 epoch 已失效”冒泡成未处理异常。
        if (request.kind === "msfile.control" && request.expectedSessionEpoch !== ports.session().sessionEpoch) {
          return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
        }
        const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;
        return {
          requestId: request.requestId,
          sessionEpoch: ports.session().sessionEpoch,
          ack: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            ...(code ? { code: code as never } : {}),
          },
        };
      }
    } finally {
      requestSignal?.removeEventListener("abort", abort);
      if (msfileRequests.get(requestKey)?.controller === controller) msfileRequests.delete(requestKey);
    }
  }

  async function executeMsfileRequestUnsafe(
    request: Extract<CoordinatorClientRequest, { kind: "msfile.grant" | "msfile.control" | "msfile.data" | "msfile.cancel" | "msfile.session.abort" }>,
    actualClientId: string,
    requestController?: AbortController,
  ): Promise<CoordinatorResponse> {
    // 审查修复：msfile 通道在通用 FIFO 的 epoch 栅栏之前分流，因此自带栅栏。
    // session.abort / cancel 是纯本地清理，永远放行且不重建 runtime。
    if (
      request.kind !== "msfile.cancel" &&
      request.kind !== "msfile.session.abort" &&
      "expectedSessionEpoch" in request &&
      request.expectedSessionEpoch !== ports.session().sessionEpoch
    ) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (request.kind === "msfile.session.abort") {
      for (const [requestId, pending] of msfileRequests) {
        if (pending.walletPublicKeyHex === request.walletPublicKeyHex) { pending.controller.abort(); msfileRequests.delete(requestId); }
      }
      ports.identity.cancelClient(actualClientId);
      for (const [grantId, grant] of msfileGrants) {
        if (grant.context.walletPublicKeyHex === request.walletPublicKeyHex) msfileGrants.delete(grantId);
      }
      // 仅当 runtime 已存在（解锁期创建）时才取消其内部未决确认；绝不重建。
      if (ports.session().vaultStatus === "unlocked" && ports.runtime.current()) {
        await ports.runtime.current()!.abortSession(request.walletPublicKeyHex);
        ports.changed();
      }
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
    }
    if (!ports.available()) {
      return ports.blocked(request.requestId);
    }
    // grant/control/data 都要求 Vault unlocked + active key runtime 可用。
    if (ports.session().vaultStatus !== "unlocked") {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "locked" } };
    }
    if (request.kind === "msfile.grant") {
      const session = await ports.appSession(request.context, request.context.transportOrigin);
      // 审查修复：session 查询是异步的——返回后复核请求 epoch 与 Vault 状态，
      // 跨越 lock/unlock / key switch 的 grant 不得绑定到新会话。
      if (request.expectedSessionEpoch !== ports.session().sessionEpoch || ports.session().vaultStatus !== "unlocked") {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
      }
      if (!session || !sameNetworkIdentity(session.networkIdentity, request.context) || session.origin !== request.context.transportOrigin || JSON.stringify(session.appIdentity) !== JSON.stringify(request.context.appIdentity)) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "MSFile session is invalid or revoked", code: "msfile_identity_required" } };
      }
      // grant 绑定前验证 session owner 与实际付款/签名 runtime 的 owner 一致：
      // wire Read 以 active key 身份购买，owner 错位即身份错位。
      if (!ports.session().activePublicKeyHex || session.ownerPublicKeyHex !== ports.session().activePublicKeyHex) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "MSFile session owner does not match the active runtime owner", code: "msfile_identity_required" } };
      }
      const grantId = `msfile-grant-${crypto.randomUUID()}`;
      msfileGrants.set(grantId, { context: { ...session.networkIdentity, walletPublicKeyHex: session.ownerPublicKeyHex, transportOrigin: session.origin, ownerPublicKeyHex: session.ownerPublicKeyHex, appIdentity: session.appIdentity }, clientId: actualClientId, sessionEpoch: ports.session().sessionEpoch });
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: grantId };
    }
    if (request.kind === "msfile.cancel") {
      const target = msfileRequests.get(msfileRequestKey(actualClientId, request.targetRequestId));
      if (target?.clientId === actualClientId) target.controller.abort();
      ports.identity.cancel(actualClientId, request.targetRequestId);
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
    }
    const controller = requestController ?? new AbortController();
    try {
      if (request.kind === "msfile.control") return await ports.control.execute(request, controller.signal);
      return await executeMsfileData(request, controller, actualClientId);
    } catch (err) {
      // 物理操作可能在 lock → unlock 期间因为旧 controller 被 abort。
      // 这不是普通的 Provider 失败：请求携带的 epoch 已经失效，必须向调用方
      // 返回明确的 stale-epoch，不能把会话栅栏降级成通用 error。
      if (request.kind === "msfile.control" && request.expectedSessionEpoch !== ports.session().sessionEpoch) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "stale-epoch" } };
      }
      const code = (err as { code?: string })?.code;
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code: code as never } : {}) } };
    }
  }
  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: `msfile.${string}` }>>({
    kinds: ["msfile.grant", "msfile.control", "msfile.data", "msfile.cancel", "msfile.session.abort"],
    policy: request => ({ scheduling: "parallel", validateEpoch: false, cleanupOnly: request.kind === "msfile.cancel" || request.kind === "msfile.session.abort" }),
    execute: (request, call) => executeMsfileRequest(request, call.peerId, call.signal),
  });
  return {
    route,
    msfileRequests,
    msfileRequestKey,
    msfileGrants,
    msfileDataQueue,
    pumpMsfileDataWaiters,
    withMsfileDataSlot,
    rejectMsfileDataWaiters,
    resolveMsfileGrant,
    msfileError,
    executeMsfileData,
    executeMsfileDataUnsafe,
    executeMsfileRequest,
    executeMsfileRequestUnsafe,
  };
}
