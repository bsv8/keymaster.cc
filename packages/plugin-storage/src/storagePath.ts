const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const LOOKALIKE_SEPARATORS = /[\u2044\u2215\u29f8\uff0f]/u;

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

function assertSafeText(value: string, field: string): void {
  if (value.length > MAX_PATH_LENGTH) throw new StoragePathError(`${field} exceeds the maximum length`);
  if (value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StoragePathError(`${field} contains an unsafe character`);
  }
  if (LOOKALIKE_SEPARATORS.test(value)) throw new StoragePathError(`${field} contains a Unicode separator lookalike`);
}

function splitPath(value: string, field: string, allowEmpty: boolean): string[] {
  if (typeof value !== "string") throw new StoragePathError(`${field} must be a string`);
  assertSafeText(value, field);
  if (value.startsWith("/")) throw new StoragePathError(`${field} must be relative`);
  if (value.length === 0) {
    if (allowEmpty) return [];
    throw new StoragePathError(`${field} must not be empty`);
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") throw new StoragePathError(`${field} contains an unsafe segment`);
    if (segment.length > MAX_SEGMENT_LENGTH) throw new StoragePathError(`${field} contains an oversized segment`);
  }
  return segments;
}

export function normalizeObjectPath(value: string): string {
  const segments = splitPath(value, "path", false);
  return segments.join("/");
}

export function normalizeDirectoryPath(value: string): string {
  if (typeof value !== "string") throw new StoragePathError("path must be a string");
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = splitPath(withoutTrailingSlash, "path", false);
  return `${segments.join("/")}/`;
}

export function buildObjectKey(root: string, relativePath: string, directory = false): string {
  const normalizedRoot = normalizeRoot(root);
  const normalizedPath = directory ? normalizeDirectoryPath(relativePath) : normalizeObjectPath(relativePath);
  const key = `${normalizedRoot}${normalizedPath}`;
  assertKeyInRoot(normalizedRoot, key);
  return key;
}

export function normalizeRoot(root: string): string {
  if (typeof root !== "string" || !root.endsWith("/")) throw new StoragePathError("namespace root must end with '/'");
  assertSafeText(root, "namespace root");
  if (root.startsWith("/") || root.includes("//")) throw new StoragePathError("namespace root is invalid");
  for (const segment of root.slice(0, -1).split("/")) {
    if (!segment || segment === "." || segment === "..") throw new StoragePathError("namespace root is invalid");
  }
  return root;
}

/** Final adapter guard. A sibling prefix such as app-aa cannot pass. */
export function assertKeyInRoot(root: string, key: string): void {
  const normalizedRoot = normalizeRoot(root);
  if (typeof key !== "string") throw new StoragePathError("object key is outside the namespace");
  assertSafeText(key, "object key");
  if (typeof key !== "string" || key.startsWith("/") || !key.startsWith(normalizedRoot)) {
    throw new StoragePathError("object key is outside the namespace");
  }
  if (key === normalizedRoot) return;
  const relative = key.slice(normalizedRoot.length);
  const path = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  if (path.includes("\\") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new StoragePathError("object key is outside the namespace");
  }
}

export function stripRoot(root: string, key: string): string {
  assertKeyInRoot(root, key);
  return key.slice(normalizeRoot(root).length);
}

export function basename(relativePath: string): string {
  const normalized = normalizeObjectPath(relativePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
