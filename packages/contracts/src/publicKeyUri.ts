/** 兼容现有裸公钥/JSON 二维码；URI 明确使用 Keymaster contact 类型。 */
export function parsePublicKeyUri(raw: string): string | undefined {
  const input = raw.trim();
  const canonical = (value: unknown) => typeof value === "string" && /^(02|03)[0-9a-f]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
  const bare = canonical(input); if (bare) return bare;
  try { const value = JSON.parse(input); const key = canonical(value?.publicKeyHex); if (key) return key; } catch { /* 非 JSON。 */ }
  try {
    const uri = new URL(input);
    if (uri.protocol !== "keymaster:" || !["contact", "public-key"].includes(uri.hostname || uri.pathname)) return undefined;
    if ([...uri.searchParams.keys()].some(key => key !== "publicKeyHex") || uri.searchParams.getAll("publicKeyHex").length !== 1 || uri.hash) return undefined;
    return canonical(uri.searchParams.get("publicKeyHex"));
  } catch { return undefined; }
}
