export type ApiFormat = "completions" | "responses" | "messages" | "gemini";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  format: ApiFormat;
}
export interface Model {
  id: string;
  reasoning: string[];
}
export interface Selection { providerId: string; model: string; reasoning: string }
export interface Settings {
  version: 1;
  configured: boolean;
  providers: Provider[];
  defaults: Selection;
  systemPrompt: string;
  disabledTools: string[];
}
export interface ToolCall { id: string; name: string; arguments: string }
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}
export interface Message {
  id: string;
  createdAt?: number;
  model?: string;
  durationMs?: number;
  usage?: Usage;
  role: "user" | "assistant" | "tool";
  content: string;
  calls?: ToolCall[];
  callId?: string;
  name?: string;
  /** Opaque provider continuation items (e.g. Gemini thought signatures), never executable. */
  continuation?: { providerId: string; format: "responses" | "gemini"; items: Json[] };
}
export interface Artifact { id: string; title: string; html: string }
export interface Conversation {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  selection: Selection;
  systemPrompt: string;
  messages: Message[];
  artifacts: Artifact[];
}
export interface ToolContext { conversationId: string; signal: AbortSignal }
export interface Tool {
  id: string;
  description: string;
  source: string;
  parameters: Record<string, unknown>;
  available(): boolean;
  execute(args: Record<string, Json>, context: ToolContext): Promise<unknown>;
}
export const message = (role: Message["role"], content: string): Message => ({ id: crypto.randomUUID(), createdAt: Date.now(), role, content });
