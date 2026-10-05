import type { CoordinatorClientRequest, CoordinatorMsFileData, CoordinatorResponse, MsFileConnectAppContext, MsFileService, SessionEpoch } from "@keymaster/contracts";
export interface MsfileDataExecutorDependencies {
  runtime(): Promise<MsFileService>;
  sessionEpoch(): SessionEpoch;
  resolveGrant(id: string, clientId: string, epoch: SessionEpoch): Promise<{ context: MsFileConnectAppContext; connectSessionId: string }>;
  unavailable(message: string): Error;
}
/** Domain operations run inside the trusted assembly's final I/O lease. */
export function createMsfileDataExecutor(deps: MsfileDataExecutorDependencies) {
async function executeMsfileDataUnsafe(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.data" }>,
  controller: AbortController,
  actualClientId: string,
): Promise<CoordinatorResponse> {
  // 审查修复：以请求自身的 epoch 为栅栏（执行时现取会得到恒真比较）。
  const requestEpoch = request.expectedSessionEpoch;
  const service = await deps.runtime();
  const data: CoordinatorMsFileData = request.data;
  const signal = controller.signal;
  // 真正调用 service 前的执行栅栏：排队 / 授权解析期间的取消与世代切换。
  if (requestEpoch !== deps.sessionEpoch() || signal.aborted) {
    throw deps.unavailable("MSFile request was cancelled");
  }
  let value: unknown;
  if (data.grantId === undefined) {
    // 受信任内部插件路径：只使用全局额度；gateway 不参与。
    switch (data.type) {
      case "stat": value = await service.stat({ seedHashHex: data.seedHashHex, signal }); break;
      case "read-seed": value = await service.readSeed({ sourceId: data.sourceId, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.readBlock({ sourceId: data.sourceId, seedHashHex: data.seedHashHex, blockHashHex: data.blockHashHex, signal }); break;
    }
  } else {
    const { context } = await deps.resolveGrant(data.grantId, actualClientId, requestEpoch);
    // grant 解析是异步的：返回后再次确认未跨越会话栅栏。
    if (requestEpoch !== deps.sessionEpoch() || signal.aborted) {
      throw deps.unavailable("MSFile request was cancelled");
    }
    switch (data.type) {
      case "stat": value = await service.connect.stat(context, { seedHashHex: data.seedHashHex, signal }); break;
      case "read-seed": value = await service.connect.readSeed(context, { sourceId: data.sourceId, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.connect.readBlock(context, { sourceId: data.sourceId, seedHashHex: data.seedHashHex, blockHashHex: data.blockHashHex, signal }); break;
    }
  }
  if (controller.signal.aborted || requestEpoch !== deps.sessionEpoch()) {
    throw deps.unavailable("MSFile request was cancelled");
  }
  if (data.grantId !== undefined) await deps.resolveGrant(data.grantId, actualClientId, requestEpoch);
  if (controller.signal.aborted || requestEpoch !== deps.sessionEpoch()) throw deps.unavailable("MSFile request became stale");
  return { requestId: request.requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: value };
}

return executeMsfileDataUnsafe;
}
