import type { Conversation, Selection, Settings } from "./types.js";

/** Disk recovery is an external boundary. Internal callers use the types directly. */
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI 本地数据格式无效");
  return value as Record<string, any>;
}
function text(value: unknown, max = 2_000_000): asserts value is string {
  if (typeof value !== "string" || value.length > max) throw new Error("AI 本地文本格式无效");
}
function selection(value: unknown): asserts value is Selection {
  const item = record(value); text(item.providerId, 100); text(item.model, 500); text(item.reasoning, 100);
}
function list(value: unknown): asserts value is unknown[] { if (!Array.isArray(value)) throw new Error("AI 本地清单格式无效"); }
export function recoverSettings(value: unknown): Settings {
  const data = record(value);
  if (data.version !== 1 || typeof data.configured !== "boolean") throw new Error("AI 设置版本或状态无效");
  selection(data.defaults); text(data.systemPrompt); list(data.providers); list(data.disabledTools);
  const ids = new Set<string>();
  for (const value of data.providers) {
    const item = record(value); text(item.id, 100); text(item.name, 200); text(item.baseUrl, 2000); text(item.apiKey, 10_000);
    if (!item.id || ids.has(item.id) || !["completions", "responses", "messages", "gemini"].includes(item.format)) throw new Error("AI 供应商记录无效");
    const url = new URL(item.baseUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("AI 供应商地址无效");
    ids.add(item.id);
  }
  data.disabledTools.forEach(item => text(item, 200));
  return data as unknown as Settings;
}
export function recoverConversation(value: unknown, id: string): Conversation {
  const data = record(value);
  if (data.version !== 1 || data.id !== id || !Number.isSafeInteger(data.createdAt)) throw new Error("AI 会话身份或版本无效");
  text(data.title, 1000); text(data.systemPrompt); selection(data.selection); list(data.messages); list(data.artifacts);
  const ids = new Set<string>();
  for (const value of data.messages) {
    const item = record(value); text(item.id, 100); text(item.content);
    if (!item.id || ids.has(item.id) || !["user", "assistant", "tool"].includes(item.role)) throw new Error("AI 消息格式无效");
    ids.add(item.id);
    if (item.createdAt !== undefined && (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0)) throw new Error("AI 消息时间无效");
    if (item.model !== undefined) text(item.model, 500);
    if (item.durationMs !== undefined && (!Number.isFinite(item.durationMs) || item.durationMs < 0)) throw new Error("AI 耗时记录无效");
    if (item.usage !== undefined) {
      const usage = record(item.usage);
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"]) if (usage[key] !== undefined && (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0 || (key !== "costUsd" && !Number.isSafeInteger(usage[key])))) throw new Error("AI 用量记录无效");
    }
    if (item.continuation !== undefined) {
      const continuation = record(item.continuation); text(continuation.providerId, 100); list(continuation.items);
      if (item.role !== "assistant" || !["responses", "gemini"].includes(continuation.format)) throw new Error("AI 供应商续接数据无效");
    }
    if (item.calls !== undefined) {
      list(item.calls);
      if (item.role !== "assistant") throw new Error("AI 工具调用归属无效");
      for (const value of item.calls) { const call = record(value); text(call.id, 200); text(call.name, 200); text(call.arguments); JSON.parse(call.arguments); }
    }
    if (item.role === "tool") { text(item.callId, 200); text(item.name, 200); }
  }
  ids.clear();
  for (const value of data.artifacts) {
    const item = record(value); text(item.id, 100); text(item.title, 120); text(item.html, 1_000_000);
    if (!item.id || ids.has(item.id)) throw new Error("AI 结果身份无效");
    ids.add(item.id);
  }
  return data as unknown as Conversation;
}
