// apps/web/src/shell/Breadcrumbs.tsx
// 面包屑：从 breadcrumb.registry 找到当前 path 对应的 provider。
// 设计缘由：动态资源名（key 标签、联系人名）必须由 provider resolve，shell 禁止硬拼。
//
// 硬切换 003：crumb.label 是 I18nText；渲染时调用 host.i18n.text() 解析。
// 动态用户数据（联系人名）走 `{ key, fallback, values }` 注入插值。

import { useEffect, useState } from "react";
import { useCurrentPath, useI18n, usePluginHost } from "@keymaster/runtime";
import type { BreadcrumbItem } from "@keymaster/contracts";
import { router } from "./RouteRenderer.js";

export function Breadcrumbs() {
  const host = usePluginHost();
  const i18n = useI18n();
  // 触发 languageChanged 重渲染：切语言后 crumb label 立即重新解析。
  i18n.language();
  const [items, setItems] = useState<BreadcrumbItem[]>([]);
  const path = useCurrentPath();

  useEffect(() => {
    const provider = host.breadcrumbs.match(path);
    if (!provider) {
      setItems([]);
      return;
    }
    Promise.resolve(provider.resolve(path)).then((result) => setItems(result));
  }, [host, path]);

  if (items.length === 0) return null;

  return (
    <nav className="app-breadcrumbs" aria-label="breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="app-breadcrumbs__item">
          {i > 0 ? <span className="app-breadcrumbs__sep">/</span> : null}
          {it.path ? (
            <button
              type="button"
              onClick={() => router.push(it.path!)}
              className="app-breadcrumbs__link"
            >
              {host.i18n.text(it.label)}
            </button>
          ) : (
            <span className="app-breadcrumbs__current">{host.i18n.text(it.label)}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
