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
import type { MsFileRepository } from "./storage/msfileRepository.js";
import { createMsFileService, MsFileServiceImpl, type MsFileServiceImplDeps, type MsFileServiceEventState } from "./msfileService.js";
import { createUnavailableMsFileTransport, type MsFileTransport } from "./msfileTransport.js";

export { openMsFileRepository, sanitizeAppOverride, type MsFileRepositoryStores } from "./storage/msfileRepository.js";
export {
  createMsFileService,
  MsFileServiceImpl,
  MSFILE_READ_SIZE_LIMITS,
  type MsFileServiceImplDeps,
  type MsFileServiceEventState,
} from "./msfileService.js";
export { createUnavailableMsFileTransport, type MsFileTransport } from "./msfileTransport.js";
export { createMsFileLocalContentSource, type MsFileLocalContentSource } from "./bitfs/localContentSource.js";
export { createBitfsVaultSigner, bitfsWorkflowFacts, mapBitfsErrorCode } from "./bitfs/sdk.js";
export { createBitfsJournal, type BitfsJournal, type BitfsJournalRecord } from "./bitfs/journal.js";
export {
  createBitfsSessionJournal,
  type BitfsSessionJournal,
  type BitfsSessionRecord,
  type BitfsBuyerPhase,
  type BitfsSellerPhase,
  type BitfsEvidenceName,
} from "./bitfs/sessionJournal.js";
export {
  BitfsTransactionBroadcaster,
  createBitfsTransactionJournal,
  type BitfsBroadcastOutcome,
  type BitfsChainPort,
  type BitfsTransactionJournal,
  type BitfsTransactionRecord,
  type BitfsTransactionState,
} from "./bitfs/broadcast.js";
export { createBitfsWocChainPort, reconcileBitfsTransactions, reconcileBitfsSessionTransactions, readBitfsPoolSpendChain } from "./bitfs/wocChain.js";
export { BitfsSeedIndex, BITFS_SEED_INDEX_PAGE_SIZE, BITFS_SEED_INDEX_VERIFY_CONCURRENCY, type BitfsSeedIndexEntry } from "./bitfs/seedIndex.js";
export { BitfsSellerRuntime, type BitfsSellerMatch, type BitfsSellerRuntimeDeps } from "./bitfs/sellerRuntime.js";
export {
  BitfsSellerProtocol,
  createUnavailableBitfsSellerContentResolver,
  type BitfsSellerContentResolver,
  type BitfsSellerContentResolution,
  type BitfsSellerProtocolDeps,
} from "./bitfs/sellerProtocol.js";
export {
  BitfsSellerSessionManager,
  createUnavailableBitfsSellerProtocolPort,
  type BitfsSellerProtocolPort,
  type BitfsSellerProtocolResult,
  type BitfsSellerSessionCloseReason,
  type BitfsSellerSessionManagerDeps,
  type BitfsSellerStreamTransport,
} from "./bitfs/sellerSession.js";
export type { BitfsStreamEvent } from "./bitfs/sellerStreamRuntime.js";
// 内容存储只暴露 Worker-safe 的读写原语；买方写入和索引检查共用同一布局。
export {
  serializeMsFileSeedMeta,
  storeMsFileSeed,
  commitPurchasedMsFileContent,
  type MsFileSeedMeta,
  type MsFileSeedSource,
} from "./storage/msfileSeedStore.js";
export { createWindowP2pMsFileTransport, type MsFileP2pLaneOperation } from "./executorTransport.js";
export type { WindowP2pExecutorBridge, WindowP2pExecutorOperation } from "@keymaster/plugin-window-p2p/executor-transport";
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
    mediaBlockReadConcurrency: state.mediaBlockReadConcurrency,
    globalSeedReadConcurrency: state.globalSeedReadConcurrency,
    globalBlockReadConcurrency: state.globalBlockReadConcurrency,
    globalStatConcurrency: state.globalStatConcurrency,
    sellerSettings: state.sellerSettings,
    sellerRuntimeStatus: state.sellerRuntimeStatus,
    pendingApprovals
  };
}

/**
 * 打开 K-V 并创建服务。`transport` 由 apps/web 注入：
 * 生产 Runtime 就绪前返回 unavailable 实现；之后返回 Window executor proxy。
 */
export async function startMsFileRuntime(options: {
  sessionEpoch: SessionEpoch;
  transport?: MsFileTransport;
  notify: (event: CoordinatorMsFileStateEvent) => void;
  revisionProvider: () => number;
  repository: MsFileRepository;
}): Promise<MsFileServiceImpl> {
  const deps: MsFileServiceImplDeps = {
    repository: options.repository,
    transport: options.transport ?? createUnavailableMsFileTransport(),
    notifyStateChange: (state) => {
      options.notify(buildMsFileStateEvent(state, options.revisionProvider(), options.sessionEpoch));
    }
  };
  return createMsFileService(deps);
}
