import type {
  BorrowedModuleFileStore, CoordinatorBitfsBuyerWalletOperation, MsFileBitfsDemandSnapshot, MsFileCoordinatorControl,
} from "@keymaster/contracts";
import { isValidMsFileHashHex, traceDev } from "@keymaster/contracts";
import { hexToBytes } from "bitcoin-libp2p/identity";
import {
  createBitfsBuyer, createBitfsBuyerDownloadPlan, createBitfsSessionJournal, downloadIntentPath,
  type BitfsBuyerFunding, type BitfsBuyerSnapshot, type BitfsBuyerTransportEvent,
} from "keymaster-bitfs";
import type { MsFileP2pLaneOperation } from "../executorTransport.js";
import type { MsFileServiceProxy } from "../msfileServiceProxy.js";
import { commitPurchasedMsFileContent } from "../storage/msfileSeedStore.js";
import type { BitfsArbitrationInfo } from "./arbitrationClient.js";
import { arbitrationFeeForItems } from "./arbitrationFees.js";
import { bitfsDownloadLockName, tryBitfsDownloadLock } from "./buyerDownloadLock.js";
import { createMsFileLocalContentSource } from "./localContentSource.js";
import { createBitfsPurchaseTasks } from "./purchaseTasks.js";
import { readSchedulerTaskState, schedulerTaskFields } from "./schedulerHost/taskState.js";

type Offer = Extract<MsFileP2pLaneOperation, { type: "bitfs-webrtc-buyer-offer" }>;
type WireEvent = { type?: string; sessionId?: unknown; frame?: unknown; bytesIn?: unknown; reason?: unknown };

export function createBitfsBuyerWindowRuntime(options: {
  coordinator: MsFileCoordinatorControl;
  service: MsFileServiceProxy;
  content: BorrowedModuleFileStore;
  journal: BorrowedModuleFileStore;
  lifecycle: AbortSignal;
  lane(operation: MsFileP2pLaneOperation, signal: AbortSignal): Promise<unknown>;
}) {
  const { coordinator, service, content, journal, lifecycle, lane } = options;
  const journalSessions = createBitfsSessionJournal(journal);
  const localSource = createMsFileLocalContentSource(content);
  let identityKey: string | undefined;
  let generation = Date.now();
  const failures = new Map<string, NonNullable<MsFileBitfsDemandSnapshot["failure"]>>();

  function identity() {
    const value = coordinator.getBootstrapSnapshot();
    const key = value.activeKeyIdentity;
    if (value.vaultStatus !== "unlocked" || !key || !value.walletGeneration) throw new Error("MSFile 下载需要已解锁的钱包");
    const identity = `${value.sessionEpoch}:${value.runGeneration}:${value.walletGeneration}`;
    if (identityKey !== identity) {
      identityKey = identity;
      failures.clear();
      generation = Math.max(Date.now(), generation + 1);
    }
    return { owner: key.publicKeyHex.toLowerCase(), network: key.bsvNetwork, generation };
  }

  async function wallet<T>(seed: string, signal: AbortSignal, operation: CoordinatorBitfsBuyerWalletOperation): Promise<T> {
    signal.throwIfAborted();
    traceDev("keymaster.bitfs.buyer-window", "wallet.start", () => ({
      seedHashHex: seed, operation: operation.type,
      sessionId: "sessionId" in operation ? operation.sessionId : undefined,
    }));
    try {
      const result = await coordinator.msfileControl({ type: "bitfs.buyer.wallet", seedHashHex: seed, operation }, signal);
      signal.throwIfAborted();
      traceDev("keymaster.bitfs.buyer-window", "wallet.finish", () => ({
        seedHashHex: seed, operation: operation.type,
        sessionId: "sessionId" in operation ? operation.sessionId : undefined,
        status: result.status,
      }));
      if (result.status !== "ok") throw Object.assign(new Error("message" in result ? result.message : "BitFS 钱包操作失败"),
        { code: "code" in result ? result.code : undefined });
      return result.value as T;
    } catch (error) {
      traceDev("keymaster.bitfs.buyer-window", "wallet.failed", () => ({
        seedHashHex: seed, operation: operation.type,
        sessionId: "sessionId" in operation ? operation.sessionId : undefined,
        aborted: signal.aborted, error,
      }));
      throw error;
    }
  }

  const bytes = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
  const buyer = createBitfsBuyer({
    identity, content, journal, lifecycle,
    settings: async () => ({ ...await service.getBitfsBuyerSettings(), schedulerRequestTimeoutMs: 5_000 }),
    signer(seed, taskSignal) {
      const publicKey = hexToBytes(identity().owner);
      return {
        publicKey: () => publicKey.slice(),
        async sign(request, signal = taskSignal) {
          const signature = await wallet<ArrayBuffer>(seed, signal, {
            type: "sign", digest: bytes(request.digest), kind: request.wireKind,
            ...(request.purpose === "wire_message" && request.documentCBOR ? { document: bytes(request.documentCBOR) } : {}),
          });
          return new Uint8Array(signature);
        },
      };
    },
    funding(seed, signal): BitfsBuyerFunding {
      return {
        async prepareOpening(input) {
          return new Uint8Array(await wallet<ArrayBuffer>(seed, signal, {
            type: "prepare-opening", ...input, minerFeeRateSatoshisPerKilobyte: input.minerFeeRateSatoshisPerKilobyte.toString(),
          }));
        },
        async acceptOpeningResponse(input) {
          await wallet(seed, signal, { type: "accept-opening", sessionId: input.sessionId, response: bytes(input.rawKind3) });
        },
        async submitOrReconcileFunding(sessionId) {
          const result = await wallet<{ outcome: Awaited<ReturnType<BitfsBuyerFunding["submitOrReconcileFunding"]>>["outcome"]; kind4?: ArrayBuffer }>(
            seed, signal, { type: "fund-opening", sessionId });
          return { outcome: result.outcome, ...(result.kind4 ? { kind4: new Uint8Array(result.kind4) } : {}) };
        },
        submitOrReconcilePoolRecovery: sessionId => wallet(seed, signal, { type: "settle-close", sessionId }),
        async cancelUnfundedOpening(sessionId) { await wallet(seed, signal, { type: "cancel-opening", sessionId }); },
      };
    },
    tryLock(key) {
      const download = /^bitfs:download:([^:]+):(?:main|test):([^:]+)$/u.exec(key);
      return tryBitfsDownloadLock(download ? bitfsDownloadLockName(download[1]!, download[2]!) : key);
    },
    // Coordinator admits the offer to this page only after authenticating its request ID.
    acceptOfferBeforePublishResult: true,
    async publishDemand(seedHashHex, signal, onPrepared) {
      const result = await coordinator.msfileControl({ type: "bitfs.demand.publish", seedHashHex }, signal);
      if (result.status !== "ok") throw new Error("message" in result ? result.message : "发布 BitFS 需求失败");
      const demand = result.value as MsFileBitfsDemandSnapshot;
      if (!demand.requestMessageId || demand.expiresAtMs === null) throw new Error("BitFS 需求缺少编号或有效期");
      onPrepared(demand.requestMessageId);
      return { requestMessageId: demand.requestMessageId, expiresAtMs: demand.expiresAtMs };
    },
    withdrawDemand: (seedHashHex, requestMessageId) =>
      coordinator.msfileControl({ type: "bitfs.demand.cancel", seedHashHex, requestMessageId }),
    arbitrationServices: async () => (await service.getSettingsSnapshot()).arbitrationServices,
    async arbitrationPrices(arbiter, signal) {
      const info = await lane({ type: "bitfs-arbitration-info", endpoint: arbiter }, signal) as BitfsArbitrationInfo;
      return { base: (arbitrationFeeForItems(info, 1) - BigInt(info.perItemSat)).toString(), perItem: String(info.perItemSat) };
    },
    async blockHeight() {
      const snapshot = coordinator.getChainHeightSnapshot();
      traceDev("keymaster.bitfs.buyer-window", "blockHeight.read", () => ({
        network: identity().network, available: snapshot.available,
        snapshotNetwork: snapshot.network, height: snapshot.height,
      }));
      if (!snapshot.available || snapshot.network !== identity().network || snapshot.height === undefined) throw new Error("链高度尚未同步");
      return snapshot.height;
    },
    feeRate: () => BigInt(coordinator.getChainFeeSnapshots()[identity().network].effectiveSatoshisPerKb),
    async commit(verified, signal) {
      const { seedHashHex, sessionId, blockHashes, manifest } = verified;
      const details = () => ({ seedHashHex, sessionId, blockCount: blockHashes.length, fileSizeBytes: manifest.fileSizeBytes });
      traceDev("keymaster.bitfs.buyer-window", "store.start", details);
      await commitPurchasedMsFileContent({
        store: content, seedHashHex, seedBytes: verified.seedBytes,
        fileName: manifest.recommendedFilename, mediaType: manifest.mediaType ?? "application/octet-stream", signal,
        readBlock: (_index, hash) => verified.readBlock(hash),
      });
      traceDev("keymaster.bitfs.buyer-window", "store.finish", details);
      void coordinator.msfileControl({ type: "bitfs.file.stored", seedHashHex })
        .then(result => traceDev("keymaster.bitfs.buyer-window", "storage-notify", () => ({ seedHashHex, sessionId, status: result.status })))
        .catch(error => traceDev("keymaster.bitfs.buyer-window", "storage-notify.failed", () => ({ seedHashHex, sessionId, error })));
    },
    onStopped: (seedHashHex, committed) => traceDev("keymaster.bitfs.buyer-window", "download.stopped", () => ({ seedHashHex, committed })),
    onError(seed, error) {
      traceDev("keymaster.bitfs.buyer-window", "download.failed", () => ({ seedHashHex: seed, error }));
      const code = (error as { code?: string } | undefined)?.code;
      failures.set(seed, code === "insufficient-funds" || code === "funding-unknown" ? code : "purchase-interrupted");
      if (failures.size > 64) failures.delete(failures.keys().next().value!);
    },
  });

  async function readOther(seed: string, snapshot: BitfsBuyerSnapshot, taskId?: string): Promise<MsFileBitfsDemandSnapshot> {
    if (!isValidMsFileHashHex(seed)) throw new Error("BitFS Seed Hash 无效");
    const current = identity();
    const locks = await navigator.locks?.query();
    const tasks = createBitfsPurchaseTasks(journal, current.owner, seed);
    const rows = await tasks.list();
    const active = rows.find(task => task.state === "active" && (!taskId || task.taskId === taskId));
    const latest = taskId ? rows.find(task => task.taskId === taskId) : rows.at(-1);
    const held = (!taskId || active !== undefined) && locks?.held?.some(lock => lock.name === bitfsDownloadLockName(current.owner, seed)) === true;
    // 下载运行时在任务结束后撤掉报价。完成状态来自持久任务和当前本地内容。
    if (!held && !active && latest?.state === "ended" && latest.endReason === "completed") {
      const localFile = await localSource.stat(seed, lifecycle);
      traceDev("keymaster.bitfs.buyer-window", "completion.read", () => ({
        seedHashHex: seed, taskId: latest.taskId, localStatus: localFile?.status ?? "absent",
      }));
      if (localFile) {
        return { ...snapshot, completedPurchase: { taskId: latest.taskId, localFile } };
      }
    }
    const intent = await journal.get(downloadIntentPath(seed));
    const partial = Boolean(!held && rows.some(task => task.state === "ended" && task.endReason !== "completed")
      && (await content.list({ prefix: `bitfs-staging/by-seed/${seed}/`, limit: 1 })).files.length);
    const purchase = active ? await journalSessions.get(active.sessionIds.at(-1) ?? active.taskId) : undefined;
    const progress = purchase && await journalSessions.getEvidence(purchase.sessionId, "purchase-manifest")
      ? await createBitfsBuyerDownloadPlan({ ownerPublicKeyHex: current.owner, seedHashHex: seed,
        taskId: active?.legacyPlan ? undefined : active?.taskId, fileSizeBytes: "0", recommendedFilename: seed, store: journal }).snapshot()
      : undefined;
    return {
      seedHashHex: seed, requestMessageId: null, expiresAtMs: null, quotes: [], currentMaxFullBlockPriceSatoshis: null,
      existingPurchaseSessionId: active?.taskId ?? null,
      taskId: active?.taskId ?? (held ? undefined : latest?.taskId),
      taskEndReason: !active && !held ? latest?.endReason : undefined,
      downloadReadOnly: held, interrupted: !held && Boolean(active || intent || partial),
      purchase: purchase && progress ? {
        sessionId: purchase.sessionId, phase: held ? "requesting-blocks" : "connection-closed",
        openingAmountSatoshis: null, verifiedBlockCount: progress.completedBlockCount,
        totalBlockCount: progress.totalBlockCount, message: held ? "正在下载" : "下载已中断，已保留本地记录",
      } : taskId && taskId !== snapshot.existingPurchaseSessionId ? undefined : snapshot.purchase,
    };
  }

  async function show(snapshot: BitfsBuyerSnapshot, requestedTaskId?: string): Promise<MsFileBitfsDemandSnapshot> {
    const result: MsFileBitfsDemandSnapshot = snapshot.requestMessageId && (!requestedTaskId || requestedTaskId === snapshot.existingPurchaseSessionId)
      ? snapshot : await readOther(snapshot.seedHashHex, snapshot, requestedTaskId);
    const current = identity();
    if (!requestedTaskId && result.requestMessageId && !result.existingPurchaseSessionId) {
      const previous = (await createBitfsPurchaseTasks(journal, current.owner, snapshot.seedHashHex).list())
        .find(task => task.state === "active");
      if (previous) return { ...result, taskId: previous.taskId };
    }
    const taskId = result.taskId ?? result.existingPurchaseSessionId ?? result.completedPurchase?.taskId;
    if (!taskId) return result;
    traceDev("keymaster.bitfs.buyer-window", "scheduler.read.start", () => ({
      seedHashHex: result.seedHashHex, taskId, network: current.network,
    }));
    const saved = await readSchedulerTaskState({ store: journal, ownerPublicKeyHex: current.owner, network: current.network, taskId })
      .catch(error => {
        traceDev("keymaster.bitfs.buyer-window", "scheduler.read.failed", () => ({
          seedHashHex: result.seedHashHex, taskId, network: current.network, error,
        }));
        throw error;
      });
    if (!saved) return { ...result, taskId };
    traceDev("keymaster.bitfs.buyer-window", "scheduler.read.finish", () => ({
      seedHashHex: result.seedHashHex, taskId, revision: saved.revision,
      execution: saved.intent, pools: Object.keys(saved.pools).length,
      requests: Object.keys(saved.requests).length, failure: saved.failure,
    }));
    return { ...result, taskId, funds: schedulerTaskFields(saved).schedulerState?.funds, ...(saved.failure ? { failure: "insufficient-funds" } : {}) };
  }

  return {
    readPlaybackRange: buyer.readPlaybackRange,
    setDownloadPrice: buyer.setDownloadPrice,
    registerOffer(offer: Offer): AbortSignal | undefined {
      return buyer.registerOffer({
        ...offer,
        async send(frame, signal) { await lane({ type: "bitfs-seller-send", sessionId: offer.sessionId, frame }, signal); },
        async close() { await lane({ type: "bitfs-seller-close", sessionId: offer.sessionId, reason: "buyer_stopped" }, lifecycle); },
      });
    },
    onTransportEvent(raw: unknown): Promise<boolean> {
      const input = raw as WireEvent;
      if (typeof input.sessionId !== "string") return Promise.resolve(false);
      const { sessionId } = input;
      traceDev("keymaster.bitfs.buyer-window", "transport.event.start", () => ({
        sessionId, inputType: input.type,
        frameBytes: input.frame instanceof Uint8Array ? input.frame.byteLength : undefined,
        bytesIn: input.bytesIn, reason: input.reason,
      }));
      let event: BitfsBuyerTransportEvent;
      if (input.type === "bitfs-webrtc-frame" && input.frame instanceof Uint8Array) {
        event = { type: "frame", sessionId, frame: input.frame };
      } else if (input.type === "bitfs-webrtc-meter" && typeof input.bytesIn === "number") {
        event = { type: "progress", sessionId, bytesIn: input.bytesIn };
      } else if (input.type === "bitfs-webrtc-session-closed") {
        traceDev("keymaster.bitfs.buyer-window", "transport.closed", () => ({ sessionId,
          reason: typeof input.reason === "string" ? input.reason : undefined }));
        event = { type: "closed", sessionId };
      } else {
        return Promise.resolve(false);
      }
      return buyer.onTransportEvent(event).then(accepted => {
        traceDev("keymaster.bitfs.buyer-window", "transport.event.finish", () => ({
          sessionId, eventType: event.type, accepted,
        }));
        return accepted;
      }).catch(error => {
        traceDev("keymaster.bitfs.buyer-window", "transport.event.failed", () => ({
          sessionId, eventType: event.type, error,
        }));
        throw error;
      });
    },
    publishBitfsDemand: async (seed: string, manualPurchase = false) => {
      failures.delete(seed);
      return show(await buyer.download(seed, manualPurchase));
    },
    resumeBitfsDownload: async (seed: string) => {
      failures.delete(seed);
      return show(await buyer.resume(seed));
    },
    deleteBitfsDownload: buyer.deleteDownload,
    getBitfsDemand: async (seed: string, taskId?: string) => {
      const observed = await buyer.getDownload(seed);
      const snapshot = await show(observed, taskId);
      const failure = !taskId || taskId === observed.existingPurchaseSessionId ? failures.get(seed) : undefined;
      return failure ? { ...snapshot, failure } : snapshot;
    },
    startBitfsPurchase: async (seed: string, sessionId: string, max?: string, requireNew?: boolean) =>
      show(await buyer.startPurchase(seed, sessionId, max, requireNew)),
    cancelBitfsDemand: buyer.withdrawDemand,
    cancelBitfsPurchase: async (seed: string) => show(await buyer.stop(seed)),
    stop: buyer.close,
  };
}

export type BitfsBuyerWindowRuntime = ReturnType<typeof createBitfsBuyerWindowRuntime>;
