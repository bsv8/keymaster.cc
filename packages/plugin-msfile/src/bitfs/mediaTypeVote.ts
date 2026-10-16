/** 输入必须是同一次查询、同一 Seed 已验签且有效的报价，按收到时间排列。 */
export function selectBitfsMediaType(quotes: readonly { sellerPublicKeyHex: string; mediaType: string }[]): string {
  const sellers = new Set<string>();
  const counts = new Map<string, number>();
  for (const quote of quotes) {
    const seller = quote.sellerPublicKeyHex.toLowerCase();
    if (sellers.has(seller)) continue;
    sellers.add(seller);
    const type = quote.mediaType.trim().toLowerCase();
    if (type.length > 255 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(type)) throw new Error("BitFS 报价 MIME 不合法");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let selected = "application/octet-stream";
  let highest = 0;
  // Map 保留首次收到顺序；同票不覆盖较早的类型。
  for (const [type, count] of counts) if (count > highest) { selected = type; highest = count; }
  return selected;
}
