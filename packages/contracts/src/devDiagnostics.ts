/** Persistent development diagnostics. Never a business journal or a funds authority. */
let sequence = 0;
let runtimeId: string | undefined;
const privateField = /password|passwd|private.?key|secret|mnemonic|credential|(^|_)wif|token|api.?key|cookie|authorization$|authorizationheader|rawtx|unsignedtx|signature|scriptsig/i;
function safeText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/(bearer\s+)[^\s"',;]+/giu, "$1[redacted]")
    .replace(/((?:password|passwd|private[_-]?key|secret|token|api[_-]?key)\s*[=:]\s*)[^\s"',;&]+/giu, "$1[redacted]");
}
function summary(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return safeText(value);
  if (typeof value === "bigint") return value.toString();
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return {byteLength: value.byteLength};
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const error = value as Error & {code?: unknown; status?: unknown; cause?: unknown};
    return {name: error.name, message: safeText(error.message), stack: error.stack && safeText(error.stack), code: error.code, status: error.status, cause: summary(error.cause, seen)};
  }
  if (Array.isArray(value)) return value.map(item => summary(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateField.test(key) ? "[redacted]" : summary(item, seen)]));
}
/** Lazy and non-throwing; the explicit Vite mode gate also covers dev-mode production builds. */
export function traceDev(source: string, event: string, details: () => unknown = () => ({})): void {
  if ((import.meta as ImportMeta & {readonly env?: {readonly MODE?: string}}).env?.MODE !== "dev"
    && (import.meta as ImportMeta & {readonly env?: {readonly MODE?: string}}).env?.MODE !== "development") return;
  try {
    runtimeId ??= globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now().toString(36)}`;
    // Share the structured console transport with the existing Worker E2E collector.
    console.debug(`[bitfs-debug] ${JSON.stringify({source, event, runtimeId, sequence: ++sequence,
      time: new Date().toISOString(), monotonicMs: performance.now(), details: summary(details())})}`);
  } catch { /* Logging must never change signatures, funds or I/O outcomes. */ }
}
