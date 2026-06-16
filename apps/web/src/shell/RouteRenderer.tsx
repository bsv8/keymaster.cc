// apps/web/src/shell/RouteRenderer.tsx
// 根据 path 渲染路由。
// 设计缘由：
//   - 业务路由来自 route.registry；
//   - 设置详情页来自 settings.registry（硬切换 003：不再有"通用 /settings 聚合页"）；
//   - 路由匹配优先精确匹配，缺失时回退到前缀匹配（例如 /contacts/:id -> /contacts/:id）。
//
// router 从 `@keymaster/runtime` re-export，保持与 `Sidebar` /
// `Breadcrumbs` 旧 import 路径兼容（`import { router } from
// "./RouteRenderer.js"`）。`navigateTo` / `currentPath` 的真实实现在
// `packages/runtime/src/navigate.ts`，shell 与所有 plugin 共用一份，
// 避免 `<a href>` 绕过 SPA 的问题。

import { router, useCurrentPath, useI18n, usePluginHost } from "@keymaster/runtime";
import type { AppRoute, SettingsRoute } from "@keymaster/contracts";

export { router };

interface ResolvedRoute {
  component: AppRoute["component"] | SettingsRoute["component"];
  source: "route" | "settings";
  path: string;
}

export function useRoute(): ResolvedRoute | undefined {
  const host = usePluginHost();
  const path = useCurrentPath();

  const routes = host.routes.list();
  const exact = routes.find((r) => r.path === path);
  if (exact) {
    return { component: exact.component, source: "route", path: exact.path };
  }
  const pref = routes.find((r) => {
    if (!r.path.includes(":")) return false;
    const re = new RegExp("^" + r.path.replace(/:[^/]+/g, "[^/]+") + "$");
    return re.test(path);
  });
  if (pref) {
    return { component: pref.component, source: "route", path: pref.path };
  }

  // 设置详情页（硬切换 003）：settings.registry 的 path 直接参与路由匹配。
  const settingsRoutes = host.settings.list();
  const settingsExact = settingsRoutes.find((r) => r.path === path);
  if (settingsExact) {
    return {
      component: settingsExact.component,
      source: "settings",
      path: settingsExact.path
    };
  }
  return undefined;
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
