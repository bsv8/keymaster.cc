import type {
  LaunchAppViewInput, ApplicationOpenMode, ApplicationView, AppBootstrapPayload, ApplicationConnection, ApplicationConnections, ApplicationConnectionsSnapshot,
  ApplicationConnectionEvent, ConnectedApplication, ProtocolCommandRecord, ProtocolMethod, ConnectStorageRepository, ApplicationAiTools, ConnectedAiTool,
} from "@keymaster/contracts";
import { traceDev } from "@keymaster/contracts";
import { KeymasterAiToolReceiver } from "keymaster-connect/server";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createConnectService, type ConnectServiceDeps, type ConnectServiceImpl } from "./connectService.js";
import { applicationKey, permissionKeyFor, readApplicationPermissions, setApplicationPermission } from "./applicationPermissions.js";
import { assertAppPublicKeyHex } from "@keymaster/contracts";

type HostedConnection = ApplicationConnection & { launchUrl?: string; expectedAppPublicKeyHex?: string; origin?:string; source: Window; service: ConnectServiceImpl; tools: KeymasterAiToolReceiver; off: () => void; identifyingKey?: string };

/** 长期应用许可与运行连接分离；断开后必须重新登录或从钱包重新打开。 */
export class ApplicationConnectionHost implements ApplicationConnections {
  private applications = new Map<string, ConnectedApplication>();
  private connections = new Map<string, HostedConnection>();
  private views = new Map<Window, ApplicationView>();
  private incomingSource: Window | null = null;
  private incomingRegistered = false;
  private openMode: ApplicationOpenMode | null = null;
  private listeners = new Set<() => void>();
  private history = new Map<string, ProtocolCommandRecord>();
  private events: ApplicationConnectionEvent[] = [];
  private available = false;
  private error: string | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private offWallet: () => void;
  private generation: string;
  private loading?: { generation: string; promise: Promise<void> };

  constructor(private deps: ConnectServiceDeps, private repo: ConnectStorageRepository) {
    this.generation = this.walletGeneration();
    this.offWallet = deps.walletState.subscribe(() => {
      const generation = this.walletGeneration();
      if (generation !== this.generation) {
        this.generation = generation;
        this.openMode = null;
        this.available = false;
        this.error = undefined;
        for (const connection of this.connections.values()) this.endConnection(connection);
        // The storage scope survives lock/unlock. Load its owner-bound data
        // only after the new session is unlocked; old completions stay fenced.
        void this.initialize();
      } else {
        for (const connection of this.connections.values()) if (!connection.closedAt) connection.service.syncWalletState();
      }
      this.tryAttachIncoming();
      this.emit();
    });
    this.timer = setInterval(() => {
      for (const [source, view] of this.views) if (view.closed) this.closeView(source);
      for (const connection of this.connections.values()) if (connection.source.closed) this.endConnection(connection);
    }, 1000);
  }
  private walletGeneration(): string {
    if (this.disposed || this.deps.runtimeSignal?.aborted) return "released";
    const s = this.deps.walletState.snapshot();
    return JSON.stringify([s.status, s.walletGeneration, s.runGeneration, s.sessionEpoch]);
  }
  async initialize(): Promise<void> {
    if (this.disposed || this.deps.runtimeSignal?.aborted || this.deps.walletState.snapshot().status !== "unlocked") return;
    const generation = this.walletGeneration();
    if (this.loading?.generation === generation) return this.loading.promise;
    const current = () => !this.disposed && generation === this.walletGeneration();
    traceDev("connect.applications", "storage.load.start");
    const promise = (async () => {
      try {
        const [apps, commands, events, openMode] = await Promise.all([
          this.repo.listApplications!(), this.repo.listCommands!(), this.repo.listApplicationEvents!(), this.repo.getApplicationOpenMode(),
        ]);
        if (!current()) {
          traceDev("connect.applications", "storage.load.discarded");
          return;
        }
        this.openMode = openMode;
        this.events = events;
        for (const app of apps) if (!this.applications.has(app.key)) this.applications.set(app.key, app);
        for (const command of commands) if (!this.history.has(command.id)) this.history.set(command.id, command);
        this.available = true;
        this.error = undefined;
        traceDev("connect.applications", "storage.load.ready", () => ({ applications: apps.length, commands: commands.length, events: events.length }));
      } catch (error) {
        if (!current()) {
          traceDev("connect.applications", "storage.load.discarded");
          return;
        }
        this.available = false;
        this.error = "应用历史读取失败，不能将未知授权当成允许。";
        traceDev("connect.applications", "storage.load.failed", () => ({
          error,
        }));
      }
      if (current()) this.emit();
    })();
    this.loading = { generation, promise };
    try { await promise; }
    finally { if (this.loading?.promise === promise) this.loading = undefined; }
  }
  applicationOpenMode(): ApplicationOpenMode {
    if (this.openMode === null || this.disposed) throw new Error("Application settings unavailable");
    return this.openMode;
  }
  async setApplicationOpenMode(mode: ApplicationOpenMode): Promise<void> {
    if (this.disposed) throw new Error("Application host stopped");
    const generation = this.walletGeneration();
    await this.repo.setApplicationOpenMode(mode);
    if (this.disposed || generation !== this.walletGeneration()) return;
    this.openMode = mode;
    this.emit();
  }
  acceptOpener(source: Window | null): void {
    if (this.disposed || this.incomingSource || this.incomingRegistered || !source || source.closed) return;
    // 仅接受钱包文档的真实 opener，不从任意 postMessage 认领来源。
    if (source !== window.opener) throw new Error("Wallet opener does not match the browser");
    this.incomingSource = source;
    this.tryAttachIncoming();
  }
  private tryAttachIncoming(): void {
    if (this.disposed || this.incomingRegistered || !this.incomingSource || this.incomingSource.closed || this.deps.walletState.snapshot().status !== "unlocked") return;
    this.incomingRegistered = true;
    this.createConnection(this.incomingSource);
    this.emit();
  }
  private createConnection(source: Window, bootMode: "connect" | "appView" = "connect"): HostedConnection {
    const id = crypto.randomUUID();
    const service = createConnectService({ ...this.deps, bootMode, hostedApplication: true, resolveOpener: () => source, storageRepository: this.repo,
      applicationIdentified: (origin, key, url,display) => this.identifyIncoming(id, origin, key, url,display),
      applicationLoggedOut: () => { const connection = this.connections.get(id); if (connection) { this.endConnection(connection); connection.closedAt = Date.now(); this.emit(); } },
      applicationPermissionChanged: () => this.refreshEvents() });
    const tools = new KeymasterAiToolReceiver({
      isCurrent: bindingId => {
        const connection = this.connections.get(id);
        const app = connection && this.applications.get(connection.applicationKey);
        return !!connection && !!app && !this.disposed && !connection.closedAt && !source.closed && this.deps.walletState.snapshot().status === "unlocked" && service.matchesBinding(source, connection.origin??app.origin, bindingId);
      },
      send: message => {
        const connection = this.connections.get(id);
        const app = connection && this.applications.get(connection.applicationKey);
        if (!app || source.closed) throw new Error("Application unavailable");
        source.postMessage(message, connection!.origin??app.origin);
      },
      names: definitions => {
        const connection = this.connections.get(id);
        if (!connection?.applicationKey) throw new Error("Application not identified");
        if (definitions.length && [...this.connections.values()].some(other => other.id !== id && other.applicationKey === connection.applicationKey && other.tools.list().length)) throw new Error("Another connection already owns this application's tools");
        return definitions.map(tool => this.toolId(connection.applicationKey, tool.name));
      },
      changed: () => this.emit(),
    });
    const connection: HostedConnection = { id, applicationKey: "", createdAt: Date.now(), source, service, tools, off: () => {} };
    this.connections.set(id, connection);
    connection.off = service.subscribeFeed(() => { tools.sync(); this.emit(); });
    service.startSession();
    return connection;
  }
  /** 只匹配本次运行仍有效的连接；旧历史和同源不同 App 不能用于复用。 */
  focusExistingApplication(input: LaunchAppViewInput): { appUrl: string } | undefined {
    if (this.disposed || this.deps.runtimeSignal?.aborted || this.deps.walletState.snapshot().status !== "unlocked" || this.walletGeneration() !== this.generation) return;
    for (const connection of this.connections.values()) {
      const view = this.views.get(connection.source);
      if (view?.closed) continue;
      const expected = input.expectedAppPublicKeyHex?.toLowerCase();
      const matches = expected
        ? connection.applicationKey ? connection.applicationKey.toLowerCase() === expected : connection.expectedAppPublicKeyHex?.toLowerCase() === expected
        : connection.launchUrl === new URL(input.appUrl).href;
      if (!matches) continue;
      if (connection.closedAt || connection.source.closed || (connection.applicationKey && !connection.service.hasApplicationAuthorization())) {
        view?.close();
        continue;
      }
      const launch = connection.service.feedSnapshot().commands.find(command => command.method === "connect.launch");
      if (launch && ["failed", "rejected", "timed_out"].includes(launch.phase)) continue;
      if (view) view.focus(); else connection.source.focus();
      traceDev("connect.applications", "launch.reused", () => ({ applicationKey: connection.applicationKey, connectionId: connection.id, mode: view?.mode ?? "external" }));
      return { appUrl: connection.launchUrl ?? input.appUrl };
    }
  }

  async acceptLaunch(payload: AppBootstrapPayload, source: Window, view: ApplicationView): Promise<void> {
    if (this.disposed) throw new Error("Application host stopped");
    const generation = this.walletGeneration();
    if (view.closed) throw new Error("Application closed during launch");
    this.views.set(source, view);
    const connection = this.createConnection(source, "appView");
    connection.launchUrl = new URL(payload.app.directoryUrl ?? payload.app.appUrl).href;
    connection.expectedAppPublicKeyHex = payload.app.expectedAppPublicKeyHex;
    try {
      await connection.service.acceptLaunchedApplication(payload, source);
      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Application host stopped or wallet changed");

      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Wallet changed while recording connection");
    } catch (error) { this.endConnection(connection); throw error; }
    this.emit();
  }
  closeView(source: Window): void {
    this.views.delete(source);
    for (const connection of this.connections.values()) {
      if (connection.source !== source) continue;
      this.endConnection(connection);
      connection.closedAt ??= Date.now();
      connection.off();
    }
    this.emit();
  }
  private async identifyIncoming(id: string, origin: string, appPublicKeyHex: string, verifiedUrl?: string,display?:{name:string;description:string;icon:string}): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection || connection.closedAt || this.disposed) throw new Error("Connection expired");
    const key = applicationKey(appPublicKeyHex);
    if ((connection.applicationKey && connection.applicationKey !== key) || (connection.identifyingKey && connection.identifyingKey !== key)) throw new Error("Application identity changed");
    if (connection.applicationKey === key) return;
    connection.identifyingKey = key;
    connection.origin=origin;
    try {
      const app: ConnectedApplication = { key, origin, ...(verifiedUrl ? {verifiedUrl} : {}),...(display?{display}:{}), name: display?.name??new URL(origin).host, updatedAt: Date.now() };
      await this.repo.putApplication!(app);
      if (connection.closedAt || this.disposed) throw new Error("Connection expired");
      await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: connection.createdAt, kind: "connected", connectionId: id });
      if (connection.closedAt || this.disposed) throw new Error("Connection expired");
      this.applications.set(key, app);
      connection.applicationKey = key;
      this.emit();
    } finally { connection.identifyingKey = undefined; }
  }
  async handleMessage(event: MessageEvent): Promise<void> {
    if (this.disposed) return;
    const message = event.data;
    // Chromium may deliver pagehide messages with a null source after destroying
    // the sender document. Only this revocation-only control accepts that case:
    // exact browser origin + the current Receiver's unpredictable binding must
    // still match. It cannot create authority or revoke a replacement binding.
    if (message?.v === 1 && message.type === "client_unloaded") {
      if (typeof message.bindingId !== "string" || !message.bindingId) return;
      for (const connection of this.connections.values()) {
        if ((!event.source || connection.source === event.source) && !connection.closedAt
          && connection.service.matchesBinding(connection.source, event.origin, message.bindingId)) this.endConnection(connection);
      }
      return;
    }
    if (!event.source) return;
    // 三条通道只接受已登记的 frame、钱包打开的 App 窗口或真实 opener。
    const sourceWindow = event.source as Window;
    const view = this.views.get(sourceWindow);
    const incoming = sourceWindow === this.incomingSource && this.incomingRegistered && !sourceWindow.closed;
    if (view ? view.closed || event.origin !== view.origin : !incoming) return;
    // 只允许新登录或新 launch 创建运行连接，旧业务帧不能复活已断开的实例。
    // A fresh client document announces ready again. Its old runtime binding cannot
    // survive navigation, even though the WindowProxy is unchanged.
    if (message?.v === 1 && message.type === "ready") {
      for (const connection of this.connections.values()) {
        if (connection.source === sourceWindow && !connection.closedAt && connection.service.hasApplicationAuthorization()) this.endConnection(connection);
      }
    }

    if (message?.v === 1 && message.type === "request" && (message.method === "connect.login" || message.method === "connect.launch")
      && ![...this.connections.values()].some(connection => connection.source === sourceWindow && !connection.closedAt)) {
      this.createConnection(sourceWindow, view ? "appView" : "connect");
    }
    for (const connection of this.connections.values()) {
      if (connection.closedAt || connection.source !== event.source) continue;
      const application = this.applications.get(connection.applicationKey);
      if (application && application.origin !== event.origin) return;
      if (connection.tools.handle(event.data)) return;
      await connection.service.handleMessage(event);
      return;
    }
  }
  private toolId(applicationKey: string, name: string): string {
    const digest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([applicationKey, name])))).slice(0, 40);
    return `app_${name.slice(0, 18)}_${digest}`;
  }
  readonly aiTools: ApplicationAiTools = {
    list: () => {
      const result: ConnectedAiTool[] = [];
      if (this.disposed) return result;
      for (const connection of this.connections.values()) {
        const app = this.applications.get(connection.applicationKey);
        if (!app || connection.closedAt) continue;
        for (const definition of connection.tools.list()) result.push({ id: this.toolId(app.key, definition.name), applicationKey: app.key, applicationName: app.name, connectionId: connection.id, definition });
      }
      return result;
    },
    subscribe: listener => this.subscribe(listener),
    invoke: (id, args, signal) => {
      const tool = this.aiTools.list().find(tool => tool.id === id);
      if (!tool) return Promise.reject(new Error("App tool unavailable; refresh tools"));
      const connection = this.connections.get(tool.connectionId)!;
      return connection.tools.invoke(tool.definition.name, args, signal);
    },
  };
  snapshot(): ApplicationConnectionsSnapshot {
    const commands = new Map(this.history);
    for (const connection of this.connections.values()) {
      for (const command of connection.service.feedSnapshot().commands) {
        // 首次登录已经验过 proof，但授权尚待用户批准；此时连接还没有正式身份。
        // 仅展示该 Receiver 自己的登录待办，不提前认领应用或发放数据权限。
        if (command.applicationKey === connection.applicationKey || (!connection.applicationKey && command.method === "connect.login")) commands.set(command.id, command);
      }
    }
    return {
      applications: [...this.applications.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      connections: [...this.connections.values()],
      commands: [...commands.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
      events: this.events,
      historyAvailable: this.available && [...this.connections.values()].every(c => c.service.feedSnapshot().historyAvailable),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  /**
   * 许可主键解析：已验证发布身份的连接按 App 公钥归属；为兼容未验证传输，
   * 同时读取来源键与该来源各会话快照中的 App 公钥（过渡行为，见 permissionKeyFor）。
   * 展示取并集，撤销扇出到实际持有该方法的键，避免静默漏撤。
   */
  async permissions(key: string): Promise<ProtocolMethod[]> {return readApplicationPermissions(this.repo,assertAppPublicKeyHex(key));}
  async revokePermission(key: string, method: ProtocolMethod): Promise<void> {await setApplicationPermission(this.repo,assertAppPublicKeyHex(key),method,false);await this.refreshEvents();this.emit();}
  /** 唯一的显式断开入口：先持久撤销，再撤回所有关联窗口的瞬时权限。 */
  async disconnect(key: string): Promise<void> {
    const app = this.applications.get(key);
    if (!app) throw new Error("Application is not registered");
    const grants = await this.repo.listConnectSessions();
    for (const grant of grants.filter(value => value.appPublicKeyHex === key && value.revokedAt === null)) {
      await this.repo.putConnectSession({ ...grant, revokedAt: Date.now() });
      for (const connection of this.connections.values()) {
        if (connection.applicationKey !== key) continue;
        this.endConnection(connection);
        connection.closedAt = Date.now();
        try { connection.source.postMessage({ v: 1, type: "revoked", authorizationId: grant.authorizationId }, grant.origin); } catch { /* 撤销只通知当前来源，不等待回复。 */ }
      }
    }
    await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: Date.now(), kind: "disconnected" });
    this.emit();
  }
  /** 只结束旧运行权，不撤销持久授权；在途资金责任仍由原业务执行链收尾。 */
  private endConnection(connection: HostedConnection): void {
    if (connection.closedAt) return;
    connection.closedAt = Date.now();
    connection.tools.dispose();
    connection.service.pageUnloading();
    for (const command of connection.service.feedSnapshot().commands) {
      const terminal = ["approved", "rejected", "failed", "timed_out"].includes(command.phase);
      const archived: ProtocolCommandRecord = terminal ? command : { ...command, phase: "failed", decision: "failed", status: "connection_expired", errorCode: "connection_expired", errorMessage: "Connection closed", finishedAt: connection.closedAt, updatedAt: connection.closedAt,
        ...(command.method === "payment.pay" ? { paymentStatus: command.phase === "executing" ? "unknown" : "not_signed" } : {}) };
      this.history.set(archived.id, archived);
      const generation = this.walletGeneration();
      if (!terminal) void this.repo.putCommand(archived).catch(() => {
        if (this.disposed || generation !== this.walletGeneration()) return;
        this.available = false; this.error = "断开事件写入失败，未丢弃内存中的业务责任。"; this.emit();
      });
    }
    connection.service.dispose();
    this.emit();
  }
  focus(id: string): void {
    const connection = this.connections.get(id);
    const view = connection && this.views.get(connection.source);
    if (!connection || connection.closedAt || (view ? view.closed : connection.source.closed)) throw new Error("Application view is unavailable");
    if (view) view.focus();
    else connection.source.focus();
  }
  private async refreshEvents(): Promise<void> {
    const generation = this.walletGeneration();
    const events = await this.repo.listApplicationEvents!();
    if (this.disposed || generation !== this.walletGeneration()) return;
    this.events = events;
    this.emit();
  }
  private async recordEvent(event: ApplicationConnectionEvent): Promise<void> { this.events = [...this.events, event]; await this.repo.putApplicationEvent!(event); this.emit(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.offWallet();
    for (const connection of this.connections.values()) { this.endConnection(connection); connection.off(); }
    for (const view of [...this.views.values()]) view.close();
    this.views.clear();
    this.listeners.clear();
  }
}
