// apps/web/src/fatalCrashPage.ts
// 统一系统级崩溃页（施工单 2026-06-30 001）。
//
// 职责：
//   - 纯 DOM 渲染；不依赖 React、不依赖 plugin host、不依赖 i18n。
//   - 不依赖 VaultStatus、不调用 vault service、不破坏业务状态。
//   - idempotent：重复调用不会越渲越乱。
//   - 内容固定、中文为主；只展示 fatal 摘要 + 唯一动作（刷新页面）。
//
// 严禁：
//   - 导出 key / 清理数据 / 恢复模式 / 跳转业务页 按钮。
//   - 调任何 service / messageBus / 业务 store。
//   - 触发再次 fatal。
//
// final fallback：如果本渲染器自身抛错，回退到最原始的 <pre> 文本。
// 那是 "兜底页失败" 的最后一道防线。
//
// 关键约束：整个 buildDom(...) 流程必须被一个外层 try/catch 完整包住。
// 之前实现只把 appendChild 那一步包了，但 createElement / style.cssText
// / textContent 等中间任何步骤抛错（例如 container 被设成 readonly
// 代理、或 DOM 工厂在极端环境下抛错）都应走 fallbackToPre，而不是
// 让 caller 拿到抛出的异常。

import type { FatalErrorSnapshot } from "@keymaster/runtime";
import { BRAND_WORDMARK } from "./brand.js";

/** 应用 bundle 同源 origin。global handler 用此做来源过滤。 */
function getAppOrigin(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.origin;
}

/** 把 fatal 摘要渲到指定容器。若容器不存在或渲染过程抛错,退回 <pre> 文本。 */
export function renderFatalCrashPage(
  container: HTMLElement | null,
  snapshot: FatalErrorSnapshot
): void {
  try {
    // 注意：此处不能 try/catch 内部吞掉所有再 fallback——因为 fallback
    // 自己也是 try/catch。如果整体抛错,走外层 try/catch 进 fallbackToPre。
    buildDom(container, snapshot);
  } catch {
    // 渲染器内部任一步抛错：返回最原始的 <pre> 文本。
    // 这里不再区分"是 createElement 抛错"还是"是 appendChild 抛错"——
    // 一律退到 fallback,兜底语义更简单。
    fallbackToPre(snapshot);
  }
}

function buildDom(container: HTMLElement | null, snapshot: FatalErrorSnapshot): void {
  const target = container ?? document.body;
  // idempotent：清空后重建,避免多次接管时 DOM 堆叠。
  target.innerHTML = "";
  const wrap = document.createElement("section");
  wrap.setAttribute("data-fatal-crash", "true");
  wrap.style.cssText = [
    "max-width:680px",
    "margin:48px auto",
    "padding:24px",
    "background:#161a22",
    "color:#e6e8ee",
    "border:1px solid #e35a5a",
    "border-radius:8px",
    "font:14px system-ui,-apple-system,sans-serif",
    "line-height:1.6"
  ].join(";");

  const title = document.createElement("h1");
  title.style.cssText =
    "color:#e35a5a;margin:0 0 12px 0;font-size:18px;font-weight:600";
  title.textContent = `${BRAND_WORDMARK} 启动/运行失败`;
  wrap.appendChild(title);

  const desc = document.createElement("p");
  desc.style.cssText = "margin:0 0 16px 0;color:#cfd3dc";
  desc.textContent = "当前浏览器本地运行时发生不可恢复错误。应用已退出正常运行路径,无法继续提供服务。";
  wrap.appendChild(desc);

  const detailTitle = document.createElement("h2");
  detailTitle.style.cssText =
    "color:#e6e8ee;margin:16px 0 8px 0;font-size:14px;font-weight:600";
  detailTitle.textContent = "诊断信息";
  wrap.appendChild(detailTitle);

  const dl = document.createElement("dl");
  dl.style.cssText = "margin:0 0 16px 0;display:grid;grid-template-columns:120px 1fr;gap:4px 12px";
  appendDlRow(dl, "阶段", String(snapshot.phase));
  appendDlRow(dl, "时间", snapshot.time);
  appendDlRow(dl, "范围", String(snapshot.scope));
  appendDlRow(dl, "来源", String(snapshot.source));
  appendDlRow(dl, "应用 origin", getAppOrigin() ?? "(unknown)");
  appendDlRow(dl, "摘要", snapshot.message);
  wrap.appendChild(dl);

  if (snapshot.stack) {
    const stackTitle = document.createElement("h2");
    stackTitle.style.cssText =
      "color:#e6e8ee;margin:16px 0 8px 0;font-size:14px;font-weight:600";
    stackTitle.textContent = "技术详情";
    wrap.appendChild(stackTitle);

    const pre = document.createElement("pre");
    pre.style.cssText =
      "margin:0;padding:12px;background:#0c0f15;color:#cfd3dc;border-radius:4px;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;max-height:240px;overflow:auto";
    pre.textContent = snapshot.stack;
    wrap.appendChild(pre);
  }

  const actionRow = document.createElement("div");
  actionRow.style.cssText = "margin-top:16px;display:flex;gap:8px;flex-wrap:wrap";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新页面";
  refresh.style.cssText = [
    "padding:8px 14px",
    "border-radius:4px",
    "border:1px solid #2c333f",
    "background:#2c333f",
    "color:#e6e8ee",
    "cursor:pointer",
    "font:14px system-ui,-apple-system,sans-serif"
  ].join(";");
  refresh.addEventListener("click", () => {
    if (typeof window !== "undefined") window.location.reload();
  });
  actionRow.appendChild(refresh);
  wrap.appendChild(actionRow);

  target.appendChild(wrap);
}

/**
 * 兜底：渲染器自身抛错时,最原始的 <pre> 文本。
 * 这里再失败就放弃,不要递归 fatal store。
 */
function fallbackToPre(snapshot: FatalErrorSnapshot): void {
  try {
    if (typeof document === "undefined") return;
    // 注意：fallback 也必须走 document.createElement + appendChild,
    // 整体包在 try/catch 里。如果 fallback 自身也失败（极端环境）,
    // 放弃,不要再 throw —— caller 拿到 throw 也没法做有用的事。
    const pre = document.createElement("pre");
    pre.setAttribute("data-fatal-crash", "fallback");
    pre.style.cssText =
      "color:#e35a5a;padding:16px;white-space:pre-wrap;font:13px ui-monospace,SFMono-Regular,Menlo,monospace";
    pre.textContent =
      `${BRAND_WORDMARK} 启动/运行失败\n` +
      `阶段: ${snapshot.phase}\n` +
      `时间: ${snapshot.time}\n` +
      `范围: ${snapshot.scope}\n` +
      `来源: ${snapshot.source}\n` +
      `摘要: ${snapshot.message}\n` +
      (snapshot.stack ? `\n${snapshot.stack}\n` : "");
    document.body.appendChild(pre);
  } catch {
    // final final:无法做任何事,放弃。
  }
}

function appendDlRow(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.style.cssText = "color:#9aa0aa;font-weight:500";
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.style.cssText = "margin:0;color:#e6e8ee;word-break:break-all";
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}
