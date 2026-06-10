// apps/web/src/bootstrapError.ts
// 启动期致命错误展示。
// 设计缘由：bootstrap 失败时 React 还没挂载，错误必须用纯 DOM 渲染。

/** 把多行错误写到 #root 容器里，使用等宽字体并保留换行。 */
export function renderFatalError(message: string): void {
  const container = document.getElementById("root");
  if (!container) {
    // 兜底：写到 body
    const pre = document.createElement("pre");
    pre.style.cssText = "color:red;padding:16px;white-space:pre-wrap;font:13px ui-monospace,monospace";
    pre.textContent = message;
    document.body.appendChild(pre);
    return;
  }
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = [
    "max-width:680px",
    "margin:48px auto",
    "padding:24px",
    "background:#161a22",
    "color:#e6e8ee",
    "border:1px solid #e35a5a",
    "border-radius:8px",
    "font:13px ui-monospace,monospace",
    "line-height:1.6",
    "white-space:pre-wrap"
  ].join(";");
  const title = document.createElement("h2");
  title.style.cssText = "color:#e35a5a;margin:0 0 12px 0;font-size:16px;font-family:system-ui,sans-serif";
  title.textContent = "Keymaster 启动失败";
  const body = document.createElement("pre");
  body.style.cssText = "margin:0;white-space:pre-wrap;font:13px ui-monospace,monospace";
  body.textContent = message;
  wrap.appendChild(title);
  wrap.appendChild(body);
  container.appendChild(wrap);
}
