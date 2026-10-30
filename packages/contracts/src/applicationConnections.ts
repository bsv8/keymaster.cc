import { defineCapability } from "webloom-framework";
import type { ApplicationOpenMode } from "./page.js";
import type { AppIdentitySnapshot } from "./appIdentity.js";
import type { ProtocolCommandRecord, ProtocolMethod, ProtocolService } from "./protocol.js";

/** Application is the management root; live connections are child instances, not permission owners. */
export interface ConnectedApplication {
  key: string;
  origin: string;
  name: string;
  identity?: AppIdentitySnapshot;
  updatedAt: number;
}
export interface ApplicationConnection {
  id: string;
  applicationKey: string;
  createdAt: number;
  closedAt?: number;
  /** 瞬时运行权已结束，原连接授权仍保留。 */
  pausedAt?: number;
  /** Wallet-internal authority already bound to this connection; never sent through Connect. */
  service: ProtocolService;
}
export interface ApplicationConnectionEvent {
  id: string;
  applicationKey: string;
  at: number;
  kind: "connected" | "disconnected" | "permission-granted" | "permission-revoked";
  connectionId?: string;
  method?: ProtocolMethod;
}
export interface ApplicationConnectionsSnapshot {
  applications: ConnectedApplication[];
  connections: ApplicationConnection[];
  commands: ProtocolCommandRecord[];
  events: ApplicationConnectionEvent[];
  historyAvailable: boolean;
  error?: string;
}
export interface ApplicationConnections {
  acceptOpener(source: Window | null): void;
  applicationOpenMode(): ApplicationOpenMode;
  setApplicationOpenMode(mode: ApplicationOpenMode): Promise<void>;
  snapshot(): ApplicationConnectionsSnapshot;
  subscribe(listener: () => void): () => void;
  permissions(key: string): Promise<ProtocolMethod[]>;
  revokePermission(key: string, method: ProtocolMethod): Promise<void>;
  disconnect(applicationKey: string): Promise<void>;
  focus(id: string): void;
}
export const APPLICATION_CONNECTIONS_CAPABILITY = defineCapability<ApplicationConnections>({ kind: "local", id: "protocol.application-connections", version: "1" });
