import { parse } from "go-bitfs";
import { BITFS_PROTOCOL_ID, MAX_WIRE_FRAME_BYTES, readArtifacts, writeArtifact } from "go-bitfs/transport";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import {
  dialAuthenticatedAddress,
  type AuthenticatedDialConnection,
  type AuthenticatedDialHost,
} from "../authenticatedDial.js";

export const BITFS_STREAM_MAX_SESSIONS = 32;
export const BITFS_STREAM_MAX_QUEUED_BYTES = MAX_WIRE_FRAME_BYTES + 10;
export const BITFS_STREAM_TEARDOWN_TIMEOUT_MS = 250;

export type BitfsStreamEvent =
  | {
    type: "bitfs-seller-frame";
    sessionId: string;
    connectionId: string;
    ownerSessionEpoch: string;
    frame: Uint8Array;
  }
  | {
    type: "bitfs-seller-session-closed";
    sessionId: string;
    connectionId: string;
    ownerSessionEpoch: string;
    reason: string;
  };

type BitfsStreamLike = {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(error: Error): void;
  addEventListener(type: string, listener: (event: Event) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  readonly writableNeedsDrain: boolean;
  readonly status?: string;
  readonly writeStatus?: string;
};

interface StreamSessionEntry {
  sessionId: string;
  connectionId: string;
  ownerSessionEpoch: string;
  connection: AuthenticatedDialConnection;
  stream: BitfsStreamLike;
  controller: AbortController;
  abortCleanup?: () => void;
  sendQueue: Promise<void>;
  queuedSendBytes: number;
  closePromise?: Promise<void>;
  closed: boolean;
}

export interface BitfsStreamRuntimeOptions {
  host: AuthenticatedDialHost;
  emit(event: BitfsStreamEvent, transfer?: Transferable[]): Promise<void> | void;
  ownerSessionEpoch: string;
  webrtcTimeoutMs?: number;
  dial?: (input: {
    address: string;
    publicKeyHex: string;
    signal?: AbortSignal;
  }) => Promise<AuthenticatedDialConnection>;
}

export class BitfsStreamRuntime {
  private readonly sessions = new Map<string, StreamSessionEntry>();
  private readonly openingSessions = new Map<string, AbortController>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: BitfsStreamRuntimeOptions) {}

  async open(input: {
    sessionId: string;
    addresses: string[];
    publicKeyHex: string;
    expectedPeerId: string;
    firstFrame: Uint8Array;
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.disposed) throw new Error("BitFS stream runtime is disposed");
    if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (this.sessions.has(input.sessionId) || this.openingSessions.has(input.sessionId)) {
      throw new Error("BitFS stream session id already exists");
    }
    if (this.sessions.size + this.openingSessions.size >= BITFS_STREAM_MAX_SESSIONS) {
      throw new Error("BitFS stream session limit reached");
    }
    if (input.addresses.length === 0) throw new Error("BitFS stream requires at least one locator");
    const publicKey = hexToBytes(input.publicKeyHex);
    const derivedPeerId = peerIdFromPublicKeyBytes(publicKey).toString();
    if (derivedPeerId !== input.expectedPeerId) throw new Error("BitFS stream PeerId does not match the requester public key");
    const first = parse(input.firstFrame.slice()).bytes();
    assertFrameSize(first);
    const openingController = new AbortController();
    const unlink = linkAbortSignal(openingController, input.signal);
    this.openingSessions.set(input.sessionId, openingController);
    const errors: string[] = [];
    try {
      for (const address of input.addresses) {
        if (this.disposed) throw new Error("BitFS stream runtime is disposed");
        if (openingController.signal.aborted) throw abortError(openingController.signal.reason, "The operation was aborted");
        let connection: AuthenticatedDialConnection | undefined;
        try {
          const dial = this.options.dial ?? ((value) => dialAuthenticatedAddress({
            host: this.options.host,
            address: value.address,
            publicKeyHex: value.publicKeyHex,
            ...(value.signal === undefined ? {} : { signal: value.signal }),
            ...(this.options.webrtcTimeoutMs === undefined ? {} : { webrtcTimeoutMs: this.options.webrtcTimeoutMs }),
          }));
          connection = await dial({
            address,
            publicKeyHex: input.publicKeyHex,
            signal: openingController.signal,
          });
          if (this.disposed) throw new Error("BitFS stream runtime is disposed");
          if (openingController.signal.aborted) throw abortError(openingController.signal.reason, "The operation was aborted");
          await this.installSession(input.sessionId, connection, first, openingController.signal);
          return;
        } catch (error) {
          errors.push(error instanceof Error ? error.message.slice(0, 128) : String(error).slice(0, 128));
          await closeConnectionWithin(connection);
        }
      }
      throw new Error(`BitFS stream dial failed: ${errors.join(" | ")}`);
    } finally {
      unlink();
      if (this.openingSessions.get(input.sessionId) === openingController) this.openingSessions.delete(input.sessionId);
    }
  }

  async send(sessionId: string, frame: Uint8Array): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed) throw new Error("BitFS stream session is not open");
    const artifact = parse(frame.slice());
    const bytes = artifact.bytes();
    assertFrameSize(bytes);
    const queuedBytes = bytes.byteLength + uvarintSize(bytes.byteLength);
    reserveSend(entry, queuedBytes);
    const operation = entry.sendQueue.catch(() => undefined).then(async () => {
      if (entry.closed) throw new Error("BitFS stream session is not open");
      await this.writeArtifactAndWait(entry, artifact);
    });
    entry.sendQueue = operation.catch(() => undefined);
    try {
      await operation;
    } finally {
      entry.queuedSendBytes = Math.max(0, entry.queuedSendBytes - queuedBytes);
    }
  }

  async close(sessionId: string, reason = "closed"): Promise<void> {
    const opening = this.openingSessions.get(sessionId);
    if (opening != null) {
      opening.abort(abortError(new Error(reason), "BitFS stream session closed"));
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      await this.teardown(entry, reason, false);
      return;
    }
    const closing = this.closing.get(sessionId);
    if (closing != null) await closing;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return await this.disposePromise;
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.openingSessions.values()) {
      controller.abort(abortError(new Error("runtime_disposed"), "BitFS stream runtime disposed"));
    }
    const entries = [...this.sessions.values()];
    const closing = [...this.closing.values()];
    this.disposePromise = (async () => {
      await Promise.allSettled([
        ...entries.map(entry => this.teardown(entry, "runtime_disposed", false)),
        ...closing
      ]);
    })();
    await this.disposePromise;
  }

  private async installSession(
    sessionId: string,
    connection: AuthenticatedDialConnection,
    firstFrame: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(controller, signal);
    let stream: BitfsStreamLike | undefined;
    try {
      const opened = await connection.newStream(BITFS_PROTOCOL_ID, { signal: controller.signal });
      stream = opened as unknown as BitfsStreamLike;
      const entry: StreamSessionEntry = {
        sessionId,
        connectionId: crypto.randomUUID(),
        ownerSessionEpoch: this.options.ownerSessionEpoch,
        connection,
        stream,
        controller,
        sendQueue: Promise.resolve(),
        queuedSendBytes: 0,
        closed: false,
      };
      await this.writeArtifactAndWait(entry, parse(firstFrame.slice()));
      if (this.disposed || controller.signal.aborted) throw new Error("BitFS stream session was closed while opening");
      this.sessions.set(sessionId, entry);
      this.startReadLoop(entry);
    } catch (error) {
      controller.abort(abortError(error, "BitFS stream session closed"));
      if (stream != null) {
        abortStream(stream, "BitFS stream session failed");
        await closeStreamWithin(stream);
      }
      throw error;
    } finally {
      unlink();
    }
  }

  private startReadLoop(entry: StreamSessionEntry): void {
    void this.readLoop(entry);
  }

  private async readLoop(entry: StreamSessionEntry): Promise<void> {
    let reason = "remote_closed";
    try {
      for await (const artifact of readArtifacts(entry.stream as unknown as Parameters<typeof readArtifacts>[0], {
        signal: entry.controller.signal,
        maxInboundFrameBytes: MAX_WIRE_FRAME_BYTES,
        maxBufferedBytes: MAX_WIRE_FRAME_BYTES + 10,
        maxBufferedFrames: 64,
      })) {
        if (entry.closed || this.sessions.get(entry.sessionId) !== entry) return;
        const frame = artifact.bytes();
        try {
          await this.options.emit({
            type: "bitfs-seller-frame",
            sessionId: entry.sessionId,
            connectionId: entry.connectionId,
            ownerSessionEpoch: entry.ownerSessionEpoch,
            frame,
          }, [frame.buffer]);
        } catch {
          reason = "worker_unreachable";
          break;
        }
      }
    } catch {
      reason = entry.controller.signal.aborted || entry.closed ? "local_closed" : "stream_error";
    }
    if (entry.closed) return;
    await this.teardown(entry, reason, true);
  }

  private async writeArtifactAndWait(entry: StreamSessionEntry, artifact: ReturnType<typeof parse>): Promise<void> {
    if (entry.closed) throw new Error("BitFS stream session is not open");
    if (entry.stream.writableNeedsDrain) await waitForDrain(entry.stream, entry.controller.signal);
    if (entry.closed) throw new Error("BitFS stream session is not open");
    if (entry.controller.signal.aborted) throw abortError(entry.controller.signal.reason, "BitFS stream session is closed");
    if (!writeArtifact(entry.stream as unknown as Parameters<typeof writeArtifact>[0], artifact)) {
      await waitForDrain(entry.stream, entry.controller.signal);
    }
  }

  private async teardown(entry: StreamSessionEntry, reason: string, notify: boolean): Promise<void> {
    if (entry.closed) {
      if (entry.closePromise != null) await entry.closePromise;
      return;
    }
    entry.closed = true;
    this.sessions.delete(entry.sessionId);
    try { entry.abortCleanup?.(); } catch { }
    entry.controller.abort(abortError(new Error(reason), "BitFS stream session closed"));
    const work = (async () => {
      abortStream(entry.stream, "BitFS stream session closed");
      try { entry.connection.abort(new Error("BitFS stream session closed")); } catch { }
      await Promise.all([closeStreamWithin(entry.stream), closeConnectionWithin(entry.connection)]);
      if (notify) {
        await emitWithin(this.options.emit, {
          type: "bitfs-seller-session-closed",
          sessionId: entry.sessionId,
          connectionId: entry.connectionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          reason: /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : "stream_error",
        });
      }
    })();
    entry.closePromise = work;
    this.closing.set(entry.sessionId, work);
    try {
      await work;
    } finally {
      if (this.closing.get(entry.sessionId) === work) this.closing.delete(entry.sessionId);
    }
  }
}

function assertFrameSize(frame: Uint8Array): void {
  if (frame.byteLength === 0 || frame.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error("BitFS stream frame size is invalid");
}

function reserveSend(entry: StreamSessionEntry, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BITFS_STREAM_MAX_QUEUED_BYTES
    || entry.queuedSendBytes > BITFS_STREAM_MAX_QUEUED_BYTES - bytes) {
    throw new Error("BitFS stream send queue limit reached");
  }
  entry.queuedSendBytes += bytes;
}

function linkAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (signal == null) return () => undefined;
  const abort = (): void => controller.abort(abortError(signal.reason, "The operation was aborted"));
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function abortError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  const error = new Error(value === undefined ? fallback : String(value));
  error.name = "AbortError";
  return error;
}

function uvarintSize(value: number): number {
  let size = 1;
  let remaining = value;
  while (remaining >= 128) {
    remaining = Math.floor(remaining / 128);
    size += 1;
  }
  return size;
}

function abortStream(stream: BitfsStreamLike, reason: string): void {
  try { stream.abort(new Error(reason)); } catch { }
}

async function closeStreamWithin(stream: BitfsStreamLike): Promise<void> {
  const settled = await settleWithin(Promise.resolve().then(() => stream.close()), BITFS_STREAM_TEARDOWN_TIMEOUT_MS);
  if (!settled) {
    try { stream.abort(new Error("BitFS stream close timed out")); } catch { }
  }
}

async function closeConnectionWithin(connection: AuthenticatedDialConnection | undefined): Promise<void> {
  if (connection == null) return;
  const settled = await settleWithin(Promise.resolve().then(() => connection.close()), BITFS_STREAM_TEARDOWN_TIMEOUT_MS);
  if (!settled) {
    try { connection.abort(new Error("BitFS stream connection close timed out")); } catch { }
  }
}

async function emitWithin(
  emit: (event: BitfsStreamEvent, transfer?: Transferable[]) => Promise<void> | void,
  event: BitfsStreamEvent,
): Promise<void> {
  await settleWithin(Promise.resolve().then(() => emit(event)), BITFS_STREAM_TEARDOWN_TIMEOUT_MS);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    operation.then(() => finish(true), () => finish(true));
  });
}

async function waitForDrain(stream: BitfsStreamLike, signal: AbortSignal): Promise<void> {
  if (!stream.writableNeedsDrain) return;
  if (streamClosed(stream)) throw new Error("stream closed while waiting for drain");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stream.removeEventListener("drain", onDrain);
      stream.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(abortError(error, "stream closed while waiting for drain"));
    };
    const onDrain = (): void => {
      if (streamClosed(stream)) finish(new Error("stream closed while waiting for drain"));
      else finish();
    };
    const onClose = (event: Event): void => {
      const value = (event as Event & { error?: unknown }).error;
      finish(value ?? new Error("stream closed while waiting for drain"));
    };
    const onAbort = (): void => finish(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    stream.addEventListener("drain", onDrain);
    if (settled) return;
    stream.addEventListener("close", onClose);
    if (settled) return;
    signal.addEventListener("abort", onAbort, { once: true });
    if (settled) return;
    if (signal.aborted) onAbort();
    else if (streamClosed(stream)) onClose(new Event("close"));
    else if (!stream.writableNeedsDrain) onDrain();
  });
}

function streamClosed(stream: BitfsStreamLike): boolean {
  return stream.status === "closing" || stream.status === "closed" || stream.status === "aborted" || stream.status === "reset" || stream.writeStatus === "closing" || stream.writeStatus === "closed";
}
