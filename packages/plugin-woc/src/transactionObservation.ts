/** 传播接口 HTTP 200 只表示查询成功；必须有节点实际找到该交易。 */
export function observedPropagation(value: unknown): "unconfirmed" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WOC propagation response is invalid");
  const { queried_peers: queried, found_on_peers: found } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(queried) || !Number.isSafeInteger(found) || (queried as number) < 1 || (found as number) < 0 || (found as number) > (queried as number)) {
    throw new Error("WOC propagation peer counts are invalid");
  }
  return (found as number) > 0 ? "unconfirmed" : undefined;
}
