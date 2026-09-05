import type {
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition
} from "@keymaster/contracts";

/** Provider 实现可共享的内部 object API 形状。 */
export type BucketObject = StorageBucketObject;
export type BucketListPage = StorageBucketListPage;
export type BucketProbeResult = StorageBucketProbeResult;
export type BucketWriteCondition = StorageBucketWriteCondition;
export type BucketProvider = StorageBucketProvider;

export const STORAGE_INTERNAL_PREFIX = ".keymaster/";

/** 物理 Provider 的相对路径校验；它是最后一道防越界门禁。 */
export function assertProviderPath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("storage path is invalid");
  }
}

/** Provider 内部对象不可被 App namespace 读取。 */
export function assertAppVisibleProviderPath(path: string): void {
  assertProviderPath(path);
  if (path === STORAGE_INTERNAL_PREFIX || path.startsWith(STORAGE_INTERNAL_PREFIX)) {
    throw new Error("storage internal path is not visible");
  }
}

export function normalizeProviderLimit(limit: number | undefined, fallback = 200, max = 1000): number {
  const value = limit ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("storage list limit is invalid");
  return value;
}

