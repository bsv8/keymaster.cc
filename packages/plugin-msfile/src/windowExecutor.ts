// MSFile 生产 Window executor。
//
// 此模块只能在页面 Window 装载：WebRTC Direct 需要 RTCPeerConnection，
// Coordinator SharedWorker 不会导入它。Window 不持有业务私钥；Host 使用
// KeymasterMsFileIdentitySigner，通过两个冻结的 TypedSigner RPC 回 Worker。

import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { authenticateConnection, createHost } from "bitcoin-libp2p/libp2p";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import {
  dialAuthenticatedWebRTCDirect,
  parseWebRTCDirectEndpoint,
  WebRTCDirectError,
} from "bitcoin-libp2p/webrtc-direct";
import type {
  MsFileSupplierConfig,
  MsFileSupplierProbeResult,
  MsFileSupplierStat,
} from "@keymaster/contracts";
import { MSFILE_PROTOCOL_ID } from "@keymaster/contracts";
import type { SessionCoordinatorClient } from "@keymaster/contracts";
import { KeymasterMsFileIdentitySigner } from "./executorIdentitySigner.js";
import { ReadStreamSession, type ReadOutcome } from "./readStream.js";
import { StatStreamSession, type StatStreamOutcome } from "./statStream.js";

type StreamChunk = Uint8Array | { subarray(begin?: number, end?: number): Uint8Array };
type StreamLike = {
  send(data: Uint8Array): boolean;
  onDrain(): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
};
type Connection = Parameters<typeof authenticateConnection>[0];
type Host = {
  dial(address: ReturnType<typeof multiaddr>, options?: { signal?: AbortSignal }): Promise<Connection>;
  stop(): void | Promise<void>;
};

const MAX_STAT_PENDING_PER_SUPPLIER = 16;
// Coordinator 冻结的生产预算是同一 supplier 4 Seed + 8 Block。这里若仍为
// 8，低负载会因小 Seed 提前结束而偶然通过，真实并发时后四路会被错误拒绝。
const MAX_READ_PENDING_PER_SUPPLIER = 12;

function asBytes(chunk: StreamChunk): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  return chunk.subarray();
}

function toDuplex(stream: StreamLike) {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    write: async (bytes: Uint8Array): Promise<void> => {
      if (!stream.send(bytes)) await stream.onDrain();
    },
    readChunk: async (): Promise<Uint8Array | null> => {
      const next = await iterator.next();
      return next.done ? null : asBytes(next.value);
    },
    close: () => stream.close(),
  };
}

function canonicalAmount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid max price");
  const amount = BigInt(value);
  if (amount > 0xffffffffffffffffn) throw new Error("max price exceeds uint64");
  return amount;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 256);
  return String(error).slice(0, 256);
}

function publicProbeErrorCode(error: unknown): string {
  if (error instanceof WebRTCDirectError) {
    // 公开给设置页的错误只能来自 SDK 稳定的 code/stage；不能依赖可变的
    // 英文 message。WSS 的底层错误没有 Direct SDK 语义，统一归为 dial_failed。
    if (error.stage === "authenticate" || error.code === "ERR_WEBRTC_DIRECT_PEER_ID" || error.code === "ERR_WEBRTC_DIRECT_AUTH") {
      return "identity_mismatch";
    }
    if (error.code === "ERR_WEBRTC_DIRECT_CERTHASH") return "tls_error";
    if (error.stage === "resolve" || error.code === "ERR_WEBRTC_DIRECT_RESOLVE") return "resolve_failed";
    if (error.code === "ERR_WEBRTC_DIRECT_TIMEOUT") return "timeout";
    if (error.stage === "validate" || error.code === "ERR_WEBRTC_DIRECT_ADDRESS") return "invalid_address";
  }
  return "dial_failed";
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface SupplierConnection {
  supplierPublicKeyHex: string;
  generation: number;
  connection: Connection;
  stat: StatStreamSession;
  read: ReadStreamSession;
  statStream: StreamLike;
  readStream: StreamLike;
}

/**
 * Host 内的多供应商 connection/stream owner。每个 supplier 最多保留一个
 * authenticated connection，并把 Stat/Read 分到两条独立的长驻 stream。
 */
export class MsFileSupplierRuntime {
  private readonly connections = new Map<string, SupplierConnection>();
  private readonly dialing = new Map<string, { promise: Promise<SupplierConnection>; controller: AbortController }>();
  private disposed = false;

  constructor(private readonly host: Host) {}

  async stat(input: { supplier: MsFileSupplierConfig; seedHashHex: string; supplierGeneration: number; signal?: AbortSignal }): Promise<MsFileSupplierStat> {
    const hash = hexToBytes(input.seedHashHex);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.ensureConnection(input.supplier, input.supplierGeneration, input.signal);
      if (!connection.stat.isUsable) {
        await this.drop(input.supplier.supplierPublicKeyHex, connection);
        continue;
      }
      const result: StatStreamOutcome = await connection.stat.send(hash, input.signal);
      if (result.type === "ok") return this.mapStat(input.supplier.supplierPublicKeyHex, result.payload);
      await this.drop(input.supplier.supplierPublicKeyHex, connection);
    }
    throw new Error("MSFile Stat stream failed");
  }

  async read(input: {
    supplier: MsFileSupplierConfig;
    kind: "seed" | "block";
    hashHex: string;
    maxPriceSatoshis: string;
    supplierGeneration: number;
    signal?: AbortSignal;
  }): Promise<ReadOutcome> {
    const hash = hexToBytes(input.hashHex);
    const maxContentBytes = input.kind === "seed" ? 16 * 1024 * 1024 : 256 * 1024;
    const amount = canonicalAmount(input.maxPriceSatoshis);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.ensureConnection(input.supplier, input.supplierGeneration, input.signal);
      if (!connection.read.isUsable) {
        await this.drop(input.supplier.supplierPublicKeyHex, connection);
        continue;
      }
      if (connection.read.pendingCount >= MAX_READ_PENDING_PER_SUPPLIER) throw new Error("MSFile Read limit exceeded");
      const result = await connection.read.send({ contentHashBytes: hash, maxPriceSatoshis: amount, maxContentBytes, signal: input.signal });
      if (result.type !== "transport-failed") return result;
      await this.drop(input.supplier.supplierPublicKeyHex, connection);
    }
    throw new Error("MSFile Read stream failed");
  }

  async probe(input: { supplier: MsFileSupplierConfig; supplierGeneration: number; signal?: AbortSignal }): Promise<MsFileSupplierProbeResult> {
    const startedAt = Date.now();
    const peerId = peerIdFromPublicKeyBytes(hexToBytes(input.supplier.supplierPublicKeyHex)).toString();
    const addresses: MsFileSupplierProbeResult["addresses"] = [];
    let connected = false;
    for (const address of input.supplier.addresses) {
      if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      try {
        const connection = await this.dialSupplierAddress(input.supplier, address, input.signal);
        connected = true;
        addresses.push({ address, ok: true });
        // Probe deliberately opens no MSFile stream and never performs a Read.
        // A normal data request will establish the two-role stream pair later.
        const existing = this.connections.get(input.supplier.supplierPublicKeyHex);
        if (existing && existing.connection !== connection) {
          await connection.close().catch(() => undefined);
        } else if (!existing) {
          await connection.close().catch(() => undefined);
        }
        break;
      } catch (error) {
        addresses.push({ address, ok: false, errorCode: publicProbeErrorCode(error) });
      }
    }
    return { supplierPublicKeyHex: input.supplier.supplierPublicKeyHex, peerId, connected, startedAt, durationMs: Date.now() - startedAt, addresses };
  }

  async invalidate(supplierPublicKeyHex: string | undefined): Promise<void> {
    if (supplierPublicKeyHex === undefined) {
      const flights = [...this.dialing.values()];
      for (const flight of flights) flight.controller.abort();
      const all = [...this.connections.values()];
      this.connections.clear();
      await Promise.all(all.map((entry) => this.closeConnection(entry)));
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return;
    }
    const flight = this.dialing.get(supplierPublicKeyHex);
    flight?.controller.abort();
    if (flight) await Promise.allSettled([flight.promise]);
    const entry = this.connections.get(supplierPublicKeyHex);
    if (!entry) return;
    this.connections.delete(supplierPublicKeyHex);
    await this.closeConnection(entry);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.invalidate(undefined);
  }

  private async ensureConnection(supplier: MsFileSupplierConfig, generation: number, signal?: AbortSignal): Promise<SupplierConnection> {
    if (this.disposed) throw new Error("MSFile executor is disposed");
    const current = this.connections.get(supplier.supplierPublicKeyHex);
    if (current?.generation === generation) return current;
    if (current) await this.drop(supplier.supplierPublicKeyHex, current);
    const existingDial = this.dialing.get(supplier.supplierPublicKeyHex);
    if (existingDial) return awaitWithAbort(existingDial.promise, signal);
    // A caller's AbortSignal only cancels that caller's wait. The shared dial
    // must not be poisoned for concurrent Stat/Read requests.
    const controller = new AbortController();
    const dial = this.dialSupplier(supplier, generation, controller.signal);
    this.dialing.set(supplier.supplierPublicKeyHex, { promise: dial, controller });
    try {
      return await awaitWithAbort(dial, signal);
    } finally {
      if (this.dialing.get(supplier.supplierPublicKeyHex)?.promise === dial) this.dialing.delete(supplier.supplierPublicKeyHex);
    }
  }

  private async dialSupplier(supplier: MsFileSupplierConfig, generation: number, signal?: AbortSignal): Promise<SupplierConnection> {
    const errors: string[] = [];
    for (const address of supplier.addresses) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      let connection: Connection | undefined;
      try {
        connection = await this.dialSupplierAddress(supplier, address, signal);
        return await this.installConnection(supplier, generation, connection);
      } catch (error) {
        errors.push(errorText(error));
        await connection?.close().catch(() => undefined);
      }
    }
    throw new Error(`MSFile supplier dial failed: ${errors.join(" | ")}`);
  }

  /**
   * Direct 与 WSS 共用一个 host，但拨号能力必须按地址类型分流：
   * WebRTC Direct 由 0.2.0 SDK 完成 endpoint 校验、身份 pin、超时和取消；
   * WSS 继续使用业务层已有的 host.dial + authenticateConnection。
   */
  private async dialSupplierAddress(
    supplier: MsFileSupplierConfig,
    address: string,
    signal?: AbortSignal,
  ): Promise<Connection> {
    const publicKey = hexToBytes(supplier.supplierPublicKeyHex);
    const parsed = multiaddr(address);
    const isDirect = parsed.getComponents().some((component) => component.name === "webrtc-direct");
    if (isDirect) {
      const endpoint = parseWebRTCDirectEndpoint(parsed, { publicKey });
      const result = await dialAuthenticatedWebRTCDirect(this.host, endpoint, {
        publicKey,
        signal,
        timeoutMs: 15_000,
      });
      return result.connection;
    }

    const connection = await this.host.dial(parsed, { signal });
    try {
      authenticateConnection(connection, {
        peerId: peerIdFromPublicKeyBytes(publicKey),
        publicKey,
      });
      return connection;
    } catch (error) {
      // host.dial 已经建立了连接；身份 pin 失败时不能交给外层用
      // `connection` 变量清理，因为这里会在返回前直接抛出。
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private async installConnection(supplier: MsFileSupplierConfig, generation: number, connection: Connection): Promise<SupplierConnection> {
    const statStream = await connection.newStream(MSFILE_PROTOCOL_ID) as unknown as StreamLike;
    let readStream: StreamLike;
    try {
      readStream = await connection.newStream(MSFILE_PROTOCOL_ID) as unknown as StreamLike;
    } catch (error) {
      await statStream.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
      throw error;
    }
    const entry: SupplierConnection = {
      supplierPublicKeyHex: supplier.supplierPublicKeyHex,
      generation,
      connection,
      statStream,
      readStream,
      stat: new StatStreamSession(toDuplex(statStream), MAX_STAT_PENDING_PER_SUPPLIER),
      read: new ReadStreamSession(toDuplex(readStream)),
    };
    const previous = this.connections.get(supplier.supplierPublicKeyHex);
    this.connections.set(supplier.supplierPublicKeyHex, entry);
    if (previous) await this.closeConnection(previous);
    return entry;
  }

  private async drop(key: string, expected: SupplierConnection): Promise<void> {
    if (this.connections.get(key) === expected) this.connections.delete(key);
    await this.closeConnection(expected);
  }

  private async closeConnection(entry: SupplierConnection): Promise<void> {
    entry.stat.dispose();
    entry.read.dispose();
    await entry.connection.close().catch(() => undefined);
  }

  private mapStat(supplierPublicKeyHex: string, payload: import("./frameCodec.js").StatResponsePayload): MsFileSupplierStat {
    switch (payload.status) {
      case 1: return { supplierPublicKeyHex, status: "available", recommendedFilename: payload.recommendedFilename, fileSizeBytes: payload.fileSizeBytes.toString(10), mediaType: payload.mediaType };
      case 2: return { supplierPublicKeyHex, status: "absent" };
      case 3: return { supplierPublicKeyHex, status: "discovering", retryAfterMs: payload.retryAfterMs };
      case 4: return {
        supplierPublicKeyHex,
        status: "quoted",
        recommendedFilename: payload.recommendedFilename,
        fileSizeBytes: payload.fileSizeBytes.toString(10),
        mediaType: payload.mediaType,
        minSeedPriceSatoshis: payload.minSeedPriceSatoshis.toString(10),
        maxSeedPriceSatoshis: payload.maxSeedPriceSatoshis.toString(10),
        minFullBlockPriceSatoshis: payload.minFullBlockPriceSatoshis.toString(10),
        maxFullBlockPriceSatoshis: payload.maxFullBlockPriceSatoshis.toString(10),
      };
    }
  }
}

interface ExecutorBridgeRequest {
  type: "request" | "cancel";
  leaseId: string;
  requestId: string;
  operation: import("./executorTransport.js").MsFileExecutorOperation;
}

interface ExecutorBridgeResponse {
  type: "response";
  leaseId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface MsFileWindowExecutorOptions {
  coordinator: SessionCoordinatorClient;
}

/**
 * 启动一个 Window executor。启动失败不会把错误传播到页面主树；Worker
 * 会继续保持 unavailable，下一次 session.state 或另一 tab 可以重新选举。
 */
export class MsFileWindowExecutor {
  private channel: MessageChannel;
  private readonly coordinator: SessionCoordinatorClient;
  private lease?: import("@keymaster/contracts").MsFileExecutorLease;
  private signer?: KeymasterMsFileIdentitySigner;
  private host?: Host;
  private supplierRuntime?: MsFileSupplierRuntime;
  private readonly pending = new Map<string, AbortController>();
  private disposed = false;
  private starting?: Promise<boolean>;
  private lifecycleToken = 0;

  constructor(options: MsFileWindowExecutorOptions) {
    this.coordinator = options.coordinator;
    this.channel = new MessageChannel();
    this.bindChannel();
  }

  private bindChannel(): void {
    this.channel.port1.onmessage = (event: MessageEvent<ExecutorBridgeRequest | { type: "shutdown" } | { type: "revoked"; leaseId: string }>) => {
      if (event.data && event.data.type === "revoked") {
        // Worker 会先推进 epoch/session.state，再把旧 lease 的 revoked 投递到
        // MessagePort。若只 stop，前面的 unlocked 事件可能已经误判 start()
        // 成功，之后再没有事件触发重建，active-key switch 会永久 unavailable。
        // 同时按 leaseId 过滤迟到 revoke，不能误杀已经重建的新 host。
        if (this.lease?.leaseId !== event.data.leaseId) return;
        void this.stop().then(() => {
          const snapshot = this.coordinator.getBootstrapSnapshot();
          if (!this.disposed && snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex) {
            void this.start();
          }
        });
        return;
      }
      if (event.data && event.data.type === "request") void this.handleRequest(event.data);
      if (event.data && event.data.type === "cancel" && typeof event.data.requestId === "string") {
        this.pending.get(event.data.requestId)?.abort();
      }
    };
    this.channel.port1.start();
  }

  async start(): Promise<boolean> {
    if (this.disposed || this.lease) return Boolean(this.lease);
    if (this.starting) return this.starting;
    const run = this.startImpl();
    this.starting = run;
    try {
      return await run;
    } finally {
      if (this.starting === run) this.starting = undefined;
    }
  }

  private async startImpl(): Promise<boolean> {
    if (this.disposed || this.lease) return Boolean(this.lease);
    const lifecycleToken = this.lifecycleToken;
    // MessagePort transferred to the Worker cannot be transferred a second
    // time. Recreate the pair after lock, release, or a failed host start.
    try { this.channel.port1.close(); } catch { /* initial channel */ }
    this.channel = new MessageChannel();
    this.bindChannel();
    const snapshot = this.coordinator.getBootstrapSnapshot();
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) return false;
    const acquired = await this.coordinator.msfileExecutorAcquire(snapshot.activePublicKeyHex, this.channel.port2);
    if (acquired.status !== "ok") return false;
    if (this.disposed || lifecycleToken !== this.lifecycleToken) {
      await this.coordinator.msfileExecutorRelease(acquired.value.leaseId).catch(() => undefined);
      return false;
    }
    this.lease = acquired.value;
    try {
      this.signer = new KeymasterMsFileIdentitySigner({ ...acquired.value, rpc: this.coordinator });
      const host = await createHost({
        signer: this.signer,
        transports: [webRTCDirect(), webSockets()],
        listenAddrs: [],
        // Supplier 地址由受信任设置页保存并经过 public-key/PeerId/certhash
        // 校验。MSFile 的主要部署形态包含 loopback/LAN NAS，因此不能沿用
        // 浏览器 libp2p 对私网 multiaddr 的默认拒绝策略；身份安全仍由拨号后
        // authenticateConnection 的 PeerId + 压缩公钥 pin 保证。
        connectionGater: { denyDialMultiaddr: async () => false },
        start: true,
      });
      if (this.disposed || lifecycleToken !== this.lifecycleToken) {
        await Promise.resolve(host.stop()).catch(() => undefined);
        this.signer.close();
        this.signer = undefined;
        const lease = this.lease;
        this.lease = undefined;
        if (lease) await this.coordinator.msfileExecutorRelease(lease.leaseId).catch(() => undefined);
        return false;
      }
      this.host = host;
      this.supplierRuntime = new MsFileSupplierRuntime(host);
      this.channel.port1.postMessage({ type: "ready", leaseId: this.lease.leaseId, ok: true });
      return true;
    } catch (error) {
      const leaseId = this.lease?.leaseId;
      if (leaseId) this.channel.port1.postMessage({ type: "ready", leaseId, ok: false, errorMessage: errorText(error) });
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    this.lifecycleToken += 1;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    await this.supplierRuntime?.dispose().catch(() => undefined);
    this.supplierRuntime = undefined;
    if (this.host) await Promise.resolve(this.host.stop()).catch(() => undefined);
    this.host = undefined;
    this.signer?.close();
    this.signer = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (lease) await this.coordinator.msfileExecutorRelease(lease.leaseId).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
    this.channel.port1.close();
    this.channel.port2.close();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 对齐 Worker session 真值；active key/epoch 改变时不能复用旧 lease。 */
  async reconcileSession(snapshot = this.coordinator.getBootstrapSnapshot()): Promise<boolean> {
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) {
      await this.stop();
      return false;
    }
    if (this.lease && (
      this.lease.sessionEpoch !== snapshot.sessionEpoch
      || this.lease.activePublicKeyHex !== snapshot.activePublicKeyHex
    )) {
      await this.stop();
    }
    return this.start();
  }

  private async handleRequest(request: ExecutorBridgeRequest): Promise<void> {
    const lease = this.lease;
    const runtime = this.supplierRuntime;
    if (!lease || !runtime || request.leaseId !== lease.leaseId) return;
    const controller = new AbortController();
    this.pending.set(request.requestId, controller);
    try {
      let result: ReadOutcome | MsFileSupplierStat | MsFileSupplierProbeResult | null;
      const operation = request.operation;
      if (operation.type === "stat") {
        result = await runtime.stat({ ...operation, signal: controller.signal });
      } else if (operation.type === "read") {
        result = await runtime.read({ ...operation, signal: controller.signal });
        if (result.type === "ok") {
          const content = result.content.slice();
          this.postResponse(request, { type: "ok", content }, content.buffer);
          return;
        }
      } else if (operation.type === "probe") {
        result = await runtime.probe({ ...operation, signal: controller.signal });
      } else {
        await runtime.invalidate(operation.supplierPublicKeyHex);
        result = null;
      }
      this.postResponse(request, result);
    } catch (error) {
      this.postResponse(request, undefined, undefined, "msfile_transport_error", errorText(error));
    } finally {
      this.pending.delete(request.requestId);
    }
  }

  private postResponse(request: ExecutorBridgeRequest, result?: unknown, transfer?: ArrayBuffer, errorCode?: string, errorMessage?: string): void {
    const response: ExecutorBridgeResponse = { type: "response", leaseId: request.leaseId, requestId: request.requestId, ok: errorCode === undefined, ...(result === undefined ? {} : { result }), ...(errorCode === undefined ? {} : { errorCode, errorMessage }) };
    try {
      this.channel.port1.postMessage(response, transfer ? [transfer] : []);
    } catch {
      // Worker 端会在超时/lease 失效时释放 pending；不把页面错误扩散到 React。
    }
  }
}

let installedExecutor: MsFileWindowExecutor | undefined;
let installedUnsubscribe: (() => void) | undefined;
let installRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** 页面只调用一次；多个 tab 各自竞争 Worker lease，失败者保持轻量重试。 */
export function installMsFileWindowExecutor(coordinator: SessionCoordinatorClient): () => void {
  if (installedExecutor) return () => { void installedExecutor?.dispose(); };
  const executor = new MsFileWindowExecutor({ coordinator });
  installedExecutor = executor;
  const attempt = (snapshot?: import("@keymaster/contracts").CoordinatorBootstrapSnapshot): void => {
    if (executor.isDisposed) return;
    void executor.reconcileSession(snapshot).then((started) => {
      if (!started && !installRetryTimer) installRetryTimer = setTimeout(() => { installRetryTimer = undefined; attempt(); }, 2_000);
    }).catch(() => undefined);
  };
  installedUnsubscribe = coordinator.subscribeTopic("session.state", (event: { vaultStatus?: string }) => {
    if (event.vaultStatus === "unlocked") attempt(event as import("@keymaster/contracts").CoordinatorBootstrapSnapshot);
    else if (event.vaultStatus === "locked" || event.vaultStatus === "fatal") void executor.stop();
  });
  const pagehideHandler = () => { void executor.dispose(); };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", pagehideHandler, { once: true });
  }
  attempt();
  return () => {
    if (installRetryTimer) clearTimeout(installRetryTimer);
    installRetryTimer = undefined;
    installedUnsubscribe?.();
    installedUnsubscribe = undefined;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", pagehideHandler);
    installedExecutor = undefined;
    void executor.dispose();
  };
}
