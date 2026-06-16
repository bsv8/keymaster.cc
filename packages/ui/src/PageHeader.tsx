// packages/ui/src/PageHeader.tsx
// 页面顶部标题 + 描述 + 操作位。
//
// 硬切换 003：title / description 接受 I18nText | string。
//
// 硬切换 013：本组件只负责 markup（title / description / actions 三段），
// 不再携带「业务页头 vs 表单页头」的视觉差异。所有响应式 grid 收敛都
// 写在 apps/web 的 global.css 里，作用域限定在 `.app-shell__paged` 内部
// —— `.app-shell__paged` 是 AppShell 在 renderNormalShell 里挂在
// `<Breadcrumbs /> + <RouteRenderer />` 上的 wrapper，正是「面包屑
// 下方业务页」容器。这样：
//   - 业务页（assets / contacts / p2pkh / settings 等）在窄屏下自动
//     获得「左上文案 + 右下操作」的斜对角结构。
//   - OnboardingShell 内的表单 / 向导 step（LockedShell /
//     FirstTimeImportWizard）不受影响，因为它们在 `.onboarding-shell__main`
//     而不是 `.app-shell__paged` 里。
//   - AppShell 的 diagnostic / recovering 分支根本不进 AppShell__main；
//     repair 分支虽然挂在 `.app-shell__main` 下，但不挂 `.app-shell__paged`，
//     也被排除。
// 调用方不需要记得传 variant prop——边界由 AppShell 自己保证。

import type { ReactNode } from "react";
import type { I18nText } from "@keymaster/contracts";

type RenderableText = string | I18nText;

function toText(input: RenderableText | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return input.fallback;
}

export interface PageHeaderProps {
  title: RenderableText;
  description?: RenderableText;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__content">
        <h1 className="ui-page-header__title">{toText(title)}</h1>
        {description ? (
          <p className="ui-page-header__description">{toText(description)}</p>
        ) : null}
      </div>
      {actions ? <div className="ui-page-header__actions">{actions}</div> : null}
    </header>
  );
}