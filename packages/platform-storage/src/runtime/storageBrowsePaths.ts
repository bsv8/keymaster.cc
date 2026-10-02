// 浏览路径的规范化与目录前缀拼装。
//
// 浏览面能看到整个钱包，因此它必须自己守住路径边界，不能只依赖调用方：
// 显示用根 `/` 在 RPC 层表示为空串，这里再逐段规范化一次，避免 `/apps`、
// `a/../b` 与 `apps/a-evil` 这类输入混进来。

import { normalizeRelativeStoragePath } from "@keymaster/contracts";

/** 目录标记对象的内容类型；只有它才表示真实目录。 */
export const DIRECTORY_CONTENT_TYPE = "application/x-directory";
/** 目录标记对象名。 */
export const DIRECTORY_MARKER_NAME = ".dir";

/** 浏览层的路径错误；调用方据此转成 storage_invalid_path。 */
export class BrowsePathError extends Error {}

/**
 * 规范化浏览目录前缀。
 *
 * 空串表示逻辑根：`/` 只是显示写法，在 RPC 层必须由调用方先转换掉，
 * 否则「显示根」和「合法对象路径」两种含义会混在一起。
 */
export function normalizeBrowseDirectory(prefix: string): string {
  if (typeof prefix !== "string") throw new BrowsePathError("browse directory is invalid");
  if (prefix === "" || prefix === "/") return "";
  try {
    // 页面用 "dir/" 这种带尾斜杠的前缀表达「这个目录的内容」。尾斜杠必须在这里
    // 去掉而不是交给 normalizeRelativeStoragePath 报错，否则浏览页自己生成的
    // 前缀会被 Worker 判成非法路径。
    return normalizeRelativeStoragePath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
  } catch {
    throw new BrowsePathError("browse directory is invalid");
  }
}

/** 规范化单个对象路径；逻辑根不是对象。 */
export function normalizeBrowseObjectPath(path: string): string {
  if (typeof path !== "string" || path === "" || path === "/") throw new BrowsePathError("browse object path is required");
  try {
    return normalizeRelativeStoragePath(path);
  } catch {
    throw new BrowsePathError("browse object path is invalid");
  }
}

/**
 * 目录前缀补尾斜杠。
 *
 * `apps/a/` 才能命中 `apps/a/.dir`，而 `apps/a` 还会命中 `apps/a-evil/…`；
 * 缺少这个斜杠是最容易写出来的前缀越界。
 */
export function directoryScanPrefix(directory: string): string | undefined {
  return directory === "" ? undefined : `${directory}/`;
}

export function isDirectoryMarkerName(name: string): boolean {
  return name === DIRECTORY_MARKER_NAME;
}
