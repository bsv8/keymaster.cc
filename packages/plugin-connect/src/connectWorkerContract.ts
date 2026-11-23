import type { DomainServiceInput } from "./domain.js";
import { defineCapability } from "webloom-framework";
import type { ApplicationConnectionsSnapshot, ConnectAuthSnapshot, ConnectCommandFeedState, ApplicationOpenMode, LaunchAppViewInput, ProtocolMethod, ConnectedAiTool } from "@keymaster/contracts";
import type { AppDirectorySnapshot } from "./catalog.js";
export type ConnectWorkerCommand =
 | { type: "snapshot" }
 | { type: "register-opener"; sourceId: string }
 | { type: "message"; sourceId: string; origin: string; data: unknown }
 | { type: "close-source"; sourceId: string }
 | { type: "focus-launch"; input: LaunchAppViewInput }
 | { type: "launch"; sourceId: string; input: LaunchAppViewInput }
 | { type: "decide"; connectionId: string; recordId: string; decision: "approve" | "reject" | "login"; expectedPhase: import("@keymaster/contracts").ProtocolCommandPhase; remember?: boolean }
 | { type: "permissions"; key: string }
 | { type: "revoke-permission"; key: string; method: ProtocolMethod }
 | { type: "disconnect"; key: string }
 | { type: "focus"; connectionId: string }
 | { type: "opening"; mode: ApplicationOpenMode }
 | { type: "list" }
 | { type: "favorite"; key: string }
 | { type: "select"; key: string; selection: { url?: string; indexseedhashhex?: string } }
 | { type: "delete-app"; key: string }
 | { type: "domain-list" }
 | { type: "domain-add"; service: DomainServiceInput }
 | { type: "domain-edit"; service: DomainServiceInput }
 | { type: "domain-remove"; id: string }
 | { type: "ai-invoke"; id: string; args: unknown };
export interface WorkerConnectionView {
 id: string; applicationKey: string; createdAt: number; closedAt?: number;
 launchUrl?: string; expectedAppPublicKeyHex?: string;
 feed: ConnectCommandFeedState; auth: ConnectAuthSnapshot | null; deadlines: Record<string, number | null>;
}
export interface ConnectWorkerSnapshot {
 revision: number;
 applications: Omit<ApplicationConnectionsSnapshot, "connections"> & { connections: WorkerConnectionView[] };
 directory: AppDirectorySnapshot;
 opening: ApplicationOpenMode | null;
 tools: readonly ConnectedAiTool[];
}
export type ConnectWorkerEvent = { type: "state"; snapshot: ConnectWorkerSnapshot }
 | { type: "post"; sourceId: string; origin: string; message: unknown }
 | { type: "view"; sourceId: string; action: "navigate" | "focus" | "close"; url?: string };
export interface ConnectWorkerResponse { snapshot: ConnectWorkerSnapshot; value?: unknown }
function command(value: unknown): ConnectWorkerCommand {
 if (!value || typeof value !== "object" || typeof (value as {type?:unknown}).type !== "string") throw new TypeError("Invalid Connect command");
 return structuredClone(value) as ConnectWorkerCommand;
}
export const CONNECT_PRIVATE_COMMAND = defineCapability<ConnectWorkerCommand, ConnectWorkerResponse>({ kind: "rpc", id: "connect.private.command", version: "1", request: { parse: command }, response: { parse: value => value as ConnectWorkerResponse } });
export const CONNECT_PRIVATE_EVENTS = defineCapability<Record<string, never>, ConnectWorkerEvent>({ kind: "stream", id: "connect.private.events", version: "1", request: { parse: () => ({}) }, item: { parse: value => value as ConnectWorkerEvent } });
