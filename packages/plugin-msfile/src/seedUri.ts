/** 明确的 Seed URI；不把任意 64 位十六进制内容误判为文件或密钥。 */
export function parseSeedUri(input: string): string | undefined {
 try {
  const uri = new URL(input.trim());
  if (uri.protocol !== "msfile:" || uri.hostname !== "seed" || uri.search || uri.hash) return undefined;
  const seed = uri.pathname.slice(1);
  return /^[0-9a-f]{64}$/i.test(seed) ? seed.toLowerCase() : undefined;
 } catch { return undefined; }
}
