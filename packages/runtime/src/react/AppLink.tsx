// packages/runtime/src/react/AppLink.tsx
// 内部文本链接：渲染真实 <a>，但只对"同源 + 应用内 pathname + 左键无 modifier +
// 无 target / download"的普通点击做 SPA 跳转；其它场景全部放行浏览器默认行为。
//
// 设计缘由：硬切换 007 要求"内部页面跳转必须走 runtime router"——但文本链接
// 仍然需要保留链接语义（可复制地址、可中键 / Ctrl+点击新开、可被屏幕阅读器
// 识别为 link）。简单换成 <button> 会破坏这些能力，而 <a href="/..."> 会触发
// 整页刷新、丢 in-memory Vault 会话。AppLink 的存在就是同时满足两边。
//
// 阻止跳转的判定：href 与 window.location 同源（host + protocol 一致），且目标
// 是应用内 pathname（开头是 "/" 且不带 "//" / scheme:）。外链、target=_blank
// 、download、modifier 点击、中键点击全部放行。
//
// 这个组件放在 runtime 而不是 UI 包：导航拦截是运行时能力；UI 包目前明确不
// 依赖 runtime。

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { router } from "../navigate.js";

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

/** 判断 href 是否为"应用内同源链接"。 */
function isInternalHref(href: string, currentLocation: Location): boolean {
  if (!href) return false;
  // 协议相对 / 绝对 / 模板片段 / mailto 等都直接判外链
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  if (href.startsWith("//")) return false;
  if (!href.startsWith("/")) return false;
  // 同源判定：相对路径（"/..."）必然同源；http(s) 同源才放行。
  if (/^https?:\/\//i.test(href)) {
    try {
      const target = new URL(href);
      return target.origin === currentLocation.origin;
    } catch {
      return false;
    }
  }
  return true;
}

/** 当前点击是否要求"放行浏览器默认行为"（新开标签 / 下载 / 修饰键）。 */
function shouldBypassNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (event.defaultPrevented) return true;
  if (event.button !== 0) return true; // 中键 / 右键
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  if (event.currentTarget.target && event.currentTarget.target !== "" && event.currentTarget.target !== "_self") {
    return true;
  }
  if (event.currentTarget.hasAttribute("download")) return true;
  return false;
}

export function AppLink({ to, onClick, children, ...rest }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (typeof window === "undefined") return;
    if (shouldBypassNavigation(event)) return;
    if (!isInternalHref(to, window.location)) return;
    event.preventDefault();
    router.push(to);
  }

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
