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

  function identity() {
    const value = coordinator.getBootstrapSnapshot();
    const key = value.activeKeyIdentity;
    if (value.vaultStatus !== "unlocked" || !key || !value.walletGeneration) throw new Error("MSFile 下载需要已解锁的钱包");
    const identity = `${value.sessionEpoch}:${value.runGeneration}:${value.walletGeneration}`;
    if (identityKey !== identity) {
      identityKey = identity;
      generation = Math.max(Date.now(), generation + 1);
    }
    return { owner: key.publicKeyHex.toLowerCase(), network: key.bsvNetwork, generation };
  }

  async function wallet<T>(seed: string, signal: AbortSignal, operation: CoordinatorBitfsBuyerWalletOperation): Promise<T> {
    signal.throwIfAborted();
    const result = await coordinator.msfileControl({ type: "bitfs.buyer.wallet", seedHashHex: seed, operation }, signal);
    signal.throwIfAborted();
    if (result.status !== "ok") throw Object.assign(new Error("message" in result ? result.message : "BitFS 钱包操作失败"),
      { code: "code" in result ? result.code : undefined });
    return result.value as T;
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
    onError: (seedHashHex, error) => traceDev("keymaster.bitfs.buyer-window", "download.failed", () => ({ seedHashHex, error })),
  });

  async function readOther(seed: string, snapshot: BitfsBuyerSnapshot): Promise<MsFileBitfsDemandSnapshot> {
    if (!isValidMsFileHashHex(seed)) throw new Error("BitFS Seed Hash 无效");
    const current = identity();
    const locks = await navigator.locks?.query();
    const held = locks?.held?.some(lock => lock.name === bitfsDownloadLockName(current.owner, seed)) === true;
    const tasks = createBitfsPurchaseTasks(journal, current.owner, seed);
    const rows = await tasks.list();
    const active = rows.find(task => task.state === "active");
    const latest = rows.at(-1);
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
      existingPurchaseSessionId: active?.taskId ?? null, downloadReadOnly: held, interrupted: !held && Boolean(active || intent || partial),
      purchase: purchase && progress ? {
        sessionId: purchase.sessionId, phase: held ? "requesting-blocks" : "connection-closed",
        openingAmountSatoshis: null, verifiedBlockCount: progress.completedBlockCount,
        totalBlockCount: progress.totalBlockCount, message: held ? "正在下载" : "下载已中断，已保留本地记录",
      } : snapshot.purchase,
    };
  }

  async function show(snapshot: BitfsBuyerSnapshot): Promise<MsFileBitfsDemandSnapshot> {
    return snapshot.requestMessageId ? snapshot : readOther(snapshot.seedHashHex, snapshot);
  }

  return {
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
      return buyer.onTransportEvent(event);
    },
    publishBitfsDemand: async (seed: string) => show(await buyer.download(seed)),
    resumeBitfsDownload: async (seed: string) => show(await buyer.resume(seed)),
    deleteBitfsDownload: buyer.deleteDownload,
    getBitfsDemand: async (seed: string) => show(await buyer.getDownload(seed)),
    startBitfsPurchase: async (seed: string, sessionId: string, max?: string) => show(await buyer.startPurchase(seed, sessionId, max)),
    cancelBitfsDemand: buyer.withdrawDemand,
    cancelBitfsPurchase: async (seed: string) => show(await buyer.stop(seed)),
    stop: buyer.close,
  };
}

export type BitfsBuyerWindowRuntime = ReturnType<typeof createBitfsBuyerWindowRuntime>;
