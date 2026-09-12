import type { TestInfo } from "@playwright/test";
import { SecretString } from "./secretString.js";

/** 可能把长期秘密带入报告的高风险形状。位置只用于报错，不输出匹配文本。 */
const SECRET_PATTERNS: readonly { readonly code: string; readonly pattern: RegExp }[] = [
  { code: "private-key-hex", pattern: /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/iu },
  { code: "wif", pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/u },
  { code: "s3-secret-field", pattern: /(?:secretAccessKey|secret[-_ ]?key|sessionToken)\s*[=:]\s*["']?[^\s,"'}]{12,}/iu },
  { code: "secret-bearing-config", pattern: /(?:seed-key\.hex|s3\.json|satsubscription\.json)\s*[:=]/iu },
];

export interface SecretLeak {
  readonly code: string;
  readonly index: number;
}

/** 把常见敏感字段替换为固定文本；不回显字段值。 */
export function redactText(input: string, knownSecrets: readonly string[] = []): string {
  let result = input;
  for (const secret of knownSecrets) {
    const normalized = secret.trim();
    if (normalized.length > 0) result = result.split(normalized).join("[REDACTED_SECRET]");
  }
  result = result
    .replace(/\b(?:5[HJK][1-9A-HJ-NP-Za-km-z]{49,52}|K|L)[1-9A-HJ-NP-Za-km-z]{40,}\b/gu, "[REDACTED_WIF]")
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/giu, "[REDACTED_HEX_SECRET]")
    .replace(/(secretAccessKey|secret[-_ ]?key|sessionToken)(\s*[=:]\s*)([^\s,"'}]+)/giu, "$1$2[REDACTED_SECRET]")
    .replace(/([?&](?:token|secret|password|key)=)[^&\s]+/giu, "$1[REDACTED_SECRET]");
  return result.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 20_000);
}

/** 扫描原文；发现秘密时只返回类别和位置，绝不返回秘密本身。 */
export function findSecretLeaks(input: string): SecretLeak[] {
  const leaks: SecretLeak[] = [];
  for (const candidate of SECRET_PATTERNS) {
    const match = candidate.pattern.exec(input);
    if (match?.index !== undefined) leaks.push({ code: candidate.code, index: match.index });
  }
  return leaks;
}

/** 附件上传前的最后一道门禁；失败时不创建附件。 */
export function assertSafeArtifact(input: string, label: string, knownSecrets: readonly string[] = []): string {
  for (const secret of knownSecrets) {
    if (secret.trim() && input.includes(secret.trim())) {
      throw new Error(`${label} contains a configured secret`);
    }
  }
  const leaks = findSecretLeaks(input);
  if (leaks.length > 0) throw new Error(`${label} contains secret-shaped data (${leaks.map((leak) => leak.code).join(", ")})`);
  return redactText(input, knownSecrets);
}

/** 将未知异常转换为稳定、脱敏、可用于报告的错误对象。 */
export function redactedError(error: unknown, knownSecrets: readonly string[] = []): { code: string; message: string } {
  const value = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const code = typeof value?.code === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(value.code)
    ? value.code
    : typeof value?.name === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(value.name)
      ? value.name
      : "e2e_failure";
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "集成测试操作失败";
  return { code, message: redactText(raw, knownSecrets) };
}

/** 安全地附加文本证据；发现秘密时让测试失败，不上传不可信附件。 */
export async function attachRedactedText(
  testInfo: TestInfo,
  name: string,
  input: string,
  options: { readonly contentType?: string; readonly knownSecrets?: readonly string[] } = {}
): Promise<void> {
  const safe = assertSafeArtifact(input, name, options.knownSecrets ?? []);
  await testInfo.attach(name, {
    body: safe,
    contentType: options.contentType ?? "text/plain",
  });
}

/** 便于 Resource 持有长期秘密时表达最小生命周期；默认字符串化绝不返回原文。 */
export { SecretString };
