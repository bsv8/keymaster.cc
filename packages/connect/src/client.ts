import {
  PROTOCOL_VERSION,
  type ConnectLaunchParams,
  type ConnectLaunchResult,
  type ConnectLoginParams,
  type ConnectLoginResult,
  type ConnectLogoutResult,
  type ConnectResumeResult,
  type MethodParams,
  type MethodResult,
  type ProtocolErrorCode,
  type ProtocolEventMessage,
  type ProtocolMethod,
  type ProtocolResultMessage
} from "@keymaster/contracts/connect-public";

/** How the SDK obtains its Keymaster Session Window. */
export type KeymasterConnectMode = "popup" | "appView";

/** Observable lifecycle of the browser transport. */
export type KeymasterConnectState = "idle" | "opening" | "connected" | "disconnected";

/** Failures produced by the browser transport before a protocol result exists. */
export type KeymasterTransportErrorCode =
  | "popup_blocked"
  | "popup_closed"
  | "ready_timeout"
  | "request_timeout"
  | "send_failed"
  | "no_opener"
  | "appview_session_lost"
  | "client_closed";

/** A browser transport failure. Protocol rejections use {@link KeymasterProtocolError}. */
export class KeymasterTransportError extends Error {
  constructor(
    public readonly code: KeymasterTransportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KeymasterTransportError";
  }
}

/** A structured rejection returned by Keymaster. */
export class KeymasterProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KeymasterProtocolError";
  }
}

/** Options applying to one protocol request. */
export interface KeymasterRequestOptions {
  /** Caller-controlled correlation id. A UUID is generated when omitted. */
  requestId?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Aborting sends a best-effort protocol cancel and rejects the local promise. */
  signal?: AbortSignal;
}

/** Injectable browser primitives used by tests and embedded runtimes. */
export interface KeymasterBrowserEnvironment {
  open(url: string, target: string, features: string): Window | null;
  opener(): Window | null;
  addMessageListener(listener: (event: MessageEvent) => void): void;
  removeMessageListener(listener: (event: MessageEvent) => void): void;
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(timer: number): void;
  setInterval(handler: () => void, intervalMs: number): number;
  clearInterval(timer: number): void;
  randomUUID(): string;
}

/** Configuration for {@link KeymasterConnectClient}. */
export interface KeymasterConnectOptions {
  /** Exact Keymaster deployment origin supplied by the host application. */
  targetOrigin: string;
  /** `popup` for direct integrations; `appView` for apps launched by Keymaster. */
  mode?: KeymasterConnectMode;
  /** Session Window path relative to `targetOrigin`. */
  popupPath?: string;
  /** Browser window name reused by direct integrations. */
  popupName?: string;
  popupWidth?: number;
  popupHeight?: number;
  /** Maximum wait for a popup-mode `ready` message. Defaults to 30 seconds. */
  readyTimeoutMs?: number;
  /** Default request timeout. Defaults to two minutes. */
  requestTimeoutMs?: number;
  /** Session Window close detection interval. Defaults to 500ms. */
  closePollMs?: number;
  /** Receives app message and broadcast server-pushed events. */
  onEvent?: (event: ProtocolEventMessage) => void;
  /** Receives transport lifecycle changes. */
  onStateChange?: (state: KeymasterConnectState) => void;
  /** Optional browser adapter, normally only supplied by tests. */
  environment?: KeymasterBrowserEnvironment;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: number;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const DEFAULT_POPUP_PATH = "/protocol/v1/popup";
const DEFAULT_POPUP_NAME = "keymaster-connect-v1";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_POLL_MS = 500;

/**
 * Official browser client for Keymaster Connect V1.
 *
 * One client owns one reusable Session Window. It validates both the exact
 * message origin and the source window, correlates concurrent requests by id,
 * supports protocol cancellation through `AbortSignal`, and keeps persistent
 * Connect sessions separate from the window transport lifecycle.
 *
 * @example Direct popup login
 * ```ts
 * const keymaster = new KeymasterConnectClient({
 *   targetOrigin: keymasterDeploymentOrigin
 * });
 *
 * const session = await keymaster.login({
 *   text: "Sign in to Example",
 *   claims: ["profile.name"]
 * });
 * ```
 *
 * @example appView launch
 * ```ts
 * const keymaster = new KeymasterConnectClient({
 *   targetOrigin: sessionWindowOrigin,
 *   mode: "appView"
 * });
 *
 * await keymaster.connect();
 * const session = await keymaster.launch({ launchToken, appIdentity });
 * ```
 */
export class KeymasterConnectClient {
  private readonly targetOrigin: string;
  private readonly mode: KeymasterConnectMode;
  private readonly environment: KeymasterBrowserEnvironment;
  private readonly options: Required<Pick<KeymasterConnectOptions,
    "popupPath" | "popupName" | "popupWidth" | "popupHeight" |
    "readyTimeoutMs" | "requestTimeoutMs" | "closePollMs">> & KeymasterConnectOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private stateValue: KeymasterConnectState = "idle";
  private sessionWindow: Window | null = null;
  private ownsSessionWindow = false;
  private listenerInstalled = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason: unknown) => void) | null = null;
  private readyTimer: number | null = null;
  private closePoller: number | null = null;

  constructor(options: KeymasterConnectOptions) {
    this.targetOrigin = normalizeHttpOrigin(options.targetOrigin);
    this.mode = options.mode ?? "popup";
    this.options = {
      ...options,
      popupPath: options.popupPath ?? DEFAULT_POPUP_PATH,
      popupName: options.popupName ?? DEFAULT_POPUP_NAME,
      popupWidth: positiveNumber(options.popupWidth ?? 520, "popupWidth"),
      popupHeight: positiveNumber(options.popupHeight ?? 760, "popupHeight"),
      readyTimeoutMs: positiveNumber(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, "readyTimeoutMs"),
      requestTimeoutMs: positiveNumber(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
      closePollMs: positiveNumber(options.closePollMs ?? DEFAULT_CLOSE_POLL_MS, "closePollMs")
    };
    this.environment = options.environment ?? createBrowserEnvironment();
  }

  /** Current browser transport state. */
  get state(): KeymasterConnectState {
    return this.stateValue;
  }

  /**
   * Establishes the browser transport.
   *
   * Popup mode opens the Session Window and waits for `ready`. appView mode
   * adopts `window.opener`, installs the listener, and sends the child `ready`
   * message without ever opening a fallback popup.
   */
  connect(): Promise<void> {
    return this.mode === "appView" ? this.connectAppView() : this.connectPopup();
  }

  /**
   * Sends any public Connect method with compile-time parameter and result
   * inference.
   */
  async request<M extends ProtocolMethod>(
    method: M,
    params: MethodParams<M>,
    options: KeymasterRequestOptions = {}
  ): Promise<MethodResult<M>> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    await this.connect();

    const target = this.sessionWindow;
    if (!target || isWindowClosed(target)) {
      throw new KeymasterTransportError("popup_closed", "Keymaster Session Window is closed");
    }
    const requestId = options.requestId ?? this.environment.randomUUID();
    if (!requestId || this.pending.has(requestId)) {
      throw new TypeError("requestId must be non-empty and unique among pending requests");
    }
    const timeoutMs = positiveNumber(options.timeoutMs ?? this.options.requestTimeoutMs, "timeoutMs");

    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = this.environment.setTimeout(() => {
        this.postCancel(requestId);
        this.deletePending(requestId);
        reject(new KeymasterTransportError("request_timeout", `Keymaster request timed out: ${method}`));
      }, timeoutMs);
      const abortListener = options.signal
        ? () => {
            this.postCancel(requestId);
            this.deletePending(requestId);
            reject(abortReason(options.signal!));
          }
        : undefined;
      if (abortListener) options.signal!.addEventListener("abort", abortListener, { once: true });
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as MethodResult<M>),
        reject,
        timer,
        signal: options.signal,
        abortListener
      });

      try {
        target.postMessage({
          v: PROTOCOL_VERSION,
          type: "request",
          id: requestId,
          method,
          params
        }, this.targetOrigin);
      } catch (cause) {
        this.deletePending(requestId);
        reject(new KeymasterTransportError("send_failed", errorMessage(cause, "Unable to send Keymaster request")));
      }
    });
  }

  /** Creates a new persistent Connect session. */
  login(params: ConnectLoginParams, options?: KeymasterRequestOptions): Promise<ConnectLoginResult> {
    return this.request("connect.login", params, options);
  }

  /** Consumes the one-time launch token of an appView session. */
  launch(params: ConnectLaunchParams, options?: KeymasterRequestOptions): Promise<ConnectLaunchResult> {
    if (this.mode !== "appView") {
      return Promise.reject(new TypeError("connect.launch requires mode: \"appView\""));
    }
    return this.request("connect.launch", params, options);
  }

  /** Restores the unlock runtime for an existing persistent session. */
  resume(connectSessionId: string, options?: KeymasterRequestOptions): Promise<ConnectResumeResult> {
    return this.request("connect.resume", { connectSessionId }, options);
  }

  /** Revokes a persistent Connect session. */
  logout(connectSessionId: string, options?: KeymasterRequestOptions): Promise<ConnectLogoutResult> {
    return this.request("connect.logout", { connectSessionId }, options);
  }

  /**
   * Cancels a locally pending request. Keymaster only cancels work that has not
   * entered execution; cancellation is therefore best-effort remotely.
   */
  cancel(requestId: string, reason: unknown = new DOMException("The operation was aborted", "AbortError")): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.postCancel(requestId);
    this.deletePending(requestId);
    pending.reject(reason);
    return true;
  }

  /**
   * Tears down the local transport. This does not revoke persistent Connect
   * sessions; call {@link logout} before closing when revocation is required.
   */
  close(): void {
    const error = new KeymasterTransportError("client_closed", "Keymaster client was closed");
    this.rejectAll(error);
    this.failReady(error);
    this.stopClosePolling();
    if (this.listenerInstalled) {
      this.environment.removeMessageListener(this.handleMessage);
      this.listenerInstalled = false;
    }
    try {
      if (this.ownsSessionWindow && this.sessionWindow && !isWindowClosed(this.sessionWindow)) {
        this.sessionWindow.close();
      }
    } catch {
      // Cross-origin windows can become unreadable during teardown.
    }
    this.sessionWindow = null;
    this.ownsSessionWindow = false;
    this.setState("disconnected");
  }

  private connectPopup(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    const url = new URL(this.options.popupPath, `${this.targetOrigin}/`);
    if (url.origin !== this.targetOrigin) {
      return Promise.reject(new TypeError("popupPath must resolve inside targetOrigin"));
    }
    this.installListener();
    this.setState("opening");
    this.sessionWindow = this.environment.open(
      url.toString(),
      this.options.popupName,
      popupFeatures(this.options.popupWidth, this.options.popupHeight)
    );
    if (!this.sessionWindow) {
      this.setState("disconnected");
      return Promise.reject(new KeymasterTransportError("popup_blocked", "Keymaster Session Window was blocked"));
    }
    this.ownsSessionWindow = true;
    this.startClosePolling();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = this.environment.setTimeout(() => {
        this.disconnect(new KeymasterTransportError("ready_timeout", "Timed out waiting for Keymaster ready"));
      }, this.options.readyTimeoutMs);
    });
    return this.readyPromise;
  }

  private connectAppView(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    const opener = this.environment.opener();
    if (!opener || isWindowClosed(opener)) {
      const code: KeymasterTransportErrorCode = this.stateValue === "idle" ? "no_opener" : "appview_session_lost";
      this.setState("disconnected");
      return Promise.reject(new KeymasterTransportError(
        code,
        "No live Keymaster appView Session Window is available"
      ));
    }
    this.installListener();
    this.sessionWindow = opener;
    this.ownsSessionWindow = false;
    try {
      opener.postMessage({ v: PROTOCOL_VERSION, type: "ready" }, this.targetOrigin);
    } catch (cause) {
      this.sessionWindow = null;
      this.setState("disconnected");
      return Promise.reject(new KeymasterTransportError("send_failed", errorMessage(cause, "Unable to send appView ready")));
    }
    this.startClosePolling();
    this.setState("connected");
    return Promise.resolve();
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (!this.sessionWindow || event.origin !== this.targetOrigin || event.source !== this.sessionWindow) return;
    const value = event.data as Record<string, unknown> | null;
    if (!value || value.v !== PROTOCOL_VERSION || typeof value.type !== "string") return;

    if (value.type === "ready" && this.mode === "popup") {
      this.finishReady();
      return;
    }
    if (value.type === "closing") {
      this.disconnect(new KeymasterTransportError("popup_closed", "Keymaster Session Window is closing"));
      return;
    }
    if (value.type === "event") {
      try {
        this.options.onEvent?.(event.data as ProtocolEventMessage);
      } catch {
        // Consumer callbacks do not own the transport event loop.
      }
      return;
    }
    if (value.type !== "result" || typeof value.id !== "string" || typeof value.ok !== "boolean") return;

    const result = event.data as ProtocolResultMessage;
    const pending = this.pending.get(result.id);
    if (!pending) return;
    this.deletePending(result.id);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new KeymasterProtocolError(result.error.code, result.error.message));
  };

  private isConnected(): boolean {
    return this.stateValue === "connected" && !!this.sessionWindow && !isWindowClosed(this.sessionWindow);
  }

  private installListener(): void {
    if (this.listenerInstalled) return;
    this.environment.addMessageListener(this.handleMessage);
    this.listenerInstalled = true;
  }

  private finishReady(): void {
    if (!this.readyPromise) return;
    if (this.readyTimer !== null) this.environment.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyResolve?.();
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.setState("connected");
  }

  private failReady(reason: unknown): void {
    if (this.readyTimer !== null) this.environment.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyReject?.(reason);
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  private disconnect(reason: unknown): void {
    this.rejectAll(reason);
    this.failReady(reason);
    this.stopClosePolling();
    try {
      if (this.ownsSessionWindow && this.sessionWindow && !isWindowClosed(this.sessionWindow)) {
        this.sessionWindow.close();
      }
    } catch {
      // Closing is best-effort.
    }
    this.sessionWindow = null;
    this.ownsSessionWindow = false;
    this.setState("disconnected");
  }

  private startClosePolling(): void {
    this.stopClosePolling();
    this.closePoller = this.environment.setInterval(() => {
      if (this.sessionWindow && isWindowClosed(this.sessionWindow)) {
        this.disconnect(new KeymasterTransportError("popup_closed", "Keymaster Session Window was closed"));
      }
    }, this.options.closePollMs);
  }

  private stopClosePolling(): void {
    if (this.closePoller !== null) this.environment.clearInterval(this.closePoller);
    this.closePoller = null;
  }

  private rejectAll(reason: unknown): void {
    for (const [id, pending] of this.pending) {
      this.deletePending(id);
      pending.reject(reason);
    }
  }

  private deletePending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.environment.clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
  }

  private postCancel(id: string): void {
    try {
      this.sessionWindow?.postMessage({ v: PROTOCOL_VERSION, type: "cancel", id }, this.targetOrigin);
    } catch {
      // Protocol cancellation is best-effort.
    }
  }

  private setState(state: KeymasterConnectState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    try {
      this.options.onStateChange?.(state);
    } catch {
      // Consumer callbacks cannot interrupt lifecycle transitions.
    }
  }
}

/** Creates a client without using `new`. */
export function createKeymasterConnect(options: KeymasterConnectOptions): KeymasterConnectClient {
  return new KeymasterConnectClient(options);
}

/** Creates the production environment adapter from the current browser window. */
export function createBrowserEnvironment(): KeymasterBrowserEnvironment {
  if (typeof window === "undefined") {
    throw new TypeError("@keymaster/connect requires a browser Window or an explicit environment");
  }
  return {
    open: (url, target, features) => window.open(url, target, features),
    opener: () => window.opener,
    addMessageListener: (listener) => window.addEventListener("message", listener),
    removeMessageListener: (listener) => window.removeEventListener("message", listener),
    setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    setInterval: (handler, intervalMs) => window.setInterval(handler, intervalMs),
    clearInterval: (timer) => window.clearInterval(timer),
    randomUUID: () => window.crypto.randomUUID()
  };
}

function normalizeHttpOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("targetOrigin must use http or https");
  }
  return url.origin;
}

function popupFeatures(width: number, height: number): string {
  return `popup=yes,width=${Math.max(320, Math.trunc(width))},height=${Math.max(320, Math.trunc(height))}`;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

function isWindowClosed(value: Window): boolean {
  try {
    return value.closed === true;
  } catch {
    return true;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}
