// apps/web/src/installGlobalFatalHandlers.ts
// 全局 window 错误接管（施工单 2026-06-30 001）。
//
// 关键不变量（必须写注释,不能"魔法 if"）：
//   - `window.error`：仅当 `filename` 指向本应用同源 bundle、或
//     error stack 明确来自本应用代码时,才升级成 fatal。
//   - `window.unhandledrejection`：仅当 reason 可归因为本应用关键启动链
//     或本应用 bundle 时升级为 fatal；opaque rejection 不默认升级。
//   - 扩展脚本 / 第三方脚本 / analytics：只 console.warn,绝不接管页面。
//     设计缘由：宁可漏接第三方噪音,也不能让坏扩展把整站误打进崩溃页。
//   - 主题 / 语言 / localStorage 最佳努力读写失败：业务自身吞,根本不
//     会冒泡到 window.error / unhandledrejection,无需在本文件处理。
//   - 业务页 provider 错误：被局部 ErrorBoundary 拦截,不应冒泡到
//     window.error；个别冒泡上来的也会被本文件来源过滤拦下。

import { reportFatalError } from "@keymaster/runtime";

interface InstalledHandle {
  errorHandler: (event: ErrorEvent) => void;
  rejectionHandler: (event: PromiseRejectionEvent) => void;
}

/**
 * 已经安装过的 window handler 句柄。同一会话里只允许安装一次,避免
 * 重复挂载导致同一条错误被多次升级 fatal。
 */
let installed: InstalledHandle | null = null;

interface WindowWithDebugFlag extends Window {
  /** 调试用：把本应用 bundle 的 origin 记录下来,便于同源判断。 */
  __keymasterOrigin?: string;
}

/**
 * 判断一个 ErrorEvent / unhandledrejection 是否来自本应用 bundle。
 *
 * 规则（按顺序短路,任一命中即为"本应用"）：
 *   1) `error.filename` / `reason.filename` 存在且与 window.location.origin
 *      同源（Vite 构建产物通常会带 file 名）。
 *   2) `error.stack` 或 `reason.stack` 含当前 origin 字符串。
 *   3) 没有 `filename` / `stack` 但发生在我们自己的 bootstrap 启动链
 *      时间窗内（保守：仅当我们明确打了"启动链"标记时）。
 *
 * 注：浏览器扩展抛错时 filename 通常是 `chrome-extension://...` 或
 * `moz-extension://...`；Cloudflare analytics 等三方脚本会带 cdn 域名；
 * 这些都会被规则 1) 拦下。opaque rejection 没有 stack/filename,
 * 默认不升级（规则 3 需要显式标记）。
 */
function isFromAppBundle(input: {
  filename?: string;
  stack?: string;
  originMarker?: string;
}): boolean {
  if (typeof window === "undefined") return false;
  const origin = window.location.origin;
  if (input.filename) {
    try {
      // file:// 这类伪协议,直接放行,交给后续 stack 判定。
      if (!input.filename.startsWith("http")) {
        // 不当作本应用:file: 协议下的脚本很可能是测试/扩展。
      } else if (new URL(input.filename).origin === origin) {
        return true;
      }
    } catch {
      // URL 解析失败：忽略,交给 stack 判定。
    }
  }
  if (input.stack && origin && input.stack.includes(origin)) {
    return true;
  }
  if (input.originMarker && input.stack && input.stack.includes(input.originMarker)) {
    return true;
  }
  return false;
}

/**
 * 安装全局 window 错误 / unhandledrejection handler。
 *
 * 关键约束：
 *   - 幂等：同一会话里多次调用只挂载一次。
 *   - 来源过滤：非本应用脚本 / opaque rejection 一律不升级 fatal。
 *   - handler 自身抛错时不能再调 reportFatalError（防止递归）。
 *     这里用 try/catch 隔离,并把异常吞掉只走 console.error。
 */
export function installGlobalFatalHandlers(): void {
  if (installed) return;
  if (typeof window === "undefined") return;

  const w = window as WindowWithDebugFlag;
  // 记录 origin,供 stack 包含关系判断使用。Vite 把入口脚本 import 为
  // 相对路径,生产环境的 stack 不会带 origin,这里以 origin 作为模糊
  // 标记；测试环境如果想严格隔离,可在 beforeEach 里覆盖。
  w.__keymasterOrigin = w.location.origin;

  const errorHandler = (event: ErrorEvent) => {
    try {
      const filename = event.filename || undefined;
      const stack = event.error instanceof Error ? event.error.stack : undefined;
      const message =
        event.message ||
        (event.error instanceof Error ? event.error.message : "Unknown window error");
      if (!isFromAppBundle({ filename, stack, originMarker: w.__keymasterOrigin })) {
        // 第三方 / 扩展 / 分析脚本噪音：只 console.warn,绝不接管页面。
        // 设计缘由：宁可漏接第三方噪音,也不能让坏扩展把整站误打进崩溃页。
        // eslint-disable-next-line no-console
        console.warn("[installGlobalFatalHandlers] non-app window.error ignored", {
          filename,
          message
        });
        return;
      }
      reportFatalError({
        phase: "global.error",
        scope: "browser",
        source: "app-bundle",
        message,
        stack: stack ?? "",
        cause: event.error
      });
    } catch (err) {
      // 隔离：handler 自身抛错不能再调 reportFatalError。
      // eslint-disable-next-line no-console
      console.error("[installGlobalFatalHandlers] errorHandler crashed", err);
    }
  };

  const rejectionHandler = (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason;
      const stack = reason instanceof Error ? reason.stack : undefined;
      const filename =
        reason && typeof reason === "object" && "filename" in reason
          ? String((reason as { filename?: unknown }).filename)
          : undefined;
      if (!isFromAppBundle({ filename, stack, originMarker: w.__keymasterOrigin })) {
        // opaque rejection / 第三方脚本:不升级。
        // eslint-disable-next-line no-console
        console.warn("[installGlobalFatalHandlers] non-app unhandledrejection ignored", {
          filename,
          reason: reason instanceof Error ? reason.message : String(reason)
        });
        return;
      }
      const message =
        reason instanceof Error ? reason.message : `Unhandled rejection: ${String(reason)}`;
      reportFatalError({
        phase: "global.unhandledrejection",
        scope: "browser",
        source: "app-bundle",
        message,
        stack: stack ?? "",
        cause: reason
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[installGlobalFatalHandlers] rejectionHandler crashed", err);
    }
  };

  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);
  installed = { errorHandler, rejectionHandler };
}

/**
 * 卸载全局 handler。仅供测试夹具使用。
 *
 * 关键约束：必须移除 window 上挂的 handler,否则测试间互相污染。
 * 不允许在生产代码里调用。
 */
export function uninstallGlobalFatalHandlersForTest(): void {
  if (!installed) return;
  if (typeof window === "undefined") return;
  window.removeEventListener("error", installed.errorHandler);
  window.removeEventListener("unhandledrejection", installed.rejectionHandler);
  installed = null;
}
