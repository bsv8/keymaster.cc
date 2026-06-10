// apps/web/src/shell/RouteRenderer.tsx
// 根据 path 渲染路由。
// 设计缘由：路由只来自 route.registry；找不到时显示 NotFound。
//
// router 从 `@keymaster/runtime` re-export，保持与 `Sidebar` /
// `Breadcrumbs` 旧 import 路径兼容（`import { router } from
// "./RouteRenderer.js"`）。`navigateTo` / `currentPath` 的真实实现在
// `packages/runtime/src/navigate.ts`，shell 与所有 plugin 共用一份，
// 避免 `<a href>` 绕过 SPA 的问题。

import { router, useCurrentPath, useI18n, usePluginHost } from "@keymaster/runtime";
import type { AppRoute } from "@keymaster/contracts";

export { router };

export function useRoute(): AppRoute | undefined {
  const host = usePluginHost();
  const path = useCurrentPath();

  // 走精确匹配优先，缺失精确匹配时回退到前缀匹配（例如 /contacts/:id -> /contacts/:id）。
  // 注意：匹配逻辑不依赖翻译后的 label；只比 path。route.label 走 i18n 是展示层。
  const routes = host.routes.list();
  return (
    routes.find((r) => r.path === path) ??
    routes.find((r) => {
      if (!r.path.includes(":")) return false;
      const re = new RegExp("^" + r.path.replace(/:[^/]+/g, "[^/]+") + "$");
      return re.test(path);
    })
  );
}

export function RouteRenderer() {
  const route = useRoute();
  const { t } = useI18n();
  if (!route) {
    return (
      <div className="route-not-found">
        <h2>404</h2>
        <p>{t("common.status.empty", { defaultValue: "页面不存在" })}</p>
      </div>
    );
  }
  const Page = route.component;
  return <Page />;
}
