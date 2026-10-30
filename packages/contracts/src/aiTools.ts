import { defineCapability } from "webloom-framework";
import type { AiToolDefinition, JSONValue } from "keymaster-connect";

/** Live tools are owned by a specific authenticated App connection, not executable source code. */
export interface ConnectedAiTool {
  id: string;
  applicationKey: string;
  applicationName: string;
  connectionId: string;
  definition: AiToolDefinition;
}
export interface ApplicationAiTools {
  list(): readonly ConnectedAiTool[];
  subscribe(listener: () => void): () => void;
  invoke(id: string, args: Record<string, JSONValue>, signal: AbortSignal): Promise<JSONValue>;
}
export const APPLICATION_AI_TOOLS_CAPABILITY = defineCapability<ApplicationAiTools>({ kind: "local", id: "protocol.ai-tools", version: "1" });
