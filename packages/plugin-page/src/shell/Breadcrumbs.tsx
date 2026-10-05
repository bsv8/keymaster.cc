import { usePageResources } from "../PageResourceContext.js";
// apps/web/src/shell/Breadcrumbs.tsx
// 面包屑：从 breadcrumb.registry 找到当前 path 对应的 provider。
// 设计缘由：动态资源名（key 标签、联系人名）必须由 provider resolve，shell 禁止硬拼。
//
// 硬切换 003：crumb.label 是 I18nText；渲染时调用 i18n.text() 解析。
// 动态用户数据（联系人名）走 `{ key, fallback, values }` 注入插值。

import { useEffect, useState } from "react";
import { useCurrentPath, usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import type { BreadcrumbItem } from "@keymaster/contracts";
import { router } from "./RouteRenderer.js";

export function Breadcrumbs() {
  const resources = usePageResources();
  const i18n = usePluginI18n();
  // 触发 languageChanged 重渲染：切语言后 crumb label 立即重新解析。
  i18n.language();
  const path = useCurrentPath();

  const items = useResourceViewSelector<BreadcrumbItem[], BreadcrumbItem[]>(resources, "page.breadcrumbs", [path], s => s.data ?? []);

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
              {i18n.text(it.label)}
            </button>
          ) : (
            <span className="app-breadcrumbs__current">{i18n.text(it.label)}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
