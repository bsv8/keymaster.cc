// MSFile 的 Window P2P lane runtime。
//
// 这里仅保留供应商连接/Stat/Read 业务；公共 Host、lease、TypedSigner 和
// lane registry 由 plugin-window-p2p 统一拥有。

import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { authenticateConnection } from "bitcoin-libp2p/libp2p";
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
import {
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_READ_CONCURRENCY_HARD_LIMITS,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
} from "@keymaster/contracts";
import {
  buildWindowP2pConcurrencyConfig,
  type WindowP2pExecutorConcurrencyConfig,
} from "./executorTransport.js";
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

type SupplierGateWaiter = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort: () => void;
};

interface SupplierGate {
  active: number;
  waiters: SupplierGateWaiter[];
}

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
  private readonly readGates = new Map<string, SupplierGate>();
  private readonly statGates = new Map<string, SupplierGate>();
  private concurrencyConfig: WindowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(
    MSFILE_READ_CONCURRENCY_RECOMMENDED,
    0,
  );
  private disposed = false;

  constructor(private readonly host: Host) {}

  async stat(input: { supplier: MsFileSupplierConfig; seedHashHex: string; supplierGeneration: number; signal?: AbortSignal }): Promise<MsFileSupplierStat> {
    return this.withSupplierSlot(
      this.statGates,
      input.supplier.supplierPublicKeyHex,
      () => this.concurrencyConfig.globalStatConcurrency,
      input.signal,
      () => this.statNow(input),
    ) as Promise<MsFileSupplierStat>;
  }

  private async statNow(input: { supplier: MsFileSupplierConfig; seedHashHex: string; supplierGeneration: number; signal?: AbortSignal }): Promise<MsFileSupplierStat> {
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
    return this.withSupplierSlot(
      this.readGates,
      input.supplier.supplierPublicKeyHex,
      () => this.concurrencyConfig.supplierPendingReadLimit,
      input.signal,
      () => this.readNow(input),
    ) as Promise<ReadOutcome>;
  }

  private async readNow(input: {
    supplier: MsFileSupplierConfig;
    kind: "seed" | "block";
    hashHex: string;
    maxPriceSatoshis: string;
    supplierGeneration: number;
    signal?: AbortSignal;
  }): Promise<ReadOutcome> {
    const hash = hexToBytes(input.hashHex);
    const maxContentBytes = input.kind === "seed" ? MSFILE_MAX_SEED_BYTES : MSFILE_MAX_BLOCK_BYTES;
    const amount = canonicalAmount(input.maxPriceSatoshis);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.ensureConnection(input.supplier, input.supplierGeneration, input.signal);
      if (!connection.read.isUsable) {
        await this.drop(input.supplier.supplierPublicKeyHex, connection);
        continue;
      }
      let abortConnection: Promise<void> | undefined;
      const onAbort = () => {
        // 不等待 ReadStreamSession 的本地 Promise 先 reject；AbortSignal
        // 一触发就 reset 远端 stream，缩短 supplier 看到取消的窗口。
        abortConnection ??= this.drop(input.supplier.supplierPublicKeyHex, connection);
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      let result: ReadOutcome;
      try {
        result = await connection.read.send({ contentHashBytes: hash, maxPriceSatoshis: amount, maxContentBytes, signal: input.signal });
      } catch (error) {
        if (input.signal?.aborted) {
          // wire v1 没有单独的 ReadCancel frame；关闭这条 Read stream 会让
          // supplier 的 stream context 立即结束，从而真正中止 Go 端在途 Read。
          // 该 supplier 的其它在途 Read 也会随连接一起失败，下一次请求会
          // 通过 ensureConnection 建立新连接，不能让旧连接继续占用资源。
          await (abortConnection ?? this.drop(input.supplier.supplierPublicKeyHex, connection));
        }
        throw error;
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
      if (input.signal?.aborted) {
        // 取消回调可能先 dispose ReadStreamSession，使 send() 以
        // transport-failed 结算；此时不能进入下面的重拨分支，否则会在
        // 用户已经取消后重新建立 supplier connection。
        await (abortConnection ?? this.drop(input.supplier.supplierPublicKeyHex, connection));
        throw new DOMException("The operation was aborted", "AbortError");
      }
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
      this.rejectSupplierWaiters();
      const flights = [...this.dialing.values()];
      for (const flight of flights) flight.controller.abort();
      const all = [...this.connections.values()];
      this.connections.clear();
      await Promise.all(all.map((entry) => this.closeConnection(entry)));
      await Promise.allSettled(flights.map((flight) => flight.promise));
      return;
    }
    this.rejectSupplierWaiters(supplierPublicKeyHex);
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

  setConcurrencyConfig(config: WindowP2pExecutorConcurrencyConfig): void {
    if (config.version < this.concurrencyConfig.version) return;
    this.concurrencyConfig = config;
    for (const key of this.readGates.keys()) this.pumpSupplierGate(this.readGates, key, () => config.supplierPendingReadLimit);
    for (const key of this.statGates.keys()) this.pumpSupplierGate(this.statGates, key, () => config.globalStatConcurrency);
  }

  private withSupplierSlot<T>(
    gates: Map<string, SupplierGate>,
    supplierPublicKeyHex: string,
    limit: () => number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("MSFile supplier runtime is disposed"));
    if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    const gate = gates.get(supplierPublicKeyHex) ?? { active: 0, waiters: [] };
    gates.set(supplierPublicKeyHex, gate);
    return new Promise<T>((resolve, reject) => {
      const waiter: SupplierGateWaiter = {
        operation: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        onAbort: () => {
          const index = gate.waiters.indexOf(waiter);
          if (index >= 0) gate.waiters.splice(index, 1);
          reject(new DOMException("The operation was aborted", "AbortError"));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      gate.waiters.push(waiter);
      this.pumpSupplierGate(gates, supplierPublicKeyHex, limit);
    });
  }

  private pumpSupplierGate(gates: Map<string, SupplierGate>, supplierPublicKeyHex: string, limit: () => number): void {
    const gate = gates.get(supplierPublicKeyHex);
    if (!gate) return;
    while (gate.active < limit() && gate.waiters.length > 0) {
      const waiter = gate.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException("The operation was aborted", "AbortError"));
        continue;
      }
      gate.active += 1;
      void waiter.operation().then(waiter.resolve, waiter.reject).finally(() => {
        gate.active = Math.max(0, gate.active - 1);
        this.pumpSupplierGate(gates, supplierPublicKeyHex, limit);
      });
    }
    if (gate.active === 0 && gate.waiters.length === 0) gates.delete(supplierPublicKeyHex);
  }

  private rejectSupplierWaiters(supplierPublicKeyHex?: string): void {
    const groups = supplierPublicKeyHex === undefined
      ? [...this.readGates.entries(), ...this.statGates.entries()]
      : [
        ...(this.readGates.has(supplierPublicKeyHex) ? [[supplierPublicKeyHex, this.readGates.get(supplierPublicKeyHex)!] as [string, SupplierGate]] : []),
        ...(this.statGates.has(supplierPublicKeyHex) ? [[supplierPublicKeyHex, this.statGates.get(supplierPublicKeyHex)!] as [string, SupplierGate]] : []),
      ];
    for (const [, gate] of groups) {
      for (const waiter of gate.waiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new Error("MSFile supplier request invalidated"));
      }
    }
  }

  private async ensureConnection(supplier: MsFileSupplierConfig, generation: number, signal?: AbortSignal): Promise<SupplierConnection> {
    if (this.disposed) throw new Error("MSFile supplier runtime is disposed");
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
   * WebRTC Direct 由 0.3.0 SDK 完成 endpoint 校验、身份 pin、超时和取消；
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
      stat: new StatStreamSession(toDuplex(statStream), MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalStatConcurrency),
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
    // connection.close() 是优雅/半关闭，Yamux 远端仍可能保持可读端并
    // 继续执行 handler；失效/取消路径必须使用 connection.abort，确保
    // supplier 的所有 stream context 立即结束，避免已取消的 Read 继续
    // 占用读取槽位。
    const error = new Error("MSFile supplier connection invalidated");
    try { entry.connection.abort(error); } catch { /* connection already closed */ }
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

