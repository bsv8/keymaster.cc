import type {
  AppBootstrapPayload, ApplicationConnection, ApplicationConnections, ApplicationConnectionsSnapshot,
  ApplicationConnectionEvent, ConnectedApplication, ProtocolCommandRecord, ProtocolMethod, ProtocolStorageRepository,
} from "@keymaster/contracts";
import { createProtocolService, type ProtocolServiceDeps, type ProtocolServiceImpl } from "./protocolService.js";
import { applicationKey, readApplicationPermissions, setApplicationPermission } from "./applicationPermissions.js";

/** One Receiver per registered Window: unrelated pages cannot elect themselves a trusted peer. */
export class ApplicationConnectionHost implements ApplicationConnections {
  private applications = new Map<string, ConnectedApplication>();
  private connections = new Map<string, ApplicationConnection & { source: Window; service: ProtocolServiceImpl; off: () => void }>();
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
        for (const connection of this.connections.values()) if (!connection.closedAt) this.disconnect(connection.id);
      } else {
        for (const connection of this.connections.values()) if (!connection.closedAt) connection.service.syncWalletState();
      }
    });
    this.timer = setInterval(() => {
      for (const connection of this.connections.values()) if (!connection.closedAt && connection.source.closed) this.disconnect(connection.id);
    }, 1000);
  }
  private walletGeneration(): string {
    const s = this.deps.walletState.snapshot();
    return JSON.stringify([s.status, s.walletGeneration, s.runGeneration, s.sessionEpoch]);
  }
  async initialize(): Promise<void> {
    try {
      const [apps, commands] = await Promise.all([this.repo.listApplications!(), this.repo.listCommands!(), this.refreshEvents()]);
      if (this.disposed) return;
      for (const app of apps) if (!this.applications.has(app.key)) this.applications.set(app.key, app);
      for (const command of commands) if (!this.history.has(command.id)) this.history.set(command.id, command);
    } catch {
      this.available = false;
      this.error = "应用历史读取失败，请重新打开钱包重试；不会恢复旧连接。";
    }
    this.emit();
  }
  async acceptLaunch(payload: AppBootstrapPayload, source: Window): Promise<void> {
    if (this.disposed) throw new Error("Application host stopped");
    const generation = this.walletGeneration();
    const key = applicationKey(payload.app.appOrigin, payload.appIdentity);
    const app: ConnectedApplication = { key, origin: payload.app.appOrigin, name: payload.appIdentity?.appName ?? payload.app.appId, identity: payload.appIdentity, updatedAt: Date.now() };
    await this.repo.putApplication!(app);
    if (this.disposed || this.walletGeneration() !== generation) throw new Error("Application host stopped or wallet changed");
    // Durable Connect records are origin-scoped today. Explicit replacement avoids two windows borrowing the same runtime authority.
    for (const connection of this.connections.values()) {
      if (!connection.closedAt && this.applications.get(connection.applicationKey)?.origin === app.origin) this.disconnect(connection.id);
    }
    const service = createProtocolService({ ...this.deps, hostedApplication: true, applicationLoggedOut: () => this.disconnect(id), applicationPermissionChanged: () => this.refreshEvents(), bootMode: "appView", resolveOpener: () => source, storageRepository: this.repo });
    service.startSession();
    try {
      await service.acceptLaunchedApplication(payload, source);
      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Application host stopped or wallet changed");
    }
    catch (error) { service.dispose(); throw error; }
    const id = crypto.randomUUID();
    const connection = { id, applicationKey: key, createdAt: Date.now(), source, service, off: () => {} };
    try {
      await this.recordEvent({ id: crypto.randomUUID(), applicationKey: key, at: connection.createdAt, kind: "connected", connectionId: id });
      if (this.disposed || this.walletGeneration() !== generation) throw new Error("Wallet changed while recording connection");
    } catch (error) { service.dispose(); throw error; }
    connection.off = service.subscribeFeed(() => this.emit());
    this.applications.set(key, app);
    this.connections.set(id, connection);
    this.emit();
  }
  async handleMessage(event: MessageEvent): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.closedAt || connection.source !== event.source) continue;
      if (this.applications.get(connection.applicationKey)?.origin !== event.origin) return;
      await connection.service.handleMessage(event);
      return;
    }
  }
  snapshot(): ApplicationConnectionsSnapshot {
    const commands = new Map(this.history);
    for (const connection of this.connections.values()) {
      for (const command of connection.service.feedSnapshot().commands) {
        if (command.applicationKey !== connection.applicationKey) continue;
        commands.set(command.id, command);
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
  disconnect(id: string): void {
    const connection = this.connections.get(id);
    if (!connection || connection.closedAt) return;
    connection.closedAt = Date.now();
    void this.recordEvent({ id: crypto.randomUUID(), applicationKey: connection.applicationKey, at: connection.closedAt, kind: "disconnected", connectionId: id }).catch(() => { this.available = false; this.error = "连接历史写入失败。"; this.emit(); });
    connection.service.pageUnloading();
    for (const command of connection.service.feedSnapshot().commands) {
      const terminal = ["approved", "rejected", "failed", "timed_out"].includes(command.phase);
      const archived: ProtocolCommandRecord = terminal ? command : { ...command, phase: "failed", decision: "failed", status: "connection_expired", errorCode: "connection_expired", errorMessage: "Connection closed", finishedAt: connection.closedAt, updatedAt: connection.closedAt,
        ...(command.method === "payment.pay" ? { paymentStatus: command.phase === "executing" ? "unknown" : "not_signed" } : {}) };
      this.history.set(archived.id, archived);
      if (!terminal) void this.repo.putCommand(archived).catch(() => { this.available = false; this.error = "断开事件写入历史失败，未丢弃内存中的责任摘要。"; this.emit(); });
    }
    connection.service.dispose();
    // Keep read-only late completion updates until this host is disposed. A closed connection never regains message authority.
    this.emit();
  }
  focus(id: string): void {
    const connection = this.connections.get(id);
    if (!connection || connection.closedAt || connection.source.closed) throw new Error("应用窗口已断开");
    connection.source.focus();
  }
  private async refreshEvents(): Promise<void> {
    this.events = await this.repo.listApplicationEvents!();
    this.emit();
  }
  private async recordEvent(event: ApplicationConnectionEvent): Promise<void> {
    this.events = [...this.events, event];
    await this.repo.putApplicationEvent!(event);
    this.emit();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.offWallet();
    for (const connection of this.connections.values()) { this.disconnect(connection.id); connection.off(); }
    this.listeners.clear();
  }
}
