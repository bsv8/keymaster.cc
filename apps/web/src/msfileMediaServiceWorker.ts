// 根作用域 MSFile 原生媒体 Service Worker。
//
// 这是一个极薄的同源 HTTP 外壳：只有固定的虚拟媒体前缀进入这里，其余请求
// 完全透传。Vault、私钥、supplier、Seed/Block Hash 和媒体字节只存在页面内的
// Range Host，绝不写入 Service Worker 的 Cache/platform K-V repository/日志。

const PROTOCOL_VERSION = 1;
const MEDIA_PREFIX = "/__keymaster/msfile-media/";
const MAX_CHUNK_BYTES = 256 * 1024;
let requestSequence = 0;

interface FetchEventLike {
  request: Request;
  clientId: string;
  respondWith(response: Promise<Response>): void;
}

interface WorkerClientLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

interface WorkerClientsLike {
  get(clientId: string): Promise<WorkerClientLike | undefined>;
  claim(): Promise<void>;
}

interface WorkerScopeLike {
  clients: WorkerClientsLike;
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

interface WorkerMessageEventLike {
  data: unknown;
  ports: readonly MessagePort[];
  source?: { id?: unknown } | null;
}

interface RangeRequestMessage {
  type: "msfile-media-range-request";
  version: number;
  /** 当前 FetchEvent 所属页面的 Client.id，用于页面 session 绑定。 */
  clientId: string;
  sessionId: string;
  requestId: string;
  method: string;
  range?: string;
}

interface RangeResponseMessage {
  type: "msfile-media-range-response";
  version: number;
  requestId: string;
  status: number;
  totalBytes: number;
  startByte: number;
  endByteExclusive: number;
  contentLength: number;
  contentRange?: string;
  mediaType?: string;
}

interface RangeChunkMessage {
  type: "msfile-media-range-chunk";
  version: number;
  requestId: string;
  bytes: ArrayBuffer;
}

interface RangeDoneMessage {
  type: "msfile-media-range-done";
  version: number;
  requestId: string;
}

interface RangeErrorMessage {
  type: "msfile-media-range-error";
  version: number;
  requestId: string;
  status: number;
  code: string;
}

interface RangePullMessage {
  type: "msfile-media-range-pull";
  version: number;
  requestId: string;
}

interface RangeCancelMessage {
  type: "msfile-media-range-cancel";
  version: number;
  requestId: string;
}

interface ProtocolProbeMessage {
  type: "msfile-media-protocol-probe";
  version: number;
}

interface BindSessionMessage {
  type: "msfile-media-bind-session";
  version: number;
  sessionId: string;
}

interface RevokeSessionMessage {
  type: "msfile-media-revoke-session";
  version: number;
  sessionId: string;
  clientId: string;
}

type RangePortMessage = RangeResponseMessage | RangeChunkMessage | RangeDoneMessage | RangeErrorMessage;

function workerScope(): WorkerScopeLike {
  return globalThis as unknown as WorkerScopeLike;
}

function requestId(): string {
  requestSequence += 1;
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(12);
    cryptoObject.getRandomValues(bytes);
    let value = "r";
    for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
    return value;
  }
  return `r${String(requestSequence)}`;
}

function safeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeMediaType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 && /^(audio|video)\/[a-z0-9.+-]+$/i.test(value);
}

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Accept-Ranges", "bytes");
  return headers;
}

function validateResponseMessage(message: RangeResponseMessage): Headers | undefined {
  if (!safeNumber(message.totalBytes) || !safeNumber(message.startByte) || !safeNumber(message.endByteExclusive) ||
    !safeNumber(message.contentLength) || message.startByte > message.endByteExclusive ||
    message.endByteExclusive > message.totalBytes || message.contentLength !== message.endByteExclusive - message.startByte) {
    return undefined;
  }
  const headers = noStoreHeaders();
  headers.set("Content-Length", String(message.contentLength));
  if (message.status === 206) {
    if (!safeMediaType(message.mediaType) || !message.contentRange ||
      message.contentRange !== `bytes ${String(message.startByte)}-${String(message.endByteExclusive - 1)}/${String(message.totalBytes)}`) return undefined;
    headers.set("Content-Type", message.mediaType);
    headers.set("Content-Range", message.contentRange);
  } else if (message.status === 200) {
    if (!safeMediaType(message.mediaType) || message.startByte !== 0 || message.endByteExclusive !== message.totalBytes) return undefined;
    headers.set("Content-Type", message.mediaType);
  } else if (message.status === 416) {
    if (message.contentRange !== `bytes */${String(message.totalBytes)}` || message.contentLength !== 0) return undefined;
    headers.set("Content-Range", message.contentRange);
  } else if (message.status !== 404) {
    return undefined;
  }
  return headers;
}

function post(port: MessagePort, message: object, transfer: Transferable[] = []): boolean {
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

async function requestMetadata(
  client: WorkerClientLike,
  message: RangeRequestMessage,
  signal: AbortSignal,
): Promise<{ port: MessagePort; message?: RangeResponseMessage; error?: RangeErrorMessage }> {
  const channel = new MessageChannel();
  const result = new Promise<{ message?: RangeResponseMessage; error?: RangeErrorMessage }>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const finish = (value: { message?: RangeResponseMessage; error?: RangeErrorMessage }) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    onAbort = () => finish({ error: {
      type: "msfile-media-range-error",
      version: PROTOCOL_VERSION,
      requestId: message.requestId,
      status: 499,
      code: "msfile_media_cancelled",
    } });
    timeout = setTimeout(() => finish({ error: {
      type: "msfile-media-range-error",
      version: PROTOCOL_VERSION,
      requestId: message.requestId,
      status: 503,
      code: "msfile_media_service_worker",
    } }), 10000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const incoming = event.data as Partial<RangePortMessage> | undefined;
      if (!incoming || incoming.version !== PROTOCOL_VERSION || incoming.requestId !== message.requestId) return;
      if (incoming.type === "msfile-media-range-response") finish({ message: incoming as RangeResponseMessage });
      if (incoming.type === "msfile-media-range-error") finish({ error: incoming as RangeErrorMessage });
    };
    channel.port1.onmessageerror = () => finish({ error: {
      type: "msfile-media-range-error",
      version: PROTOCOL_VERSION,
      requestId: message.requestId,
      status: 503,
      code: "msfile_media_service_worker",
    } });
    channel.port1.start();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    if (!settled && !postToClient(client, message, channel.port2)) finish({ error: {
      type: "msfile-media-range-error",
      version: PROTOCOL_VERSION,
      requestId: message.requestId,
      status: 404,
      code: "msfile_media_service_worker",
    } });
  });
  return { port: channel.port1, ...(await result) };
}

function postToClient(client: WorkerClientLike, message: RangeRequestMessage, port: MessagePort): boolean {
  try {
    client.postMessage(message, [port]);
    return true;
  } catch {
    return false;
  }
}

function responseForError(error: RangeErrorMessage | undefined): Response {
  const status = error && safeNumber(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
  const headers = noStoreHeaders();
  headers.set("Content-Length", "0");
  return new Response(null, { status, headers });
}

function cancelBridge(port: MessagePort, requestId: string): void {
  post(port, {
    type: "msfile-media-range-cancel",
    version: PROTOCOL_VERSION,
    requestId,
  } satisfies RangeCancelMessage);
  closePortSoon(port);
}

async function handleMediaFetch(event: FetchEventLike): Promise<Response> {
  const url = new URL(event.request.url);
  const sessionId = url.pathname.slice(MEDIA_PREFIX.length);
  // SW 可能在任意时刻被回收并重新启动，不能把 session 权限放在 SW 内存
  // Map 中。这里仅按 FetchEvent.clientId 把请求转给对应页面；最终 owner
  // 判断由页面 RangeHostSession.handle() 完成。
  if (!/^[0-9a-f]{32}$/.test(sessionId) || !event.clientId) return new Response(null, { status: 404, headers: noStoreHeaders() });
  const client = await workerScope().clients.get(event.clientId);
  if (!client) return new Response(null, { status: 404, headers: noStoreHeaders() });

  const request: RangeRequestMessage = {
    type: "msfile-media-range-request",
    version: PROTOCOL_VERSION,
    clientId: event.clientId,
    sessionId,
    requestId: requestId(),
    method: event.request.method,
  };
  const range = event.request.headers.get("Range");
  if (range !== null) request.range = range;
  const bridge = await requestMetadata(client, request, event.request.signal);
  if (bridge.error || !bridge.message) {
    cancelBridge(bridge.port, request.requestId);
    return responseForError(bridge.error);
  }
  const metadata = bridge.message;
  const headers = validateResponseMessage(metadata);
  if (!headers) {
    cancelBridge(bridge.port, request.requestId);
    return responseForError({
      type: "msfile-media-range-error",
      version: PROTOCOL_VERSION,
      requestId: request.requestId,
      status: 502,
      code: "msfile_media_service_worker",
    });
  }
  if (metadata.status === 404 || metadata.status === 416 || event.request.method.toUpperCase() === "HEAD" || metadata.contentLength === 0) {
    post(bridge.port, { type: "msfile-media-range-done", version: PROTOCOL_VERSION, requestId: request.requestId } satisfies RangeDoneMessage);
    closePortSoon(bridge.port);
    return new Response(null, { status: metadata.status, headers });
  }

  let done = false;
  let pulling = false;
  let outputBytes = 0;
  const abortBridge = () => {
    cancelBridge(bridge.port, request.requestId);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        if (done) return;
        done = true;
        abortBridge();
        try { controller.close(); } catch { /* stream 已结束 */ }
      };
      if (event.request.signal.aborted) onAbort();
      else event.request.signal.addEventListener("abort", onAbort, { once: true });
      bridge.port.onmessage = (event: MessageEvent<unknown>) => {
        const incoming = event.data as Partial<RangePortMessage> | undefined;
        if (!incoming || incoming.version !== PROTOCOL_VERSION || incoming.requestId !== request.requestId || done) return;
        if (incoming.type === "msfile-media-range-chunk") {
          const chunk = incoming as RangeChunkMessage;
          if (!(chunk.bytes instanceof ArrayBuffer) || chunk.bytes.byteLength > MAX_CHUNK_BYTES) {
            done = true;
            controller.error(new Error("invalid media range chunk"));
            abortBridge();
            return;
          }
          outputBytes += chunk.bytes.byteLength;
          if (outputBytes > metadata.contentLength) {
            done = true;
            controller.error(new Error("media range length mismatch"));
            abortBridge();
            return;
          }
          pulling = false;
          controller.enqueue(new Uint8Array(chunk.bytes));
        } else if (incoming.type === "msfile-media-range-done") {
          if (outputBytes !== metadata.contentLength) {
            done = true;
            controller.error(new Error("media range length mismatch"));
            abortBridge();
            return;
          }
          done = true;
          pulling = false;
          controller.close();
          try { bridge.port.close(); } catch { /* channel already closed */ }
        } else if (incoming.type === "msfile-media-range-error") {
          done = true;
          pulling = false;
          controller.error(new Error("media range bridge failed"));
          try { bridge.port.close(); } catch { /* channel already closed */ }
        }
      };
      bridge.port.onmessageerror = () => {
        if (done) return;
        done = true;
        controller.error(new Error("media range bridge message failed"));
        abortBridge();
      };
      bridge.port.start();
    },
    pull(controller) {
      if (done || pulling) return;
      pulling = true;
      const message: RangePullMessage = { type: "msfile-media-range-pull", version: PROTOCOL_VERSION, requestId: request.requestId };
      if (!post(bridge.port, message)) {
        done = true;
        pulling = false;
        controller.error(new Error("media range bridge unavailable"));
        try { bridge.port.close(); } catch { /* channel already closed */ }
      }
    },
    cancel() {
      if (done) return;
      done = true;
      abortBridge();
    },
  });
  return new Response(stream, { status: metadata.status, headers });
}

function handleWorkerMessage(event: WorkerMessageEventLike): void {
  const message = event.data as Partial<ProtocolProbeMessage | BindSessionMessage | RevokeSessionMessage> | undefined;
  const port = event.ports[0];
  if (!message || typeof message.type !== "string") return;

  if (message.type === "msfile-media-protocol-probe") {
    if (!port) return;
    post(port, {
      type: "msfile-media-protocol-probe-result",
      version: PROTOCOL_VERSION,
      supported: message.version === PROTOCOL_VERSION,
    });
    closePortSoon(port);
    return;
  }

  const sourceClientId = typeof event.source?.id === "string" ? event.source.id : undefined;
  if (message.type === "msfile-media-bind-session") {
    if (!port) return;
    const sessionId = message.sessionId;
    const validSession = typeof sessionId === "string" && /^[0-9a-f]{32}$/.test(sessionId);
    // bind 只返回 SW 从 MessageEvent.source 取得的真实 Client.id，不在 SW
    // 保存 session->client 映射；这样 SW 重启不会使正在播放的 URL 失效。
    const accepted = message.version === PROTOCOL_VERSION && validSession && Boolean(sourceClientId);
    post(port, {
      type: "msfile-media-bind-session-result",
      version: PROTOCOL_VERSION,
      sessionId: typeof sessionId === "string" ? sessionId : "",
      ok: accepted,
      clientId: accepted ? sourceClientId : "",
    });
    closePortSoon(port);
    return;
  }

  if (message.type === "msfile-media-revoke-session") {
    const sessionId = message.sessionId;
    // revoke 同样只做协议确认。页面侧已销毁 session 后，后续请求会被
    // RangeHostSession 的本地 sessions map 返回 404。
    const revoked = message.version === PROTOCOL_VERSION && typeof sessionId === "string" &&
      /^[0-9a-f]{32}$/.test(sessionId) && Boolean(sourceClientId) && message.clientId === sourceClientId;
    if (port) {
      post(port, {
        type: "msfile-media-revoke-session-result",
        version: PROTOCOL_VERSION,
        sessionId: typeof sessionId === "string" ? sessionId : "",
        ok: Boolean(revoked),
      });
      closePortSoon(port);
    }
  }
}

const scope = workerScope();
scope.addEventListener("message", (event) => handleWorkerMessage(event as WorkerMessageEventLike));
scope.addEventListener("install", (event) => {
  const installEvent = event as { waitUntil(promise: Promise<unknown>): void };
  installEvent.waitUntil(scope.skipWaiting());
});
scope.addEventListener("activate", (event) => {
  const activateEvent = event as { waitUntil(promise: Promise<unknown>): void };
  activateEvent.waitUntil(scope.clients.claim());
});
scope.addEventListener("fetch", (event) => {
  const fetchEvent = event as FetchEventLike;
  const path = new URL(fetchEvent.request.url).pathname;
  if (!path.startsWith(MEDIA_PREFIX)) return;
  fetchEvent.respondWith(handleMediaFetch(fetchEvent));
});
