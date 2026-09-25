import { parse } from "go-bitfs";
import { BITFS_PROTOCOL_ID, MAX_WIRE_FRAME_BYTES, readArtifacts, writeArtifact } from "go-bitfs/transport";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import type {
  WebRTCInterconnectConnectionEvent,
  WebRTCInterconnectDialer,
  WebRTCInterconnectEnvelope,
  WebRTCInterconnectSignal
} from "bitcoin-libp2p/webrtc-interconnect";
import type { WindowWebRtcInterconnectContext } from "@keymaster/plugin-window-p2p/webrtc-interconnect";

const MAX_QUEUED_SEND_BYTES = 2 * (MAX_WIRE_FRAME_BYTES + 10);
const MAX_PENDING_INBOUND_STREAMS = 8;
const MAX_PENDING_INBOUND_CONNECTIONS = 32;
const TEARDOWN_TIMEOUT_MS = 250;
const DEFAULT_SIGNAL_TIMEOUT_MS = 30_000;

export type BitfsWebRtcStreamEvent =
  | {
    type: "bitfs-webrtc-frame";
    sessionId: string;
    webrtcSessionId: string;
    ownerSessionEpoch: string;
    frame: Uint8Array;
  }
  | {
    type: "bitfs-webrtc-session-closed";
    sessionId: string;
    webrtcSessionId: string;
    ownerSessionEpoch: string;
    reason: string;
    errorCode?: string;
    errorMessage?: string;
    errorName?: string;
  }
  | {
    type: "bitfs-webrtc-runtime-error";
    sessionId: string;
    webrtcSessionId: string;
    ownerSessionEpoch: string;
    direction: "inbound" | "outbound";
    message: string;
    name: string;
  }
  | {
    type: "bitfs-webrtc-signal-outbound";
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    publicKeyHex: string;
    ownerSessionEpoch: string;
    envelope: WebRTCInterconnectEnvelope;
  };

export type BitfsWebRtcHost = Parameters<WebRTCInterconnectDialer["dial"]>[0];
type BitfsConnection = Awaited<ReturnType<BitfsWebRtcHost["dial"]>>;
type BitfsStream = Awaited<ReturnType<BitfsConnection["newStream"]>>;
type BitfsArtifact = ReturnType<typeof parse>;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingInbound {
  connection: BitfsConnection;
  streams: BitfsStreamLike[];
  candidates: Set<SessionEntry>;
}

interface SessionEntry {
  sessionId: string;
  requestMessageId: string;
  webrtcSessionId: string;
  publicKeyHex: string;
  publicKey: Uint8Array;
  remotePeerId: ReturnType<typeof peerIdFromPublicKeyBytes>;
  localPeerId: ReturnType<typeof peerIdFromPublicKeyBytes>;
  ownerSessionEpoch: string;
  connectionId: string;
  attemptId: string;
  direction: "inbound" | "outbound";
  controller: AbortController;
  ready: Deferred<SessionEntry>;
  unregister: () => void;
  abortCleanup?: () => void;
  connection?: BitfsConnection;
  connectionVerified: boolean;
  stream?: BitfsStreamLike;
  firstFrame?: Uint8Array;
  installPromise?: Promise<void>;
  readerStarted: boolean;
  sendQueue: Promise<void>;
  queuedSendBytes: number;
  closePromise?: Promise<void>;
  closed: boolean;
  remoteSequence: number;
}

export interface BitfsWebRtcStreamRuntimeOptions {
  interconnect: WindowWebRtcInterconnectContext;
  host: BitfsWebRtcHost;
  stunServers(): readonly string[];
  emit(event: BitfsWebRtcStreamEvent, transfer?: Transferable[]): Promise<void> | void;
  onError?(error: unknown, context: { sessionId: string; webrtcSessionId: string; direction: "inbound" | "outbound" }): void;
  ownerSessionEpoch: string;
  signalTimeoutMs?: number;
}

export class BitfsWebRtcStreamRuntime {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connectionOwners = new Map<BitfsConnection, SessionEntry>();
  private readonly retiredConnections = new WeakSet<object>();
  private readonly connectionIdOwners = new Map<string, SessionEntry>();
  private readonly attemptOwners = new Map<string, SessionEntry>();
  private readonly pendingInbound = new Map<BitfsConnection, PendingInbound>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly unsubscribeConnection: () => void;
  private readonly handlerReady: Promise<void>;
  private handlerRegistered = false;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: BitfsWebRtcStreamRuntimeOptions) {
    options.interconnect.setStunServers(options.stunServers());
    this.handlerReady = this.options.host.handle(BITFS_PROTOCOL_ID, (stream, connection) => this.onInboundStream(stream, connection), { maxInboundStreams: 1 })
      .then(() => { this.handlerRegistered = true; });
    this.handlerReady.catch(error => {
      try { this.options.onError?.(error, { sessionId: "handler", webrtcSessionId: "handler", direction: "inbound" }); } catch { }
    });
    this.unsubscribeConnection = options.interconnect.onConnection(event => {
      void this.onConnection(event).catch(error => this.reportConnectionError(event, error));
    });
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async createOffer(input: {
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    peerPublicKeyHex: string;
    firstFrame: Uint8Array;
    ownerSessionEpoch: string;
    signal?: AbortSignal;
  }): Promise<{ started: true }> {
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    const firstFrame = parse(input.firstFrame.slice()).bytes();
    this.assertFrameSize(firstFrame);
    await this.handlerReady;
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    const entry = this.createEntry(input, "outbound", firstFrame);
    this.bindAbortSignal(entry, input.signal);
    this.sessions.set(entry.sessionId, entry);
    try {
      if (entry.controller.signal.aborted) throw normalizeError(entry.controller.signal.reason, "The operation was aborted", "AbortError");
      const dial = this.options.interconnect.dialer.dial(this.options.host, {
        remotePeerId: entry.remotePeerId,
        publicKey: entry.publicKey,
        connectionId: entry.connectionId,
        attemptId: entry.attemptId,
        signal: entry.controller.signal,
        timeoutMs: this.signalTimeoutMs()
      });
      void Promise.resolve(dial)
        .then(result => this.onDialResult(entry, result))
        .catch(async error => {
          this.reportError(entry, error);
          await this.closeEntry(entry, "dial_failed", true, error);
        });
    } catch (error) {
      this.reportError(entry, error);
      await this.closeEntry(entry, "dial_failed", true, error);
      throw error;
    }
    return { started: true };
  }

  async acceptOffer(input: {
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    peerPublicKeyHex: string;
    offerSdp: string;
    ownerSessionEpoch: string;
    signal?: AbortSignal;
  }): Promise<{ accepted: true }> {
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    if (typeof input.offerSdp !== "string" || input.offerSdp.length === 0 || input.offerSdp.length > 256_000) {
      throw new Error("BitFS WebRTC offer SDP is invalid");
    }
    await this.handlerReady;
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    const entry = this.createEntry(input, "inbound");
    this.bindAbortSignal(entry, input.signal);
    this.sessions.set(entry.sessionId, entry);
    try {
      if (entry.controller.signal.aborted) throw normalizeError(entry.controller.signal.reason, "The operation was aborted", "AbortError");
      this.options.interconnect.deliver(this.toEnvelope(entry, { type: "offer", sdp: input.offerSdp }));
      await this.waitReady(entry, input.signal);
      return { accepted: true };
    } catch (error) {
      await this.closeEntry(entry, "answer_failed", true, error);
      throw error;
    }
  }

  async applySignal(input: {
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    peerPublicKeyHex: string;
    signal: Record<string, unknown>;
    ownerSessionEpoch: string;
  }): Promise<void> {
    const entry = this.sessions.get(input.sessionId);
    if (!entry || entry.closed) throw new Error("BitFS WebRTC session is not open");
    this.assertEntryRelation(entry, input.requestMessageId, input.webrtcSessionId, input.peerPublicKeyHex, input.ownerSessionEpoch);
    const signal = this.toSdkSignal(input.signal);
    this.options.interconnect.deliver(this.toEnvelope(entry, signal));
  }

  async send(sessionId: string, frame: Uint8Array): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed || entry.stream == null) throw new Error("BitFS WebRTC stream is not open");
    const artifact = parse(frame.slice());
    const bytes = artifact.bytes();
    this.assertFrameSize(bytes);
    const queuedBytes = bytes.byteLength + uvarintSize(bytes.byteLength);
    this.reserveSend(entry, queuedBytes);
    const operation = entry.sendQueue.catch(() => undefined).then(async () => {
      if (entry.closed || entry.stream == null) throw new Error("BitFS WebRTC stream is not open");
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
    const entry = this.sessions.get(sessionId);
    if (entry) {
      await this.closeEntry(entry, reason, false);
      return;
    }
    const closing = this.closing.get(sessionId);
    if (closing != null) await closing;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return await this.disposePromise;
    if (this.disposed) return;
    this.disposed = true;
    try { this.unsubscribeConnection(); } catch { }
    this.abortAllPending("BitFS WebRTC runtime disposed");
    const entries = [...this.sessions.values()];
    const closing = [...this.closing.values()];
    this.disposePromise = (async () => {
      await Promise.allSettled([
        ...entries.map(entry => this.closeEntry(entry, "runtime_disposed", false)),
        ...closing
      ]);
      await settleWithin(this.handlerReady, TEARDOWN_TIMEOUT_MS);
      if (this.handlerRegistered) await closeHostHandler(this.options.host);
      else void this.handlerReady.then(() => {
        if (this.disposed && this.handlerRegistered) return closeHostHandler(this.options.host);
        return undefined;
      }).catch(() => undefined);
    })();
    await this.disposePromise;
  }

  private bindAbortSignal(entry: SessionEntry, signal?: AbortSignal): void {
    if (signal == null) return;
    const abort = (): void => {
      entry.controller.abort(normalizeError(signal.reason, "BitFS WebRTC setup was cancelled", "AbortError"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    entry.abortCleanup = cleanup;
  }

  private createEntry(input: {
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    peerPublicKeyHex: string;
    ownerSessionEpoch: string;
    firstFrame?: Uint8Array;
  }, direction: "inbound" | "outbound", firstFrame?: Uint8Array): SessionEntry {
    const publicKeyHex = input.peerPublicKeyHex.toLowerCase();
    const publicKey = hexToBytes(publicKeyHex);
    const remotePeerId = peerIdFromPublicKeyBytes(publicKey);
    const localPeerId = this.options.host.peerId;
    const connectionId = input.webrtcSessionId;
    const attemptId = crypto.randomUUID();
    if (this.connectionIdOwners.has(connectionId) || this.attemptOwners.has(attemptId)) {
      throw new Error("BitFS WebRTC connection relation is already registered");
    }
    const controller = new AbortController();
    const ready = deferred<SessionEntry>();
    ready.promise.catch(() => undefined);
    let entry!: SessionEntry;
    const unregister = this.options.interconnect.register(connectionId, envelope => {
      if (entry.closed || this.disposed || this.sessions.get(input.sessionId) !== entry) {
        throw new Error("BitFS WebRTC session is closed");
      }
      return this.options.emit({
        type: "bitfs-webrtc-signal-outbound",
        sessionId: input.sessionId,
        requestMessageId: input.requestMessageId,
        webrtcSessionId: input.webrtcSessionId,
        publicKeyHex,
        ownerSessionEpoch: input.ownerSessionEpoch,
        envelope
      });
    });
    entry = {
      sessionId: input.sessionId,
      requestMessageId: input.requestMessageId,
      webrtcSessionId: input.webrtcSessionId,
      publicKeyHex,
      publicKey,
      remotePeerId,
      localPeerId,
      ownerSessionEpoch: input.ownerSessionEpoch,
      connectionId,
      attemptId,
      direction,
      controller,
      ready,
      unregister,
      connectionVerified: false,
      readerStarted: false,
      ...(firstFrame === undefined ? {} : { firstFrame: firstFrame.slice() }),
      sendQueue: Promise.resolve(),
      queuedSendBytes: 0,
      closed: false,
      remoteSequence: 0
    };
    this.connectionIdOwners.set(connectionId, entry);
    this.attemptOwners.set(attemptId, entry);
    return entry;
  }

  private onInboundStream(stream: BitfsStream, connection: BitfsConnection): void {
    const inbound = stream as unknown as BitfsStreamLike;
    if (this.disposed) {
      this.abortStream(inbound, "BitFS WebRTC runtime is disposed");
      return;
    }
    if (this.retiredConnections.has(connection)) {
      this.abortStream(inbound, "BitFS WebRTC connection is closed");
      return;
    }
    const owner = this.connectionOwners.get(connection);
    if (owner) {
      this.acceptInboundStream(owner, inbound, connection);
      return;
    }
    const fallback = this.uniqueInboundPeerEntry(connection);
    if (fallback && (fallback.connection == null || fallback.connection === connection)) {
      if (this.bindConnection(fallback, connection, false)) this.acceptInboundStream(fallback, inbound, connection);
      else this.abortStream(inbound, "BitFS WebRTC stream connection is already owned");
      return;
    }
    this.queuePendingInbound(inbound, connection);
  }

  private acceptInboundStream(entry: SessionEntry, stream: BitfsStreamLike, connection: BitfsConnection): void {
    if (entry.closed || entry.direction !== "inbound" || entry.connection !== connection) {
      this.abortStream(stream, "BitFS WebRTC stream does not belong to an active inbound session");
      return;
    }
    void this.attachInbound(entry, stream).catch(async error => {
      this.reportError(entry, error);
      await this.closeEntry(entry, "stream_error", true, error);
    });
  }

  private queuePendingInbound(stream: BitfsStreamLike, connection: BitfsConnection): void {
    if (this.disposed) {
      this.abortStream(stream, "BitFS WebRTC runtime is disposed");
      return;
    }
    let pending = this.pendingInbound.get(connection);
    if (pending == null) {
      if (this.pendingInbound.size >= MAX_PENDING_INBOUND_CONNECTIONS) {
        this.abortStream(stream, "BitFS WebRTC pending stream limit reached");
        return;
      }
      pending = { connection, streams: [], candidates: new Set(this.peerCandidates(connection)) };
      this.pendingInbound.set(connection, pending);
    }
    if (pending.streams.length >= MAX_PENDING_INBOUND_STREAMS) {
      this.abortStream(stream, "BitFS WebRTC pending stream limit reached");
      return;
    }
    for (const candidate of this.peerCandidates(connection)) pending.candidates.add(candidate);
    pending.streams.push(stream);
  }

  private async onConnection(event: WebRTCInterconnectConnectionEvent): Promise<void> {
    const mapped = this.connectionOwners.get(event.connection);
    if (mapped && !this.eventMatchesEntry(mapped, event)) {
      if (!mapped.connectionVerified) {
        this.abortStream(mapped.stream, "BitFS WebRTC connection relation does not match the session");
        await this.closeEntry(mapped, "connection_mismatch", true, new Error("BitFS WebRTC connection relation does not match the session"));
      }
      return;
    }
    const entry = this.entryForConnectionEvent(event);
    if (!entry || entry.closed || !samePeer(entry.remotePeerId, event.remotePeerId)) return;
    if (entry.connection != null && entry.connection !== event.connection) {
      if (!entry.connectionVerified) {
        this.abortStream(entry.stream, "BitFS WebRTC connection relation does not match the session");
        await this.closeEntry(entry, "connection_mismatch", true, new Error("BitFS WebRTC connection relation does not match the session"));
      }
      return;
    }
    if (!this.bindConnection(entry, event.connection, true)) return;
    const pending = this.takePending(event.connection);
    if (entry.direction === "outbound") {
      this.abortStreams(pending, "BitFS WebRTC unexpected inbound stream");
      try {
        await this.install(entry, event.connection);
      } catch (error) {
        if (!entry.closed) {
          this.reportError(entry, error);
          await this.closeEntry(entry, "connection_failed", true, error);
        }
      }
      return;
    }
    for (let index = 0; index < pending.length; index += 1) {
      try {
        await this.attachInbound(entry, pending[index]!);
      } catch (error) {
        this.abortStreams(pending.slice(index + 1), "BitFS WebRTC inbound stream routing failed");
        if (!entry.closed) {
          this.reportError(entry, error);
          await this.closeEntry(entry, "stream_error", true, error);
        }
        return;
      }
    }
  }

  private entryForConnectionEvent(event: WebRTCInterconnectConnectionEvent): SessionEntry | undefined {
    const owner = this.connectionOwners.get(event.connection);
    if (owner) return this.eventMatchesEntry(owner, event) ? owner : undefined;
    const byConnectionId = this.connectionIdOwners.get(event.connectionId);
    if (byConnectionId && this.eventMatchesEntry(byConnectionId, event)) return byConnectionId;
    const byAttempt = this.attemptOwners.get(event.attemptId);
    if (byAttempt && this.eventMatchesEntry(byAttempt, event)) return byAttempt;
    return undefined;
  }

  private eventMatchesEntry(entry: SessionEntry, event: WebRTCInterconnectConnectionEvent): boolean {
    return entry.connectionId === event.connectionId
      && entry.attemptId === event.attemptId
      && samePeer(entry.remotePeerId, event.remotePeerId);
  }

  private peerCandidates(connection: BitfsConnection): SessionEntry[] {
    return [...this.sessions.values()].filter(entry => !entry.closed
      && entry.direction === "inbound"
      && samePeer(entry.remotePeerId, connection.remotePeer));
  }

  private uniqueInboundPeerEntry(connection: BitfsConnection): SessionEntry | undefined {
    const candidates = this.peerCandidates(connection);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private bindConnection(entry: SessionEntry, connection: BitfsConnection, verified: boolean): boolean {
    const owner = this.connectionOwners.get(connection);
    if (owner != null && owner !== entry) return false;
    if (entry.connection != null && entry.connection !== connection) return false;
    entry.connection = connection;
    this.retiredConnections.delete(connection);
    if (verified) entry.connectionVerified = true;
    this.connectionOwners.set(connection, entry);
    this.connectionIdOwners.set(entry.connectionId, entry);
    this.attemptOwners.set(entry.attemptId, entry);
    return true;
  }

  private takePending(connection: BitfsConnection): BitfsStreamLike[] {
    const pending = this.pendingInbound.get(connection);
    if (pending == null) return [];
    this.pendingInbound.delete(connection);
    return pending.streams;
  }

  private async onDialResult(entry: SessionEntry, result: Awaited<ReturnType<WebRTCInterconnectDialer["dial"]>>): Promise<void> {
    const resultPeer = result.remotePeerId ?? result.connection.remotePeer;
    const matches = result.connectionId === entry.connectionId
      && result.attemptId === entry.attemptId
      && (resultPeer == null || samePeer(entry.remotePeerId, resultPeer));
    if (!matches) {
      await closeConnectionWithin(result.connection);
      throw new Error("BitFS WebRTC dial connection relation does not match the session");
    }
    if (entry.closed) {
      await closeConnectionWithin(result.connection);
      return;
    }
    if (!this.bindConnection(entry, result.connection, true)) {
      await closeConnectionWithin(result.connection);
      throw new Error("BitFS WebRTC dial connection is already owned");
    }
    await this.install(entry, result.connection);
  }

  private async install(entry: SessionEntry, connection: BitfsConnection): Promise<void> {
    if (entry.closed) return;
    if (entry.connection != null && entry.connection !== connection) throw new Error("BitFS WebRTC connection is not assigned to the session");
    if (!entry.connectionVerified && !this.bindConnection(entry, connection, true)) throw new Error("BitFS WebRTC connection is already owned");
    if (entry.installPromise != null) return await entry.installPromise;
    const install = (async () => {
      const stream = await connection.newStream(BITFS_PROTOCOL_ID, { signal: entry.controller.signal });
      const typedStream = stream as unknown as BitfsStreamLike;
      if (entry.closed || this.connectionOwners.get(connection) !== entry) {
        this.abortStream(typedStream, "BitFS WebRTC session closed while opening stream");
        throw new Error("BitFS WebRTC session is closed");
      }
      entry.stream = typedStream;
      if (entry.firstFrame != null) {
        const firstWrite = entry.sendQueue.catch(() => undefined).then(async () => {
          if (entry.closed) throw new Error("BitFS WebRTC session is not open");
          await this.writeFrame(entry, entry.firstFrame!);
        });
        entry.sendQueue = firstWrite.catch(() => undefined);
        await firstWrite;
      }
      if (entry.closed) throw new Error("BitFS WebRTC session is closed");
      entry.ready.resolve(entry);
      this.startReadLoop(entry);
    })();
    entry.installPromise = install;
    try {
      await install;
    } catch (error) {
      if (entry.installPromise === install) entry.installPromise = undefined;
      throw error;
    }
  }

  private async attachInbound(entry: SessionEntry, stream: BitfsStreamLike): Promise<void> {
    if (entry.closed || entry.direction !== "inbound" || entry.stream != null) {
      this.abortStream(stream, "BitFS WebRTC stream is already attached");
      return;
    }
    entry.stream = stream;
    if (entry.firstFrame != null) await this.writeFrame(entry, entry.firstFrame);
    if (entry.closed) throw new Error("BitFS WebRTC session is closed");
    entry.ready.resolve(entry);
    this.startReadLoop(entry);
  }

  private startReadLoop(entry: SessionEntry): void {
    if (entry.readerStarted || entry.stream == null) return;
    entry.readerStarted = true;
    void this.readLoop(entry);
  }

  private async readLoop(entry: SessionEntry): Promise<void> {
    if (entry.stream == null) return;
    try {
      for await (const artifact of readArtifacts(entry.stream as unknown as Parameters<typeof readArtifacts>[0], {
        signal: entry.controller.signal,
        maxInboundFrameBytes: MAX_WIRE_FRAME_BYTES,
        maxBufferedBytes: MAX_WIRE_FRAME_BYTES + 10,
        maxBufferedFrames: 64
      })) {
        if (entry.closed || this.sessions.get(entry.sessionId) !== entry) return;
        const frame = artifact.bytes();
        if (frame.byteLength === 0 || frame.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error("BitFS WebRTC frame size is invalid");
        const exact = parse(frame.slice()).bytes();
        if (exact.byteLength !== frame.byteLength || exact.some((byte, index) => byte !== frame[index])) throw new Error("Non-canonical BitFS Artifact");
        await this.options.emit({
          type: "bitfs-webrtc-frame",
          sessionId: entry.sessionId,
          webrtcSessionId: entry.webrtcSessionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          frame: exact
        }, [exact.buffer]);
      }
      if (!entry.closed) await this.closeEntry(entry, "remote_closed", true);
    } catch (error) {
      if (entry.closed) return;
      this.reportError(entry, error);
      await this.closeEntry(entry, "stream_error", true, error);
    }
  }

  private async writeFrame(entry: SessionEntry, frame: Uint8Array): Promise<void> {
    if (entry.closed || entry.stream == null) throw new Error("BitFS WebRTC stream is not open");
    const artifact = parse(frame.slice());
    this.assertFrameSize(artifact.bytes());
    await this.writeArtifactAndWait(entry, artifact);
  }

  private async writeArtifactAndWait(entry: SessionEntry, artifact: BitfsArtifact): Promise<void> {
    if (entry.closed || entry.stream == null) throw new Error("BitFS WebRTC stream is not open");
    if (entry.stream.writableNeedsDrain) await waitForDrain(entry.stream, entry.controller.signal);
    if (entry.closed || entry.stream == null) throw new Error("BitFS WebRTC stream is not open");
    if (entry.controller.signal.aborted) throw normalizeError(entry.controller.signal.reason, "BitFS WebRTC stream is closed", "AbortError");
    if (!writeArtifact(entry.stream as unknown as Parameters<typeof writeArtifact>[0], artifact)) {
      await waitForDrain(entry.stream, entry.controller.signal);
    }
  }

  private assertFrameSize(frame: Uint8Array): void {
    if (frame.byteLength === 0 || frame.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error("BitFS WebRTC frame size is invalid");
  }

  private reserveSend(entry: SessionEntry, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_QUEUED_SEND_BYTES
      || entry.queuedSendBytes > MAX_QUEUED_SEND_BYTES - bytes) {
      throw new Error("BitFS WebRTC send queue limit reached");
    }
    entry.queuedSendBytes += bytes;
  }

  private async waitReady(entry: SessionEntry, signal?: AbortSignal): Promise<void> {
    if (entry.closed) throw new Error("BitFS WebRTC session is not open");
    const signals = new Set<AbortSignal>([entry.controller.signal]);
    if (signal != null) signals.add(signal);
    await waitAbortable(entry.ready.promise, signals, this.signalTimeoutMs(), "BitFS WebRTC connection timed out");
  }

  private signalTimeoutMs(): number {
    const value = this.options.signalTimeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SIGNAL_TIMEOUT_MS;
  }

  private toEnvelope(entry: SessionEntry, signal: WebRTCInterconnectSignal): WebRTCInterconnectEnvelope {
    const sequence = entry.remoteSequence++;
    return {
      connectionId: entry.connectionId,
      attemptId: entry.attemptId,
      from: entry.remotePeerId.toString(),
      to: entry.localPeerId.toString(),
      sequence,
      expiresAtMs: Date.now() + 120_000,
      signal
    };
  }

  private toSdkSignal(signal: Record<string, unknown>): WebRTCInterconnectSignal {
    if (signal.type === "answer" && typeof signal.sdp === "string") return { type: "answer", sdp: signal.sdp };
    if (signal.type === "offer" && typeof signal.sdp === "string") return { type: "offer", sdp: signal.sdp };
    if (signal.type === "end-of-candidates") return { type: "end-of-candidates" };
    if (signal.type === "ice-candidate") {
      const candidate = signal.candidate;
      if (candidate == null || typeof candidate !== "object") return { type: "ice-candidate", candidate: null };
      const value = candidate as Record<string, unknown>;
      if (typeof value.candidate !== "string") throw new Error("BitFS WebRTC ICE candidate is invalid");
      return {
        type: "ice-candidate",
        candidate: {
          candidate: value.candidate,
          sdpMid: typeof value.sdp_mid === "string" ? value.sdp_mid : null,
          sdpMLineIndex: typeof value.sdp_m_line_index === "number" ? value.sdp_m_line_index : null,
          ...(typeof value.username_fragment === "string" ? { usernameFragment: value.username_fragment } : {})
        }
      };
    }
    throw new Error("BitFS WebRTC signal type is invalid");
  }

  private assertEntryRelation(entry: SessionEntry, requestMessageId: string, webrtcSessionId: string, publicKeyHex: string, ownerSessionEpoch: string): void {
    if (entry.requestMessageId !== requestMessageId || entry.webrtcSessionId !== webrtcSessionId || entry.publicKeyHex !== publicKeyHex.toLowerCase() || entry.ownerSessionEpoch !== ownerSessionEpoch) {
      throw new Error("BitFS WebRTC signal relation does not match the session");
    }
  }

  private assertOpen(sessionId: string, ownerSessionEpoch: string, signal?: AbortSignal): void {
    if (this.disposed) throw new Error("BitFS WebRTC runtime is disposed");
    if (signal?.aborted) throw new DOMException("BitFS WebRTC setup was cancelled", "AbortError");
    if (!sessionId || sessionId.length > 128) throw new TypeError("BitFS WebRTC session id is invalid");
    if (ownerSessionEpoch !== this.options.ownerSessionEpoch) throw new Error("BitFS WebRTC owner generation changed");
  }

  private reportError(entry: SessionEntry, error: unknown): void {
    try {
      this.options.onError?.(error, { sessionId: entry.sessionId, webrtcSessionId: entry.webrtcSessionId, direction: entry.direction });
    } catch {
    }
  }

  private reportConnectionError(event: WebRTCInterconnectConnectionEvent, error: unknown): void {
    const entry = this.connectionOwners.get(event.connection)
      ?? this.connectionIdOwners.get(event.connectionId)
      ?? this.attemptOwners.get(event.attemptId);
    if (entry) this.reportError(entry, error);
  }

  private async closeEntry(entry: SessionEntry, reason: string, notify: boolean, error?: unknown): Promise<void> {
    if (entry.closed) {
      if (entry.closePromise != null) await entry.closePromise;
      return;
    }
    entry.closed = true;
    this.sessions.delete(entry.sessionId);
    this.detachEntry(entry);
    this.cleanupPendingForEntry(entry);
    try { entry.abortCleanup?.(); } catch { }
    entry.controller.abort(new DOMException("BitFS WebRTC session closed", "AbortError"));
    entry.ready.reject(new Error("BitFS WebRTC session closed"));
    const work = (async () => {
      this.abortStream(entry.stream, "BitFS WebRTC session closed");
      this.abortConnection(entry.connection, "BitFS WebRTC session closed");
      await Promise.all([closeStreamWithin(entry.stream), closeConnectionWithin(entry.connection)]);
      if (notify) {
        await emitWithin(this.options.emit, {
          type: "bitfs-webrtc-session-closed",
          sessionId: entry.sessionId,
          webrtcSessionId: entry.webrtcSessionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          reason: /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : "transport_error",
          ...(error === undefined ? {} : {
            errorCode: typeof error === "object" && error != null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "UNKNOWN",
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : typeof error
          })
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

  private detachEntry(entry: SessionEntry): void {
    if (this.connectionIdOwners.get(entry.connectionId) === entry) this.connectionIdOwners.delete(entry.connectionId);
    if (this.attemptOwners.get(entry.attemptId) === entry) this.attemptOwners.delete(entry.attemptId);
    if (entry.connection != null && this.connectionOwners.get(entry.connection) === entry) {
      this.retiredConnections.add(entry.connection);
      this.connectionOwners.delete(entry.connection);
    }
    try { entry.unregister(); } catch { }
  }

  private cleanupPendingForEntry(entry: SessionEntry): void {
    for (const [connection, pending] of this.pendingInbound) {
      if (pending.candidates.delete(entry) || pending.connection === entry.connection || pending.candidates.size === 0) {
        this.pendingInbound.delete(connection);
        this.abortStreams(pending.streams, "BitFS WebRTC pending stream was closed");
      }
    }
  }

  private abortAllPending(reason: string): void {
    for (const pending of this.pendingInbound.values()) this.abortStreams(pending.streams, reason);
    this.pendingInbound.clear();
  }

  private abortStreams(streams: readonly BitfsStreamLike[], reason: string): void {
    for (const stream of streams) this.abortStream(stream, reason);
  }

  private abortStream(stream: BitfsStreamLike | undefined, reason: string): void {
    if (stream == null) return;
    try { stream.abort(new Error(reason)); } catch { }
  }

  private abortConnection(connection: BitfsConnection | undefined, reason: string): void {
    if (connection == null) return;
    try { connection.abort(new Error(reason)); } catch { }
  }
}

async function closeHostHandler(host: BitfsWebRtcHost): Promise<void> {
  await settleWithin(Promise.resolve().then(() => host.unhandle(BITFS_PROTOCOL_ID)), TEARDOWN_TIMEOUT_MS);
}

async function closeStreamWithin(stream: BitfsStreamLike | undefined): Promise<void> {
  if (stream == null) return;
  const settled = await settleWithin(Promise.resolve().then(() => stream.close()), TEARDOWN_TIMEOUT_MS);
  if (!settled) abortStreamAfterTimeout(stream);
}

async function closeConnectionWithin(connection: BitfsConnection | undefined): Promise<void> {
  if (connection == null) return;
  const settled = await settleWithin(Promise.resolve().then(() => connection.close()), TEARDOWN_TIMEOUT_MS);
  if (!settled) {
    try { connection.abort(new Error("BitFS WebRTC connection close timed out")); } catch { }
  }
}

function abortStreamAfterTimeout(stream: BitfsStreamLike): void {
  try { stream.abort(new Error("BitFS WebRTC stream close timed out")); } catch { }
}

async function emitWithin(
  emit: (event: BitfsWebRtcStreamEvent, transfer?: Transferable[]) => Promise<void> | void,
  event: BitfsWebRtcStreamEvent,
): Promise<void> {
  await settleWithin(Promise.resolve().then(() => emit(event)), TEARDOWN_TIMEOUT_MS);
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

async function waitAbortable<T>(promise: Promise<T>, signals: ReadonlySet<AbortSignal>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  void promise.catch(() => undefined);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (error?: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      if (error === undefined) resolve(value as T);
      else reject(normalizeError(error, timeoutMessage));
    };
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    for (const signal of signals) {
      if (settled) break;
      const onAbort = (): void => finish(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      cleanups.push(cleanup);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    promise.then(value => finish(undefined, value), error => finish(error));
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
      else reject(normalizeError(error, "stream closed while waiting for drain"));
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

function samePeer(expected: { equals(other: unknown): boolean; toString(): string }, actual: unknown): boolean {
  if (actual != null && typeof actual === "object" && "equals" in actual && typeof (actual as { equals?: unknown }).equals === "function") {
    return (actual as { equals(other: unknown): boolean }).equals(expected);
  }
  return String(actual) === expected.toString();
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

function normalizeError(value: unknown, fallback: string, name = "Error"): Error {
  if (value instanceof Error) return value;
  const error = new Error(value === undefined ? fallback : String(value));
  error.name = name;
  return error;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
