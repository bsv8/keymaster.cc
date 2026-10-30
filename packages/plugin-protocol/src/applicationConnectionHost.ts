import type {
  ApplicationOpenMode, ApplicationView, AppBootstrapPayload, AppIdentitySnapshot, ApplicationConnection, ApplicationConnections, ApplicationConnectionsSnapshot,
  ApplicationConnectionEvent, ConnectedApplication, ProtocolCommandRecord, ProtocolMethod, ProtocolStorageRepository, ApplicationAiTools, ConnectedAiTool,
} from "@keymaster/contracts";
import { requireUnlockedWalletIdentity, sameNetworkIdentity } from "@keymaster/contracts";
import { KeymasterAiToolReceiver, parseReconnectMessage } from "keymaster-connect/server";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createProtocolService, type ProtocolServiceDeps, type ProtocolServiceImpl } from "./protocolService.js";
import { applicationKey, readApplicationPermissions, setApplicationPermission } from "./applicationPermissions.js";

type HostedConnection = ApplicationConnection & { source: Window; service: ProtocolServiceImpl; tools: KeymasterAiToolReceiver; off: () => void; authorizationId?: string; identifyingKey?: string };

/** 持久授权与运行期分离；每次恢复重新登记实际来源、创建 Receiver 和执行句柄。 */
export class ApplicationConnectionHost implements ApplicationConnections {
  private applications = new Map<string, ConnectedApplication>();
  private connections = new Map<string, HostedConnection>();
  private recovering = new Set<Window>();
  private views = new Map<Window, ApplicationView>();
  private incomingSource: Window | null = null;
  private incomingRegistered = false;
  private openMode: ApplicationOpenMode | null = null;
  private listeners = new Set<() => void>();
  private history = new Map<string, ProtocolCommandRecord>();
  private events: ApplicationConnectionEvent[] = [];
  private available = true;
  private error: string | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private offWallet: () => void;
  private generation: string;

  constructor(private deps: ProtocolServiceDeps, private repo: ProtocolStorageRepository) {
    this.generation = this.walletGeneration();
    this.offWallet = deps.walletState.subscribe(() => {
      const generation = this.walletGeneration();
      if (generation !== this.generation) {
        this.generation = generation;
        for (const connection of this.connections.values()) this.pause(connection);
      } else {
        for (const connection of this.connections.values()) if (!connection.closedAt && !connection.pausedAt) connection.service.syncWalletState();
      }
      this.tryAttachIncoming();
    });
    this.timer = setInterval(() => {
      for (const [source, view] of this.views) if (view.closed) this.closeView(source);
      for (const connection of this.connections.values()) if (connection.source.closed) this.pause(connection);
    }, 1000);
  }
  private walletGeneration(): string {
    const s = this.deps.walletState.snapshot();
    return JSON.stringify([s.status, s.walletGeneration, s.runGeneration, s.sessionEpoch]);
  }
  async initialize(): Promise<void> {
    try {
      const [apps, commands, , openMode] = await Promise.all([this.repo.listApplications!(), this.repo.listCommands!(), this.refreshEvents(), this.repo.getApplicationOpenMode()]);
      if (this.disposed) return;
      this.openMode = openMode;
      for (const app of apps) if (!this.applications.has(app.key)) this.applications.set(app.key, app);
      for (const command of commands) if (!this.history.has(command.id)) this.history.set(command.id, command);
    } catch {
      this.available = false;
      this.error = "应用历史读取失败，不能将未知授权当成允许。";
    }
    this.emit();
  }
  applicationOpenMode(): ApplicationOpenMode {
    if (this.openMode === null || this.disposed) throw new Error("Application settings unavailable");
    return this.openMode;
  }
  async setApplicationOpenMode(mode: ApplicationOpenMode): Promise<void> {
    if (this.disposed) throw new Error("Application host stopped");
    await this.repo.setApplicationOpenMode(mode);
    if (this.disposed) return;
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
    const service = createProtocolService({ ...this.deps, bootMode, hostedApplication: true, resolveOpener: () => source, storageRepository: this.repo,
      applicationIdentified: (origin, identity) => this.identifyIncoming(id, origin, identity),
      applicationLoggedOut: () => { const connection = this.connections.get(id); if (connection) { this.pause(connection); connection.closedAt = Date.now(); this.emit(); } },
      applicationPermissionChanged: () => this.refreshEvents() });
    const tools = new KeymasterAiToolReceiver({
      isCurrent: bindingId => {
        const connection = this.connections.get(id);
        const app = connection && this.applications.get(connection.applicationKey);
        return !!connection && !!app && !this.disposed && !connection.closedAt && !connection.pausedAt && !source.closed && this.deps.walletState.snapshot().status === "unlocked" && service.matchesBinding(source, app.origin, bindingId);
      },
      send: message => {
        const connection = this.connections.get(id);
        const app = connection && this.applications.get(connection.applicationKey);
        if (!app || source.closed) throw new Error("Application unavailable");
        source.postMessage(message, app.origin);
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
  async acceptLaunch(payload: AppBootstrapPayload, source: Window, view: ApplicationView): Promise<void> {
    if (this.disposed) throw new Error("Application host stopped");
    const generation = this.walletGeneration();
    const key = applicationKey(payload.app.appOrigin, payload.appIdentity);
    const app: ConnectedApplication = { key, origin: payload.app.appOrigin, name: payload.appIdentity?.appName ?? payload.app.appId, identity: payload.appIdentity, updatedAt: Date.now() };
    await this.repo.putApplication!(app);
    if (this.disposed || this.walletGeneration() !== generation) throw new Error("Application host stopped or wallet changed");
    for (const previous of this.connections.values()) {
      if (this.applications.get(previous.applicationKey)?.origin === app.origin) this.pause(previous);
    }
    if (view.closed) throw new Error("Application closed during launch");
    this.views.set(source, view);
    const connection = this.createConnection(source, "appView");
    try {
      await connection.service.acceptLaunchedApplication(payload, source);
      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Application host stopped or wallet changed");
      connection.applicationKey = key;
      await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: connection.createdAt, kind: "connected", connectionId: connection.id });
      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Wallet changed while recording connection");
    } catch (error) { this.pause(connection); throw error; }
    this.applications.set(key, app);
    this.emit();
  }
  closeView(source: Window): void {
    this.views.delete(source);
    for (const connection of this.connections.values()) {
      if (connection.source !== source) continue;
      this.pause(connection);
      connection.closedAt ??= Date.now();
      connection.off();
    }
    this.emit();
  }
  private async identifyIncoming(id: string, origin: string, identity?: AppIdentitySnapshot): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection || connection.closedAt || connection.pausedAt || this.disposed) throw new Error("Connection expired");
    const key = applicationKey(origin, identity);
    if ((connection.applicationKey && connection.applicationKey !== key) || (connection.identifyingKey && connection.identifyingKey !== key)) throw new Error("Application identity changed");
    if (connection.applicationKey === key) return;
    connection.identifyingKey = key;
    try {
      const app: ConnectedApplication = { key, origin, name: identity?.appName ?? new URL(origin).host, identity, updatedAt: Date.now() };
      await this.repo.putApplication!(app);
      if (connection.closedAt || connection.pausedAt || this.disposed) throw new Error("Connection expired");
      await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: connection.createdAt, kind: "connected", connectionId: id });
      if (connection.closedAt || connection.pausedAt || this.disposed) throw new Error("Connection expired");
      this.applications.set(key, app);
      connection.applicationKey = key;
      this.emit();
    } finally { connection.identifyingKey = undefined; }
  }
  async handleMessage(event: MessageEvent): Promise<void> {
    if (this.disposed || !event.source) return;
    // 三条通道只接受已登记的 frame、钱包打开的 App 窗口或真实 opener。
    const sourceWindow = event.source as Window;
    const view = this.views.get(sourceWindow);
    const incoming = sourceWindow === this.incomingSource && this.incomingRegistered && !sourceWindow.closed;
    if (view ? view.closed || event.origin !== view.origin : !incoming) return;
    const reconnect = parseReconnectMessage(event.data);
    if (reconnect) {
      if (this.deps.walletState.snapshot().status !== "unlocked") return;
      const source = event.source as Window;
      const current = [...this.connections.values()].find(c => c.source === source && !c.closedAt && !c.pausedAt);
      // 健康连接的发现轮询不读磁盘、不更换 binding，更不会重放业务。
      if (current && current.authorizationId === reconnect.authorizationId && current.service.matchesBinding(source, event.origin, reconnect.bindingId)) return;
      if (this.recovering.has(source)) return;
      this.recovering.add(source);
      try {
        const generation = this.walletGeneration();
        const sessions = await this.repo.listConnectSessionsByOrigin(event.origin);
        const grant = sessions.find(record => record.authorizationId === reconnect.authorizationId);
        if (this.disposed || generation !== this.walletGeneration() || (view ? view.closed || this.views.get(source) !== view : source !== this.incomingSource || source.closed)) return;
        if (!grant || grant.revokedAt !== null) {
          source.postMessage({ v: 1, type: "revoked", authorizationId: reconnect.authorizationId }, event.origin);
          return;
        }
        // 身份变化只能暂停原授权，绝不让旧任务无感换钱包。
        const identity = requireUnlockedWalletIdentity(this.deps.walletState.snapshot());
        if (!sameNetworkIdentity(identity, grant.networkIdentity)) return;
        if (current && applicationKey(event.origin, grant.appIdentity) === current.applicationKey) {
          current.authorizationId = grant.authorizationId;
          if (current.service.matchesBinding(source, event.origin, reconnect.bindingId)) return;
        }
        if (current) this.pause(current);
        const connection = this.createConnection(source);
        connection.authorizationId = grant.authorizationId;
        await connection.service.handleMessage(event);
        this.emit();
      } finally { this.recovering.delete(source); }
      return;
    }
    for (const connection of this.connections.values()) {
      if (connection.closedAt || connection.pausedAt || connection.source !== event.source) continue;
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
        if (!app || connection.closedAt || connection.pausedAt) continue;
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
        if (command.applicationKey === connection.applicationKey) commands.set(command.id, command);
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
  permissions(key: string): Promise<ProtocolMethod[]> { return readApplicationPermissions(this.repo, key); }
  async revokePermission(key: string, method: ProtocolMethod): Promise<void> {
    await setApplicationPermission(this.repo, key, method, false);
    await this.refreshEvents();
    this.emit();
  }
  /** 唯一的显式断开入口：先持久撤销，再撤回所有关联窗口的瞬时权限。 */
  async disconnect(key: string): Promise<void> {
    const app = this.applications.get(key);
    if (!app) throw new Error("Application is not registered");
    const grants = await this.repo.listConnectSessionsByOrigin(app.origin);
    for (const grant of grants.filter(value => applicationKey(value.origin, value.appIdentity) === key && value.revokedAt === null)) {
      await this.repo.putConnectSession({ ...grant, revokedAt: Date.now() });
      for (const connection of this.connections.values()) {
        if (connection.applicationKey !== key) continue;
        this.pause(connection);
        connection.closedAt = Date.now();
        try { connection.source.postMessage({ v: 1, type: "revoked", authorizationId: grant.authorizationId }, app.origin); } catch { /* 关闭的窗口以后也不能凭旧授权恢复。 */ }
      }
    }
    await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: Date.now(), kind: "disconnected" });
    this.emit();
  }
  /** 只结束旧运行权，不撤销持久授权；在途资金责任仍由原业务执行链收尾。 */
  private pause(connection: HostedConnection): void {
    if (connection.pausedAt) return;
    connection.pausedAt = Date.now();
    connection.tools.dispose();
    connection.service.pageUnloading();
    for (const command of connection.service.feedSnapshot().commands) {
      const terminal = ["approved", "rejected", "failed", "timed_out"].includes(command.phase);
      const archived: ProtocolCommandRecord = terminal ? command : { ...command, phase: "failed", decision: "failed", status: "connection_expired", errorCode: "connection_expired", errorMessage: "Connection paused", finishedAt: connection.pausedAt, updatedAt: connection.pausedAt,
        ...(command.method === "payment.pay" ? { paymentStatus: command.phase === "executing" ? "unknown" : "not_signed" } : {}) };
      this.history.set(archived.id, archived);
      if (!terminal) void this.repo.putCommand(archived).catch(() => { this.available = false; this.error = "暂停事件写入失败，未丢弃内存中的业务责任。"; this.emit(); });
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
  private async refreshEvents(): Promise<void> { this.events = await this.repo.listApplicationEvents!(); this.emit(); }
  private async recordEvent(event: ApplicationConnectionEvent): Promise<void> { this.events = [...this.events, event]; await this.repo.putApplicationEvent!(event); this.emit(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.offWallet();
    for (const connection of this.connections.values()) { this.pause(connection); connection.off(); }
    for (const view of [...this.views.values()]) view.close();
    this.views.clear();
    this.listeners.clear();
  }
}
