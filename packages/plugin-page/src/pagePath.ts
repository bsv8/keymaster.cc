import type { PageUiLocation } from "@keymaster/contracts";

export function validatePagePath(path: string): void {
  if (!path.startsWith("/") || /[?#]/.test(path)) throw new TypeError("Invalid page path");
  const names = new Set<string>();
  for (const segment of path.split("/").slice(1)) {
    if (!segment.startsWith(":")) continue;
    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new TypeError("Invalid page parameter");
    names.add(name);
  }
}
export function pagePathShape(path: string): string {
  return path.split("/").map(segment => segment.startsWith(":") ? ":" : segment).join("/");
}
export function matchPagePath(pattern: string, path: string): PageUiLocation | undefined {
  if (!path.startsWith("/")) return undefined;
  const segments = path.split(/[?#]/, 1)[0]!.split("/");
  const expected = pattern.split("/");
  if (segments.length !== expected.length) return undefined;
  const params: Record<string, string> = Object.create(null);
  for (let index = 0; index < expected.length; index++) {
    const segment = expected[index]!;
    if (!segment.startsWith(":")) {
      if (segment !== segments[index]) return undefined;
    } else {
      if (!segments[index]) return undefined;
      try { params[segment.slice(1)] = decodeURIComponent(segments[index]!); } catch { return undefined; }
    }
  }
  return Object.freeze({ path, params: Object.freeze(params) });
}
/** 同一段中静态文字比参数更具体，确保注册顺序与 order 不改变路由选择。 */
export function comparePagePaths(left: string, right: string): number {
  const a = left.split("/"), b = right.split("/");
  for (let index = 0; index < a.length; index++) {
    const difference = Number(a[index]!.startsWith(":")) - Number(b[index]!.startsWith(":"));
    if (difference) return difference;
  }
  return left.localeCompare(right);
}
