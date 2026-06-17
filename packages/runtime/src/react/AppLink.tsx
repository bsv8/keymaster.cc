// packages/runtime/src/react/AppLink.tsx
// 内部文本链接：渲染真实 <a>，但只对"同源 + 应用内 path + 左键无 modifier +
// 无 target / download"的普通点击做 SPA 跳转；其它场景全部放行浏览器默认行为。
//
// 设计缘由：硬切换 007 要求"内部页面跳转必须走 runtime router"——但文本链接
// 仍然需要保留链接语义（可复制地址、可中键 / Ctrl+点击新开、可被屏幕阅读器
// 识别为 link）。简单换成 <button> 会破坏这些能力，而 <a href="/..."> 会触发
// 整页刷新、丢 in-memory Vault 会话。AppLink 的存在就是同时满足两边。
//
// 阻止跳转的判定（isInternalHref）：
//   - mailto: / tel: / javascript: / data: 等非 http(s) scheme → 外链
//   - "https?://..."：parse 后 origin === 当前 origin → 内部
//   - "//host/path" 协议相对：parse 后 origin === 当前 origin → 内部
//   - 其它（"/foo"、"?x=1"、"#x"、"foo.html"）：按当前 location 解析，浏览器
//     必然同源 → 内部
//
// `to` 支持完整 path：pathname + 可选 search + 可选 hash。navigateTo /
// useCurrentPath 在 007 同期升级为"完整 location"语义，所以同一路径下换
// ?query 也能正常更新 URL 并通知订阅者。
//
// 硬切换 007 收尾 3：AppLink 自己先把 `to` 规范化成相对 pathname + search +
// hash 再 router.push。这样组件语义自洽——传入 `to="https://当前域名/foo"`
// 在当前页时不会多打一条 history，也不需要调用方记得提前 normalize。
//
// 这个组件放在 runtime 而不是 UI 包：导航拦截是运行时能力；UI 包目前明确不
// 依赖 runtime。

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { normalizeLocationPath, router } from "../navigate.js";

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

/** 判断 href 是否为"应用内同源链接"。 */
function isInternalHref(href: string, currentLocation: Location): boolean {
  if (!href) return false;

  // 任何带 scheme 的 href 先单独判外链（mailto: / tel: / javascript: / data: /
  // blob: / ftp: 等）。http(s) 走同源判定。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!/^https?:\/\//i.test(href)) return false;
    try {
      const target = new URL(href);
      return target.origin === currentLocation.origin;
    } catch {
      return false;
    }
  }

  // 协议相对 "//host/path"：按当前 location 解析后判同源。
  if (href.startsWith("//")) {
    try {
      const target = new URL(href, currentLocation.href);
      return target.origin === currentLocation.origin;
    } catch {
      return false;
    }
  }

  // 其它（"/foo"、"?x=1"、"#x"、相对路径 "foo.html"）：浏览器按当前 location
  // 解析，必然同源。
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
    // AppLink 自身把 `to` 规范化为相对 pathname + search + hash，再交给
    // router.push。navigateTo 内部也会 normalize（兜底），但组件层先做一
    // 次能让"to 是当前页"时即使 navigateTo 被未来其它实现替换也不会多打
    // history。`<a>` 的 href 仍保留原始 `to`，可复制 / 可中键新开等行为
    // 保持不变。
    router.push(normalizeLocationPath(to));
  }

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
