// apps/web/src/main.tsx
// 应用入口：硬切换为统一 fatal 驱动入口（施工单 2026-06-30 001）。
//
// 启动顺序（硬切换后）：
//   1) applyInitialTheme / applyInitialLanguage：首帧前写好 <html data-theme>
//      与 <html lang>,避免 FOUC / 首屏语言错位。
//   2) normalizeLegacyHashRoute：把旧的 "#/settings/vault" 形式迁移到正式
//      pathname；必须在 RouteRenderer 读取 location.pathname 之前完成。
//   3) installGlobalFatalHandlers:挂 window.error / unhandledrejection。
//   4) subscribeFatalError:接管者——只要 fatal store 生效,立即卸载 root
//      并渲染纯 DOM 崩溃页。
//   5) checkEnvironment / bootstrapPlugins / createRoot / render。
//
// 设计缘由：
//   - 当前 fatal 通道是**唯一**的统一接管入口；环境检查失败、bootstrap 失败、
//     顶级 React 树 fatal、window 级 fatal、vault 关键持久化异常全部走
//     reportFatalError(...),由本文件 start() 启动前订阅的统一接管者
//     完成页面接管。
//   - 不在 main.tsx 多处散落 renderFatalError(...)。过去旧实现
//     (renderFatalError) 仅覆盖 React 挂载前的错误,无法兜住挂载后
//     的 React 异常、异步异常与持久化异常。

import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PluginHostProvider,
  applyInitialLanguage,
  getFatalError,
  reportFatalError,
  subscribeFatalError,
  type FatalErrorSnapshot
} from "@keymaster/runtime";
import { App } from "./App.js";
import { AppCrashBoundary } from "./AppCrashBoundary.js";
import { bootstrapPlugins } from "./bootstrapPlugins.js";
import { renderFatalCrashPage } from "./fatalCrashPage.js";
import { installGlobalFatalHandlers } from "./installGlobalFatalHandlers.js";
import { normalizeLegacyHashRoute } from "./shell/legacyHashRoute.js";
import { applyInitialTheme } from "./theme/themeStore.js";
import "./shims/buffer.js";
import "./styles/global.css";
import "./styles/plugins.css";

// 主题/语言首帧前置：不阻塞 fatal 接管,这两个都是最佳努力。
applyInitialTheme();
applyInitialLanguage();
normalizeLegacyHashRoute();

// 启动最前面就安装 fatal store 接管者：bootstrapPlugins 失败时
// React root 还没创建,接管者直接渲染纯 DOM 崩溃页。
// 接管者严格幂等:重复接管只重渲染同一份崩溃页。
let currentRoot: Root | null = null;
let lastRenderedFatalId: string | null = null;

function takeOverFatalPage(snapshot: FatalErrorSnapshot): void {
  if (typeof document === "undefined") return;
  // 已挂载 React root:卸载,再渲染纯 DOM 崩溃页。
  // 不保留旧树、不 append 错误容器——fatal 语义就是"当前正常应用路径
  // 已退出",任何保留旧 UI 都会误导用户。
  if (currentRoot) {
    try {
      currentRoot.unmount();
    } catch (err) {
      // 卸载失败也继续渲染崩溃页;不能让 fatal 通道卡住。
      // eslint-disable-next-line no-console
      console.error("[main] root.unmount failed", err);
    }
    currentRoot = null;
  }
  // 同一 fatal 多次触发时不要重绘(已显示的崩溃页已足够)。
  if (lastRenderedFatalId === snapshot.id) return;
  lastRenderedFatalId = snapshot.id;
  const container = document.getElementById("root");
  renderFatalCrashPage(container, snapshot);
}

// 全局接管:启动最前面就订阅,React 挂载前 fatal 也能进入接管。
subscribeFatalError((snapshot) => {
  takeOverFatalPage(snapshot);
});

installGlobalFatalHandlers();

/** 检测运行环境是否能跑 vault。返回 null 表示通过；否则返回错误描述。 */
function checkEnvironment(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) {
    return [
      "当前页面不是安全上下文（secure context）。",
      "浏览器在 HTTP + 非 localhost 主机下会禁用 WebCrypto 和 IndexedDB，vault 无法初始化。",
      "请改用以下任一方式访问：",
      "  - http://localhost:5173",
      "  - http://127.0.0.1:5173",
      "  - 通过 HTTPS（例如反向代理）",
      `当前主机：${window.location.host}`
    ].join("\n");
  }
  if (!window.crypto?.subtle) {
    return "当前浏览器未提供 crypto.subtle（WebCrypto API）。请使用现代浏览器（Chrome/Edge/Firefox/Safari）最新版。";
  }
  if (typeof indexedDB === "undefined") {
    return "当前环境未提供 IndexedDB。vault 无法持久化私钥。";
  }
  return null;
}

async function start() {
  const envError = checkEnvironment();
  if (envError) {
    // 不再散落 renderFatalError(...):统一走 fatal 通道。
    reportFatalError({
      phase: "pre-bootstrap.env",
      scope: "app-root",
      source: "app-bundle",
      message: envError
    });
    return;
  }

  try {
    const host = await bootstrapPlugins();
    // 二次确认：bootstrapPlugins 完成后若 fatal 已生效（plugin 自己
    // 上报了 fatal），就不必再 mount。
    if (getFatalError()) {
      return;
    }
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing #root");
    const root = createRoot(container);
    currentRoot = root;
    root.render(
      <StrictMode>
        <AppCrashBoundary>
          <PluginHostProvider host={host}>
            <App />
          </PluginHostProvider>
        </AppCrashBoundary>
      </StrictMode>
    );
  } catch (err) {
    // 不再调旧 renderFatalError；统一走 fatal 通道。
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    reportFatalError({
      phase: "pre-bootstrap.plugins",
      scope: "app-root",
      source: "app-bundle",
      message,
      cause: err
    });
  }
}

start();
