import type { ApiFormat, Conversation, Message, Model, Provider, Tool, ToolCall, Usage } from "./types.js";

/** Presets are browser candidates, not a claim of live credentialed verification. */
export const PROVIDER_PRESETS: { name: string; baseUrl: string; format: ApiFormat }[] = [
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "completions" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "responses" },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", format: "messages" },
  { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", format: "gemini" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", format: "completions" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", format: "completions" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", format: "completions" },
];
function base(provider: Provider) {
  const url = new URL(provider.baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("AI 地址必须使用 HTTPS（本机除外）");
  if (url.username || url.password || url.search || url.hash) throw new Error("AI 地址不能含凭据、查询参数或片段");
  return url.href.replace(/\/$/, "");
}
function headers(provider: Provider): Record<string, string> {
  if (provider.format === "messages") return { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  if (provider.format === "gemini") return { "content-type": "application/json", "x-goog-api-key": provider.apiKey };
  return { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` };
}
async function request(provider: Provider, path: string, signal: AbortSignal, body?: unknown): Promise<any> {
  const response = await fetch(base(provider) + path, { method: body ? "POST" : "GET", headers: headers(provider), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]), credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok) throw new Error(`AI 供应商请求失败（HTTP ${response.status}）；请检查密钥、模型、额度和跨域支持`);
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("AI 供应商返回了无效 JSON 对象");
  if (data.error) throw new Error("AI 供应商返回错误；请检查模型及请求配置");
  return data;
}
export async function listModels(provider: Provider, signal: AbortSignal): Promise<Model[]> {
  const data = await request(provider, "/models", signal);
  const rows = provider.format === "gemini" ? data.models : data.data;
  if (!Array.isArray(rows)) throw new Error("供应商模型列表格式无效，可手动输入模型名称");
  return rows.filter((row: any) => row && typeof row === "object" && typeof (provider.format === "gemini" ? row.name : row.id) === "string" && (provider.format !== "gemini" || row.supportedGenerationMethods?.includes("generateContent"))).map((row: any) => {
    const id = provider.format === "gemini" ? String(row.name).replace(/^models\//, "") : String(row.id);
    // Only explicit provider metadata advertises reasoning. No name-based guessing.
    if (!id || id.length > 500) throw new Error("供应商返回的模型标识无效");
    const supported = Array.isArray(row.supported_parameters) && row.supported_parameters.includes("reasoning");
    return { id, reasoning: supported ? ["low", "medium", "high"] : [] };
  }).sort((a: Model, b: Model) => a.id.localeCompare(b.id));
}
const schema = (tool: Tool) => ({ name: tool.id, description: tool.description, parameters: tool.parameters });
function completionsMessages(conversation: Conversation) {
  return [{ role: "system", content: conversation.systemPrompt }, ...conversation.messages.map(m => ({ role: m.role, content: m.content || null, ...(m.calls?.length ? { tool_calls: m.calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}), ...(m.callId ? { tool_call_id: m.callId } : {}) }))];
}
function anthropicMessages(messages: Message[]) {
  return messages.map(m => m.role === "tool"
    ? { role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, content: m.content }] }
    : { role: m.role, content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...(m.calls ?? []).map(call => ({ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments) }))] });
}
interface Answer { content: string; calls: ToolCall[]; continuation?: Message["continuation"]; usage?: Usage }
/** Missing provider metadata stays unknown, never estimated as zero or a model price. */
function usage(raw: any, format: Provider["format"]): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const values: Usage = format === "messages"
    ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, cacheReadTokens: raw.cache_read_input_tokens, cacheWriteTokens: raw.cache_creation_input_tokens }
    : format === "gemini"
      ? { inputTokens: raw.promptTokenCount, outputTokens: raw.candidatesTokenCount, cacheReadTokens: raw.cachedContentTokenCount }
      : { inputTokens: raw.prompt_tokens ?? raw.input_tokens, outputTokens: raw.completion_tokens ?? raw.output_tokens, cacheReadTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens, costUsd: raw.cost };
  const known: Usage = {};
  for (const [key, value] of Object.entries(values)) if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (key === "costUsd" || Number.isSafeInteger(value))) known[key as keyof Usage] = value;
  return Object.keys(known).length ? known : undefined;
}
async function completeRaw(provider: Provider, conversation: Conversation, tools: Tool[], signal: AbortSignal): Promise<Answer> {
  const model = conversation.selection.model;
  if (!model) throw new Error("请选择模型");
  const reasoning = conversation.selection.reasoning;
  if (provider.format === "completions") {
    const data = await request(provider, "/chat/completions", signal, { model, messages: completionsMessages(conversation), ...(tools.length ? { tools: tools.map(tool => ({ type: "function", function: schema(tool) })) } : {}), ...(reasoning ? (new URL(base(provider)).hostname === "openrouter.ai" ? { reasoning: { effort: reasoning } } : { reasoning_effort: reasoning }) : {}) });
    const result = data.choices?.[0]?.message;
    if (!result) throw new Error("AI 未返回有效回复");
    return { usage: usage(data.usage, provider.format), content: result.content ?? "", calls: (result.tool_calls ?? []).map((call: any) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) };
  }
  if (provider.format === "responses") {
    const input = conversation.messages.flatMap((m): any[] => m.role === "assistant" && m.continuation?.format === "responses" && m.continuation.providerId === provider.id ? m.continuation.items : m.role === "tool" ? [{ type: "function_call_output", call_id: m.callId, output: m.content }] : [ ...(m.content ? [{ role: m.role, content: m.content }] : []), ...(m.calls ?? []).map(call => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments })) ]);
    const data = await request(provider, "/responses", signal, { model, instructions: conversation.systemPrompt, input, store: false, include: ["reasoning.encrypted_content"], ...(tools.length ? { tools: tools.map(tool => ({ type: "function", ...schema(tool), strict: false })) } : {}), ...(reasoning ? { reasoning: { effort: reasoning } } : {}) });
    if (!Array.isArray(data.output)) throw new Error("AI 未返回有效回复");
    if (data.status === "incomplete") throw new Error("AI 回复未完成，请调整模型输出限制后重试");
    return { usage: usage(data.usage, provider.format), continuation: { providerId: provider.id, format: "responses", items: data.output }, content: data.output.filter((item: any) => item.type === "message").flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? part.refusal ?? "").join("\n"), calls: data.output.filter((item: any) => item.type === "function_call").map((call: any) => ({ id: call.call_id, name: call.name, arguments: call.arguments })) };
  }
  if (provider.format === "messages") {
    const data = await request(provider, "/messages", signal, { model, max_tokens: 8192, system: conversation.systemPrompt, messages: anthropicMessages(conversation.messages), ...(tools.length ? { tools: tools.map(tool => ({ name: tool.id, description: tool.description, input_schema: tool.parameters })) } : {}) });
    if (!Array.isArray(data.content)) throw new Error("AI 未返回有效回复");
    if (data.stop_reason === "max_tokens") throw new Error("AI 回复达到输出上限，未保存不完整工具参数");
    return { usage: usage(data.usage, provider.format), content: data.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), calls: data.content.filter((part: any) => part.type === "tool_use").map((part: any) => ({ id: part.id, name: part.name, arguments: JSON.stringify(part.input) })) };
  }
  const contents = conversation.messages.map(m => m.role === "tool"
    ? { role: "user", parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] }
    : { role: m.role === "assistant" ? "model" : "user", parts: m.continuation?.format === "gemini" && m.continuation.providerId === provider.id ? m.continuation.items : [...(m.content ? [{ text: m.content }] : []), ...(m.calls ?? []).map(call => ({ functionCall: { name: call.name, args: JSON.parse(call.arguments) } }))] });
  const data = await request(provider, `/models/${encodeURIComponent(model)}:generateContent`, signal, { systemInstruction: { parts: [{ text: conversation.systemPrompt }] }, contents, ...(tools.length ? { tools: [{ functionDeclarations: tools.map(schema) }] } : {}) });
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) throw new Error("AI 未返回有效回复（可能被供应商拦截）");
  if (candidate.finishReason && candidate.finishReason !== "STOP") throw new Error(`AI 回复未完整结束：${String(candidate.finishReason)}`);
  const parts = candidate.content.parts;
  return { usage: usage(data.usageMetadata, provider.format), continuation: { providerId: provider.id, format: "gemini", items: parts }, content: parts.filter((part: any) => part.text && !part.thought).map((part: any) => part.text).join("\n"), calls: parts.filter((part: any) => part.functionCall).map((part: any) => ({ id: crypto.randomUUID(), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) })) };
}
/** Validate the provider response before writing it into durable conversation history. */
export async function complete(provider: Provider, conversation: Conversation, tools: Tool[], signal: AbortSignal): Promise<Answer> {
  const answer = await completeRaw(provider, conversation, tools, signal);
  if (typeof answer.content !== "string" || answer.content.length > 2_000_000 || !Array.isArray(answer.calls)) throw new Error("AI 回复格式无效或过大");
  if (!answer.content && !answer.calls.length) throw new Error("AI 返回了空回复");
  const ids = new Set(conversation.messages.flatMap(message => message.calls ?? []).map(call => call.id));
  for (const call of answer.calls) {
    if (typeof call.id !== "string" || !call.id || call.id.length > 200 || ids.has(call.id) || typeof call.name !== "string" || !call.name || call.name.length > 200 || typeof call.arguments !== "string" || call.arguments.length > 1_500_000) throw new Error("AI 工具调用格式无效");
    ids.add(call.id);
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("AI 工具参数必须是 JSON 对象");
  }
  return answer;
}
