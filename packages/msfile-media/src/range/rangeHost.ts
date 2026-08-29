// 页面侧 Range Host 与 Service Worker 的 MessageChannel 桥。
//
// Service Worker 只负责同源 HTTP 外壳；本文件所在的受信任页面才持有
// `msfile.service` 适配后的 RangeSource。每次 pull 只传输一块已经校验的
// Uint8Array，并且使用 transfer，禁止把整个 requested range 拼在内存里。

import { MSFILE_BLOCK_SIZE_BYTES } from "@keymaster/contracts";
import { MsFileMediaError, normalizeMediaError } from "../core/errors.js";
import type { MsFileMediaDebugValue, MsFileVodSourceInput } from "../core/types.js";
import { MsFileRangeSource, type MsFileRangeResponse, type MsFileRangeSourceOptions, type MsFileRangeSourceSnapshot } from "./rangeSource.js";

export const MSFILE_MEDIA_RANGE_PROTOCOL_VERSION = 1;
export const MSFILE_MEDIA_RANGE_PATH_PREFIX = "/__keymaster/msfile-media/";
const MSFILE_MEDIA_PROTOCOL_PROBE = "msfile-media-protocol-probe";
const MSFILE_MEDIA_PROTOCOL_PROBE_RESULT = "msfile-media-protocol-probe-result";
const MSFILE_MEDIA_BIND_SESSION = "msfile-media-bind-session";
const MSFILE_MEDIA_BIND_SESSION_RESULT = "msfile-media-bind-session-result";
const MSFILE_MEDIA_REVOKE_SESSION = "msfile-media-revoke-session";
const MSFILE_MEDIA_REVOKE_SESSION_RESULT = "msfile-media-revoke-session-result";
const DEFAULT_SERVICE_WORKER_URL = "/msfile-media-sw.js";
const DEFAULT_SERVICE_WORKER_SCOPE = "/";
const DEFAULT_SERVICE_WORKER_TIMEOUT_MS = 5000;

export interface MsFileMediaServiceWorkerInfo {
  /** 页面侧要求的协议版本。 */
  protocolVersion: number;
  /** 当前配置的 Service Worker 绝对脚本地址。 */
  scriptUrl: string;
  /** 当前配置的 Service Worker 作用域。 */
  scope: string;
}

export interface MsFileRangeRequestMessage {
  /** MessageChannel 请求类型。 */
  type: "msfile-media-range-request";
  /** 页面与 Service Worker 必须同时支持的协议版本。 */
  version: number;
  /** Service Worker 观察到的创建该请求的 Client.id；页面 session 首次请求时绑定。 */
  clientId: string;
  /** 仅存在于页面内存中的临时 session 标识。 */
  sessionId: string;
  /** 当前 HTTP 请求在该 session 内的临时标识。 */
  requestId: string;
  /** 原生媒体请求方法；首版只接受 GET/HEAD。 */
  method: string;
  /** 原始单 Range 请求头；缺失表示从文件起点读取。 */
  range?: string;
}

interface MsFileRangePullMessage {
  type: "msfile-media-range-pull";
  version: number;
  requestId: string;
}

interface MsFileRangeCancelMessage {
  type: "msfile-media-range-cancel";
  version: number;
  requestId: string;
}

export interface MsFileRangeResponseMessage {
  /** HTTP 元数据响应消息类型。 */
  type: "msfile-media-range-response";
  /** 页面与 Service Worker 必须同时支持的协议版本。 */
  version: number;
  /** 与请求对应的临时标识。 */
  requestId: string;
  /** HTTP 响应状态码。 */
  status: number;
  /** 文件总字节数。 */
  totalBytes: number;
  /** 正文起点，包含该字节。 */
  startByte: number;
  /** 正文终点，不包含该字节。 */
  endByteExclusive: number;
  /** 本次响应正文的精确长度。 */
  contentLength: number;
  /** 206 的闭区间 Content-Range，或 416 的未满足范围描述。 */
  contentRange?: string;
  /** 通过 declared MIME 白名单收敛后的媒体 MIME。 */
  mediaType?: string;
}

interface MsFileRangeChunkMessage {
  type: "msfile-media-range-chunk";
  version: number;
  requestId: string;
  bytes: ArrayBuffer;
}

interface MsFileRangeDoneMessage {
  type: "msfile-media-range-done";
  version: number;
  requestId: string;
}

interface MsFileRangeErrorMessage {
  type: "msfile-media-range-error";
  version: number;
  requestId: string;
  status: number;
  code: string;
}

type MsFileRangePortMessage =
  | MsFileRangePullMessage
  | MsFileRangeCancelMessage;

export interface MsFileRangeHostOptions {
  /** 默认开启的安全诊断；不输出 session URL、Hash、媒体字节或身份。 */
  onDebug?(scope: string, action: string, details: Record<string, MsFileMediaDebugValue>): void;
}

export interface MsFileRangeSessionHandle {
  readonly sessionId: string;
  readonly url: string;
  readonly source: MsFileRangeSource;
  /** 在把 url 交给 HTMLMediaElement 前，固定创建页面的 Client.id。 */
  bind(): Promise<void>;
  snapshot(): MsFileRangeSourceSnapshot;
  dispose(): Promise<void>;
}

interface ActiveRangeRequest {
  requestId: string;
  method: string;
  requestedRange?: string;
  port: MessagePort;
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  response?: MsFileRangeResponse;
  outputBytes: number;
  supplierReadCountAtStart: number;
  pullInFlight: boolean;
  finished: boolean;
}

function randomSessionId(): string {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) throw new MsFileMediaError("msfile_media_browser_capability");
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function randomRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(12);
    cryptoObject.getRandomValues(bytes);
    let value = "r";
    for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
    return value;
  }
  return `r${String(Date.now())}`;
}

function safeContentType(value: string | undefined): string | undefined {
  if (!value || value.length > 96 || !/^(audio|video)\/[a-z0-9.+-]+$/i.test(value)) return undefined;
  return value.toLowerCase();
}

function safeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function statusForMediaError(error: MsFileMediaError): number {
  switch (error.code) {
    case "msfile_media_range_invalid": return 416;
    case "msfile_media_amount": return 402;
    case "msfile_media_network": return 503;
    case "msfile_media_unsupported_container":
    case "msfile_media_unsupported_codec":
    case "msfile_media_native_unsupported": return 415;
    case "msfile_media_service_worker": return 503;
    case "msfile_media_cancelled": return 499;
    default: return 502;
  }
}

function responseHeadersMessage(
  requestId: string,
  response: MsFileRangeResponse,
): MsFileRangeResponseMessage {
  const message: MsFileRangeResponseMessage = {
    type: "msfile-media-range-response",
    version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
    requestId,
    status: response.status,
    totalBytes: response.totalBytes,
    startByte: response.startByte,
    endByteExclusive: response.endByteExclusive,
    contentLength: response.contentLength,
  };
  if (response.contentRange) message.contentRange = response.contentRange;
  const mediaType = safeContentType(response.mediaType);
  if (mediaType) message.mediaType = mediaType;
  return message;
}

function rangeText(response: MsFileRangeResponse | undefined, requestedRange: string | undefined): string | null {
  if (response && response.status !== 416 && response.contentLength > 0) {
    return `bytes=${String(response.startByte)}-${String(response.endByteExclusive - 1)}`;
  }
  if (requestedRange) return requestedRange.slice(0, 128);
  return null;
}

function unknownSessionResponse(requestId: string): MsFileRangeResponseMessage {
  return {
    type: "msfile-media-range-response",
    version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
    requestId,
    status: 404,
    totalBytes: 0,
    startByte: 0,
    endByteExclusive: 0,
    contentLength: 0,
  };
}

function postPort(port: MessagePort, message: object, transfer: Transferable[] = []): boolean {
  try {
    port.postMessage(message, transfer);
    return true;
  } catch {
    return false;
  }
}

function closePortSoon(port: MessagePort): void {
  setTimeout(() => {
    try { port.close(); } catch { /* channel already closed */ }
  }, 0);
}

class RangeHostSession implements MsFileRangeSessionHandle {
  readonly url: string;
  private readonly activeRequests = new Map<string, ActiveRangeRequest>();
  private ownerClientId: string | undefined;
  private binding: Promise<void> | undefined;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    readonly source: MsFileRangeSource,
    private readonly sessionDebug: (scope: string, action: string, details: Record<string, MsFileMediaDebugValue>) => void,
    private readonly onRevoked: () => void,
  ) {
    this.url = `${MSFILE_MEDIA_RANGE_PATH_PREFIX}${sessionId}`;
  }

  snapshot(): MsFileRangeSourceSnapshot { return this.source.snapshot(); }

  /** 仅由 SW bind-session 响应调用；HTTP Range 请求不能建立 owner。 */
  bindClient(clientId: string): void {
    if (this.disposed || !clientId) throw new MsFileMediaError("msfile_media_service_worker");
    if (this.ownerClientId && this.ownerClientId !== clientId) throw new MsFileMediaError("msfile_media_service_worker");
    this.ownerClientId = clientId;
    this.sessionDebug("range", "session.bound", {});
  }

  private acceptsClient(clientId: string | undefined): boolean {
    return Boolean(clientId && this.ownerClientId && clientId === this.ownerClientId);
  }

  async bind(): Promise<void> {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.ownerClientId) return;
    if (this.binding) return this.binding;
    this.binding = (async () => {
      if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller || typeof MessageChannel === "undefined") {
        throw new MsFileMediaError("msfile_media_service_worker");
      }
      const controller = navigator.serviceWorker.controller;
      const channel = new MessageChannel();
      const timeoutMs = serviceWorkerConfig.timeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new MsFileMediaError("msfile_media_service_worker")), timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          channel.port1.removeEventListener("message", onMessage);
          channel.port1.onmessageerror = null;
          try { channel.port1.close(); } catch { /* channel already closed */ }
        };
        const finish = (error?: MsFileMediaError) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data as {
            type?: unknown;
            version?: unknown;
            sessionId?: unknown;
            ok?: unknown;
            clientId?: unknown;
          } | undefined;
          if (!message || message.type !== MSFILE_MEDIA_BIND_SESSION_RESULT || message.version !== MSFILE_MEDIA_RANGE_PROTOCOL_VERSION ||
            message.sessionId !== this.sessionId) return;
          if (message.ok !== true || typeof message.clientId !== "string" || message.clientId.length === 0) {
            finish(new MsFileMediaError("msfile_media_service_worker"));
            return;
          }
          try {
            this.bindClient(message.clientId);
            finish();
          } catch (error) {
            finish(error instanceof MsFileMediaError ? error : new MsFileMediaError("msfile_media_service_worker"));
          }
        };
        channel.port1.addEventListener("message", onMessage);
        channel.port1.onmessageerror = () => finish(new MsFileMediaError("msfile_media_service_worker"));
        channel.port1.start();
        try {
          controller.postMessage({
            type: MSFILE_MEDIA_BIND_SESSION,
            version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
            sessionId: this.sessionId,
          }, [channel.port2]);
        } catch {
          finish(new MsFileMediaError("msfile_media_service_worker"));
        }
      });
    })().finally(() => {
      this.binding = undefined;
    });
    return this.binding;
  }

  async handle(message: MsFileRangeRequestMessage, port: MessagePort): Promise<void> {
    if (this.disposed || message.version !== MSFILE_MEDIA_RANGE_PROTOCOL_VERSION || !this.acceptsClient(message.clientId)) {
      postPort(port, unknownSessionResponse(message.requestId));
      postPort(port, { type: "msfile-media-range-done", version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION, requestId: message.requestId } satisfies MsFileRangeDoneMessage);
      closePortSoon(port);
      return;
    }
    if (this.activeRequests.has(message.requestId)) {
      postPort(port, {
        type: "msfile-media-range-error",
        version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
        requestId: message.requestId,
        status: 409,
        code: "msfile_media_service_worker",
      } satisfies MsFileRangeErrorMessage);
      closePortSoon(port);
      return;
    }

    const request: ActiveRangeRequest = {
      requestId: message.requestId,
      method: message.method.toUpperCase(),
      requestedRange: typeof message.range === "string" ? message.range.slice(0, 128) : undefined,
      port,
      controller: new AbortController(),
      outputBytes: 0,
      supplierReadCountAtStart: this.source.snapshot().supplierReadCount,
      pullInFlight: false,
      finished: false,
    };
    this.activeRequests.set(request.requestId, request);
    port.onmessage = (event: MessageEvent<unknown>) => {
      const incoming = event.data as Partial<MsFileRangePortMessage> | undefined;
      if (!incoming || incoming.version !== MSFILE_MEDIA_RANGE_PROTOCOL_VERSION || incoming.requestId !== request.requestId) return;
      if (incoming.type === "msfile-media-range-cancel") {
        this.cancelRequest(request, "cancel-message");
      } else if (incoming.type === "msfile-media-range-pull") {
        void this.pull(request);
      }
    };
    port.start();

    try {
      this.source.beginRequest();
      const response = await this.source.describeResponse(message.method, message.range, request.controller.signal);
      if (request.finished || request.controller.signal.aborted) return;
      request.response = response;
      this.sessionDebug("range", "request.begin", {
        requestId: request.requestId,
        method: request.method,
        range: rangeText(response, request.requestedRange),
        start: response.status === 416 ? null : response.startByte,
        end: response.status === 416 ? null : response.endByteExclusive - 1,
        total: response.totalBytes,
      });
      const blockCount = response.status === 416 || response.contentLength === 0
        ? 0
        : Math.floor((response.endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES) - Math.floor(response.startByte / MSFILE_BLOCK_SIZE_BYTES) + 1;
      this.sessionDebug("range", "request.mapped", {
        requestId: request.requestId,
        range: rangeText(response, request.requestedRange),
        firstBlock: response.status === 416 || response.contentLength === 0 ? null : Math.floor(response.startByte / MSFILE_BLOCK_SIZE_BYTES),
        lastBlock: response.status === 416 || response.contentLength === 0 ? null : Math.floor((response.endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES),
        blockCount,
      });
      if (!postPort(port, responseHeadersMessage(request.requestId, response))) {
        this.cancelRequest(request, "response-post-failed");
        return;
      }
      if (response.status === 416 || message.method.toUpperCase() === "HEAD" || response.contentLength === 0) {
        this.finishRequest(request, response.status, false);
        return;
      }
      request.reader = this.source.readStream(response.startByte, response.endByteExclusive, request.controller.signal).getReader();
      // GET 正文只在 SW 发来 pull 后读取；这里不能主动启动下一个 Block。
    } catch (error) {
      if (request.finished || request.controller.signal.aborted) return;
      const normalized = normalizeMediaError(error, request.controller.signal);
      const status = statusForMediaError(normalized);
      this.sessionDebug("range", "request.failed", {
        requestId: request.requestId,
        method: request.method,
        range: rangeText(request.response, request.requestedRange),
        firstBlock: null,
        lastBlock: null,
        stage: "metadata",
        status,
        code: normalized.code,
      });
      postPort(port, {
        type: "msfile-media-range-error",
        version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        status,
        code: normalized.code,
      } satisfies MsFileRangeErrorMessage);
      this.finishRequest(request, status, false);
    }
  }

  private async pull(request: ActiveRangeRequest): Promise<void> {
    if (request.finished || request.pullInFlight || !request.reader) return;
    request.pullInFlight = true;
    try {
      const next = await request.reader.read();
      if (request.finished || request.controller.signal.aborted) return;
      if (next.done) {
        if (request.response && request.outputBytes !== request.response.contentLength) {
          throw new MsFileMediaError("msfile_media_integrity");
        }
        postPort(request.port, {
          type: "msfile-media-range-done",
          version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
          requestId: request.requestId,
        } satisfies MsFileRangeDoneMessage);
        this.finishRequest(request, request.response?.status ?? 206, false);
        return;
      }
      const bytes = next.value.slice();
      request.outputBytes += bytes.byteLength;
      const sent = postPort(request.port, {
        type: "msfile-media-range-chunk",
        version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        bytes: bytes.buffer,
      } satisfies MsFileRangeChunkMessage, [bytes.buffer]);
      if (!sent) this.cancelRequest(request, "chunk-post-failed");
    } catch (error) {
      if (request.finished || request.controller.signal.aborted) return;
      const normalized = normalizeMediaError(error, request.controller.signal);
      const status = statusForMediaError(normalized);
      this.sessionDebug("range", "request.failed", {
        requestId: request.requestId,
        method: request.method,
        range: rangeText(request.response, request.requestedRange),
        firstBlock: request.response && request.response.contentLength > 0 ? Math.floor(request.response.startByte / MSFILE_BLOCK_SIZE_BYTES) : null,
        lastBlock: request.response && request.response.contentLength > 0 ? Math.floor((request.response.endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES) : null,
        stage: "body-pull",
        status,
        code: normalized.code,
      });
      postPort(request.port, {
        type: "msfile-media-range-error",
        version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        status,
        code: normalized.code,
      } satisfies MsFileRangeErrorMessage);
      this.finishRequest(request, status, false);
    } finally {
      request.pullInFlight = false;
    }
  }

  private cancelRequest(request: ActiveRangeRequest, stage: string): void {
    if (request.finished) return;
    request.controller.abort();
    void request.reader?.cancel().catch(() => undefined);
    this.sessionDebug("range", "request.cancelled", {
      requestId: request.requestId,
      method: request.method,
      range: rangeText(request.response, request.requestedRange),
      firstBlock: request.response && request.response.contentLength > 0 ? Math.floor(request.response.startByte / MSFILE_BLOCK_SIZE_BYTES) : null,
      lastBlock: request.response && request.response.contentLength > 0 ? Math.floor((request.response.endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES) : null,
      outputBytes: request.outputBytes,
      stage,
      reason: stage,
    });
    this.finishRequest(request, 499, true);
  }

  private finishRequest(request: ActiveRangeRequest, status: number, cancelled: boolean): void {
    if (request.finished) return;
    request.finished = true;
    this.activeRequests.delete(request.requestId);
    this.source.endRequest();
    if (!cancelled) {
      this.sessionDebug("range", "request.done", {
        requestId: request.requestId,
        method: request.method,
        range: rangeText(request.response, request.requestedRange),
        firstBlock: request.response && request.response.contentLength > 0 ? Math.floor(request.response.startByte / MSFILE_BLOCK_SIZE_BYTES) : null,
        lastBlock: request.response && request.response.contentLength > 0 ? Math.floor((request.response.endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES) : null,
        status,
        outputBytes: request.outputBytes,
        supplierReadCount: Math.max(0, this.source.snapshot().supplierReadCount - request.supplierReadCountAtStart),
      });
    }
    // 不在 postMessage(done/response) 后立即 close：部分浏览器会丢弃仍在
    // MessagePort 队列中的最后一条消息。SW 收到 done/response 后负责关闭端口。
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const revokePromise = this.revokeFromServiceWorker();
    for (const request of this.activeRequests.values()) this.cancelRequest(request, "session-dispose");
    this.activeRequests.clear();
    await revokePromise;
    await this.source.dispose();
    this.onRevoked();
  }

  /** 等待 SW 确认删除绑定；旧 SW 不理解 ack 时以短超时 fail closed。 */
  private async revokeFromServiceWorker(): Promise<void> {
    if (this.ownerClientId && typeof navigator !== "undefined" && navigator.serviceWorker?.controller) {
      const controller = navigator.serviceWorker.controller;
      if (typeof MessageChannel === "undefined") return;
      const channel = new MessageChannel();
      try {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            channel.port1.removeEventListener("message", onMessage);
            channel.port1.onmessageerror = null;
            try { channel.port1.close(); } catch { /* channel already closed */ }
            resolve();
          };
          const timer = setTimeout(finish, 250);
          const onMessage = (event: MessageEvent<unknown>) => {
            const message = event.data as { type?: unknown; version?: unknown; sessionId?: unknown } | undefined;
            if (message?.type === MSFILE_MEDIA_REVOKE_SESSION_RESULT &&
              message.version === MSFILE_MEDIA_RANGE_PROTOCOL_VERSION && message.sessionId === this.sessionId) finish();
          };
          channel.port1.addEventListener("message", onMessage);
          channel.port1.onmessageerror = finish;
          channel.port1.start();
          controller.postMessage({
            type: MSFILE_MEDIA_REVOKE_SESSION,
            version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
            sessionId: this.sessionId,
            clientId: this.ownerClientId,
          }, [channel.port2]);
        });
      } catch { /* SW 已更新或页面正在销毁 */ }
    }
  }
}

export class MsFileRangeHost {
  private readonly sessions = new Map<string, RangeHostSession>();
  private readonly onMessageBound: (event: MessageEvent<unknown>) => void;
  private disposed = false;

  constructor(private readonly options: MsFileRangeHostOptions = {}) {
    this.onMessageBound = (event) => this.onMessage(event);
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", this.onMessageBound);
    }
  }

  debug(scope: string, action: string, details: Record<string, MsFileMediaDebugValue> = {}): void {
    this.options.onDebug?.(scope, action, details);
  }

  createSession(
    input: MsFileVodSourceInput,
    options: { onDebug?(scope: string, action: string, details: Record<string, MsFileMediaDebugValue>): void } = {},
  ): MsFileRangeSessionHandle {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    let sessionId = randomSessionId();
    while (this.sessions.has(sessionId)) sessionId = randomSessionId();
    const sessionDebug = options.onDebug ?? ((scope, action, details) => this.debug(scope, action, details));
    const sourceOptions: MsFileRangeSourceOptions = {
      maxConcurrentReads: 2,
      onDebug: (action, details) => sessionDebug("range", action, details),
    };
    let session: RangeHostSession | undefined;
    const onRevoked = () => {
      if (session && this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId);
        sessionDebug("range", "session.revoked", {});
      }
    };
    session = new RangeHostSession(sessionId, new MsFileRangeSource(input, sourceOptions), sessionDebug, onRevoked);
    this.sessions.set(sessionId, session);
    sessionDebug("range", "session.created", {
      fileSizeBytes: input.fileSizeBytes <= MAX_SAFE_BIGINT ? Number(input.fileSizeBytes) : null,
      declaredMediaType: input.declaredMediaType || "empty",
    });
    return session;
  }

  private onMessage(event: MessageEvent<unknown>): void {
    const message = event.data as Partial<MsFileRangeRequestMessage> | undefined;
    const port = event.ports?.[0];
    if (!message || message.type !== "msfile-media-range-request" || !port ||
      typeof message.clientId !== "string" || message.clientId.length === 0 ||
      typeof message.sessionId !== "string" || typeof message.requestId !== "string") return;
    const session = this.sessions.get(message.sessionId);
    if (!session || message.version !== MSFILE_MEDIA_RANGE_PROTOCOL_VERSION) {
      postPort(port, unknownSessionResponse(message.requestId));
      postPort(port, { type: "msfile-media-range-done", version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION, requestId: message.requestId } satisfies MsFileRangeDoneMessage);
      closePortSoon(port);
      return;
    }
    void session.handle(message as MsFileRangeRequestMessage, port);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      navigator.serviceWorker.removeEventListener("message", this.onMessageBound);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
let defaultRangeHost: MsFileRangeHost | undefined;

/** 单页面共享一个 message listener，避免每个媒体元素重复接收 SW 消息。 */
export function getMsFileRangeHost(): MsFileRangeHost {
  return defaultRangeHost ??= new MsFileRangeHost();
}

export interface MsFileMediaServiceWorkerConfig {
  /** 根作用域 Service Worker 脚本 URL。 */
  scriptUrl: string;
  /** 必须是 `/`，使虚拟媒体 URL 可被全站页面消费。 */
  scope?: string;
  /** 等待首次 controller claim 的超时。 */
  timeoutMs?: number;
}

let serviceWorkerConfig: MsFileMediaServiceWorkerConfig = {
  scriptUrl: DEFAULT_SERVICE_WORKER_URL,
  scope: DEFAULT_SERVICE_WORKER_SCOPE,
  timeoutMs: DEFAULT_SERVICE_WORKER_TIMEOUT_MS,
};
let serviceWorkerReady: Promise<void> | undefined;

export function configureMsFileMediaServiceWorker(config: MsFileMediaServiceWorkerConfig): void {
  if (!config || typeof config.scriptUrl !== "string" || config.scriptUrl.length === 0 || config.scope !== undefined && config.scope !== "/" ||
    config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 60_000)) {
    throw new MsFileMediaError("msfile_media_configuration");
  }
  serviceWorkerConfig = { ...config, scope: config.scope ?? "/", timeoutMs: config.timeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS };
  serviceWorkerReady = undefined;
}

export function hasMsFileMediaServiceWorkerController(): boolean {
  const controller = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : undefined;
  if (!controller) return false;
  try {
    const expected = new URL(serviceWorkerConfig.scriptUrl, globalThis.location?.href ?? "http://localhost/").href;
    return controller.scriptURL === expected;
  } catch {
    return false;
  }
}

/** 返回 Debug 所需的当前媒体 Service Worker 协议与脚本信息。 */
export function getMsFileMediaServiceWorkerInfo(): MsFileMediaServiceWorkerInfo {
  let scriptUrl = serviceWorkerConfig.scriptUrl;
  try {
    scriptUrl = new URL(scriptUrl, globalThis.location?.href ?? "http://localhost/").href;
  } catch { /* 配置校验已在 configure 阶段完成，保留原值便于诊断 */ }
  return {
    protocolVersion: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
    scriptUrl,
    scope: serviceWorkerConfig.scope ?? DEFAULT_SERVICE_WORKER_SCOPE,
  };
}

function waitForController(timeoutMs: number): Promise<void> {
  if (hasMsFileMediaServiceWorkerController()) return Promise.resolve();
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return Promise.reject(new MsFileMediaError("msfile_media_service_worker"));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new MsFileMediaError("msfile_media_service_worker")), timeoutMs);
    const onChange = () => {
      if (hasMsFileMediaServiceWorkerController()) finish();
    };
    const finish = (error?: MsFileMediaError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      if (error) reject(error);
      else resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange, { once: false });
    onChange();
  });
}

async function probeMsFileMediaServiceWorker(timeoutMs: number): Promise<void> {
  if (!hasMsFileMediaServiceWorkerController() || typeof MessageChannel === "undefined") {
    throw new MsFileMediaError("msfile_media_service_worker");
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new MsFileMediaError("msfile_media_service_worker");
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new MsFileMediaError("msfile_media_service_worker")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      channel.port1.removeEventListener("message", onMessage);
      channel.port1.onmessageerror = null;
      try { channel.port1.close(); } catch { /* channel already closed */ }
    };
    const finish = (error?: MsFileMediaError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: unknown; version?: unknown; supported?: unknown } | undefined;
      if (!message || message.type !== MSFILE_MEDIA_PROTOCOL_PROBE_RESULT) return;
      if (message.version !== MSFILE_MEDIA_RANGE_PROTOCOL_VERSION || message.supported !== true) {
        finish(new MsFileMediaError("msfile_media_service_worker"));
        return;
      }
      finish();
    };
    channel.port1.addEventListener("message", onMessage);
    channel.port1.onmessageerror = () => finish(new MsFileMediaError("msfile_media_service_worker"));
    channel.port1.start();
    try {
      controller.postMessage({
        type: MSFILE_MEDIA_PROTOCOL_PROBE,
        version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
      }, [channel.port2]);
    } catch {
      finish(new MsFileMediaError("msfile_media_service_worker"));
    }
  });
}

/** 注册并等待当前页面被控制；失败只返回稳定错误，调用方负责降级下载。 */
export async function ensureMsFileMediaServiceWorker(): Promise<void> {
  const cachedReady = serviceWorkerReady;
  if (cachedReady) {
    try {
      await cachedReady;
      // 缓存的 Promise 可能对应旧版本 SW；每次复用前都重新握手，避免旧
      // controller 被当成当前协议实现。握手失败后允许下面的 register/update
      // 流程重新接管页面。
      await probeMsFileMediaServiceWorker(serviceWorkerConfig.timeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS);
      return;
    } catch {
      if (serviceWorkerReady === cachedReady) serviceWorkerReady = undefined;
    }
  }
  serviceWorkerReady = (async () => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) throw new MsFileMediaError("msfile_media_service_worker");
    try {
      // 即使当前已有 controller，也必须重新 register 当前脚本；旧版本/其他根
      // 作用域 SW 不能被“有 controller”这个布尔值误判为媒体 SW。
      const registration = await navigator.serviceWorker.register(serviceWorkerConfig.scriptUrl, {
        scope: serviceWorkerConfig.scope ?? "/",
        type: "module",
      });
      try { await registration.update(); } catch { /* ready/controller 检查会继续 fail closed */ }
      await navigator.serviceWorker.ready;
      await waitForController(serviceWorkerConfig.timeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS);
      await probeMsFileMediaServiceWorker(serviceWorkerConfig.timeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS);
    } catch (error) {
      throw error instanceof MsFileMediaError ? error : new MsFileMediaError("msfile_media_service_worker");
    }
  })();
  try {
    await serviceWorkerReady;
  } catch (error) {
    serviceWorkerReady = undefined;
    throw error;
  }
}

export function createMsFileRangeSession(input: MsFileVodSourceInput): MsFileRangeSessionHandle {
  return getMsFileRangeHost().createSession(input);
}

export function rangeSessionRequestId(): string { return randomRequestId(); }
