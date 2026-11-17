/** Persistent development diagnostics. Never a business journal or a funds authority. */
let sequence = 0;
let runtimeId: string | undefined;
const privateField = /password|passwd|private.?key|secret|mnemonic|credential|(^|_)wif|token|api.?key|cookie|authorization$|authorizationheader|rawtx|unsignedtx|signature|scriptsig/i;
export function sanitizeDiagnosticText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/(bearer\s+)[^\s"',;]+/giu, "$1[redacted]")
    .replace(/((?:password|passwd|private[_-]?key|secret|mnemonic|seed[_-]?phrase|credential|wif|token|api[_-]?key|cookie|authorization|rawtx|unsignedtx|signature|scriptsig)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/giu, "$1[redacted]")
    .replace(/\b[0-9a-f]{64}\b/giu, "[redacted-256bit]")
    .replace(/\b(?:[KL][1-9A-HJ-NP-Za-km-z]{51}|5[1-9A-HJ-NP-Za-km-z]{50})\b/gu, "[redacted-wif]");
}
export function sanitizeDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "bigint") return value.toString();
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return {byteLength: value.byteLength};
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const error = value as Error & {code?: unknown; status?: unknown; cause?: unknown};
    return {name: error.name, message: sanitizeDiagnosticText(error.message), stack: error.stack && sanitizeDiagnosticText(error.stack), code: sanitizeDiagnosticValue(error.code, seen), status: sanitizeDiagnosticValue(error.status, seen), cause: sanitizeDiagnosticValue(error.cause, seen), ...(error instanceof AggregateError ? {errors: sanitizeDiagnosticValue(error.errors, seen)} : {})};
  }
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateField.test(key) ? "[redacted]" : sanitizeDiagnosticValue(item, seen)]));
}
/** Lazy and non-throwing; the explicit Vite mode gate also covers dev-mode production builds. */
export function traceDev(source: string, event: string, details: () => unknown = () => ({})): void {
  if ((import.meta as ImportMeta & {readonly env?: {readonly MODE?: string}}).env?.MODE !== "dev"
    && (import.meta as ImportMeta & {readonly env?: {readonly MODE?: string}}).env?.MODE !== "development") return;
  try {
    runtimeId ??= globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now().toString(36)}`;
    // Share the structured console transport with the existing Worker E2E collector.
    console.debug(`[bitfs-debug] ${JSON.stringify({source, event, runtimeId, sequence: ++sequence,
      time: new Date().toISOString(), monotonicMs: performance.now(), details: sanitizeDiagnosticValue(details())})}`);
  } catch { /* Logging must never change signatures, funds or I/O outcomes. */ }
}
