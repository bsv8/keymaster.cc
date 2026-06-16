// apps/web/src/main.tsx
// 应用入口：先做环境检查，再 bootstrap，再挂载。
// 设计缘由：vault 依赖 WebCrypto + IndexedDB，二者都要求安全上下文（HTTPS 或 localhost）。
// 通过 Tailscale 主机名访问时常常是 HTTP，会被浏览器拒绝；这里给出明确提示。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PluginHostProvider, applyInitialLanguage } from "@keymaster/runtime";
import { App } from "./App.js";
import { bootstrapPlugins } from "./bootstrapPlugins.js";
import { renderFatalError } from "./bootstrapError.js";
import { normalizeLegacyHashRoute } from "./shell/legacyHashRoute.js";
import { applyInitialTheme } from "./theme/themeStore.js";
import "./styles/global.css";
import "./styles/plugins.css";

// 启动顺序（硬切换 002 + 003）：
//   1) applyInitialTheme：首帧前把 <html data-theme="…"> 写好，避免 FOUC。
//   2) applyInitialLanguage：首帧前把 <html lang="…"> 写好，避免首屏渲染语言错位。
//      不阻塞环境检查（localStorage 读取 / 浏览器语言解析都很快）。
//   3) normalizeLegacyHashRoute：把旧的 "#/settings/vault" 形式迁移到
//      正式 pathname；必须在 RouteRenderer 读取 location.pathname 之前完成。
//   4) checkEnvironment：WebCrypto / IndexedDB / SecureContext 守卫。
//   5) bootstrapPlugins：装载所有插件、注册 routes / menus。
//   6) React mount。

// 在样式表加载后、React 挂载前同步应用一次主题，避免首屏 FOUC。
// 设计缘由：localStorage 读取与 matchMedia 解析都很快（同步），
// 在这里执行可以让 <html data-theme="…"> 在第一帧渲染前就位。
applyInitialTheme();
applyInitialLanguage();
normalizeLegacyHashRoute();

/** 检测运行环境是否能跑 vault。返回 null 表示通过；否则返回错误描述。 */
function checkEnvironment(): string | null {
  if (typeof window === "undefined") return null;
  // 1. Secure context
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
  // 2. WebCrypto
  if (!window.crypto?.subtle) {
    return "当前浏览器未提供 crypto.subtle（WebCrypto API）。请使用现代浏览器（Chrome/Edge/Firefox/Safari）最新版。";
  }
  // 3. IndexedDB（最佳努力）
  if (typeof indexedDB === "undefined") {
    return "当前环境未提供 IndexedDB。vault 无法持久化私钥。";
  }
  return null;
}

async function start() {
  const envError = checkEnvironment();
  if (envError) {
    renderFatalError(envError);
    return;
  }

  try {
    const host = await bootstrapPlugins();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing #root");
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <PluginHostProvider host={host}>
          <App />
        </PluginHostProvider>
      </StrictMode>
    );
  } catch (err) {
    console.error("Bootstrap failed", err);
    renderFatalError(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

start();
