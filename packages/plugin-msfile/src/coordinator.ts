// packages/plugin-msfile/src/coordinator.ts
// Worker-safe MSFile runtime exports。Coordinator SharedWorker 只从本入口导入，
// 保持 page manifest 与 React 设置 UI 不进入 Worker bundle。
//
// Coordinator 只装载无 libp2p 的 transport proxy；真实 host 永远位于 Window
// executor（见 ./windowExecutor.ts），因此 SharedWorker 不会触碰 RTCPeerConnection。

import type {
  CoordinatorMsFileStateEvent,
  SessionEpoch,
} from "@keymaster/contracts";
import { openMsFileDb, type MsFileDb } from "./msfileDb.js";
import { createMsFileService, MsFileServiceImpl, type MsFileServiceImplDeps, type MsFileServiceEventState } from "./msfileService.js";
import { createUnavailableMsFileTransport, type MsFileTransport } from "./msfileTransport.js";

export { openMsFileDb, MSFILE_DB_NAME, MSFILE_DB_VERSION, sanitizeAppOverride } from "./msfileDb.js";
export {
  createMsFileService,
  MsFileServiceImpl,
  MSFILE_READ_SIZE_LIMITS,
  type MsFileServiceImplDeps,
  type MsFileServiceEventState,
} from "./msfileService.js";
export { createUnavailableMsFileTransport, type MsFileTransport } from "./msfileTransport.js";
export { createMsFileExecutorTransport, type MsFileExecutorBridge, type MsFileExecutorOperation } from "./executorTransport.js";
// 注意：supplierConfig（multiaddr/libp2p 依赖）不在此静态导出，
// 保持 Worker 初始模块图轻量；页面设置组件直接 import "./supplierConfig.js"。
export { validateSeedContent, validateBlockContent, expectedSeedLength } from "./contentValidation.js";
export {
  FrameDecoder,
  RequestIdCounter,
  encodeReadRequest,
  encodeStatRequest,
  WireCodecError,
  DEFAULT_FRAME_LIMITS,
} from "./frameCodec.js";
export { ReadStreamSession, StatResponseTable, type ReadOutcome } from "./readStream.js";
export { StatStreamSession, type StatStreamOutcome } from "./statStream.js";
export { startReceiveLoop, FrameWriter, type WireDuplex } from "./wireStream.js";

/** 构造发布到 `msfile.state` topic 的状态事件。 */
export function buildMsFileStateEvent(
  state: MsFileServiceEventState,
  msfileRevision: number,
  sessionEpoch: SessionEpoch
): CoordinatorMsFileStateEvent {
  const pendingApprovals = state.pendingApprovals;
  return {
    topic: "msfile.state",
    type: "msfile.state.changed",
    msfileRevision,
    sessionEpoch,
    status: state.status,
    supplierGeneration: state.supplierGeneration,
    globalSettings: state.globalSettings,
    mediaPlaybackPrefetchBlocks: state.mediaPlaybackPrefetchBlocks,
    pendingApprovals
  };
}

/**
 * 打开 DB 并创建服务。`transport` 由 apps/web 注入：
 * 生产 Runtime 就绪前返回 unavailable 实现；之后返回 Window executor proxy。
 */
export async function startMsFileRuntime(options: {
  sessionEpoch: SessionEpoch;
  transport?: MsFileTransport;
  notify: (event: CoordinatorMsFileStateEvent) => void;
  revisionProvider: () => number;
  db?: MsFileDb;
}): Promise<MsFileServiceImpl> {
  const deps: MsFileServiceImplDeps = {
    db: options.db ?? (await openMsFileDb()),
    transport: options.transport ?? createUnavailableMsFileTransport(),
    notifyStateChange: (state) => {
      options.notify(buildMsFileStateEvent(state, options.revisionProvider(), options.sessionEpoch));
    }
  };
  return createMsFileService(deps);
}
