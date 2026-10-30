import type { Json, Tool, ToolContext } from "./types.js";

export class ToolRegistry {
  private entries = new Map<string, Tool>();
  private listeners = new Set<() => void>();
  constructor(private disabled: () => string[], private assertActive: () => void) {}
  register(tool: Tool): () => void {
    this.assertActive();
    if (this.entries.has(tool.id)) throw new Error(`工具已注册：${tool.id}`);
    this.entries.set(tool.id, tool); this.changed();
    return () => { if (this.entries.get(tool.id) === tool) { this.entries.delete(tool.id); this.changed(); } };
  }
  all() { return [...this.entries.values()]; }
  enabled() { return this.all().filter(tool => this.isEnabled(tool)); }
  private isEnabled(tool: Tool) { return (tool.id === "tools_refresh" || !this.disabled().includes(tool.id)) && tool.available(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed() { for (const listener of this.listeners) listener(); }
  async execute(id: string, raw: string, context: ToolContext) {
    this.assertActive(); context.signal.throwIfAborted();
    const tool = this.entries.get(id);
    if (!tool || !this.isEnabled(tool)) throw new Error("工具已关闭或当前不可用，请刷新工具列表");
    if (raw.length > 1_500_000) throw new Error("工具参数过大");
    const args: unknown = JSON.parse(raw);
    validate(args, tool.parameters);
    const result = await tool.execute(args as Record<string, Json>, context);
    this.assertActive(); context.signal.throwIfAborted();
    return result;
  }
  dispose() { this.entries.clear(); this.listeners.clear(); }
}
/** Small schema subset used by built-in tools; external App schemas need their own SDK boundary. */
function validate(value: unknown, schema: Record<string, any>, depth = 0): void {
  if (depth > 32) throw new Error("工具参数嵌套过深");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具参数必须是对象");
    const input = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(input, key)) throw new Error(`缺少工具参数：${key}`);
    for (const [key, entry] of Object.entries(input)) {
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (child) validate(entry, child, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`未知工具参数：${key}`);
    }
  } else if (schema.type === "string" && (typeof value !== "string" || (schema.minLength && value.length < schema.minLength) || (schema.maxLength && value.length > schema.maxLength))) throw new Error("工具字符串参数无效");
  else if (schema.type === "integer" && (!Number.isSafeInteger(value) || (schema.minimum !== undefined && Number(value) < schema.minimum) || (schema.maximum !== undefined && Number(value) > schema.maximum))) throw new Error("工具整数参数无效");
  else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error("工具布尔参数无效");
  else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error("工具数字参数无效");
}
export const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const string = (maxLength = 200) => ({ type: "string", minLength: 1, maxLength });
